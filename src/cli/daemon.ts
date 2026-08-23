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
 *             `node dist/index.js` process, saves PID, logs child stderr
 *   stop    → kills the process (taskkill /T /F on Windows), removes PID file
 *   restart → kills running instance (if any), waits, then starts fresh
 *   status  → checks PID file, falls back to an os-agnostic /health port
 *             probe (instances started outside the daemon have no PID file),
 *             and prints the enabled harnesses
 */

import { spawn, execFileSync } from 'node:child_process';
import chalk from 'chalk';
import { existsSync, writeFileSync, readFileSync, rmSync, mkdirSync, copyFileSync, createWriteStream } from 'node:fs';
import { resolve as pathResolve, join as pathJoin } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getModelsJsonPath } from './opencode-config.js';
import { checkForUpdate } from './update-check.js';
import { loadConfig } from '../config.js';
import { DAEMON_SYNC_TIMEOUT_MS } from '../constants.js';
import { syncModelsInAllHarnesses, readHarnessSettings } from './harness-sync.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PID_DIR = pathJoin(homedir(), '.config', 'saros');
const PID_FILE = pathJoin(PID_DIR, 'daemon.pid');
const DAEMON_LOG = pathJoin(PID_DIR, 'daemon.log');
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

function readPid(): string | null {
  try {
    return readFileSync(PID_FILE, 'utf-8').trim();
  } catch {
    return null;
  }
}

function writePid(pid: number): void {
  ensurePidDir();
  writeFileSync(PID_FILE, String(pid), 'utf-8');
}

function deletePid(): void {
  try {
    rmSync(PID_FILE);
  } catch {
    // ignore
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

/** Check if a process is alive by PID. Cross-platform. */
function isProcessAlive(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
        windowsHide: true,
        timeout: 5000,
        stdio: 'pipe',
      });
      return true;
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill a process and all its children. Cross-platform. */
function killProcess(pid: number): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true,
        timeout: 10000,
      });
    } catch {
      // Process may already be dead — ignore
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process may already be dead — ignore
    }
  }
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
  const pid = readPid();
  if (!pid) return { pid: null, wasRunning: false, wasStale: false };
  const pidNum = Number(pid);
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
  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'production' };
  const encKey = getEnv('OPENCODE_GO_ENCRYPTION_KEY');
  if (encKey) env.OPENCODE_GO_ENCRYPTION_KEY = encKey;

  // Capture child stderr (also appended to daemon.log) so startup failures
  // can be diagnosed instead of swallowed by stdio ignore.
  // Best-effort: an unopenable log (dir deleted under us, permissions) must
  // not crash the starter — the stream open is async and can lose the race
  // with cleanup in tests.
  const logStream = createWriteStream(DAEMON_LOG, { flags: 'a' });
  logStream.on('error', () => { /* daemon.log is diagnostic only */ });
  let stderrBuf = '';

  const child = spawn('node', args, {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
    windowsHide: true,
    env,
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    logStream.write(chunk);
  });

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
      // Surface the real startup failure from the child's stderr.
      if (stderrBuf.includes('EADDRINUSE')) {
        console.error(
          chalk.red(
            `✗ Port ${effectivePort} is already in use. Choose a different port (\`--port <port>\`), or stop the running proxy first.`,
          ),
        );
      } else if (stderrBuf.includes('No valid API keys')) {
        console.error(
          chalk.red('✗ No valid API keys found. Ensure keys start with "sk-" and are at least 20 characters.'),
        );
      } else if (stderrBuf.trim()) {
        const tail = stderrBuf.trim().split('\n').slice(-6).join('\n');
        console.error(chalk.red('✗ Proxy exited shortly after starting. Last output:'));
        console.error(chalk.dim(tail));
      } else {
        console.error(chalk.red('✗ Proxy exited shortly after starting. Check your config.'));
      }
      deletePid();
      process.exit(1);
    }
  }, 2000);
}

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
  // wasRunning === true — killRunningDaemon already killed the process and
  // deleted the PID file. Now verify it's actually gone.
  const pidNum = Number(pid);
  setTimeout(() => {
    if (isProcessAlive(pidNum)) {
      console.error(chalk.red(`✗ Failed to stop daemon (PID ${pid}). Try: taskkill /F /PID ${pid}`));
      process.exit(1);
    } else {
      console.log(chalk.green(`✓ Proxy (PID ${pid}) stopped.`));
      process.exit(0);
    }
  }, 1000);
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
  const pid = readPid();
  const pidAlive = pid !== null && isProcessAlive(Number(pid));
  const stalePid = pid !== null && !pidAlive;
  if (stalePid) deletePid();
  const probe = await probeProxyHealth(port);
  return {
    running: pidAlive || probe.ok,
    pid: pidAlive ? pid : null,
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
