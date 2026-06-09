/**
 * daemon.ts — Start/stop the proxy as a background process.
 *
 * Usage:
 *   saros-proxy start  [--port <port>] [--config <path>]
 *   saros-proxy stop
 *   saros-proxy status
 *
 * Daemon lifecycle:
 *   start  → spawns detached `node dist/index.js` process, saves PID
 *   stop   → kills the process (taskkill /T /F on Windows), removes PID file
 *   status → checks if the process is still alive
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve as pathResolve, join as pathJoin } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { syncModelsToOpencodeConfig, getModelsJsonPath } from './opencode-config.js';
import { checkForUpdate } from './update-check.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PID_DIR = pathJoin(homedir(), '.config', 'saros');
const PID_FILE = pathJoin(PID_DIR, 'daemon.pid');
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
 * Copies the bundled default if missing.
 */
function ensureModelsJson(): void {
  const modelsPath = getModelsJsonPath();
  if (existsSync(modelsPath)) return;

  const dir = pathJoin(homedir(), '.config', 'saros');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Copy bundled models.json to default location
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
// Public API
// ---------------------------------------------------------------------------

export function daemonStart(port?: number, configPath?: string): void {
  ensurePidDir();

  // Build args for the child process — pass through any overrides
  const args = [ENTRY_POINT];
  if (port) args.push('--port', String(port));
  if (configPath) args.push('--config', configPath);

  // Spawn detached child (no console window on Windows)
  // Read env vars from registry if not in process.env (Windows User-scope fix)
  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'production' };
  const encKey = getEnv('OPENCODE_GO_ENCRYPTION_KEY');
  if (encKey) env.OPENCODE_GO_ENCRYPTION_KEY = encKey;

  const child = spawn('node', args, {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'ignore', 'ignore'], // child logs to its own stderr via pino
    detached: true,
    windowsHide: true,
    env,
  });

  // Allow parent to exit independently while child continues
  child.unref();

  const pid = child.pid!;
  writePid(pid);

  // Wait briefly then verify the process is alive
  setTimeout(() => {
    if (isProcessAlive(pid)) {
      console.log(`Proxy started (PID ${pid}) on port ${port ?? 3000}`);

      // Sync models from models.json to opencode.json
      ensureModelsJson();
      syncModelsToOpencodeConfig();

      // Check for newer version — fire-and-forget
      checkForUpdate();

      process.exit(0);
    } else {
      console.error('Proxy exited shortly after starting. Check your config.');
      deletePid();
      process.exit(1);
    }
  }, 2000);
}

export function daemonStop(): void {
  const pid = readPid();
  if (!pid) {
    console.log('No running proxy daemon found.');
    process.exit(0);
  }

  const pidNum = Number(pid);
  if (!isProcessAlive(pidNum)) {
    console.log(`Daemon process (PID ${pid}) is not running. Cleaning up PID file.`);
    deletePid();
    process.exit(0);
  }

  killProcess(pidNum);
  deletePid();

  // Wait a moment to confirm it's gone
  setTimeout(() => {
    if (isProcessAlive(pidNum)) {
      console.error(`Failed to stop daemon (PID ${pid}). Try: taskkill /F /PID ${pid}`);
      process.exit(1);
    } else {
      console.log(`Proxy (PID ${pid}) stopped.`);
      process.exit(0);
    }
  }, 1000);
}

export function daemonStatus(): void {
  const pid = readPid();
  if (!pid) {
    console.log('Daemon is not running.');
    process.exit(0);
  }

  const pidNum = Number(pid);
  if (isProcessAlive(pidNum)) {
    console.log(`Proxy is running (PID ${pid}).`);
    process.exit(0);
  } else {
    console.log(`Stale PID file (PID ${pid} is gone). Cleaning up.`);
    deletePid();
    process.exit(1);
  }
}
