/**
 * update-command.test.ts — Tests for `saros-proxy update`.
 *
 * The command is driven through injected dependencies: no test runs npm,
 * systemd or the real daemon. One wiring test mocks node:child_process to
 * prove the default adapters pass `systemctl --user stop/start` and
 * `npm install -g saros-proxy@<latest>`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as ClackPrompts from '@clack/prompts';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// The daemon module owns process.exit paths and the real PID file. Replace it
// with spies so the default adapters can be exercised safely.
const mockDaemonStart = vi.hoisted(() => vi.fn());
const mockDaemonStop = vi.hoisted(() => vi.fn());
const mockGetDaemonState = vi.hoisted(() => vi.fn());
const mockProbeProxyHealth = vi.hoisted(() => vi.fn());

vi.mock('../src/cli/daemon.js', () => ({
  daemonStart: mockDaemonStart,
  daemonStop: mockDaemonStop,
  getDaemonState: mockGetDaemonState,
  probeProxyHealth: mockProbeProxyHealth,
}));

// The default confirmation path uses @clack/prompts; keep every other export
// real so importing the CLI modules still works.
const mockClackConfirm = vi.hoisted(() => vi.fn());
vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof ClackPrompts>();
  return { ...actual, confirm: mockClackConfirm };
});

import {
  chooseRestartMode,
  isGlobalInstall,
  parseUpdateArgs,
  readPackageVersion,
  runUpdateCommand,
  waitForUpdatedProxy,
  type UpdateDependencies,
} from '../src/cli/update.js';
import { isSystemdUnitActive } from '../src/cli/autostart.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ExecCall {
  command: string;
  args: readonly string[];
  inherit: boolean;
}

interface DepOptions extends Partial<UpdateDependencies> {
  failInstall?: boolean;
  /** null makes `npm root -g` fail. */
  globalRoot?: string | null;
  /** Defaults to the latest version; null makes package.json unreadable. */
  installedVersion?: string | null;
  /** Defaults to ok; false makes /health fail. */
  healthOk?: boolean;
  /** null omits the version field; defaults to the latest version. */
  healthVersion?: string | null;
}

interface Harness {
  deps: UpdateDependencies;
  events: string[];
  execs: ExecCall[];
  confirms: string[];
  probes: number[];
}

function makeDeps(options: DepOptions = {}): Harness {
  const events: string[] = [];
  const execs: ExecCall[] = [];
  const confirms: string[] = [];
  const probes: number[] = [];
  const {
    failInstall,
    globalRoot,
    installedVersion,
    healthOk,
    healthVersion,
    ...overrides
  } = options;

  const deps: UpdateDependencies = {
    currentVersion: '1.1.2',
    fetchLatestVersion: async () => '1.1.3',
    exec: (command, args, execOptions) => {
      execs.push({ command, args: [...args], inherit: execOptions?.inherit === true });
      events.push(`exec:${command} ${args.join(' ')}`);
      if (command === 'npm' && args[0] === 'root') {
        if (globalRoot === null) throw new Error('npm was not found on PATH');
        return globalRoot ?? '/usr/lib/node_modules';
      }
      if (command === 'npm' && args[0] === 'install' && failInstall) {
        throw new Error('EACCES: permission denied');
      }
      return '';
    },
    packageRoot: '/usr/lib/node_modules/saros-proxy',
    readInstalledVersion: () =>
      installedVersion === undefined ? '1.1.3' : installedVersion,
    isTTY: true,
    confirm: async (message) => {
      confirms.push(message);
      events.push('confirm');
      return true;
    },
    getDaemonState: async () => {
      events.push('daemon-state');
      return { running: true, port: 3000 };
    },
    daemonStop: async () => {
      events.push('daemon-stop');
      return true;
    },
    daemonStart: async () => {
      events.push('daemon-start');
    },
    systemdActive: () => false,
    systemdStop: () => {
      events.push('systemd-stop');
    },
    systemdStart: () => {
      events.push('systemd-start');
    },
    probeHealth: async (port) => {
      probes.push(port);
      events.push(`probe:${port}`);
      return {
        ok: healthOk ?? true,
        body: {
          status: 'ok',
          ...(healthVersion === null ? {} : { version: healthVersion ?? '1.1.3' }),
        },
      };
    },
    daemonLogPath: '/tmp/saros/daemon.log',
    sleep: async () => {},
    healthAttempts: 2,
    healthDelayMs: 1,
    platform: 'linux',
    ...overrides,
  };

  return { deps, events, execs, confirms, probes };
}

function captureOutput(): { stdout: string[]; stderr: string[]; all: () => string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  return { stdout, stderr, all: () => [...stdout, ...stderr].join('\n') };
}

let tempDir = '';

beforeEach(() => {
  mockExecFileSync.mockReset();
  mockExecFileSync.mockImplementation(() => '');
  mockDaemonStart.mockReset();
  mockDaemonStop.mockReset();
  mockGetDaemonState.mockReset();
  mockProbeProxyHealth.mockReset();
  mockClackConfirm.mockReset();
  tempDir = mkdtempSync(join(tmpdir(), 'saros-update-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (tempDir !== '') rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

describe('parseUpdateArgs', () => {
  it('parses the documented flags', () => {
    expect(parseUpdateArgs(['--check', '--yes', '--force'])).toEqual({
      check: true,
      yes: true,
      force: true,
    });
    expect(parseUpdateArgs([])).toEqual({ check: false, yes: false, force: false });
  });

  it('reports an unknown option instead of ignoring it', () => {
    expect(parseUpdateArgs(['--yolo']).error).toContain('Unknown option: --yolo');
  });
});

describe('chooseRestartMode', () => {
  it('prefers the active systemd unit over the PID-file daemon', () => {
    expect(chooseRestartMode(true, true)).toBe('systemd');
    expect(chooseRestartMode(false, true)).toBe('systemd');
  });

  it('uses the daemon when systemd is inactive, and nothing when both are down', () => {
    expect(chooseRestartMode(true, false)).toBe('daemon');
    expect(chooseRestartMode(false, false)).toBe('none');
  });
});

describe('isGlobalInstall', () => {
  it('accepts only the package inside the npm global prefix', () => {
    expect(
      isGlobalInstall('/usr/lib/node_modules/saros-proxy', '/usr/lib/node_modules', 'linux'),
    ).toBe(true);
    expect(
      isGlobalInstall('/home/user/Projetos/saros-proxy', '/usr/lib/node_modules', 'linux'),
    ).toBe(false);
    expect(isGlobalInstall('', '/usr/lib/node_modules', 'linux')).toBe(false);
    expect(isGlobalInstall('/usr/lib/node_modules/saros-proxy', '', 'linux')).toBe(false);
  });

  it('compares Windows paths case-insensitively', () => {
    expect(
      isGlobalInstall(
        '/USR/LIB/node_modules/saros-proxy',
        '/usr/lib/node_modules',
        'win32',
      ),
    ).toBe(true);
  });

  it('accepts the global root child and rejects another package tree', () => {
    const globalRoot = join(tempDir, 'node_modules');
    const other = join(tempDir, 'store', 'saros-proxy');
    mkdirSync(other, { recursive: true });
    mkdirSync(join(globalRoot, 'saros-proxy'), { recursive: true });
    expect(isGlobalInstall(other, globalRoot, 'linux')).toBe(false);
    expect(
      isGlobalInstall(join(globalRoot, 'saros-proxy'), globalRoot, 'linux'),
    ).toBe(true);
  });
});

describe('readPackageVersion', () => {
  it('reads the version field and treats unreadable packages as null', () => {
    const root = join(tempDir, 'pkg');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    expect(readPackageVersion(root)).toBe('9.9.9');

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'no-version' }));
    expect(readPackageVersion(root)).toBeNull();

    writeFileSync(join(root, 'package.json'), '{not json');
    expect(readPackageVersion(root)).toBeNull();

    expect(readPackageVersion(join(tempDir, 'missing'))).toBeNull();
  });
});

describe('waitForUpdatedProxy', () => {
  it('keeps polling until /health reports the installed version', async () => {
    const responses = [
      { ok: true, body: { version: '1.1.2' } },
      { ok: false },
      { ok: true, body: { version: '1.1.3' } },
    ];
    const probe = vi.fn(async () => responses.shift() ?? { ok: false });
    const sleep = vi.fn(async () => {});

    const result = await waitForUpdatedProxy(probe, '1.1.3', 5, 10, sleep);

    expect(result.body?.version).toBe('1.1.3');
    expect(probe).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('returns the last answer when the version never matches', async () => {
    const probe = vi.fn(async () => ({ ok: true, body: { version: '1.1.2' } }));
    const result = await waitForUpdatedProxy(probe, '1.1.3', 2, 0, async () => {});
    expect(result.body?.version).toBe('1.1.2');
  });
});

// ---------------------------------------------------------------------------
// Command behavior
// ---------------------------------------------------------------------------

describe('runUpdateCommand', () => {
  it('exits 0 without touching anything when already up to date', async () => {
    const harness = makeDeps({ fetchLatestVersion: async () => '1.1.2' });
    const out = captureOutput();

    expect(await runUpdateCommand([], harness.deps)).toBe(0);

    expect(harness.execs).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(out.all()).toContain('Already on 1.1.2');
  });

  it('--check reports both versions and exits 1 only when an update exists', async () => {
    const outdated = makeDeps();
    const out = captureOutput();

    expect(await runUpdateCommand(['--check'], outdated.deps)).toBe(1);
    expect(out.all()).toContain('installed 1.1.2 / latest 1.1.3');
    expect(outdated.execs).toEqual([]);
    expect(outdated.events).toEqual([]);

    const updated = makeDeps({ fetchLatestVersion: async () => '1.1.2' });
    expect(await runUpdateCommand(['--check'], updated.deps)).toBe(0);
    expect(updated.execs).toEqual([]);
  });

  it('--check exits 0 when the local build is ahead of npm', async () => {
    const harness = makeDeps({ fetchLatestVersion: async () => '1.1.1' });
    captureOutput();
    expect(await runUpdateCommand(['--check'], harness.deps)).toBe(0);
  });

  it('prints the transition, confirms, stops, installs, starts and verifies', async () => {
    const harness = makeDeps();
    const out = captureOutput();

    expect(await runUpdateCommand([], harness.deps)).toBe(0);

    expect(harness.confirms).toHaveLength(1);
    expect(harness.confirms[0]).toContain('1.1.2 → 1.1.3');
    expect(out.all()).toContain('Updating saros-proxy: 1.1.2 → 1.1.3');
    expect(harness.execs.map((call) => `${call.command} ${call.args.join(' ')}`)).toEqual([
      'npm root -g',
      'npm install -g saros-proxy@1.1.3',
    ]);
    expect(harness.execs[1].inherit).toBe(true);

    const stop = harness.events.indexOf('daemon-stop');
    const install = harness.events.indexOf('exec:npm install -g saros-proxy@1.1.3');
    const start = harness.events.indexOf('daemon-start');
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(install);
    expect(install).toBeLessThan(start);
    expect(harness.probes).toEqual([3000]);
    expect(out.all()).toContain('✓ Updated to 1.1.3 and restarted the proxy on port 3000.');
  });

  it('restarts the previous version when npm install fails', async () => {
    const harness = makeDeps({
      failInstall: true,
      readInstalledVersion: () => '1.1.3',
      probeHealth: async () => ({ ok: true, body: { status: 'ok', version: '1.1.2' } }),
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.events).toContain('daemon-start');
    expect(harness.events).toContain('daemon-stop');
    expect(out.all()).toContain('npm install -g saros-proxy@1.1.3 failed');
    expect(out.all()).toContain('Restarted saros-proxy 1.1.2 (the previous install).');
  });

  it('refuses a non-global checkout without --force, and updates with it', async () => {
    const checkout = makeDeps({ packageRoot: '/home/user/Projetos/saros-proxy' });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], checkout.deps)).toBe(1);
    expect(checkout.execs.map((call) => call.args.join(' '))).toEqual(['root -g']);
    expect(checkout.events).toEqual(['exec:npm root -g']);
    expect(out.all()).toContain('not a global npm package');

    const forced = makeDeps({ packageRoot: '/home/user/Projetos/saros-proxy' });
    const forcedOut = captureOutput();
    expect(await runUpdateCommand(['--yes', '--force'], forced.deps)).toBe(0);
    expect(forced.execs.map((call) => call.args.join(' '))).toEqual([
      'root -g',
      'install -g saros-proxy@1.1.3',
    ]);
    expect(forcedOut.all()).toContain('Updated to 1.1.3');
  });

  it('refuses when the npm global prefix cannot be determined, unless forced', async () => {
    const harness = makeDeps({ globalRoot: null });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);
    expect(out.all()).toContain('Could not determine the npm global prefix');
    expect(harness.execs).toHaveLength(1);
    expect(harness.execs[0].args).toEqual(['root', '-g']);
  });

  it('does not start anything when the daemon was stopped', async () => {
    const harness = makeDeps({
      getDaemonState: async () => ({ running: false, port: 3000 }),
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(0);

    expect(harness.events).toContain('exec:npm install -g saros-proxy@1.1.3');
    expect(harness.events).not.toContain('daemon-start');
    expect(harness.events).not.toContain('systemd-start');
    expect(out.all()).toContain('The daemon was not running, so it was left stopped.');
  });

  it('uses systemctl stop/start for an active systemd unit', async () => {
    const harness = makeDeps({ systemdActive: () => true });
    captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(0);

    expect(harness.events).toContain('systemd-stop');
    expect(harness.events).toContain('systemd-start');
    expect(harness.events).not.toContain('daemon-stop');
    expect(harness.events).not.toContain('daemon-start');

    const stop = harness.events.indexOf('systemd-stop');
    const install = harness.events.indexOf('exec:npm install -g saros-proxy@1.1.3');
    const start = harness.events.indexOf('systemd-start');
    expect(stop).toBeLessThan(install);
    expect(install).toBeLessThan(start);
  });

  it('refuses without a TTY and without --yes, before any exec', async () => {
    const harness = makeDeps({ isTTY: false });
    const out = captureOutput();

    expect(await runUpdateCommand([], harness.deps)).toBe(1);

    expect(harness.execs).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(harness.confirms).toEqual([]);
    expect(out.all()).toContain('Refusing to update without a TTY');
  });

  it('rejects an unknown option before resolving anything', async () => {
    const harness = makeDeps();
    const out = captureOutput();

    expect(await runUpdateCommand(['--yolo'], harness.deps)).toBe(1);

    expect(harness.execs).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(out.all()).toContain('Unknown option: --yolo');
  });

  it('reports a systemd stop failure instead of installing over a live service', async () => {
    const harness = makeDeps({
      systemdActive: () => true,
      systemdStop: () => {
        throw new Error('Failed to connect to bus');
      },
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.execs.map((call) => call.args.join(' '))).toEqual(['root -g']);
    expect(out.all()).toContain('Could not stop the running proxy: Failed to connect to bus');
  });

  it('rolls back without starting when the daemon was stopped', async () => {
    const harness = makeDeps({
      failInstall: true,
      getDaemonState: async () => ({ running: false, port: 3000 }),
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.events).not.toContain('daemon-start');
    expect(out.all()).toContain('The daemon was not running before the update');
  });

  it('asks for confirmation through the default prompt when none is injected', async () => {
    mockClackConfirm.mockResolvedValueOnce(true);
    const harness = makeDeps();
    delete (harness.deps as Partial<UpdateDependencies>).confirm;
    captureOutput();

    expect(await runUpdateCommand([], harness.deps)).toBe(0);
    expect(mockClackConfirm).toHaveBeenCalledWith({
      message: expect.stringContaining('1.1.2 → 1.1.3'),
    });

    mockClackConfirm.mockResolvedValueOnce(undefined);
    const declined = makeDeps();
    delete (declined.deps as Partial<UpdateDependencies>).confirm;
    const out = captureOutput();
    expect(await runUpdateCommand([], declined.deps)).toBe(1);
    expect(out.all()).toContain('Update cancelled.');
  });

  it('reports a registry failure and exits 1 without side effects', async () => {
    const harness = makeDeps({
      fetchLatestVersion: async () => {
        throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
      },
    });
    const out = captureOutput();

    expect(await runUpdateCommand([], harness.deps)).toBe(1);

    expect(harness.execs).toEqual([]);
    expect(out.all()).toContain('Could not reach the npm registry');
    expect(out.all()).toContain('ENOTFOUND');
  });

  it('warns and exits 0 for a local build ahead of npm, unless forced', async () => {
    const harness = makeDeps({ fetchLatestVersion: async () => '1.1.1' });
    const out = captureOutput();

    expect(await runUpdateCommand([], harness.deps)).toBe(0);
    expect(harness.execs).toEqual([]);
    expect(out.all()).toContain('newer than the npm latest 1.1.1');
  });

  it('stops when the confirmation is declined', async () => {
    const harness = makeDeps({ confirm: async () => false });
    const out = captureOutput();

    expect(await runUpdateCommand([], harness.deps)).toBe(1);

    expect(harness.events).toEqual(['exec:npm root -g']);
    expect(harness.execs.map((call) => call.args.join(' '))).toEqual(['root -g']);
    expect(out.all()).toContain('Update cancelled.');
  });

  it('aborts before install when the daemon cannot be stopped', async () => {
    const harness = makeDeps({ daemonStop: async () => false });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.events).not.toContain('daemon-start');
    expect(harness.execs.map((call) => call.args.join(' '))).toEqual(['root -g']);
    expect(out.all()).toContain('Could not stop the running proxy');
  });

  it('reports a health failure with the daemon log and status hint', async () => {
    const harness = makeDeps({ healthOk: false, healthAttempts: 3 });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.probes).toHaveLength(3);
    expect(out.all()).toContain('did not answer /health');
    expect(out.all()).toContain('/tmp/saros/daemon.log');
    expect(out.all()).toContain('saros-proxy status');
  });

  it('rejects a still-running old version reported by /health', async () => {
    const harness = makeDeps({ healthVersion: '1.1.2' });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);
    expect(out.all()).toContain('reports version 1.1.2');
  });

  it('rejects an install whose global package.json still reports the old version', async () => {
    const harness = makeDeps({ installedVersion: '1.1.2' });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);
    expect(out.all()).toContain('The global package reports 1.1.2, expected 1.1.3.');
  });

  it('reports a start failure instead of claiming success', async () => {
    const harness = makeDeps({
      daemonStart: async () => {
        throw new Error('EADDRINUSE');
      },
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);
    expect(out.all()).toContain('failed to start: EADDRINUSE');
    expect(out.all()).toContain('/tmp/saros/daemon.log');
  });

  it('reports a rollback that could not start the previous version', async () => {
    const harness = makeDeps({
      failInstall: true,
      daemonStart: async () => {
        throw new Error('permission denied');
      },
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);
    expect(out.all()).toContain('Could not restart saros-proxy 1.1.2');
    expect(out.all()).toContain('permission denied');
  });
});

// ---------------------------------------------------------------------------
// Default wiring
// ---------------------------------------------------------------------------

describe('default dependency wiring', () => {
  it('updates through npm and systemctl --user without injected adapters', async () => {
    const execCalls: string[][] = [];
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      execCalls.push([command, ...args]);
      if (command === 'npm' && args[0] === 'root') {
        return '/usr/lib/node_modules\n';
      }
      if (command === 'systemctl' && args[1] === 'is-active') {
        return 'active\n';
      }
      return '';
    });
    mockGetDaemonState.mockResolvedValue({ running: true, port: 3000 });
    mockProbeProxyHealth.mockResolvedValue({
      ok: true,
      body: { status: 'ok', version: '1.1.3' },
    });
    const out = captureOutput();

    const code = await runUpdateCommand(['--yes'], {
      currentVersion: '1.1.2',
      fetchLatestVersion: async () => '1.1.3',
      isTTY: true,
      confirm: async () => true,
      readInstalledVersion: () => '1.1.3',
      packageRoot: '/usr/lib/node_modules/saros-proxy',
      daemonLogPath: '/tmp/saros/daemon.log',
      sleep: async () => {},
      healthAttempts: 2,
      healthDelayMs: 1,
      platform: 'linux',
    });

    expect(code).toBe(0);
    expect(execCalls).toEqual([
      ['npm', 'root', '-g'],
      ['systemctl', '--user', 'is-active', 'saros-proxy.service'],
      ['systemctl', '--user', 'stop', 'saros-proxy.service'],
      ['npm', 'install', '-g', 'saros-proxy@1.1.3'],
      ['systemctl', '--user', 'start', 'saros-proxy.service'],
    ]);
    expect(mockDaemonStop).not.toHaveBeenCalled();
    expect(mockDaemonStart).not.toHaveBeenCalled();
    expect(mockProbeProxyHealth).toHaveBeenCalledWith(3000);
    expect(out.all()).toContain('Updated to 1.1.3');
  });

  it('uses the default daemon adapters for a PID-file install', async () => {
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'npm' && args[0] === 'root') return '/usr/lib/node_modules\n';
      if (command === 'systemctl' && args[1] === 'is-active') return 'inactive\n';
      return '';
    });
    mockGetDaemonState.mockResolvedValue({ running: true, port: 3100 });
    mockDaemonStop.mockResolvedValue(true);
    mockDaemonStart.mockResolvedValue(undefined);
    mockProbeProxyHealth.mockResolvedValue({
      ok: true,
      body: { status: 'ok', version: '1.1.3' },
    });
    captureOutput();

    const code = await runUpdateCommand(['--yes'], {
      currentVersion: '1.1.2',
      fetchLatestVersion: async () => '1.1.3',
      readInstalledVersion: () => '1.1.3',
      packageRoot: '/usr/lib/node_modules/saros-proxy',
      sleep: async () => {},
      healthAttempts: 2,
      healthDelayMs: 1,
      platform: 'linux',
    });

    expect(code).toBe(0);
    expect(mockDaemonStop).toHaveBeenCalledWith({ exitOnComplete: false });
    expect(mockDaemonStart).toHaveBeenCalledWith(undefined, undefined, {
      exitOnComplete: false,
    });
    expect(mockProbeProxyHealth).toHaveBeenCalledWith(3100);
  });

  it('uses the real registry fetch and package-root defaults for --check', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ version: '1.1.2' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    captureOutput();

    const code = await runUpdateCommand(['--check'], {
      currentVersion: '1.1.2',
    });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://registry.npmjs.org/saros-proxy/latest',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('detects an inactive systemd unit as the daemon path', () => {
    mockExecFileSync.mockReturnValue('inactive\n');
    expect(isSystemdUnitActive()).toBe(false);
    mockExecFileSync.mockReturnValue('active\n');
    expect(isSystemdUnitActive()).toBe(true);
  });
});
