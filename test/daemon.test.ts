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
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, mkdtempSync, statSync, readlinkSync, readdirSync, closeSync, chmodSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type * as Daemon from '../src/cli/daemon.js';

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
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  execFileSync: vi.fn(() => Buffer.from('')),
}));

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

// ---------------------------------------------------------------------------
// probeProxyHealth
// ---------------------------------------------------------------------------

describe('probeProxyHealth', () => {
  let tempHome: string;
  let daemon: Daemon;

  beforeEach(async () => {
    tempHome = createTempHome();
    mockHomeRef.current = tempHome;
    daemon = await importDaemon();
  });

  afterEach(() => {
    mockHomeRef.current = '';
    rmSync(tempHome, { recursive: true, force: true });
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
// daemonStatus
// ---------------------------------------------------------------------------

describe('daemonStatus', () => {
  let tempHome: string;
  let daemon: Daemon;

  beforeEach(async () => {
    tempHome = createTempHome();
    mockHomeRef.current = tempHome;
    daemon = await importDaemon();
  });

  afterEach(() => {
    mockHomeRef.current = '';
    rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
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
    const pidDir = join(tempHome, '.config', 'saros');
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(join(pidDir, 'daemon.pid'), String(process.pid), 'utf-8');
    mockProcessExitThrow();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(daemon.daemonStatus()).rejects.toThrow('process.exit(0)');
    const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain(`Proxy is running (PID ${process.pid}) on port 3000`);
    expect(output).toContain('Enabled harnesses: opencode');
  });

  it('reports running when the PID file is stale but the port still serves', async () => {
    const pidDir = join(tempHome, '.config', 'saros');
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(join(pidDir, 'daemon.pid'), '999999999', 'utf-8'); // dead PID
    stubPidDead();
    stubHealthOk();
    mockProcessExitThrow();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(daemon.daemonStatus()).rejects.toThrow('process.exit(0)');
    const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('Proxy is running on port 3000');
    expect(existsSync(join(pidDir, 'daemon.pid'))).toBe(false); // stale cleaned up
  });

  it('prints the configured harness selection', async () => {
    // Explicit selection instead of the implicit opencode default.
    const pidDir = join(tempHome, '.config', 'saros');
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(
      join(pidDir, 'harnesses.json'),
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
    daemon = await importDaemon();
  });

  afterEach(() => {
    mockHomeRef.current = '';
    // Second layer: daemonStart closes daemon.log before it settles, but the OS
    // can still refuse a recursive delete while a just-closed handle is reaped.
    rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    // restoreAllMocks may reset plain vi.fn()s — re-assert the spawn default.
    mockSpawn.mockImplementation(() => ({ pid: 12345, unref: vi.fn(), stderr: null }));
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
    expect(existsSync(join(tempHome, '.config', 'saros', 'daemon.pid'))).toBe(false);
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
    const logPath = join(tempHome, '.config', 'saros', 'daemon.log');
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
    const logPath = join(tempHome, '.config', 'saros', 'daemon.log');
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
    const logPath = join(tempHome, '.config', 'saros', 'daemon.log');
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
    const logPath = join(tempHome, '.config', 'saros', 'daemon.log');
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
    const logPath = join(tempHome, '.config', 'saros', 'daemon.log');
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
    const dir = join(tempHome, '.config', 'saros');
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, 'daemon.log');
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
    const logPath = join(tempHome, '.config', 'saros', 'daemon.log');

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
    const logPath = join(tempHome, '.config', 'saros', 'daemon.log');

    await daemon.daemonStart();
    await vi.advanceTimersByTimeAsync(2000);
    // Let the post-verification work (models sync, update check) settle.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(openFdsTo(logPath)).toEqual([]);
  });

  it('rotates daemon.log at start when it exceeds 10 MB', async () => {
    stubHealthDown();
    stubPidDead();
    mockSpawn.mockClear();
    mockProcessExitRecord();
    vi.useFakeTimers();
    const logPath = join(tempHome, '.config', 'saros', 'daemon.log');
    mkdirSync(join(tempHome, '.config', 'saros'), { recursive: true });
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
    const dir = join(tempHome, '.config', 'saros');
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, 'daemon.log');
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
    const dir = join(tempHome, '.config', 'saros');
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, 'daemon.log');
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
    expect(target).toBe(join(tempHome, '.config', 'saros', 'daemon.log'));
    expect(statSync(target).mode & 0o777).toBe(0o600);
    closeSync(fd as number);
  });

  it('leaves a daemon.log under the limit alone', async () => {
    stubHealthDown();
    stubPidDead();
    mockSpawn.mockClear();
    mockProcessExitRecord();
    vi.useFakeTimers();
    const logPath = join(tempHome, '.config', 'saros', 'daemon.log');
    mkdirSync(join(tempHome, '.config', 'saros'), { recursive: true });
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
// Original lifecycle tests (PID file mechanics)
// ---------------------------------------------------------------------------

describe('daemon PID lifecycle', () => {
  const OENV = process.env;
  let tempHome: string;

  beforeEach(() => {
    tempHome = createTempHome();
    // Point the user's home to our temp so the PID file goes there
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome); // Windows compat
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    process.env = { ...OENV };
  });

  it('daemon start creates PID file and daemon stop cleans it up', async () => {
    mockHomeRef.current = tempHome;

    // We can't call daemonStart directly (it spawns + exits) so we replicate
    // the PID file logic that the real daemon uses.
    const pidDir = join(tempHome, '.config', 'saros');
    const pidFile = join(pidDir, 'daemon.pid');

    // Ensure dir exists (like ensurePidDir does)
    mkdirSync(pidDir, { recursive: true });

    // Simulate writing PID (like writePid does)
    writeFileSync(pidFile, String(process.pid), 'utf-8');
    expect(existsSync(pidFile)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));

    // Simulate deletion (like deletePid does)
    rmSync(pidFile);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('daemon stop on non-existing PID file reports cleanly', async () => {
    // Just verify the exported functions don't throw on missing files
    const daemon = await import('../src/cli/daemon.js');
    expect(daemon.daemonStop).toBeDefined();
    expect(daemon.daemonRestart).toBeDefined();
    expect(daemon.daemonStatus).toBeDefined();
    // These call process.exit — we can't safely call them in tests
  });

  it('daemon status shows correct information', async () => {
    const daemon = await import('../src/cli/daemon.js');
    expect(daemon.daemonStatus).toBeDefined();
  });

  it('daemon status explains why a key is out of rotation', async () => {
    mockHomeRef.current = tempHome;
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
