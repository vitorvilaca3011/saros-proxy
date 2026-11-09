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
 *   stop    → kills the process (taskkill /T /F on Windows) and removes the
 *             PID file only once the process is confirmed gone; exits 1 when
 *             something still serves the port
 *   restart → kills running instance (if any), waits for it to disappear,
 *             then starts fresh
 *   status  → checks PID file, falls back to an os-agnostic /health port
 *             probe (instances started outside the daemon have no PID file),
 *             and prints the enabled harnesses
 */

import { spawn, execFileSync } from 'node:child_process';
import chalk from 'chalk';
import { existsSync, writeFileSync, readFileSync, rmSync, mkdirSync, copyFileSync, statSync, renameSync, openSync, closeSync, chmodSync, readSync, fstatSync, realpathSync } from 'node:fs';
import {
  resolve as pathResolve,
  join as pathJoin,
  relative as pathRelative,
  isAbsolute as pathIsAbsolute,
  dirname as pathDirname,
  basename as pathBasename,
  sep as pathSep,
} from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getModelsJsonPath } from './opencode-config.js';
import { mergeMissingModels, parseCatalogObject, serializeCatalogObject } from '../models-catalog.js';
import { formatKeyBlock } from './key-state.js';
import { logger } from '../logger.js';
import { checkForUpdate } from './update-check.js';
import { loadConfig, getSarosDir, type ProxyConfig } from '../config.js';
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
// Test-run guard
// ---------------------------------------------------------------------------

/**
 * test/setup-env.ts publishes the account's real home here before any src
 * module is evaluated. `userInfo().homedir` is the one value a suite cannot
 * fake, which makes the guard below independent of environment isolation.
 */
const REAL_HOME_GLOBAL = '__SAROS_REAL_HOME__';

/** A vitest / `NODE_ENV=test` run: the real installation's handles are not ours. */
const TEST_RUN = process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined;

/**
 * Refuse a PID path inside a real installation's state dir while under test.
 *
 * #104: a suite with a temporary config dir but the real HOME read
 * `~/.config/saros/daemon.pid`, and `stop` killed the live daemon. The env
 * isolation in test/setup-env.ts covers the normal path, but any suite that
 * re-registers `node:os` (`test/config.test.ts` did) or drops
 * XDG_CONFIG_HOME resolves the real home again. This makes the incident
 * structural: under test, a file in the real installation's state dir is
 * never read, never removed and never written, and a PID only reaches
 * killProcess through this read.
 *
 * The two dirs are the ones a real installation can use (`~/.config/saros`,
 * `~/AppData/Local/saros`), not "anything under $HOME": temp dirs can live
 * under the home (TMPDIR=/home/<user>/.cache/...), and refusing those would
 * only break the isolation it is meant to prove.
 */
function pidPathRefused(file: string): boolean {
  if (!TEST_RUN) return false;
  const realHome = (globalThis as Record<string, unknown>)[REAL_HOME_GLOBAL];
  if (typeof realHome !== 'string' || realHome === '') return false;
  // Compare real locations, not spellings: an XDG_CONFIG_HOME symlinked into
  // the real install passed the lexical check and the test happily killed the
  // live daemon.
  const target = canonicalPath(file);
  const realDirs = [
    pathJoin(realHome, '.config', 'saros'),
    pathJoin(realHome, 'AppData', 'Local', 'saros'),
  ];
  return realDirs.some((dir) => isBelow(canonicalPath(dir), target));
}

/**
 * `file` with symlinks resolved, or the longest existing prefix of it with
 * the missing tail kept lexical. A pid or log file usually does not exist
 * yet, and `realpathSync` throws on a missing file — but its directory does,
 * and that is what a symlinked state dir hides behind.
 */
function canonicalPath(file: string): string {
  let current = pathResolve(file);
  let rest = '';
  for (;;) {
    try {
      const real = realpathSync(current);
      return rest === '' ? real : pathJoin(real, rest);
    } catch {
      const parent = pathDirname(current);
      // The root always exists: a failure there means realpathSync refused
      // for another reason (EACCES, ELOOP), so keep the lexical path instead
      // of walking in circles.
      if (parent === current) return pathResolve(file);
      rest = rest === '' ? pathBasename(current) : pathJoin(pathBasename(current), rest);
      current = parent;
    }
  }
}

/** Is `target` strictly below `dir`? Both are absolute, canonical paths. */
function isBelow(dir: string, target: string): boolean {
  const rel = pathRelative(dir, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${pathSep}`) && !pathIsAbsolute(rel);
}

/**
 * The one gate for every path this module touches — pid file, daemon.log,
 * models.json, and the legacy pid file on the opt-in upgrade path. Read,
 * remove and write all pass through here; returning false means the caller
 * must leave the path alone and take its no-op branch (null, silent return or
 * exit 1). Inert outside a test run, where pidPathRefused is always false.
 */
function assertStateDir(file: string, action: 'read' | 'remove' | 'write'): boolean {
  if (!pidPathRefused(file)) return true;
  console.error(
    chalk.red(
      `✗ Refusing to ${action} ${file}: a test run must never touch the real home. Point HOME and XDG_CONFIG_HOME at a temp dir.`,
    ),
  );
  return false;
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
  if (!assertStateDir(file, 'read')) return null;
  try {
    return readFileSync(file, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/** A PID handle on disk: its value and the file it came from. */
interface PidRecord {
  pid: string;
  /** The file that holds this PID — the only one this process may remove. */
  file: string;
}

/**
 * The running PID: the current state dir first. The pre-0.11 path is consulted
 * only when the operator sets SAROS_ALLOW_LEGACY_PID=1 — it lives in the real
 * home, so treating it as a default fallback made isolated runs kill a live
 * daemon. With the flag on, a live legacy PID is migrated into the state dir.
 */
function readPid(): PidRecord | null {
  const current = readPidFile(PID_FILE);
  if (current !== null) return { pid: current, file: PID_FILE };
  if (LEGACY_PID_FILE === null || !legacyPidEnabled()) return null;
  const legacy = readPidFile(LEGACY_PID_FILE);
  if (legacy === null) return null;
  return { pid: legacy, file: migrateLegacyPid(legacy, LEGACY_PID_FILE) };
}

/**
 * Move an opt-in legacy PID into the state dir. Returns the file that holds
 * the handle afterwards: a read-only state dir leaves it where it was.
 */
function migrateLegacyPid(pid: string, legacyFile: string): string {
  if (!legacyPidEnabled()) return legacyFile;
  if (!assertStateDir(PID_FILE, 'write') || !assertStateDir(legacyFile, 'remove')) {
    return legacyFile;
  }
  const pidNum = parsePid(pid);
  if (pidNum === null || !isProcessAlive(pidNum)) return legacyFile;
  try {
    ensurePidDir();
    writeFileSync(PID_FILE, pid, 'utf-8');
    rmSync(legacyFile, { force: true });
    return PID_FILE;
  } catch {
    return legacyFile;
  }
}

function writePid(pid: number): void {
  if (!assertStateDir(PID_FILE, 'write')) return;
  ensurePidDir();
  writeFileSync(PID_FILE, String(pid), 'utf-8');
}

/**
 * Remove one PID file: the one whose PID this process acted on. Removing both
 * used to drop a live legacy instance's handle whenever the current file was
 * the stale one.
 */
function removePidFile(file: string | null): void {
  if (file === null || !assertStateDir(file, 'remove')) return;
  try {
    rmSync(file, { force: true });
  } catch {
    // ignore
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
  if (!assertStateDir(DAEMON_LOG, 'write')) return;
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
  if (!assertStateDir(DAEMON_LOG, 'write')) return null;
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
 *
 * A missing file is seeded from the bundle. An existing file is the user's:
 * a value they customized is never overwritten, but bundle keys they lack are
 * added so an installation created before a catalog refresh still gets the new
 * models. An unparseable file is backed up to models.json.corrupt and
 * re-seeded — it used to be kept forever while the CLI silently fell back to
 * the bundled catalog.
 */
function ensureModelsJson(): void {
  const modelsPath = getModelsJsonPath();
  if (!assertStateDir(modelsPath, 'write')) return;

  const bundledPath = pathJoin(PACKAGE_ROOT, 'assets', 'models.json');
  if (!existsSync(bundledPath)) return;

  let bundledContent: string;
  let bundled: Record<string, unknown>;
  try {
    bundledContent = readFileSync(bundledPath, 'utf-8');
    bundled = parseCatalogObject(bundledContent);
  } catch (err) {
    // A damaged bundle (build defect, disk error) must not become an unhandled
    // rejection after "✓ Proxy started": that exits 1 and skips the harness
    // sync and the update check while the detached proxy keeps running. Warn
    // and skip the seed; the runtime already handles a missing catalog.
    logger.warn(
      { err, path: bundledPath },
      'models.json: could not read or parse the bundled catalog; skipping the seed',
    );
    return;
  }

  if (!existsSync(modelsPath)) {
    mkdirSync(pathDirname(modelsPath), { recursive: true });
    writeModelsFile(modelsPath, bundledContent);
    return;
  }

  const raw = readModelsFile(modelsPath);
  if (raw === null) return;

  let existing: Record<string, unknown>;
  try {
    existing = parseCatalogObject(raw);
  } catch {
    const backupPath = `${modelsPath}.corrupt`;
    copyFileSync(modelsPath, backupPath);
    writeModelsFile(modelsPath, bundledContent);
    console.warn(
      chalk.yellow(`⚠ models.json is not a valid catalog; backed it up to ${backupPath} and re-seeded from the bundle`),
    );
    return;
  }

  const merged = mergeMissingModels(existing, bundled);
  if (merged.added.length === 0) {
    console.log(chalk.dim('models.json already present, keeping the user copy'));
    return;
  }

  writeModelsFile(modelsPath, serializeCatalogObject(merged.models));
  console.log(chalk.dim(`models.json: added ${merged.added.length} missing models from the bundle`));
}

/** Read models.json; a read error leaves the file alone instead of replacing it. */
function readModelsFile(modelsPath: string): string | null {
  try {
    return readFileSync(modelsPath, 'utf-8');
  } catch {
    console.warn(chalk.yellow('⚠ could not read models.json; keeping it as is'));
    return null;
  }
}

/** Write a catalog atomically: temp file beside it, then rename. */
function writeModelsFile(modelsPath: string, content: string): void {
  const tempPath = `${modelsPath}.tmp`;
  writeFileSync(tempPath, content, 'utf-8');
  renameSync(tempPath, modelsPath);
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
/** taskkill's generic failure code, kept only when it carries no diagnostic. */
const TASKKILL_GENERIC_FAILURE = 1;

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

/**
 * Did the target already exit? Decided by the exit code, never by the message:
 * taskkill localises "not found" ("não foi encontrado", "no se encuentra"), so
 * text matching only worked in English and Portuguese.
 *
 * A non-zero taskkill exit with no output is a wrapper that swallowed the
 * reason; "Access is denied" and friends always write one, and keeping such a
 * failure visible is the point of the boolean.
 */
function isAlreadyExited(err: unknown): boolean {
  const failure = err as NodeJS.ErrnoException & {
    status?: number | null;
    stdout?: Buffer | string;
    stderr?: Buffer | string;
  };
  if (failure?.code === 'ESRCH') return true;
  if (failure?.status === TASKKILL_NOT_FOUND) return true;
  const output = `${failure?.stdout ?? ''}${failure?.stderr ?? ''}`.trim();
  return failure?.status === TASKKILL_GENERIC_FAILURE && output === '';
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

/**
 * Load config once for `start` and keep the object: the port decision and the
 * harness model sync must see the same snapshot, and a CLI run must not print
 * the load warnings (plaintext keys, legacy encryption) twice. A config that
 * cannot load keeps the historical behavior — default port, start proceeds.
 */
function loadStartupConfig(configPath?: string): { port: number; config: ProxyConfig | null } {
  try {
    const config = loadConfig(configPath);
    return { port: config.port, config };
  } catch {
    return { port: 3000, config: null };
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

/** What `killRunningDaemon` found and what the kill attempt achieved. */
interface KillResult {
  pid: string | null;
  /** The file the PID came from; null when no usable handle was found. */
  pidFile: string | null;
  /** The process was alive when the kill was issued. */
  wasRunning: boolean;
  /** The file existed but its process was already gone (file removed). */
  wasStale: boolean;
  /**
   * The kill was accepted, or the target turned out to be gone. Not proof of
   * death: SIGKILL/taskkill return before the process is reaped, which is why
   * both callers re-check liveness before touching the PID file.
   */
  killed: boolean;
}

/**
 * Synchronously kill the running daemon if its PID file exists and the
 * process is alive. Cleans up stale PID files. Does NOT call process.exit.
 *
 * The PID file survives a kill that failed: dropping the handle left the next
 * `stop` reporting "no running proxy daemon" (exit 0) for a proxy that was
 * still serving, and `restart` then died on the busy port.
 */
function killRunningDaemon(): KillResult {
  const record = readPid();
  if (record === null) {
    return { pid: null, pidFile: null, wasRunning: false, wasStale: false, killed: false };
  }
  const pidNum = parsePid(record.pid);
  if (pidNum === null) {
    // Garbage in the file — nothing to kill, but the file is not evidence of
    // a running daemon either.
    removePidFile(record.file);
    return { pid: null, pidFile: null, wasRunning: false, wasStale: false, killed: false };
  }
  const pid = String(pidNum);
  if (!isProcessAlive(pidNum)) {
    // Stale PID file — clean it up
    removePidFile(record.file);
    return { pid, pidFile: record.file, wasRunning: false, wasStale: true, killed: true };
  }
  const killed = killProcess(pidNum) || !isProcessAlive(pidNum);
  return { pid, pidFile: record.file, wasRunning: true, wasStale: false, killed };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function daemonStart(port?: number, configPath?: string): Promise<void> {
  // Before the first directory is created: under test a state dir in the real
  // installation is not ours to populate — not the pid, not daemon.log, not
  // models.json.
  if (!assertStateDir(PID_FILE, 'write')) process.exit(1);
  ensurePidDir();

  const startup = loadStartupConfig(configPath);
  const effectivePort = port ?? startup.port;

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
        if (startup.config) {
          await Promise.race([
            syncModelsInAllHarnesses(startup.config),
            new Promise((resolve) => setTimeout(resolve, DAEMON_SYNC_TIMEOUT_MS)),
          ]);
        }
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
      removePidFile(PID_FILE);
      process.exit(1);
    }
  }, 2000);
}
/** How long `stop` waits for the killed process to disappear. */
const STOP_VERIFY_MS = 2000;

/** The pre-0.11 PID file the operator has not opted into yet (stat only). */
function legacyPidFileToAdopt(): string | null {
  if (LEGACY_PID_FILE === null || legacyPidEnabled()) return null;
  return existsSync(LEGACY_PID_FILE) ? LEGACY_PID_FILE : null;
}

/**
 * Wait for a kill to land, then remove the PID file and run `onGone` — or
 * report the failure and exit 1. The liveness re-check is the only honest
 * answer: `killed` says the signal was accepted, not that the process died.
 * A refused kill is checked at once, since waiting cannot change it.
 */
function awaitDaemonGone(result: KillResult, onGone: () => void): void {
  const pidNum = Number(result.pid);
  const check = (): void => {
    if (isProcessAlive(pidNum)) {
      const hint =
        process.platform === 'win32'
          ? `taskkill /T /F /PID ${result.pid}`
          : `kill -9 ${result.pid}`;
      console.error(chalk.red(`✗ Failed to stop daemon (PID ${result.pid}). Try: ${hint}`));
      process.exit(1);
      return;
    }
    removePidFile(result.pidFile);
    onGone();
  };
  if (result.killed) setTimeout(check, STOP_VERIFY_MS);
  else check();
}

/**
 * Nothing to stop in the state dir. That is not the whole truth: a 0.10.x
 * installation keeps its PID under `~/.config/saros`, and an instance started
 * outside the daemon never writes a handle at all, so "no pid file" used to
 * print "no daemon" and exit 0 while a proxy was still serving. Probe the
 * configured port: when /health answers, report what is serving — naming the
 * legacy file and the flag when one exists — and exit non-zero.
 *
 * `alreadyReported` is for a caller that just announced a stale handle: the
 * header is redundant, but the port verdict is not.
 */
async function reportNothingToStop(alreadyReported = false): Promise<void> {
  const legacy = legacyPidFileToAdopt();
  if (legacy === null) {
    if (!alreadyReported) console.log(chalk.yellow('No running proxy daemon found.'));
  } else {
    if (!alreadyReported) {
      console.log(chalk.yellow(`No running proxy daemon found in ${PID_DIR}.`));
    }
    console.log(chalk.yellow(`A pre-0.11 PID file exists at ${legacy}.`));
    console.log(
      chalk.cyan('Re-run with SAROS_ALLOW_LEGACY_PID=1 to let this command read and stop it.'),
    );
  }
  const port = getConfigPort();
  const probe = await probeProxyHealth(port);
  if (!probe.ok) process.exit(0);
  const detail =
    legacy === null
      ? 'it was started outside `saros-proxy start`'
      : 'the pre-0.11 instance was not stopped';
  console.error(chalk.red(`✗ Something is still serving on port ${port} — ${detail}.`));
  process.exit(1);
}

export async function daemonStop(): Promise<void> {
  const result = killRunningDaemon();
  if (result.pid === null) {
    await reportNothingToStop();
    return;
  }
  if (result.wasStale) {
    console.log(
      chalk.yellow(`Daemon process (PID ${result.pid}) is not running. Cleaning up PID file.`),
    );
    // The stale handle was removed; something can still serve — a live legacy
    // instance, or one started outside the daemon. Exiting 0 here hid that.
    await reportNothingToStop(true);
    return;
  }
  awaitDaemonGone(result, () => {
    console.log(chalk.green(`✓ Proxy (PID ${result.pid}) stopped.`));
    process.exit(0);
  });
}

/**
 * Restart the proxy daemon: stop the running instance (if any), wait for it
 * to actually disappear and the port to release, then start a fresh instance.
 * Reuses daemonStart which owns its own exit path via setTimeout.
 *
 * "Restarting: stopped daemon" used to print before the kill landed, so a
 * failed stop was followed by a start that died on the busy port.
 */
export function daemonRestart(port?: number, configPath?: string): void {
  const result = killRunningDaemon();
  if (result.wasRunning && result.pid) {
    awaitDaemonGone(result, () => {
      console.log(
        chalk.dim(`Restarting: stopped daemon (PID ${result.pid}), starting new instance...`),
      );
      daemonStart(port, configPath);
    });
    return;
  }
  if (result.wasStale && result.pid) {
    console.log(chalk.dim(`Stale PID file (PID ${result.pid}) cleaned up. Starting new instance...`));
  } else {
    console.log(chalk.dim('No running daemon found, starting new instance...'));
  }
  daemonStart(port, configPath);
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
  const record = readPid();
  const pidNum = parsePid(record?.pid ?? null);
  const pidAlive = pidNum !== null && isProcessAlive(pidNum);
  const stalePid = record !== null && !pidAlive;
  if (stalePid) removePidFile(record.file);
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
  // A 0.10.x installation keeps its PID under ~/.config/saros: without the
  // flag `status` cannot see it, so say where it is and how to opt in.
  const legacy = state.pid === null ? legacyPidFileToAdopt() : null;
  if (legacy !== null) {
    console.log(chalk.yellow(`A pre-0.11 PID file exists at ${legacy}.`));
    console.log(
      chalk.cyan('Re-run with SAROS_ALLOW_LEGACY_PID=1 to let this command read it.'),
    );
  }
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
