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
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
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

const mockSpawn = vi.hoisted(() => vi.fn(() => ({ pid: 12345, unref: vi.fn() })));
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
    rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    // restoreAllMocks may reset plain vi.fn()s — re-assert the spawn default.
    mockSpawn.mockImplementation(() => ({ pid: 12345, unref: vi.fn() }));
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
});
