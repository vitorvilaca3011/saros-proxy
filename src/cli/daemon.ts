/**
 * daemon.ts — Start/stop the proxy as a background process.
 *
 * Usage:
 *   saros-proxy start    [--port <port>] [--config <path>]
 *   saros-proxy stop
 *   saros-proxy restart  [--port <port>] [--config <path>]
 *   saros-proxy status
 *
 * Daemon lifecycle:
 *   start   → refuses if the port is already serving, then spawns detached
 *             `node dist/index.js` process, saves PID, appends child stdout
 *             and stderr to daemon.log
 *   stop    → kills the process (taskkill /T /F on Windows), removes PID file
 *   restart → kills running instance (if any), waits, then starts fresh
 *   status  → checks PID file, falls back to an os-agnostic /health port
 *             probe (instances started outside the daemon have no PID file),
 *             and prints the enabled harnesses
 */

import { spawn, execFileSync } from 'node:child_process';
import chalk from 'chalk';
import { existsSync, writeFileSync, readFileSync, rmSync, mkdirSync, copyFileSync, statSync, renameSync, openSync, closeSync, chmodSync, readSync, fstatSync } from 'node:fs';
import { resolve as pathResolve, join as pathJoin } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getModelsJsonPath } from './opencode-config.js';
import { formatKeyBlock } from './key-state.js';
import { checkForUpdate } from './update-check.js';
import { loadConfig, getSarosDir } from '../config.js';
import { DAEMON_SYNC_TIMEOUT_MS } from '../constants.js';
import { syncModelsInAllHarnesses, readHarnessSettings } from './harness-sync.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * State dir: same resolver as config.yaml, so on Windows everything (config,
 * pid, log) lives under %LOCALAPPDATA%\saros — the pid file used to sit in
 * ~/.config/saros there while the config sat elsewhere.
 */
function resolveStateDir(): string {
  try {
    return getSarosDir();
  } catch {
    // No determinable home (headless test env): the legacy shape keeps the
    // CLI importable instead of failing before it can report anything.
    return pathJoin(homedir(), '.config', 'saros');
  }
}

const PID_DIR = resolveStateDir();
const PID_FILE = pathJoin(PID_DIR, 'daemon.pid');
const DAEMON_LOG = pathJoin(PID_DIR, 'daemon.log');
/**
 * Pre-0.11 location. Transition path, and OPT-IN: this path sits in the
 * user's real home, so an isolated run (a test with a temp XDG_CONFIG_HOME but
 * the real HOME) would otherwise act on the developer's live daemon — it did,
 * killing a running proxy from a test. Reading, migrating and deleting it all
 * require SAROS_ALLOW_LEGACY_PID=1; without the flag the file is inert.
 * null when the state dir already *is* that location (POSIX default).
 */
const LEGACY_PID_FILE = resolveLegacyPidFile();

/** Legacy PID handling is explicit operator intent, never a silent fallback. */
function legacyPidEnabled(): boolean {
  return process.env.SAROS_ALLOW_LEGACY_PID === '1';
}

function resolveLegacyPidFile(): string | null {
  const legacy = pathJoin(homedir(), '.config', 'saros', 'daemon.pid');
  return pathResolve(legacy) === pathResolve(PID_FILE) ? null : legacy;
}
/** daemon.log is rotated at start: 10 MB per file, 5 kept. */
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const LOG_KEEP = 5;
const PACKAGE_ROOT = pathResolve(fileURLToPath(import.meta.url), '..', '..', '..');
const ENTRY_POINT = pathResolve(PACKAGE_ROOT, 'dist', 'index.js');

// ---------------------------------------------------------------------------
// Windows registry helper — reads env vars set at User scope
// ---------------------------------------------------------------------------

/**
 * On Windows, env vars set via [System.Environment]::SetEnvironmentVariable
 * at User scope are not visible to the current process until it restarts.
 * This reads them from the registry so the daemon child inherits them.
 */
function readWindowsUserEnv(name: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execFileSync('reg', [
      'query',
      'HKCU\\Environment',
      '/v',
      name,
    ], { windowsHide: true, stdio: 'pipe', timeout: 5000 });
    // Parse: "    name    REG_SZ    value"
    const lines = out.toString().split('\n');
    for (const line of lines) {
      if (line.includes(name) && line.includes('REG_SZ')) {
        const parts = line.split('REG_SZ');
        if (parts[1]) return parts[1].trim();
      }
    }
  } catch {
    // Key doesn't exist or reg query failed
  }
  return undefined;
}

/**
 * Get env var, falling back to Windows registry for User-scope vars.
 */
function getEnv(name: string): string | undefined {
  return process.env[name] ?? readWindowsUserEnv(name);
}

// ---------------------------------------------------------------------------
// PID file management
// ---------------------------------------------------------------------------

function ensurePidDir(): void {
  if (!existsSync(PID_DIR)) {
    mkdirSync(PID_DIR, { recursive: true });
  }
}

/** PID digits, or null when the file is missing/empty/unusable. */
function parsePid(raw: string | null): number | null {
  if (raw === null) return null;
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readPidFile(file: string | null): string | null {
  if (file === null) return null;
  try {
    return readFileSync(file, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * The running PID: the current state dir first. The pre-0.11 path is consulted
 * only when the operator sets SAROS_ALLOW_LEGACY_PID=1 — it lives in the real
 * home, so treating it as a default fallback made isolated runs kill a live
 * daemon. With the flag on, a live legacy PID is migrated into the state dir.
 */
function readPid(): string | null {
  const current = readPidFile(PID_FILE);
  if (current !== null) return current;
  if (LEGACY_PID_FILE === null || !legacyPidEnabled()) return null;
  const legacy = readPidFile(LEGACY_PID_FILE);
  if (legacy === null) return null;
  migrateLegacyPid(legacy, LEGACY_PID_FILE);
  return legacy;
}

function migrateLegacyPid(pid: string, legacyFile: string): void {
  if (!legacyPidEnabled()) return;
  const pidNum = parsePid(pid);
  if (pidNum === null || !isProcessAlive(pidNum)) return;
  try {
    ensurePidDir();
    writeFileSync(PID_FILE, pid, 'utf-8');
    rmSync(legacyFile, { force: true });
  } catch {
    // Read-only state dir: the legacy file still works for this run.
  }
}

function writePid(pid: number): void {
  ensurePidDir();
  writeFileSync(PID_FILE, String(pid), 'utf-8');
}

function deletePid(): void {
  // The legacy file is only ours to remove when the operator opted in.
  const files = legacyPidEnabled() ? [PID_FILE, LEGACY_PID_FILE] : [PID_FILE];
  for (const file of files) {
    if (file === null) continue;
    try {
      rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Rotate daemon.log at start when it grew past LOG_MAX_BYTES:
 * daemon.log.5 is dropped, .4→.5 … .1→.2, and daemon.log becomes .1.
 *
 * Rotation at boot keeps the logging path dependency-free. A local proxy
 * restarts far more often than it writes 10 MB, so mid-run rotation buys
 * nothing but a runtime dependency.
 */
function rotateDaemonLog(): void {
  try {
    if (!existsSync(DAEMON_LOG)) return;
    if (statSync(DAEMON_LOG).size < LOG_MAX_BYTES) return;
    rmSync(`${DAEMON_LOG}.${LOG_KEEP}`, { force: true });
    // Shift newest-first: .4→.5 … .1→.2, then the live log becomes .1. The
    // loop used to stop at i=4, so .4→.5 never happened and the newest
    // generation was silently dropped while .5 disappeared.
    for (let i = LOG_KEEP; i >= 2; i--) {
      const from = `${DAEMON_LOG}.${i - 1}`;
      if (existsSync(from)) renameSync(from, `${DAEMON_LOG}.${i}`);
    }
    if (existsSync(DAEMON_LOG)) renameSync(DAEMON_LOG, `${DAEMON_LOG}.1`);
  } catch {
    // Diagnostics only — a failed rotation must never block startup.
  }
}

/**
 * Open daemon.log for append (0600 — it carries upstream error bodies).
 * Returns null when the file cannot be opened, so callers fall back to
 * discarding output. Used for the child's stdout and stderr, which share this
 * single file. Exported so the wiring can be asserted in tests.
 */
export function openDaemonLog(): number | null {
  try {
    ensurePidDir();
    // mode only applies on create; an existing 0644 log from an older version
    // keeps pino output world-readable unless we chmod it explicitly.
    const fd = openSync(DAEMON_LOG, 'a', 0o600);
    chmodSync(DAEMON_LOG, 0o600);
    return fd;
  } catch {
    return null;
  }
}

/** Enough of the boot tail to hold a stack trace; diagnostics only. */
const LOG_TAIL_BYTES = 16 * 1024;

/** Current daemon.log size — the offset past which this boot's output starts. */
function logSize(): number {
  try {
    return statSync(DAEMON_LOG).size;
  } catch {
    return 0;
  }
}

/**
 * Read daemon.log from `offset` to the end, capped at LOG_TAIL_BYTES.
 * The child's stdout and stderr are the same file (no pipe), so a startup
 * failure has to be recovered from what this boot appended to the log.
 */
function readLogSince(offset: number): string {
  try {
    const fd = openSync(DAEMON_LOG, 'r');
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(offset, size - LOG_TAIL_BYTES);
      if (size <= start) return '';
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Ensure models.json exists at ~/.config/saros/models.json.
 * Always overwrites with the bundled copy on every daemon start.
 */
function ensureModelsJson(): void {
  const modelsPath = getModelsJsonPath();

  const dir = pathJoin(homedir(), '.config', 'saros');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Copy bundled models.json to default location (always overwrite)
  const bundledPath = pathJoin(PACKAGE_ROOT, 'models.json');
  if (existsSync(bundledPath)) {
    copyFileSync(bundledPath, modelsPath);
  }
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

/**
 * Check if a process is alive by PID.
 *
 * `process.kill(pid, 0)` is the portable liveness probe: Node maps it to
 * OpenProcess on Windows, so a dead PID fails with ESRCH and an EPERM/EACCES
 * answer means "the PID exists, it is just not ours to signal" → alive.
 *
 * The previous win32 path ran `tasklist /FI "PID eq <pid>"`, which exits 0
 * even when no task matches — every PID looked alive (#83).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EACCES';
  }
}

/** taskkill's exit code for "no process with that PID". */
const TASKKILL_NOT_FOUND = 128;

/**
 * Kill a process and all its children. Returns whether the target is gone.
 *
 * Output is piped (never inherited): taskkill's "not found" text used to land
 * in the caller's console and PowerShell surfaced it as a NativeCommandError.
 */
export function killProcess(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true,
        timeout: 10000,
        stdio: 'pipe',
      });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch (err) {
    // Dying between the liveness check and the kill is success, not failure.
    return isAlreadyExited(err);
  }
}

function isAlreadyExited(err: unknown): boolean {
  const failure = err as NodeJS.ErrnoException & {
    status?: number | null;
    stdout?: Buffer | string;
    stderr?: Buffer | string;
  };
  if (failure?.code === 'ESRCH') return true;
  if (failure?.status === TASKKILL_NOT_FOUND) return true;
  const output = `${failure?.stdout ?? ''}${failure?.stderr ?? ''}`.toLowerCase();
  // Localized taskkill ("não foi encontrado") keeps its exit code, but a
  // wrapper may surface only the text.
  return output.includes('not found') || output.includes('encontrado');
}

// ---------------------------------------------------------------------------
// Port probing (os-agnostic — no platform-specific process tools)
// ---------------------------------------------------------------------------

/**
 * Probe the proxy's /health endpoint on a port. Returns the parsed body when
 * the endpoint answers with status ok — the strongest cross-platform signal
 * that a saros-proxy instance is actually serving there (PID files can go
 * stale, and instances started outside the daemon never write one).
 */
export async function probeProxyHealth(
  port: number,
): Promise<{ ok: boolean; body?: Record<string, unknown> }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as Record<string, unknown>;
    return { ok: body?.status === 'ok', body };
  } catch {
    return { ok: false };
  }
}

/** The port the proxy binds by default: --port override, else config, else 3000. */
function getConfigPort(configPath?: string): number {
  try {
    return loadConfig(configPath)?.port ?? 3000;
  } catch {
    return 3000;
  }
}

/** Print the harness selection (which harnesses saros-proxy syncs into). */
function printHarnesses(): void {
  const enabled = readHarnessSettings();
  console.log(chalk.cyan(`Enabled harnesses: ${enabled.join(', ') || '(none)'}`));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Synchronously kill the running daemon if its PID file exists and the
 * process is alive. Cleans up stale PID files. Does NOT call process.exit.
 * Returns the PID string found (or null), and whether the process was
 * running (killed) or the PID file was stale (cleaned up).
 */
function killRunningDaemon(): { pid: string | null; wasRunning: boolean; wasStale: boolean } {
  const rawPid = readPid();
  const pidNum = parsePid(rawPid);
  if (pidNum === null) {
    // No PID file, or one holding garbage — nothing to kill, but the file is
    // not evidence of a running daemon either.
    if (rawPid !== null) deletePid();
    return { pid: null, wasRunning: false, wasStale: false };
  }
  const pid = String(pidNum);
  if (!isProcessAlive(pidNum)) {
    // Stale PID file — clean it up
    deletePid();
    return { pid, wasRunning: false, wasStale: true };
  }
  killProcess(pidNum);
  deletePid();
  return { pid, wasRunning: true, wasStale: false };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function daemonStart(port?: number, configPath?: string): Promise<void> {
  ensurePidDir();

  const effectivePort = port ?? getConfigPort(configPath);

  // Refuse to start when the port is already serving: a second instance
  // would die with EADDRINUSE, which the old code misreported as
  // "exited shortly after starting. Check your config."
  const probe = await probeProxyHealth(effectivePort);
  if (probe.ok) {
    console.error(
      chalk.red(
        `✗ Port ${effectivePort} is already in use — a proxy instance appears to be running. Run \`saros-proxy status\` to check.`,
      ),
    );
    process.exit(1);
  }

  // Build args for the child process — `serve` runs the foreground server,
  // which bare `saros-proxy` (overview) must no longer do.
  const args = [ENTRY_POINT, 'serve'];
  if (port) args.push('--port', String(port));
  if (configPath) args.push('--config', configPath);

  // Spawn detached child (no console window on Windows)
  // Read env vars from registry if not in process.env (Windows User-scope fix)
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'production',
    // The child has no terminal: never try the TTY passphrase prompt there.
    SAROS_DAEMON: '1',
  };
  const encKey = getEnv('OPENCODE_GO_ENCRYPTION_KEY');
  if (encKey) env.OPENCODE_GO_ENCRYPTION_KEY = encKey;

  // Child stdout carries pino, stderr carries node's uncaught-exception
  // reporter and startup errors. Both are the same daemon.log descriptor and
  // no pipe is involved: the parent exits after the models sync, and a pipe's
  // missing reader used to kill the serve process with EPIPE on the next
  // stderr write (#99) — a crash trace could be the thing that killed the proxy.
  rotateDaemonLog();
  // A synchronous append descriptor, not createWriteStream: a stream opens
  // asynchronously and its handle outlived startup verification, so cleanup
  // that removes the directory raced with the pending open (ENOTEMPTY) and a
  // restart left a writer on the old log. openDaemonLog chmods to 0600 (the
  // log carries upstream error bodies) and returns null when the file cannot
  // be opened — logging is diagnostic only.
  const logFd = openDaemonLog();
  // Everything past this offset belongs to this boot; earlier boots must not
  // be able to explain a failure.
  const bootOffset = logSize();

  const child = spawn('node', args, {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
    detached: true,
    windowsHide: true,
    env,
  });

  // The child holds its own duplicates of the descriptor.
  if (logFd !== null) {
    try {
      closeSync(logFd);
    } catch {
      // ignore
    }
  }

  // Allow parent to exit independently while child continues
  child.unref();

  const pid = child.pid!;
  writePid(pid);

  // Wait briefly then verify the process is alive
  setTimeout(async () => {
    if (isProcessAlive(pid)) {
      console.log(chalk.green(`✓ Proxy started (PID ${pid}) on port ${effectivePort}.`));

      // Sync models to all enabled harnesses — await with timeout before exit
      ensureModelsJson();
      try {
        const cfg = loadConfig();
        await Promise.race([
          syncModelsInAllHarnesses(cfg),
          new Promise((resolve) => setTimeout(resolve, DAEMON_SYNC_TIMEOUT_MS)),
        ]);
      } catch {
        /* silent — daemon exits regardless */
      }

      // Check for newer version — fire-and-forget
      checkForUpdate();

      process.exit(0);
    } else {
      // The child had no pipe to capture: recover its failure from whatever
      // this boot appended to daemon.log (stdout and stderr are the same file).
      const tail = readLogSince(bootOffset);
      if (tail.includes('EADDRINUSE')) {
        console.error(
          chalk.red(
            `✗ Port ${effectivePort} is already in use. Choose a different port (\`--port <port>\`), or stop the running proxy first.`,
          ),
        );
      } else if (tail.includes('No valid API keys')) {
        console.error(
          chalk.red('✗ No valid API keys found. Ensure keys start with "sk-" and are at least 20 characters.'),
        );
      } else if (tail.trim()) {
        const lines = tail.trim().split('\n').slice(-6).join('\n');
        console.error(chalk.red('✗ Proxy exited shortly after starting. Last output:'));
        console.error(chalk.dim(lines));
      } else {
        console.error(chalk.red('✗ Proxy exited shortly after starting. Check your config.'));
      }
      deletePid();
      process.exit(1);
    }
  }, 2000);
}

/** How long `stop` waits for the killed process to disappear. */
const STOP_VERIFY_MS = 2000;

export function daemonStop(): void {
  const { pid, wasStale } = killRunningDaemon();
  if (pid === null) {
    console.log(chalk.yellow('No running proxy daemon found.'));
    process.exit(0);
  }
  if (wasStale) {
    console.log(chalk.yellow(`Daemon process (PID ${pid}) is not running. Cleaning up PID file.`));
    process.exit(0);
  }
  // The kill has been issued; the re-check is the only thing that can tell a
  // real stop from a failed one — taskkill's own exit code used to be trusted.
  const pidNum = Number(pid);
  setTimeout(() => {
    const alive = isProcessAlive(pidNum);
    if (!alive) {
      console.log(chalk.green(`✓ Proxy (PID ${pid}) stopped.`));
      process.exit(0);
      return;
    }
    const hint = process.platform === 'win32' ? `taskkill /T /F /PID ${pid}` : `kill -9 ${pid}`;
    console.error(chalk.red(`✗ Failed to stop daemon (PID ${pid}). Try: ${hint}`));
    process.exit(1);
  }, STOP_VERIFY_MS);
}

/**
 * Restart the proxy daemon: stop the running instance (if any), wait
 * briefly for the port to release, then start a fresh instance.
 * Reuses daemonStart which owns its own exit path via setTimeout.
 */
export function daemonRestart(port?: number, configPath?: string): void {
  const { pid, wasRunning, wasStale } = killRunningDaemon();
  if (wasRunning && pid) {
    console.log(chalk.dim(`Restarting: stopped daemon (PID ${pid}), starting new instance...`));
    // Wait for the OS to release the port before respawning
    setTimeout(() => daemonStart(port, configPath), 1500);
  } else {
    if (wasStale && pid) {
      console.log(chalk.dim(`Stale PID file (PID ${pid}) cleaned up. Starting new instance...`));
    } else {
      console.log(chalk.dim('No running daemon found, starting new instance...'));
    }
    daemonStart(port, configPath);
  }
}

export interface DaemonState {
  running: boolean;
  pid: string | null;
  port: number;
  stalePid: boolean;
  health?: Record<string, unknown>;
}

/**
 * Resolve the daemon state os-agnostically: PID file first (cleaning up a
 * stale one), then a /health port probe for instances started outside the
 * daemon (no PID file). Shared by `status` and the bare `saros-proxy`
 * overview.
 */
export async function getDaemonState(): Promise<DaemonState> {
  const port = getConfigPort();
  const rawPid = readPid();
  const pidNum = parsePid(rawPid);
  const pidAlive = pidNum !== null && isProcessAlive(pidNum);
  const stalePid = rawPid !== null && !pidAlive;
  if (stalePid) deletePid();
  const probe = await probeProxyHealth(port);
  return {
    running: pidAlive || probe.ok,
    pid: pidAlive ? String(pidNum) : null,
    port,
    stalePid,
    health: probe.ok ? probe.body : undefined,
  };
}

export async function daemonStatus(): Promise<void> {
  const state = await getDaemonState();
  if (state.running) {
    if (state.pid) {
      console.log(chalk.green(`✓ Proxy is running (PID ${state.pid}) on port ${state.port}.`));
    } else {
      console.log(
        chalk.green(
          `✓ Proxy is running on port ${state.port} (no PID file — started outside \`saros-proxy start\`).`,
        ),
      );
    }
    // Per-key state from the daemon's own report: which key is out, why, and
    // when it retries. Skipped silently when the payload has no keys block.
    for (const line of formatKeyBlock(state.health)) console.log(line);
    printHarnesses();
    process.exit(0);
  }
  if (state.stalePid) {
    console.log(chalk.yellow('Daemon is not running (stale PID cleaned up).'));
    process.exit(1);
  }
  console.log(chalk.yellow('Daemon is not running.'));
  printHarnesses();
  process.exit(0);
}
