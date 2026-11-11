/**
 * daemon.test.ts — Tests for the proxy daemon lifecycle.
 *
 * child_process is mocked for the whole file so daemonStart tests stay
 * deterministic (no real process trees). daemon.js reads homedir() at import
 * time (PID_DIR/PID_FILE constants), so homedir is mocked via a mutable ref
 * and daemon.js is re-imported (vi.resetModules) per test, keeping PID
 * operations inside temp homes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, mkdtempSync, statSync, readlinkSync, readdirSync, closeSync, chmodSync, openSync, writeSync, symlinkSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type * as Daemon from '../src/cli/daemon.js';
import type * as ConfigModule from '../src/config.js';
import type * as HarnessSyncModule from '../src/cli/harness-sync.js';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// os.homedir() caches its result, so a process.env.HOME override is ignored.
// Mock homedir() to a mutable ref (same pattern as harness-config.test.ts).
const mockHomeRef = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockHomeRef.current };
});

const mockSpawn = vi.hoisted(() =>
  vi.fn((..._args: unknown[]): { pid: number; unref: () => void; stderr: null } => ({
    pid: 12345,
    unref: vi.fn(),
    stderr: null,
  })),
);
const mockExecFileSync = vi.hoisted(() =>
  vi.fn((..._args: unknown[]): Buffer => Buffer.from('')),
);
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  execFileSync: mockExecFileSync,
}));

// Logger is mocked so a warning emitted from inside a timer is observable.
const mockLoggerWarn = vi.hoisted(() => vi.fn());
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: mockLoggerWarn, error: vi.fn() },
}));

// loadConfig is wrapped (not replaced) so the number of loads per `start` is
// observable: the double load (#cli-log-render) duplicated the CLI warnings.
const mockLoadConfig = vi.hoisted(() => vi.fn());
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return { ...actual, loadConfig: mockLoadConfig };
});

// The models sync would otherwise reach the network from the startup timer.
const mockSyncModels = vi.hoisted(() => vi.fn());
vi.mock('../src/cli/harness-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HarnessSyncModule>();
  return { ...actual, syncModelsInAllHarnesses: mockSyncModels };
});

// Force the bundled catalog read to fail when a test sets a fault mode. The
// daemon imports readFileSync directly, so an ESM spy cannot intercept it.
// 'unreadable' throws like a disk error; 'invalid-json' returns a truncated
// file so the parse branch (not just the read) is exercised.
const mockBundleFault = vi.hoisted(
  () => ({ mode: 'none' as 'none' | 'unreadable' | 'invalid-json' }),
);
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      const isBundle =
        typeof path === 'string' &&
        path.includes('assets') &&
        path.endsWith('models.json');
      if (isBundle && mockBundleFault.mode === 'unreadable') {
        throw new Error('EIO: simulated broken bundle');
      }
      if (isBundle && mockBundleFault.mode === 'invalid-json') {
        return '{"truncated": ';
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp "home" dir so PID operations are isolated. */
function createTempHome(): string {
  // mkdtemp: unique, attacker-unpredictable dir (Date.now() names are guessable)
  const dir = mkdtempSync(join(tmpdir(), 'saros-daemon-test-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Re-import daemon.js so its PID_DIR/PID_FILE constants use the current home.
 * Dynamic import is a deliberate test seam: vi.resetModules() re-evaluates
 * the module, which a static import cannot do.
 */
function importDaemon(): Promise<Daemon> {
  vi.resetModules();
  return import('../src/cli/daemon.js');
}

/** process.exit spy that throws — for paths where exit must stop control flow. */
function mockProcessExitThrow() {
  return vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null): never => {
    throw new Error(`process.exit(${code})`);
  });
}

/** process.exit spy that records without throwing — for setTimeout callbacks. */
function mockProcessExitRecord() {
  return vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
}

/** A fetch stub answering /health like the real proxy. */
function stubHealthOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok', keyCount: 2 }) }),
  );
}

/** A fetch stub that fails the port probe (nothing listening). */
function stubHealthDown() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
}

/** Make isProcessAlive() report the PID as dead (POSIX path). */
function stubPidDead() {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('ESRCH');
  });
}

/**
 * State dir (config, pid, log) the daemon resolves for `home` on the current
 * platform. Mirrors getDefaultConfigPath in src/config.ts.
 */
function stateDir(home: string): string {
  return process.platform === 'win32'
    ? join(home, 'AppData', 'Local', 'saros')
    : join(home, '.config', 'saros');
}

/**
 * State dir resolved for the current test's temp home. Set by stubStateDir
 * before each daemon import; tests use it instead of rebuilding the path.
 */
let sarosDir = '';

/**
 * Point every state-dir input at `home` BEFORE importing daemon.js — the
 * module resolves its pid/log paths at import time, exactly like the real
 * CLI. Sets `sarosDir` to the dir daemon.js will use.
 */
function stubStateDir(home: string): void {
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  vi.stubEnv('LOCALAPPDATA', join(home, 'AppData', 'Local'));
  sarosDir = stateDir(home);
}

/** Run `fn` with a faked process.platform, restoring the real one after. */
async function withPlatform<T>(
  platform: NodeJS.Platform,
  fn: () => T | Promise<T>,
): Promise<T> {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    if (desc) Object.defineProperty(process, 'platform', desc);
  }
}

/** Errno-shaped failure from a syscall. */
function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** execFileSync failure shape for a taskkill run that exited non-zero. */
function taskkillError(status: number, output: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Command failed: taskkill`), {
    status,
    stdout: Buffer.from(''),
    stderr: Buffer.from(output),
  });
}

/**
 * File descriptors this process holds on `target` (Linux only). /proc/self/fd
 * is the cheap identity check — same trick as the stdout wiring test.
 */
function openFdsTo(target: string): number[] {
  return readdirSync('/proc/self/fd').filter((name) => {
    try {
      return readlinkSync(`/proc/self/fd/${name}`) === target;
    } catch {
      return false; // fd closed between readdir and readlink
    }
  });
}

// vi.restoreAllMocks() (each describe's afterEach) can wipe a vi.fn
// implementation, so every test re-attaches the delegating implementation
// before daemon.js is imported. The real loadConfig still runs — only the
// number of loads is observed.
beforeEach(async () => {
  const actual = await vi.importActual<typeof ConfigModule>('../src/config.js');
  mockLoadConfig.mockReset();
  mockLoadConfig.mockImplementation(actual.loadConfig);
  mockSyncModels.mockReset();
  mockSyncModels.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// probeProxyHealth
// ---------------------------------------------------------------------------

describe('probeProxyHealth', () => {
  let tempHome: string;
  let daemon: Daemon;

  beforeEach(async () => {
    tempHome = createTempHome();
    mockHomeRef.current = tempHome;
    stubStateDir(tempHome);
    daemon = await importDaemon();
  });

  afterEach(() => {
    mockHomeRef.current = '';
    rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns ok with the health body when a proxy answers', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', keyCount: 2 }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const result = await daemon.probeProxyHealth(port);

    expect(result.ok).toBe(true);
    expect(result.body?.status).toBe('ok');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns not ok when nothing is listening', async () => {
    const result = await daemon.probeProxyHealth(1);
    expect(result.ok).toBe(false);
  });

  it('returns not ok when the endpoint answers but is not our proxy', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const result = await daemon.probeProxyHealth(port);

    expect(result.ok).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

// ---------------------------------------------------------------------------
// isProcessAlive
// ---------------------------------------------------------------------------

describe('isProcessAlive', () => {
  let tempHome: string;
  let daemon: Daemon;

  beforeEach(async () => {
    tempHome = createTempHome();
    mockHomeRef.current = tempHome;
    stubStateDir(tempHome);
    daemon = await importDaemon();
  });

  afterEach(() => {
    mockHomeRef.current = '';
    rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reports a PID as alive when the liveness probe succeeds', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(daemon.isProcessAlive(4242)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(4242, 0);
  });

  it('reports ESRCH as dead', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('ESRCH');
    });

    expect(daemon.isProcessAlive(4242)).toBe(false);
  });

  it('reports EPERM as alive — the PID exists but is not ours to signal', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('EPERM');
    });

    expect(daemon.isProcessAlive(4242)).toBe(true);
  });

  it('reports EACCES as alive — OpenProcess denied but the PID exists', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('EACCES');
    });

    expect(daemon.isProcessAlive(4242)).toBe(true);
  });

  it('rejects an unusable PID without asking the OS', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(daemon.isProcessAlive(pid)).toBe(false);
    }
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('never trusts a tasklist exit code on win32 (#83)', async () => {
    await withPlatform('win32', () => {
      // tasklist exits 0 for a PID that does not exist, so the old probe
      // reported every PID as alive.
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw errnoError('ESRCH');
      });
      mockExecFileSync.mockClear();

      expect(daemon.isProcessAlive(999999)).toBe(false);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// killProcess
// ---------------------------------------------------------------------------

describe('killProcess', () => {
  let tempHome: string;
  let daemon: Daemon;

  beforeEach(async () => {
    tempHome = createTempHome();
    mockHomeRef.current = tempHome;
    stubStateDir(tempHome);
    daemon = await importDaemon();
    mockExecFileSync.mockClear();
  });

  afterEach(() => {
    mockHomeRef.current = '';
    rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mockExecFileSync.mockImplementation(() => Buffer.from(''));
  });

  it('win32: runs taskkill and captures its output instead of leaking it', async () => {
    await withPlatform('win32', () => {
      expect(daemon.killProcess(4242)).toBe(true);
      // stdio: 'pipe' keeps taskkill's "not found" text off our console; the
      // exit code used to be the only signal, and it was ignored.
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'taskkill',
        ['/T', '/F', '/PID', '4242'],
        expect.objectContaining({ stdio: 'pipe', windowsHide: true }),
      );
    });
  });

  it('win32: a non-zero taskkill exit is a failure', async () => {
    await withPlatform('win32', () => {
      mockExecFileSync.mockImplementationOnce(() => {
        throw taskkillError(1, 'ERROR: Access is denied.');
      });

      expect(daemon.killProcess(4242)).toBe(false);
    });
  });

  it('win32: "process not found" is not a failure', async () => {
    await withPlatform('win32', () => {
      // The process can die between isProcessAlive and taskkill.
      mockExecFileSync.mockImplementationOnce(() => {
        throw taskkillError(128, 'ERROR: The process "4242" not found.');
      });

      expect(daemon.killProcess(4242)).toBe(true);
    });
  });

  it('win32: a silent generic failure counts as already exited', async () => {
    await withPlatform('win32', () => {
      // A wrapper that swallowed taskkill's message: no diagnostic to keep.
      mockExecFileSync.mockImplementationOnce(() => {
        throw taskkillError(1, '');
      });

      expect(daemon.killProcess(4242)).toBe(true);
    });
  });

  it('win32: a localised message does not decide — the exit code does', async () => {
    await withPlatform('win32', () => {
      // "não foi encontrado" used to read as success for one locale only.
      mockExecFileSync.mockImplementationOnce(() => {
        throw taskkillError(1, 'ERRO: não foi encontrado o processo "4242".');
      });

      expect(daemon.killProcess(4242)).toBe(false);
    });
  });

  it('win32: a taskkill that cannot even spawn is a failure', async () => {
    await withPlatform('win32', () => {
      mockExecFileSync.mockImplementationOnce(() => {
        throw errnoError('ENOENT');
      });

      expect(daemon.killProcess(4242)).toBe(false);
    });
  });

  it('posix: sends SIGKILL and reports success', async () => {
    await withPlatform('linux', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      expect(daemon.killProcess(4242)).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL');
    });
  });

  it('posix: ESRCH is success, EPERM is a failure', async () => {
    await withPlatform('linux', () => {
      const killSpy = vi.spyOn(process, 'kill');

      killSpy.mockImplementationOnce(() => {
        throw errnoError('ESRCH');
      });
      expect(daemon.killProcess(4242)).toBe(true);

      killSpy.mockImplementationOnce(() => {
        throw errnoError('EPERM');
      });
      expect(daemon.killProcess(4242)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// daemonStop
// ---------------------------------------------------------------------------

describe('daemonStop', () => {
  const TEST_PID = 4242;
  let tempHome: string;
  let daemon: Daemon;

  beforeEach(async () => {
    tempHome = createTempHome();
    mockHomeRef.current = tempHome;
    stubStateDir(tempHome);
    daemon = await importDaemon();
    // Nothing in this suite may ever reach a real signal.
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('ESRCH');
    });
    // `stop` without a handle probes /health now: keep it off the network so
    // a real proxy on :3000 cannot decide the exit code.
    stubHealthDown();
  });

  afterEach(() => {
    mockHomeRef.current = '';
    rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    mockExecFileSync.mockImplementation(() => Buffer.from(''));
  });

  function writeDaemonPid(pid: number): string {
    mkdirSync(sarosDir, { recursive: true });
    const file = join(sarosDir, 'daemon.pid');
    writeFileSync(file, String(pid), 'utf-8');
    return file;
  }

  /** The PID stays alive until a kill lands, then reports ESRCH. */
  function stubDyingProcess(state: { alive: boolean }): void {
    vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
      if (signal === 0) {
        if (!state.alive) throw errnoError('ESRCH');
        return true;
      }
      state.alive = false;
      return true;
    });
  }

  it('reports nothing to stop when no PID file exists', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExitThrow();

    await expect(daemon.daemonStop()).rejects.toThrow('process.exit(0)');
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('No running proxy daemon found.');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('probes the explicit port passed by update when there is no PID file', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await daemon.daemonStop({ port: 3100, exitOnComplete: false });

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3100/health',
      expect.anything(),
    );
  });

  it('exits non-zero when no handle exists but something serves the port', async () => {
    // Instance started outside `saros-proxy start`, or one whose pid file was
    // never written: "no daemon" was a lie while /health answered.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = mockProcessExitThrow();
    stubHealthOk();

    await expect(daemon.daemonStop()).rejects.toThrow('process.exit(1)');

    const errors = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errors).toContain('still serving on port 3000');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('cleans up a stale PID file without claiming to have stopped anything', async () => {
    const pidFile = writeDaemonPid(TEST_PID);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockProcessExitThrow();

    await expect(daemon.daemonStop()).rejects.toThrow('process.exit(0)');
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain(`Daemon process (PID ${TEST_PID}) is not running.`);
    expect(output).not.toContain('stopped');
    expect(existsSync(pidFile)).toBe(false);
  });

  it('cleans an unreadable handle, then still reports a serving port', async () => {
    mkdirSync(sarosDir, { recursive: true });
    const pidFile = join(sarosDir, 'daemon.pid');
    writeFileSync(pidFile, 'not-a-pid', 'utf-8');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = mockProcessExitThrow();
    stubHealthOk();

    await expect(daemon.daemonStop()).rejects.toThrow('process.exit(1)');

    expect(existsSync(pidFile)).toBe(false);
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'still serving on port 3000',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('reports success once the process is gone and removes the PID file', async () => {
    const pidFile = writeDaemonPid(TEST_PID);
    stubDyingProcess({ alive: true });
    const exitSpy = mockProcessExitRecord();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();

    await daemon.daemonStop();
    // Nothing may be printed before the post-kill verification runs.
    expect(logSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain(`✓ Proxy (PID ${TEST_PID}) stopped.`);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('reports failure only when the process is still alive after the wait', async () => {
    const pidFile = writeDaemonPid(TEST_PID);
    vi.spyOn(process, 'kill').mockImplementation(() => true); // never dies
    const exitSpy = mockProcessExitRecord();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();

    await daemon.daemonStop();
    await vi.advanceTimersByTimeAsync(3000);

    const output = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain(`Failed to stop daemon (PID ${TEST_PID})`);
    expect(exitSpy).toHaveBeenCalledWith(1);
    // The handle survives: a failed stop that dropped it made the next `stop`
    // report "no running daemon" (exit 0) for a proxy that still served.
    expect(existsSync(pidFile)).toBe(true);
  });

  it('keeps the handle after a failed stop, so the next stop is not a false success', async () => {
    const pidFile = writeDaemonPid(TEST_PID);
    vi.spyOn(process, 'kill').mockImplementation(() => true); // never dies
    const exitSpy = mockProcessExitRecord();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();

    await daemon.daemonStop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(existsSync(pidFile)).toBe(true);

    // A second stop still has something to act on — and reports the same
    // failure instead of "No running proxy daemon found." with exit 0.
    await daemon.daemonStop();
    await vi.advanceTimersByTimeAsync(3000);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).not.toContain('No running proxy daemon found');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(existsSync(pidFile)).toBe(true);
  });

  it('win32: taskkill success is reported as success (#83)', async () => {
    const pidFile = writeDaemonPid(TEST_PID);
    const state = { alive: true };
    const exitSpy = mockProcessExitRecord();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();

    await withPlatform('win32', async () => {
      vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
        if (signal === 0) {
          if (!state.alive) throw errnoError('ESRCH');
          return true;
        }
        return true;
      });
      mockExecFileSync.mockImplementation(() => {
        state.alive = false; // taskkill /F terminated it
        return Buffer.from('SUCCESS: sent termination signal');
      });

      await daemon.daemonStop();
      await vi.advanceTimersByTimeAsync(3000);
    });

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain(`✓ Proxy (PID ${TEST_PID}) stopped.`);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('win32: a PID that died before taskkill still counts as stopped', async () => {
    const pidFile = writeDaemonPid(TEST_PID);
    let probes = 0;
    // Throws on exit: a second exit call (or a fall-through after exit) fails
    // the test instead of being absorbed by a recording spy.
    const exitSpy = mockProcessExitThrow();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();

    await withPlatform('win32', async () => {
      vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
        if (signal !== 0) return true;
        probes += 1;
        if (probes > 1) throw errnoError('ESRCH');
        return true;
      });
      mockExecFileSync.mockImplementation(() => {
        throw taskkillError(128, 'ERROR: The process "4242" not found.');
      });

      await expect(async () => {
        await daemon.daemonStop();
        await vi.advanceTimersByTimeAsync(3000);
      }).rejects.toThrow('process.exit(0)');
    });

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain(`✓ Proxy (PID ${TEST_PID}) stopped.`);
    // taskkill's "not found" text must not reach the operator's console.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('win32: a surviving process after a failed taskkill is a failure', async () => {
    const pidFile = writeDaemonPid(TEST_PID);
    const exitSpy = mockProcessExitRecord();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();

    await withPlatform('win32', async () => {
      vi.spyOn(process, 'kill').mockImplementation(() => true); // liveness never clears
      mockExecFileSync.mockImplementation(() => {
        throw taskkillError(1, 'ERROR: Access is denied.');
      });

      await daemon.daemonStop();
      await vi.advanceTimersByTimeAsync(3000);
    });

    const output = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain(`Failed to stop daemon (PID ${TEST_PID})`);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(existsSync(pidFile)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Legacy PID opt-in (#104) — the pre-0.11 pid sits in the REAL home
// ---------------------------------------------------------------------------

describe('legacy PID file is opt-in', () => {
  const TEST_PID = 979; // the live daemon a test run killed in #104
  let tempHome: string;
  let legacyHome: string;
  let daemon: Daemon;

  beforeEach(async () => {
    tempHome = createTempHome();
    // The incident shape: config dir isolated (temp XDG), home not. The
    // state dir and the legacy path must be different directories for the
    // fallback to be exercised at all.
    legacyHome = createTempHome();
    mockHomeRef.current = legacyHome;
    stubStateDir(tempHome);
    daemon = await importDaemon();
  });

  afterEach(() => {
    mockHomeRef.current = '';
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(legacyHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function writeLegacyPid(pid: number): string {
    const file = join(legacyHome, '.config', 'saros', 'daemon.pid');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, String(pid), 'utf-8');
    return file;
  }

  it('is inert without SAROS_ALLOW_LEGACY_PID=1: stop never signals it', async () => {
    const legacyPidFile = writeLegacyPid(TEST_PID);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExitThrow();
    stubHealthDown();

    await expect(daemon.daemonStop()).rejects.toThrow('process.exit(0)');

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('No running proxy daemon found in');
    expect(exitSpy).toHaveBeenCalledWith(0);
    // Not even a liveness probe: the file was never consulted.
    expect(killSpy).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
    // Untouched: not migrated into the state dir, not deleted from home.
    expect(readFileSync(legacyPidFile, 'utf-8')).toBe(String(TEST_PID));
    expect(existsSync(join(sarosDir, 'daemon.pid'))).toBe(false);
  });

  it('stop names the pre-0.11 PID file and how to opt in, without reading it', async () => {
    const legacyPidFile = writeLegacyPid(TEST_PID);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = mockProcessExitThrow();
    stubHealthDown();

    await expect(daemon.daemonStop()).rejects.toThrow('process.exit(0)');

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain(legacyPidFile);
    expect(output).toContain('SAROS_ALLOW_LEGACY_PID=1');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(killSpy).not.toHaveBeenCalled();
    expect(readFileSync(legacyPidFile, 'utf-8')).toBe(String(TEST_PID));
  });

  it('stop exits non-zero when the pre-0.11 daemon still serves the port', async () => {
    const legacyPidFile = writeLegacyPid(TEST_PID);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockProcessExitThrow();
    stubHealthOk();

    // Reporting "no daemon" with exit 0 while the old proxy serves is the
    // upgrade trap this hint exists for.
    await expect(daemon.daemonStop()).rejects.toThrow('process.exit(1)');

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain(legacyPidFile);
    const errors = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errors).toContain('still serving on port 3000');
    expect(killSpy).not.toHaveBeenCalled();
    expect(readFileSync(legacyPidFile, 'utf-8')).toBe(String(TEST_PID));
  });

  it('status points at the pre-0.11 PID file without reading it', async () => {
    const legacyPidFile = writeLegacyPid(TEST_PID);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockProcessExitThrow();
    stubHealthDown();

    await expect(daemon.daemonStatus()).rejects.toThrow('process.exit(0)');

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain(legacyPidFile);
    expect(output).toContain('SAROS_ALLOW_LEGACY_PID=1');
    expect(output).toContain('Daemon is not running.');
    expect(killSpy).not.toHaveBeenCalled();
    expect(readFileSync(legacyPidFile, 'utf-8')).toBe(String(TEST_PID));
  });

  it('removes only the PID file it read, never a live legacy instance', async () => {
    vi.stubEnv('SAROS_ALLOW_LEGACY_PID', '1');
    // Current handle is stale, the legacy one is alive: deleting both (the
    // old deletePid) dropped a live instance's handle.
    mkdirSync(sarosDir, { recursive: true });
    const currentPidFile = join(sarosDir, 'daemon.pid');
    writeFileSync(currentPidFile, '999999', 'utf-8');
    const legacyPidFile = writeLegacyPid(TEST_PID);
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (signal === 0 && pid === 999999) throw errnoError('ESRCH');
      return true;
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockProcessExitThrow();
    stubHealthDown();

    await expect(daemon.daemonStop()).rejects.toThrow('process.exit(0)');

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Daemon process (PID 999999) is not running.');
    expect(existsSync(currentPidFile)).toBe(false);
    expect(readFileSync(legacyPidFile, 'utf-8')).toBe(String(TEST_PID));
  });

  it('stale current handle with the port still serving reports instead of exiting 0', async () => {
    // Cleaning a stale handle is not proof that nothing serves: a live legacy
    // instance (or one started outside the daemon) keeps the port. Exiting 0
    // here made the next `stop` the first honest answer.
    mkdirSync(sarosDir, { recursive: true });
    const currentPidFile = join(sarosDir, 'daemon.pid');
    writeFileSync(currentPidFile, '999999', 'utf-8');
    const legacyPidFile = writeLegacyPid(TEST_PID);
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (signal === 0 && pid === 999999) throw errnoError('ESRCH');
      return true;
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockProcessExitThrow();
    stubHealthOk();

    await expect(daemon.daemonStop()).rejects.toThrow('process.exit(1)');

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Daemon process (PID 999999) is not running.');
    expect(output).toContain(legacyPidFile);
    expect(output).toContain('SAROS_ALLOW_LEGACY_PID=1');
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'still serving on port 3000',
    );
    expect(existsSync(currentPidFile)).toBe(false);
    expect(readFileSync(legacyPidFile, 'utf-8')).toBe(String(TEST_PID));
  });

  it('getDaemonState ignores a live legacy PID without the flag', async () => {
    writeLegacyPid(TEST_PID);
    stubHealthDown();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const state = await daemon.getDaemonState();

    expect(state.pid).toBeNull();
    expect(state.running).toBe(false);
    expect(state.stalePid).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
    expect(existsSync(join(sarosDir, 'daemon.pid'))).toBe(false);
  });

  it('reads, migrates and kills a live legacy PID with SAROS_ALLOW_LEGACY_PID=1', async () => {
    vi.stubEnv('SAROS_ALLOW_LEGACY_PID', '1');
    const legacyPidFile = writeLegacyPid(TEST_PID);
    const state = { alive: true };
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((_pid: number, signal?: string | number) => {
        if (signal === 0) {
          if (!state.alive) throw errnoError('ESRCH');
          return true;
        }
        state.alive = false; // SIGKILL lands
        return true;
      });
    const exitSpy = mockProcessExitRecord();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    stubHealthDown();

    // The explicit opt-in is what makes the legacy PID visible, and reading
    // it moves it into the current state dir.
    const before = await daemon.getDaemonState();
    expect(before.pid).toBe(String(TEST_PID));
    expect(readFileSync(join(sarosDir, 'daemon.pid'), 'utf-8')).toBe(String(TEST_PID));
    expect(existsSync(legacyPidFile)).toBe(false);

    await withPlatform('linux', async () => {
      await daemon.daemonStop();
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(killSpy).toHaveBeenCalledWith(TEST_PID, 'SIGKILL');
    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain(`✓ Proxy (PID ${TEST_PID}) stopped.`);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// ---------------------------------------------------------------------------
// daemonRestart (#104) — the stop is confirmed before a new instance starts
// ---------------------------------------------------------------------------

describe('daemonRestart', () => {
  const TEST_PID = 4242;
  let tempHome: string;
  let daemon: Daemon;

  beforeEach(async () => {
    tempHome = createTempHome();
    mockHomeRef.current = tempHome;
    stubStateDir(tempHome);
    daemon = await importDaemon();
    mockSpawn.mockClear();
  });

  afterEach(() => {
    mockHomeRef.current = '';
    rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    mockSpawn.mockImplementation(() => ({ pid: 12345, unref: vi.fn(), stderr: null }));
  });

  function writeDaemonPid(pid: number): string {
    mkdirSync(sarosDir, { recursive: true });
    const file = join(sarosDir, 'daemon.pid');
    writeFileSync(file, String(pid), 'utf-8');
    return file;
  }

  it('reports the failed stop instead of starting over the busy port', async () => {
    const pidFile = writeDaemonPid(TEST_PID);
    vi.spyOn(process, 'kill').mockImplementation(() => true); // alive; kill accepted
    const exitSpy = mockProcessExitRecord();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubHealthDown();
    vi.useFakeTimers();

    await withPlatform('linux', async () => {
      daemon.daemonRestart();
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      `Failed to stop daemon (PID ${TEST_PID})`,
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    // "Restarting: stopped daemon" used to print before the kill landed.
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('Restarting');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(existsSync(pidFile)).toBe(true);
  });

  it('starts the new instance only once the old one is gone', async () => {
    const pidFile = writeDaemonPid(TEST_PID);
    const state = { alive: true };
    vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
      if (signal === 0) {
        if (!state.alive) throw errnoError('ESRCH');
        return true;
      }
      state.alive = false; // SIGKILL lands
      return true;
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockProcessExitRecord();
    vi.useFakeTimers();
    // daemonStart's first act is this probe: what it sees is the state the
    // restart handed over. daemonStart then refuses (port taken), so it never
    // writes a handle of its own and a surviving file would be the old one.
    let pidFileAtStart: boolean | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        pidFileAtStart = existsSync(pidFile);
        return { ok: true, json: async () => ({ status: 'ok' }) };
      }),
    );

    await withPlatform('linux', async () => {
      daemon.daemonRestart();
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      `Restarting: stopped daemon (PID ${TEST_PID})`,
    );
    expect(pidFileAtStart).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Code-level guard (#104) — a PID path in the real home is never ours
// ---------------------------------------------------------------------------

describe('test-run guard', () => {
  const TEST_PID = 979;
  let fakeHome: string;
  let previousRealHome: unknown;

  beforeEach(() => {
    fakeHome = createTempHome();
    // The shape a suite that re-registered node:os (test/config.test.ts did)
    // and dropped XDG_CONFIG_HOME produces: the real home again.
    mockHomeRef.current = fakeHome;
    vi.stubEnv('XDG_CONFIG_HOME', '');
    vi.stubEnv('LOCALAPPDATA', '');
    previousRealHome = (globalThis as Record<string, unknown>).__SAROS_REAL_HOME__;
    (globalThis as Record<string, unknown>).__SAROS_REAL_HOME__ = fakeHome;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).__SAROS_REAL_HOME__ = previousRealHome;
    mockHomeRef.current = '';
    rmSync(fakeHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses to read or kill a PID file under the real home', async () => {
    const pidFile = join(stateDir(fakeHome), 'daemon.pid');
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, String(TEST_PID), 'utf-8');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockProcessExitThrow();
    stubHealthDown();

    const daemon = await importDaemon();
    const state = await daemon.getDaemonState();

    expect(state.pid).toBeNull();
    expect(state.running).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
    expect(existsSync(pidFile)).toBe(true);
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Refusing to read');

    await expect(daemon.daemonStop()).rejects.toThrow('process.exit(0)');
    expect(killSpy).not.toHaveBeenCalled();
    expect(existsSync(pidFile)).toBe(true);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'No running proxy daemon found',
    );
  });

  it('refuses a state dir reached through a symlink into the real home', async () => {
    const realDir = stateDir(fakeHome);
    mkdirSync(realDir, { recursive: true });
    const pidFile = join(realDir, 'daemon.pid');
    writeFileSync(pidFile, String(TEST_PID), 'utf-8');
    // Same location, different spelling: the symlink's `saros` child IS the
    // real state dir, so the lexical guard waved it through and the decoy died.
    const link = join(fakeHome, 'state-link');
    symlinkSync(dirname(realDir), link, process.platform === 'win32' ? 'junction' : 'dir');
    vi.stubEnv(process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_CONFIG_HOME', link);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockProcessExitThrow();
    stubHealthDown();

    const daemon = await importDaemon();
    const state = await daemon.getDaemonState();

    expect(state.pid).toBeNull();
    expect(killSpy).not.toHaveBeenCalled();
    expect(readFileSync(pidFile, 'utf-8')).toBe(String(TEST_PID));
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Refusing to read');
  });

  it('refuses to create the pid file or daemon.log under the real home', async () => {
    const dir = stateDir(fakeHome);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = mockProcessExitThrow();
    mockSpawn.mockClear();
    stubHealthDown();

    const daemon = await importDaemon();
    // Opening the log used to mkdir the real state dir and create daemon.log
    // there; starting used to spawn a child and write its pid.
    expect(daemon.openDaemonLog()).toBeNull();
    await expect(daemon.daemonStart()).rejects.toThrow('process.exit(1)');

    expect(existsSync(dir)).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Refusing to write');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('throws from the state guard instead of exiting when exitOnComplete is false', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = mockProcessExitThrow();
    mockSpawn.mockClear();

    const daemon = await importDaemon();
    await expect(
      daemon.daemonStart(undefined, undefined, { exitOnComplete: false }),
    ).rejects.toThrow('Refusing to write');

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Refusing to write');
  });
});

// ---------------------------------------------------------------------------
// State directory — pid/log next to config.yaml (#83, defect 5)
// ---------------------------------------------------------------------------

describe('daemon state directory', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = createTempHome();
    mockHomeRef.current = tempHome;
  });

  afterEach(() => {
    mockHomeRef.current = '';
    rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Import daemon.js with a live PID file placed in `dir`; return its state. */
  async function stateWithPidIn(dir: string): Promise<Daemon.DaemonState> {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'daemon.pid'), String(process.pid), 'utf-8');
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    stubHealthDown();
    const daemon = await importDaemon();
    return daemon.getDaemonState();
  }

  it('win32: keeps the PID file under LOCALAPPDATA, next to config.yaml', async () => {
    const localAppData = join(tempHome, 'AppData', 'Local');
    vi.stubEnv('LOCALAPPDATA', localAppData);

    await withPlatform('win32', async () => {
      const state = await stateWithPidIn(join(localAppData, 'saros'));

      expect(state.pid).toBe(String(process.pid));
      expect(state.stalePid).toBe(false);
    });
  });

  it('posix: keeps the PID file under XDG_CONFIG_HOME', async () => {
    const xdg = join(tempHome, 'xdg');
    vi.stubEnv('XDG_CONFIG_HOME', xdg);

    await withPlatform('linux', async () => {
      const state = await stateWithPidIn(join(xdg, 'saros'));

      expect(state.pid).toBe(String(process.pid));
    });
  });

  it('posix: falls back to ~/.config without XDG_CONFIG_HOME', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', '');

    await withPlatform('linux', async () => {
      const state = await stateWithPidIn(join(tempHome, '.config', 'saros'));

      expect(state.pid).toBe(String(process.pid));
    });
  });

  it('win32: reads a legacy ~/.config/saros/daemon.pid and migrates it when opted in', async () => {
    const localAppData = join(tempHome, 'AppData', 'Local');
    vi.stubEnv('LOCALAPPDATA', localAppData);
    vi.stubEnv('SAROS_ALLOW_LEGACY_PID', '1');
    mkdirSync(join(tempHome, '.config', 'saros'), { recursive: true });
    const legacyPidFile = join(tempHome, '.config', 'saros', 'daemon.pid');
    writeFileSync(legacyPidFile, String(process.pid), 'utf-8');
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    stubHealthDown();

    await withPlatform('win32', async () => {
      const daemon = await importDaemon();
      const state = await daemon.getDaemonState();

      expect(state.pid).toBe(String(process.pid));
      expect(state.stalePid).toBe(false);
    });

    const migrated = join(localAppData, 'saros', 'daemon.pid');
    expect(readFileSync(migrated, 'utf-8')).toBe(String(process.pid));
    expect(existsSync(legacyPidFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// daemonStatus
// ---------------------------------------------------------------------------

describe('daemonStatus', () => {
  let tempHome: string;
  let daemon: Daemon;

  beforeEach(async () => {
    tempHome = createTempHome();
    mockHomeRef.current = tempHome;
    stubStateDir(tempHome);
    daemon = await importDaemon();
  });

  afterEach(() => {
    mockHomeRef.current = '';
    rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reports running via the port probe when no PID file exists', async () => {
    stubHealthOk();
    mockProcessExitThrow();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(daemon.daemonStatus()).rejects.toThrow('process.exit(0)');
    const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('Proxy is running on port 3000');
    expect(output).toContain('Enabled harnesses: opencode');
  });

  it('reports not running when nothing answers on the port', async () => {
    stubHealthDown();
    mockProcessExitThrow();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(daemon.daemonStatus()).rejects.toThrow('process.exit(0)');
    const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('Daemon is not running.');
    expect(output).toContain('Enabled harnesses: opencode');
  });

  it('reports running with the PID when the PID file is alive', async () => {
    mkdirSync(sarosDir, { recursive: true });
    writeFileSync(join(sarosDir, 'daemon.pid'), String(process.pid), 'utf-8');
    mockProcessExitThrow();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(daemon.daemonStatus()).rejects.toThrow('process.exit(0)');
    const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain(`Proxy is running (PID ${process.pid}) on port 3000`);
    expect(output).toContain('Enabled harnesses: opencode');
  });

  it('win32: a dead PID is not running and the stale file is removed (#83)', async () => {
    mkdirSync(sarosDir, { recursive: true });
    writeFileSync(join(sarosDir, 'daemon.pid'), '999999', 'utf-8');
    stubHealthDown();
    const exitSpy = mockProcessExitThrow();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('ESRCH');
    });

    await withPlatform('win32', async () => {
      await expect(daemon.daemonStatus()).rejects.toThrow('process.exit(1)');
    });

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Daemon is not running (stale PID cleaned up).');
    expect(output).not.toContain('Proxy is running');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(join(sarosDir, 'daemon.pid'))).toBe(false);
  });

  it('reports running when the PID file is stale but the port still serves', async () => {
    mkdirSync(sarosDir, { recursive: true });
    writeFileSync(join(sarosDir, 'daemon.pid'), '999999999', 'utf-8'); // dead PID
    stubPidDead();
    stubHealthOk();
    mockProcessExitThrow();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(daemon.daemonStatus()).rejects.toThrow('process.exit(0)');
    const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('Proxy is running on port 3000');
    expect(existsSync(join(sarosDir, 'daemon.pid'))).toBe(false); // stale cleaned up
  });

  it('prints the configured harness selection', async () => {
    // Explicit selection instead of the implicit opencode default.
    mkdirSync(sarosDir, { recursive: true });
    writeFileSync(
      join(sarosDir, 'harnesses.json'),
      JSON.stringify({ harnesses: ['omp', 'pi'] }),
      'utf-8',
    );
    stubHealthDown();
    mockProcessExitThrow();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(daemon.daemonStatus()).rejects.toThrow('process.exit(0)');
    const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('Enabled harnesses: omp, pi');
  });

  it('getDaemonState includes the health body when the port probe succeeds', async () => {
    stubHealthOk();
    const state = await daemon.getDaemonState();
    expect(state.running).toBe(true);
    expect(state.pid).toBeNull();
    expect(state.port).toBe(3000);
    expect(state.health?.status).toBe('ok');
  });

  it('getDaemonState probes the explicit port passed by update', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ status: 'ok' }) }));
    vi.stubGlobal('fetch', fetchMock);

    const state = await daemon.getDaemonState({ port: 3100 });

    expect(state.port).toBe(3100);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3100/health',
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// daemonStart
// ---------------------------------------------------------------------------

describe('daemonStart', () => {
  let tempHome: string;
  let daemon: Daemon;

  beforeEach(async () => {
    tempHome = createTempHome();
    mockHomeRef.current = tempHome;
    stubStateDir(tempHome);
    daemon = await importDaemon();
  });

  afterEach(() => {
    mockHomeRef.current = '';
    // Second layer: daemonStart closes daemon.log before it settles, but the OS
    // can still refuse a recursive delete while a just-closed handle is reaped.
    rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
    // restoreAllMocks may reset plain vi.fn()s — re-assert the defaults.
    mockSpawn.mockImplementation(() => ({ pid: 12345, unref: vi.fn(), stderr: null }));
    mockExecFileSync.mockImplementation(() => Buffer.from(''));
  });

  it('refuses to start when the port is already serving', async () => {
    stubHealthOk();
    mockSpawn.mockClear();
    mockProcessExitThrow();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(daemon.daemonStart()).rejects.toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('already in use'));
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('throws instead of exiting when the port is taken and exitOnComplete is false', async () => {
    stubHealthOk();
    mockSpawn.mockClear();
    const exitSpy = mockProcessExitThrow();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      daemon.daemonStart(undefined, undefined, { exitOnComplete: false }),
    ).rejects.toThrow('already in use');

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('already in use'));
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns the entry point passed by the caller', async () => {
    stubHealthDown();
    mockSpawn.mockClear();
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.useFakeTimers();

    await daemon.daemonStart(undefined, undefined, {
      exitOnComplete: false,
      entryPoint: '/opt/global/node_modules/saros-proxy/dist/index.js',
    });

    const [, args] = mockSpawn.mock.calls.at(-1) as unknown as [string, string[]];
    expect(args[0]).toBe('/opt/global/node_modules/saros-proxy/dist/index.js');
    await vi.advanceTimersByTimeAsync(2000);
  });

  it('loads config once and reuses that object for the harness sync', async () => {
    stubHealthDown();
    mockSpawn.mockClear();
    mockLoadConfig.mockClear();
    mockSyncModels.mockClear();
    mockProcessExitRecord();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.useFakeTimers();

    mkdirSync(sarosDir, { recursive: true });
    writeFileSync(
      join(sarosDir, 'config.yaml'),
      'port: 3099\nkeys:\n  - label: test\n    key: sk-boot-test-key-that-is-long-enough-0001\n',
      'utf-8',
    );

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);

    // One load: the port decision and the sync share the same snapshot, so the
    // config warnings (plaintext, legacy encryption) cannot be printed twice.
    expect(mockLoadConfig).toHaveBeenCalledTimes(1);
    expect(mockLoadConfig).toHaveBeenCalledWith(undefined);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('on port 3099'));
    expect(mockSyncModels).toHaveBeenCalledTimes(1);
    expect(mockSyncModels.mock.calls[0][0]).toMatchObject({ port: 3099 });
  });

  it('reports the real failure when the child dies during startup', async () => {
    stubHealthDown();
    stubPidDead();
    mockSpawn.mockClear();
    const exitSpy = mockProcessExitRecord();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockSpawn).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('exited shortly after starting'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(existsSync(join(sarosDir, 'daemon.pid'))).toBe(false);
  });

  it('wires both child streams to daemon.log instead of a stderr pipe', async () => {
    stubHealthDown();
    stubPidDead();
    mockSpawn.mockClear();
    mockProcessExitRecord();
    vi.useFakeTimers();

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);

    const [, , options] = mockSpawn.mock.calls.at(-1) as unknown as [
      string,
      string[],
      { stdio: unknown[] },
    ];
    // stdin discarded; stdout and stderr are the SAME log descriptor. A pipe
    // here would lose its reader when the parent exits (#99) and the child's
    // next stderr write would die with EPIPE.
    expect(options.stdio[0]).toBe('ignore');
    expect(typeof options.stdio[1]).toBe('number');
    expect(options.stdio[2]).toBe(options.stdio[1]);
  });

  it('lands stdout and stderr in daemon.log, in one file', async () => {
    stubHealthDown();
    stubPidDead();
    mockSpawn.mockClear();
    mockProcessExitRecord();
    vi.useFakeTimers();
    const logPath = join(sarosDir, 'daemon.log');
    // The child inherits both descriptors; writing through them here is what
    // pino (stdout) and node's uncaught-exception reporter (stderr) do.
    mockSpawn.mockImplementationOnce((...args: unknown[]) => {
      const { stdio } = args[2] as { stdio: unknown[] };
      writeSync(stdio[1] as number, '{"evt":"boot"}\n');
      writeSync(stdio[2] as number, 'Error: crash on boot\n');
      return { pid: 12345, unref: vi.fn(), stderr: null };
    });

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);

    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('{"evt":"boot"}');
    expect(log).toContain('Error: crash on boot');
  });

  it('keeps a child stderr write after startup verification out of trouble', async () => {
    stubHealthDown(); // probe fails, so the start is attempted
    mockSpawn.mockClear();
    const exitSpy = mockProcessExitRecord();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'kill').mockImplementation(() => true); // child stays alive
    vi.useFakeTimers();
    const logPath = join(sarosDir, 'daemon.log');
    // Emulates the descriptor the child inherits. The parent closes its own
    // copy right after spawn, so this is the only writer left.
    let childStderrFd = -1;
    mockSpawn.mockImplementationOnce(() => {
      childStderrFd = openSync(logPath, 'a', 0o600);
      return { pid: 12345, unref: vi.fn(), stderr: null };
    });

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(60_000); // parent exits after the sync

    const [, , options] = mockSpawn.mock.calls.at(-1) as unknown as [
      string,
      string[],
      { stdio: unknown[] },
    ];
    expect(options.stdio[2]).not.toBe('pipe'); // nothing to lose its reader

    // The parent is gone by now; a late crash trace is a plain file append.
    try {
      expect(() => writeSync(childStderrFd, 'late crash trace\n')).not.toThrow();
      expect(readFileSync(logPath, 'utf-8')).toContain('late crash trace');
    } finally {
      closeSync(childStderrFd);
    }
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('reports EADDRINUSE from the daemon.log tail when the child dies', async () => {
    stubHealthDown();
    stubPidDead();
    mockSpawn.mockClear();
    const exitSpy = mockProcessExitRecord();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const logPath = join(sarosDir, 'daemon.log');
    mockSpawn.mockImplementationOnce(() => {
      appendFileSync(logPath, 'Error: listen EADDRINUSE: address already in use :::3100\n');
      return { pid: 12345, unref: vi.fn(), stderr: null };
    });

    await daemon.daemonStart(3100);
    await vi.advanceTimersByTimeAsync(2000);

    const output = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Port 3100 is already in use');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('reports missing API keys from the daemon.log tail', async () => {
    stubHealthDown();
    stubPidDead();
    mockSpawn.mockClear();
    const exitSpy = mockProcessExitRecord();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const logPath = join(sarosDir, 'daemon.log');
    mockSpawn.mockImplementationOnce(() => {
      appendFileSync(logPath, '✗ No valid API keys configured\n');
      return { pid: 12345, unref: vi.fn(), stderr: null };
    });

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);

    const output = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('No valid API keys found');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('surfaces the crash tail from daemon.log for an unknown boot failure', async () => {
    stubHealthDown();
    stubPidDead();
    mockSpawn.mockClear();
    mockProcessExitRecord();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const logPath = join(sarosDir, 'daemon.log');
    mockSpawn.mockImplementationOnce(() => {
      appendFileSync(logPath, 'Error: Cannot find module \'./dist/index.js\'\n    at boot\n');
      return { pid: 12345, unref: vi.fn(), stderr: null };
    });

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);

    const output = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('exited shortly after starting');
    expect(output).toContain("Cannot find module './dist/index.js'");
  });

  it('ignores failures logged before this boot', async () => {
    stubHealthDown();
    stubPidDead();
    mockSpawn.mockClear();
    mockProcessExitRecord();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    mkdirSync(sarosDir, { recursive: true });
    const logPath = join(sarosDir, 'daemon.log');
    writeFileSync(logPath, 'Error: listen EADDRINUSE: address already in use :::3000\n');

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);

    const output = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).not.toContain('already in use');
    expect(output).toContain('Check your config');
  });

  it('holds no descriptor on daemon.log after the startup verification', async () => {
    if (process.platform !== 'linux') return; // /proc/self/fd only
    stubHealthDown();
    stubPidDead();
    mockSpawn.mockClear();
    mockProcessExitRecord();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const logPath = join(sarosDir, 'daemon.log');

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);

    // A surviving handle lets an async open recreate daemon.log while cleanup
    // walks the directory — the CI ENOTEMPTY.
    expect(openFdsTo(logPath)).toEqual([]);
  });

  it('closes daemon.log on the started branch too', async () => {
    if (process.platform !== 'linux') return; // /proc/self/fd only
    stubHealthDown(); // probe fails, so the start is attempted
    mockSpawn.mockClear();
    const exitSpy = mockProcessExitRecord();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'kill').mockImplementation(() => true); // child stays alive
    vi.useFakeTimers();
    const logPath = join(sarosDir, 'daemon.log');

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);
    // Let the post-verification work (models sync, update check) settle.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(openFdsTo(logPath)).toEqual([]);
  });

  it('seeds models.json on a start when the user has none', async () => {
    stubHealthDown();
    mockSpawn.mockClear();
    mockProcessExitRecord();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'kill').mockImplementation(() => true); // child stays alive
    vi.useFakeTimers();

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);

    const bundled = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'models.json'),
      'utf-8',
    );
    expect(readFileSync(join(sarosDir, 'models.json'), 'utf-8')).toBe(bundled);
    // Let the post-verification work (models sync, update check) settle.
    await vi.advanceTimersByTimeAsync(60_000);
  });

  it('adds the bundle keys an older models.json lacks and keeps the user values', async () => {
    stubHealthDown();
    mockSpawn.mockClear();
    mockProcessExitRecord();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'kill').mockImplementation(() => true); // child stays alive
    vi.useFakeTimers();

    const bundledPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'models.json');
    const bundled = JSON.parse(readFileSync(bundledPath, 'utf-8')) as Record<string, Record<string, unknown>>;
    const bundleKeys = Object.keys(bundled).sort();
    const partial: Record<string, unknown> = {};
    for (const key of bundleKeys.slice(0, 37)) partial[key] = bundled[key];
    partial[bundleKeys[0]] = { ...bundled[bundleKeys[0]], name: 'My Custom Name' };
    mkdirSync(sarosDir, { recursive: true });
    writeFileSync(join(sarosDir, 'models.json'), JSON.stringify(partial, null, 2), 'utf-8');

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);

    const merged = JSON.parse(readFileSync(join(sarosDir, 'models.json'), 'utf-8')) as Record<string, Record<string, unknown>>;
    expect(Object.keys(merged).sort()).toEqual(bundleKeys);
    expect(merged[bundleKeys[0]].name).toBe('My Custom Name');
    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain(`models.json: added ${bundleKeys.length - 37} missing models`);
    // Let the post-verification work (models sync, update check) settle.
    await vi.advanceTimersByTimeAsync(60_000);
  });

  it('keeps a user copy that already covers the bundle', async () => {
    stubHealthDown();
    mockSpawn.mockClear();
    mockProcessExitRecord();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'kill').mockImplementation(() => true); // child stays alive
    vi.useFakeTimers();

    const bundledPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'models.json');
    const bundled = JSON.parse(readFileSync(bundledPath, 'utf-8')) as Record<string, Record<string, unknown>>;
    const firstKey = Object.keys(bundled).sort()[0];
    const userCatalog = {
      ...bundled,
      [firstKey]: { ...bundled[firstKey], name: 'My Custom Name' },
    };
    const userContent = JSON.stringify(userCatalog, null, 2);
    mkdirSync(sarosDir, { recursive: true });
    writeFileSync(join(sarosDir, 'models.json'), userContent, 'utf-8');

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);

    expect(readFileSync(join(sarosDir, 'models.json'), 'utf-8')).toBe(userContent);
    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('models.json already present, keeping the user copy');
    // Let the post-verification work (models sync, update check) settle.
    await vi.advanceTimersByTimeAsync(60_000);
  });

  it('backs up and re-seeds a corrupt models.json', async () => {
    stubHealthDown();
    mockSpawn.mockClear();
    mockProcessExitRecord();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(process, 'kill').mockImplementation(() => true); // child stays alive
    vi.useFakeTimers();
    const modelsPath = join(sarosDir, 'models.json');
    const corrupt = '{ not json';
    mkdirSync(sarosDir, { recursive: true });
    writeFileSync(modelsPath, corrupt, 'utf-8');

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);

    expect(readFileSync(`${modelsPath}.corrupt`, 'utf-8')).toBe(corrupt);
    const bundled = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'models.json'),
      'utf-8',
    );
    expect(readFileSync(modelsPath, 'utf-8')).toBe(bundled);
    const output = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('backed it up');
    // Let the post-verification work (models sync, update check) settle.
    await vi.advanceTimersByTimeAsync(60_000);
  });

  it.each([
    ['cannot be read', 'unreadable'],
    ['is not valid JSON', 'invalid-json'],
  ] as const)('warns and keeps starting when the bundled catalog %s', async (_label, mode) => {
    stubHealthDown();
    mockSpawn.mockClear();
    const exitSpy = mockProcessExitRecord();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'kill').mockImplementation(() => true); // child stays alive
    vi.useFakeTimers();
    mockLoggerWarn.mockClear();
    mockBundleFault.mode = mode;

    try {
      await daemon.daemonStart();
      // The start completes — no unhandled rejection after "✓ Proxy started".
      await expect(vi.advanceTimersByTimeAsync(2000)).resolves.not.toThrow();
    } finally {
      mockBundleFault.mode = 'none';
    }

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('could not read or parse the bundled catalog'),
    );
    // No models.json was seeded from the broken bundle.
    expect(existsSync(join(sarosDir, 'models.json'))).toBe(false);
    // The post-verification work still ran and the CLI exited 0.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('rotates daemon.log at start when it exceeds 10 MB', async () => {
    stubHealthDown();
    stubPidDead();
    mockSpawn.mockClear();
    mockProcessExitRecord();
    vi.useFakeTimers();
    const logPath = join(sarosDir, 'daemon.log');
    mkdirSync(sarosDir, { recursive: true });
    writeFileSync(logPath, Buffer.alloc(11 * 1024 * 1024, 'x'));

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(statSync(`${logPath}.1`).size).toBeGreaterThan(10 * 1024 * 1024);
    expect(statSync(logPath).size).toBeLessThan(1024);
  });

  it('shifts the rotation chain and drops the oldest file', async () => {
    stubHealthDown();
    stubPidDead();
    mockSpawn.mockClear();
    mockProcessExitRecord();
    vi.useFakeTimers();
    mkdirSync(sarosDir, { recursive: true });
    const logPath = join(sarosDir, 'daemon.log');
    writeFileSync(logPath, Buffer.alloc(11 * 1024 * 1024, 'x'));
    for (let i = 1; i <= 5; i++) writeFileSync(`${logPath}.${i}`, `gen-${i}`);

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);

    // .5 dropped, .4→.5, .1→.2, current log→.1
    expect(readFileSync(`${logPath}.2`, 'utf-8')).toBe('gen-1');
    expect(readFileSync(`${logPath}.5`, 'utf-8')).toBe('gen-4');
    expect(existsSync(`${logPath}.6`)).toBe(false);
    expect(statSync(`${logPath}.1`).size).toBeGreaterThan(10 * 1024 * 1024);
  });

  it('tightens an existing world-readable daemon.log to 0600', async () => {
    if (process.platform === 'win32') return; // POSIX modes only
    mkdirSync(sarosDir, { recursive: true });
    const logPath = join(sarosDir, 'daemon.log');
    writeFileSync(logPath, 'old boot\n');
    chmodSync(logPath, 0o644);

    const fd = daemon.openDaemonLog();
    expect(fd).not.toBeNull();
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    closeSync(fd as number);
  });

  it('opens daemon.log, 0600, as the child stdout', async () => {
    if (process.platform !== 'linux') return; // /proc/self/fd is the cheap identity check
    const fd = daemon.openDaemonLog();
    expect(fd).not.toBeNull();
    const target = readlinkSync(`/proc/self/fd/${fd}`);
    expect(target).toBe(join(sarosDir, 'daemon.log'));
    expect(statSync(target).mode & 0o777).toBe(0o600);
    closeSync(fd as number);
  });

  it('leaves a daemon.log under the limit alone', async () => {
    stubHealthDown();
    stubPidDead();
    mockSpawn.mockClear();
    mockProcessExitRecord();
    vi.useFakeTimers();
    const logPath = join(sarosDir, 'daemon.log');
    mkdirSync(sarosDir, { recursive: true });
    writeFileSync(logPath, 'previous boot\n');

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);

    expect(existsSync(`${logPath}.1`)).toBe(false);
    expect(readFileSync(logPath, 'utf-8')).toContain('previous boot');
  });

  it('spawns node with dist/index.js as entry point', async () => {
    stubHealthDown();
    stubPidDead();
    mockSpawn.mockClear();
    const exitSpy = mockProcessExitRecord();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockSpawn).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([expect.stringContaining('dist/index.js'), 'serve']),
      expect.objectContaining({ detached: true }),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Status payload rendering
// ---------------------------------------------------------------------------

describe('daemon status key reporting', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = createTempHome();
    mockHomeRef.current = tempHome;
    stubStateDir(tempHome);
  });

  afterEach(() => {
    mockHomeRef.current = '';
    rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('daemon status explains why a key is out of rotation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          keyCount: 2,
          enabledCount: 1,
          keys: [
            {
              label: 'work',
              provider: 'commandcode',
              enabled: false,
              entitled: true,
              retryAfterMs: 42_000,
              lastError: { status: 401, reason: 'auth' },
            },
            { label: 'home', provider: 'opencode-go', enabled: true, entitled: true },
          ],
        }),
        { status: 200 },
      ),
    );
    mockProcessExitThrow();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const daemon = await importDaemon();

    await expect(daemon.daemonStatus()).rejects.toThrow('process.exit(0)');

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Keys: 1/2 enabled');
    expect(output).toContain('work');
    expect(output).toContain('auth');
    expect(output).toContain('(401)');
    expect(output).toContain('retry in 42s');
  });
});
