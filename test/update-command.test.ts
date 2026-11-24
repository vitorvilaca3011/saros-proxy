/**
 * update-command.test.ts — Tests for `saros-proxy update`.
 *
 * The command is driven through injected dependencies: no test runs npm,
 * pnpm, yarn, systemd or the real daemon. Wiring tests mock
 * node:child_process to prove the default adapters pass `systemctl --user
 * stop/start`, the manager-specific global install, and `shell: true` for
 * the Windows shims.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
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

// Windows reports some junctions as plain directories. Keep every fs function
// real except lstat, so one test can force that misreport.
const mockLstatSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  mockLstatSync.mockImplementation((...args: unknown[]) =>
    (actual.lstatSync as (...a: unknown[]) => unknown)(...args),
  );
  return { ...actual, lstatSync: mockLstatSync };
});

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
  detectGlobalInstall,
  isGlobalInstall,
  parseUpdateArgs,
  readPackageVersion,
  runUpdateCommand,
  waitForUpdatedProxy,
  type UpdateDependencies,
} from '../src/cli/update.js';
import { isSystemdUnitActive } from '../src/cli/autostart.js';
import { logger } from '../src/logger.js';

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
  failReinstall?: boolean;
  /** null makes `npm root -g` fail. */
  globalRoot?: string | null;
  /** Root that `pnpm root -g` reports; null makes pnpm absent. */
  pnpmRoot?: string | null;
  /** Directory that `yarn global dir` reports; null makes yarn absent. */
  yarnGlobalDir?: string | null;
  /** Defaults to the latest version; null makes package.json unreadable. */
  installedVersion?: string | null;
  /** Defaults to ok; false makes /health fail. */
  healthOk?: boolean;
  /** null omits the version field; defaults to the latest version. */
  healthVersion?: string | null;
  daemonRunning?: boolean;
  /** null omits the health body; defaults to the current package version. */
  daemonHealthVersion?: string | null;
  daemonPid?: string | null;
  daemonPort?: number;
  /** State dir the snapshot names; defaults to /home/u/.config/saros. */
  daemonPidDir?: string;
  /** Pre-0.11 PID file the snapshot reports; defaults to null. */
  legacyPidFile?: string | null;
}

interface Harness {
  deps: UpdateDependencies;
  events: string[];
  execs: ExecCall[];
  confirms: string[];
  probes: number[];
  stopOptions: Array<Record<string, unknown>>;
  startOptions: Array<Record<string, unknown>>;
  /** Entry points passed to the systemd repair adapter. */
  refreshes: string[];
  /** Entry points passed to the systemd start adapter. */
  systemdStarts: Array<string | undefined>;
  /** Ports passed to findPortOwner. */
  ownerLookups: number[];
  /** PIDs passed to killPortOwner. */
  killedPids: number[];
}

function makeDeps(options: DepOptions = {}): Harness {
  const events: string[] = [];
  const execs: ExecCall[] = [];
  const confirms: string[] = [];
  const probes: number[] = [];
  const stopOptions: Array<Record<string, unknown>> = [];
  const startOptions: Array<Record<string, unknown>> = [];
  const refreshes: string[] = [];
  const systemdStarts: Array<string | undefined> = [];
  const ownerLookups: number[] = [];
  const killedPids: number[] = [];
  const {
    failInstall,
    failReinstall,
    globalRoot,
    pnpmRoot,
    yarnGlobalDir,
    installedVersion,
    healthOk,
    healthVersion,
    daemonRunning,
    daemonHealthVersion,
    daemonPid,
    daemonPort,
    daemonPidDir,
    legacyPidFile,
    ...overrides
  } = options;
  const currentVersion = overrides.currentVersion ?? '1.1.2';
  const running = daemonRunning ?? true;

  const deps: UpdateDependencies = {
    currentVersion,
    fetchLatestVersion: async () => '1.1.3',
    exec: (command, args, execOptions) => {
      execs.push({ command, args: [...args], inherit: execOptions?.inherit === true });
      events.push(`exec:${command} ${args.join(' ')}`);
      if (command === 'npm' && args[0] === 'root') {
        if (globalRoot === null) throw new Error('npm was not found on PATH');
        return globalRoot ?? '/usr/lib/node_modules';
      }
      if (command === 'pnpm' && args[0] === 'root') {
        if (pnpmRoot === null) throw new Error('pnpm was not found on PATH');
        return pnpmRoot ?? '';
      }
      if (command === 'yarn' && args[0] === 'global' && args[1] === 'dir') {
        if (yarnGlobalDir === null) throw new Error('yarn was not found on PATH');
        return yarnGlobalDir ?? '';
      }
      const installTarget =
        command === 'npm' && args[0] === 'install'
          ? args[2]
          : command === 'pnpm' && args[0] === 'add'
            ? args[2]
            : command === 'yarn' && args[0] === 'global' && args[1] === 'add'
              ? args[2]
              : undefined;
      if (installTarget !== undefined) {
        const reinstalling = installTarget.endsWith(`@${currentVersion}`);
        if (failInstall && !reinstalling) {
          throw new Error('EACCES: permission denied');
        }
        if (failReinstall && reinstalling) {
          throw new Error('E404: the previous version is unavailable');
        }
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
      return {
        running,
        port: daemonPort ?? 3000,
        pid: daemonPid === undefined ? (running ? '4242' : null) : daemonPid,
        health:
          running && daemonHealthVersion !== null
            ? { status: 'ok', version: daemonHealthVersion ?? currentVersion }
            : undefined,
        pidDir: daemonPidDir ?? '/home/u/.config/saros',
        legacyPidFile: legacyPidFile ?? null,
      };
    },
    daemonStop: async (callOptions) => {
      stopOptions.push({ ...callOptions });
      events.push('daemon-stop');
      return true;
    },
    daemonStart: async (callOptions) => {
      startOptions.push({ ...callOptions });
      events.push('daemon-start');
    },
    // A listener exists but a managed daemon owns the port in most fixtures;
    // the unmanaged-listener tests replace these two adapters.
    findPortOwner: (port) => {
      ownerLookups.push(port);
      return { pid: 999, command: 'node /srv/orphan.js serve', starttime: '123456' };
    },
    killPortOwner: (pid) => {
      killedPids.push(pid);
    },
    systemdActive: () => false,
    systemdStop: () => {
      events.push('systemd-stop');
    },
    systemdStart: (entryPoint) => {
      systemdStarts.push(entryPoint);
      events.push('systemd-start');
    },
    refreshSystemdUnit: (entryPoint) => {
      refreshes.push(entryPoint);
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

  return {
    deps,
    events,
    execs,
    confirms,
    probes,
    stopOptions,
    startOptions,
    refreshes,
    systemdStarts,
    ownerLookups,
    killedPids,
  };
}

/** A real on-disk global install, so entry-point checks see a file. */
function makeGlobalInstall(): {
  globalRoot: string;
  packageRoot: string;
  entryPoint: string;
} {
  const globalRoot = join(tempDir, 'node_modules');
  const packageRoot = join(globalRoot, 'saros-proxy');
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  writeFileSync(join(packageRoot, 'dist', 'index.js'), '');
  return {
    globalRoot,
    packageRoot,
    entryPoint: join(packageRoot, 'dist', 'index.js'),
  };
}

/**
 * A pnpm global layout: `root/saros-proxy` is a symlink into the
 * content-addressed store, and the running package lives at the real path.
 */
function makePnpmInstall(): {
  pnpmRoot: string;
  packageRoot: string;
  entryPoint: string;
} {
  const pnpmHome = join(tempDir, 'pnpm');
  const pnpmRoot = join(pnpmHome, 'global', '5', 'node_modules');
  const packageRoot = join(
    pnpmHome,
    'global',
    '5',
    '.pnpm',
    'saros-proxy@1.3.4',
    'node_modules',
    'saros-proxy',
  );
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  writeFileSync(join(packageRoot, 'dist', 'index.js'), '');
  mkdirSync(pnpmRoot, { recursive: true });
  symlinkSync(packageRoot, join(pnpmRoot, 'saros-proxy'), symlinkType());
  return {
    pnpmRoot,
    packageRoot,
    entryPoint: join(pnpmRoot, 'saros-proxy', 'dist', 'index.js'),
  };
}

/** A yarn 1 global layout: `<dir>/node_modules/saros-proxy` is a real dir. */
function makeYarnInstall(): {
  yarnDir: string;
  packageRoot: string;
  entryPoint: string;
} {
  const yarnDir = join(tempDir, 'yarn-global');
  const packageRoot = join(yarnDir, 'node_modules', 'saros-proxy');
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  writeFileSync(join(packageRoot, 'dist', 'index.js'), '');
  return {
    yarnDir,
    packageRoot,
    entryPoint: join(packageRoot, 'dist', 'index.js'),
  };
}

function symlinkType(): 'junction' | 'dir' {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

/**
 * Write a systemd unit whose ExecStart points into a versioned pnpm store and
 * point XDG_CONFIG_HOME at it. Returns the unit path and the stale entry.
 */
function makeVersionedUnit(portArg = ''): { unitPath: string; oldEntry: string } {
  const xdgHome = join(tempDir, 'xdg');
  const unitDir = join(xdgHome, 'systemd', 'user');
  const unitPath = join(unitDir, 'saros-proxy.service');
  const oldEntry = join(
    tempDir,
    'pnpm',
    'global',
    '5',
    '.pnpm',
    'saros-proxy@1.3.3',
    'node_modules',
    'saros-proxy',
    'dist',
    'index.js',
  );
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(
    unitPath,
    `[Service]\nExecStart="${process.execPath}" "${oldEntry}" serve${portArg}\n`,
    'utf-8',
  );
  vi.stubEnv('XDG_CONFIG_HOME', xdgHome);
  return { unitPath, oldEntry };
}

function formatExec(call: ExecCall): string {
  return `${call.command} ${call.args.join(' ')}`;
}

/** Discovery stand-in: each manager answers its root, throws when absent. */
function discoveryExec(
  roots: { npm?: string | null; pnpm?: string | null; yarn?: string | null },
  calls: string[] = [],
): (command: string, args: readonly string[]) => string {
  return (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    const value =
      command === 'npm' ? roots.npm : command === 'pnpm' ? roots.pnpm : roots.yarn;
    if (value === null) throw new Error(`${command} was not found on PATH`);
    return value ?? '';
  };
}

async function withProcessPlatform<T>(
  platform: NodeJS.Platform,
  run: () => Promise<T>,
): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', {
      value: original,
      configurable: true,
    });
  }
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
    expect(
      parseUpdateArgs(['--check', '--yes', '--force', '--port', '3100', '--config', '/x.yaml']),
    ).toEqual({
      check: true,
      yes: true,
      force: true,
      port: 3100,
      config: '/x.yaml',
    });
    expect(parseUpdateArgs([])).toEqual({ check: false, yes: false, force: false });
  });

  it('rejects a missing or invalid port and a missing config path', () => {
    expect(parseUpdateArgs(['--port']).error).toContain('--port requires');
    expect(parseUpdateArgs(['--port', 'nope']).error).toContain('--port requires');
    expect(parseUpdateArgs(['--port', '0']).error).toContain('--port requires');
    expect(parseUpdateArgs(['--port', '70000']).error).toContain('--port requires');
    expect(parseUpdateArgs(['--config']).error).toContain('--config requires');
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

  it('rejects a junction reported as a directory (npm link) even when it resolves to the package', () => {
    const globalRoot = join(tempDir, 'node_modules');
    const checkout = join(tempDir, 'checkout');
    mkdirSync(globalRoot, { recursive: true });
    mkdirSync(checkout, { recursive: true });
    symlinkSync(checkout, join(globalRoot, 'saros-proxy'), symlinkType());
    mockLstatSync.mockImplementationOnce(
      () => ({ isSymbolicLink: () => false }) as NodeFs.Stats,
    );

    expect(isGlobalInstall(checkout, globalRoot, 'linux')).toBe(false);
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

  it('rejects a global entry that is a symlink (npm link) even when it resolves to the package', () => {
    const globalRoot = join(tempDir, 'node_modules');
    const checkout = join(tempDir, 'checkout');
    mkdirSync(globalRoot, { recursive: true });
    mkdirSync(checkout, { recursive: true });
    symlinkSync(checkout, join(globalRoot, 'saros-proxy'), process.platform === 'win32' ? 'junction' : 'dir');

    expect(isGlobalInstall(checkout, globalRoot, 'linux')).toBe(false);
  });
});

describe('detectGlobalInstall', () => {
  it('detects npm from its global root and stops probing the other managers', () => {
    const globalRoot = join(tempDir, 'node_modules');
    const packageRoot = join(globalRoot, 'saros-proxy');
    mkdirSync(packageRoot, { recursive: true });
    const calls: string[] = [];

    expect(
      detectGlobalInstall(
        packageRoot,
        discoveryExec({ npm: globalRoot }, calls),
        'linux',
      ),
    ).toEqual({ manager: 'npm', root: globalRoot });
    expect(calls).toEqual(['npm root -g']);
  });

  it('accepts a pnpm entry that is a symlink into the store', () => {
    const pnpm = makePnpmInstall();
    const calls: string[] = [];

    expect(
      detectGlobalInstall(
        pnpm.packageRoot,
        discoveryExec(
          { npm: '/usr/lib/node_modules', pnpm: pnpm.pnpmRoot, yarn: null },
          calls,
        ),
        'linux',
      ),
    ).toEqual({ manager: 'pnpm', root: pnpm.pnpmRoot });
    expect(calls).toEqual(['npm root -g', 'pnpm root -g']);
  });

  it('detects yarn and normalizes its global dir to the node_modules root', () => {
    const yarn = makeYarnInstall();
    const calls: string[] = [];

    expect(
      detectGlobalInstall(
        yarn.packageRoot,
        discoveryExec(
          { npm: '/usr/lib/node_modules', pnpm: null, yarn: yarn.yarnDir },
          calls,
        ),
        'linux',
      ),
    ).toEqual({ manager: 'yarn', root: join(yarn.yarnDir, 'node_modules') });
    expect(calls).toEqual(['npm root -g', 'pnpm root -g', 'yarn global dir']);
  });

  it('refuses an npm link that points at a checkout', () => {
    const globalRoot = join(tempDir, 'node_modules');
    const checkout = join(tempDir, 'checkout');
    mkdirSync(globalRoot, { recursive: true });
    mkdirSync(checkout, { recursive: true });
    symlinkSync(checkout, join(globalRoot, 'saros-proxy'), symlinkType());

    expect(
      detectGlobalInstall(
        checkout,
        discoveryExec({ npm: globalRoot, pnpm: null, yarn: null }),
        'linux',
      ),
    ).toBeNull();
  });

  it('accepts a pnpm link into a custom store inside the global directory', () => {
    const prefix = join(tempDir, 'pnpm', 'global', '5');
    const pnpmRoot = join(prefix, 'node_modules');
    const packageRoot = join(
      prefix,
      'custom-store',
      'saros-proxy@1.3.4',
      'node_modules',
      'saros-proxy',
    );
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(pnpmRoot, { recursive: true });
    symlinkSync(packageRoot, join(pnpmRoot, 'saros-proxy'), symlinkType());

    expect(
      detectGlobalInstall(
        packageRoot,
        discoveryExec({ npm: '/usr/lib/node_modules', pnpm: pnpmRoot, yarn: null }),
        'linux',
      ),
    ).toEqual({ manager: 'pnpm', root: pnpmRoot });
  });

  it('treats a junction reported as a directory as a link and refuses a checkout', () => {
    const pnpmRoot = join(tempDir, 'pnpm', 'global', '5', 'node_modules');
    const checkout = join(tempDir, 'checkout');
    mkdirSync(pnpmRoot, { recursive: true });
    mkdirSync(checkout, { recursive: true });
    const expected = join(pnpmRoot, 'saros-proxy');
    symlinkSync(checkout, expected, symlinkType());
    // Windows can report the junction as a plain directory; readlink still
    // answers, which must force the link path (and its store containment).
    mockLstatSync.mockImplementationOnce(
      () => ({ isSymbolicLink: () => false }) as NodeFs.Stats,
    );

    expect(
      detectGlobalInstall(
        checkout,
        discoveryExec({ npm: null, pnpm: pnpmRoot, yarn: null }),
        'linux',
      ),
    ).toBeNull();
  });

  it('refuses a pnpm link that points at a checkout', () => {
    const pnpmRoot = join(tempDir, 'pnpm', 'global', '5', 'node_modules');
    const checkout = join(tempDir, 'checkout');
    mkdirSync(pnpmRoot, { recursive: true });
    mkdirSync(checkout, { recursive: true });
    symlinkSync(checkout, join(pnpmRoot, 'saros-proxy'), symlinkType());

    expect(
      detectGlobalInstall(
        checkout,
        discoveryExec({ npm: '/usr/lib/node_modules', pnpm: pnpmRoot, yarn: null }),
        'linux',
      ),
    ).toBeNull();
  });

  it('refuses a broken pnpm symlink even when packageRoot is the link itself', () => {
    const pnpmRoot = join(tempDir, 'pnpm', 'global', '5', 'node_modules');
    mkdirSync(pnpmRoot, { recursive: true });
    const packageRoot = join(pnpmRoot, 'saros-proxy');
    symlinkSync(join(tempDir, 'store', 'gone'), packageRoot, symlinkType());

    expect(
      detectGlobalInstall(
        packageRoot,
        discoveryExec({ npm: '/usr/lib/node_modules', pnpm: pnpmRoot, yarn: null }),
        'linux',
      ),
    ).toBeNull();
  });

  it('treats a missing binary or empty output as no candidate', () => {
    expect(
      detectGlobalInstall(
        '/usr/lib/node_modules/saros-proxy',
        discoveryExec({ npm: null, pnpm: null, yarn: null }),
        'linux',
      ),
    ).toBeNull();
    expect(
      detectGlobalInstall(
        '/usr/lib/node_modules/saros-proxy',
        discoveryExec({ npm: '  ', pnpm: null, yarn: null }),
        'linux',
      ),
    ).toBeNull();
    expect(
      detectGlobalInstall('', discoveryExec({ npm: '/usr/lib/node_modules' }), 'linux'),
    ).toBeNull();
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

  it('accepts any healthy proxy when the expected version is unknown', async () => {
    const probe = vi.fn(async () => ({ ok: true, body: { version: '9.9.9' } }));
    const result = await waitForUpdatedProxy(probe, null, 1, 0, async () => {});
    expect(result.ok).toBe(true);
    expect(result.body?.version).toBe('9.9.9');
  });
});

// ---------------------------------------------------------------------------
// Command behavior
// ---------------------------------------------------------------------------

describe('runUpdateCommand', () => {
  it('exits 0 without installing when already up to date', async () => {
    const harness = makeDeps({
      fetchLatestVersion: async () => '1.1.2',
      daemonRunning: false,
      packageRoot: '/home/user/Projetos/saros-proxy',
      pnpmRoot: null,
      yarnGlobalDir: null,
    });
    const out = captureOutput();

    expect(await runUpdateCommand([], harness.deps)).toBe(0);

    expect(harness.execs.map(formatExec)).toEqual([
      'npm root -g',
      'pnpm root -g',
      'yarn global dir',
    ]);
    expect(harness.refreshes).toEqual([]);
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

  it('reinstalls and restarts the previous version when npm install fails', async () => {
    const harness = makeDeps({
      failInstall: true,
      probeHealth: async () => ({ ok: true, body: { status: 'ok', version: '1.1.2' } }),
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.execs.map((call) => `${call.command} ${call.args.join(' ')}`)).toEqual([
      'npm root -g',
      'npm install -g saros-proxy@1.1.3',
      'npm install -g saros-proxy@1.1.2',
    ]);
    expect(harness.events).toContain('daemon-start');
    expect(harness.events).toContain('daemon-stop');
    expect(out.all()).toContain('npm install -g saros-proxy@1.1.3 failed');
    expect(out.all()).toContain('Restarted saros-proxy 1.1.2 (the previous install).');
  });

  it('detects a pnpm install, installs with pnpm and restarts its entry point', async () => {
    const pnpm = makePnpmInstall();
    const harness = makeDeps({
      packageRoot: pnpm.packageRoot,
      pnpmRoot: pnpm.pnpmRoot,
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(0);

    expect(harness.execs.map(formatExec)).toEqual([
      'npm root -g',
      'pnpm root -g',
      'pnpm add -g saros-proxy@1.1.3',
    ]);
    expect(harness.execs[2].inherit).toBe(true);
    expect(harness.startOptions).toEqual([
      expect.objectContaining({ entryPoint: pnpm.entryPoint }),
    ]);
    expect(out.all()).toContain('Detected the pnpm global install');
  });

  it('rolls back a pnpm install with pnpm add -g', async () => {
    const pnpm = makePnpmInstall();
    const harness = makeDeps({
      packageRoot: pnpm.packageRoot,
      pnpmRoot: pnpm.pnpmRoot,
      failInstall: true,
      probeHealth: async () => ({ ok: true, body: { status: 'ok', version: '1.1.2' } }),
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.execs.map(formatExec)).toEqual([
      'npm root -g',
      'pnpm root -g',
      'pnpm add -g saros-proxy@1.1.3',
      'pnpm add -g saros-proxy@1.1.2',
    ]);
    expect(out.all()).toContain('pnpm add -g saros-proxy@1.1.3 failed');
    expect(out.all()).toContain('Restarted saros-proxy 1.1.2 (the previous install).');
  });

  it('detects a yarn install, installs with yarn and restarts its entry point', async () => {
    const yarn = makeYarnInstall();
    const harness = makeDeps({
      packageRoot: yarn.packageRoot,
      pnpmRoot: null,
      yarnGlobalDir: yarn.yarnDir,
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(0);

    expect(harness.execs.map(formatExec)).toEqual([
      'npm root -g',
      'pnpm root -g',
      'yarn global dir',
      'yarn global add saros-proxy@1.1.3',
    ]);
    expect(harness.startOptions).toEqual([
      expect.objectContaining({ entryPoint: yarn.entryPoint }),
    ]);
    expect(out.all()).toContain('Detected the yarn global install');
  });

  it('rolls back a yarn install with yarn global add', async () => {
    const yarn = makeYarnInstall();
    const harness = makeDeps({
      packageRoot: yarn.packageRoot,
      pnpmRoot: null,
      yarnGlobalDir: yarn.yarnDir,
      failInstall: true,
      probeHealth: async () => ({ ok: true, body: { status: 'ok', version: '1.1.2' } }),
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.execs.map(formatExec)).toEqual([
      'npm root -g',
      'pnpm root -g',
      'yarn global dir',
      'yarn global add saros-proxy@1.1.3',
      'yarn global add saros-proxy@1.1.2',
    ]);
    expect(out.all()).toContain('yarn global add saros-proxy@1.1.3 failed');
    expect(out.all()).toContain('Restarted saros-proxy 1.1.2 (the previous install).');
  });

  it('refuses a pnpm entry whose symlink target is missing', async () => {
    const pnpmRoot = join(tempDir, 'pnpm', 'global', '5', 'node_modules');
    mkdirSync(pnpmRoot, { recursive: true });
    const packageRoot = join(pnpmRoot, 'saros-proxy');
    symlinkSync(join(tempDir, 'store', 'gone'), packageRoot, symlinkType());
    const harness = makeDeps({
      packageRoot,
      pnpmRoot,
      yarnGlobalDir: null,
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.execs.map(formatExec)).toEqual([
      'npm root -g',
      'pnpm root -g',
      'yarn global dir',
    ]);
    expect(harness.events).not.toContain('daemon-stop');
    expect(out.all()).toContain('not a global npm, pnpm or yarn package');
  });

  it('refuses a pnpm link to a checkout without installing anything', async () => {
    const pnpmRoot = join(tempDir, 'pnpm', 'global', '5', 'node_modules');
    const checkout = join(tempDir, 'checkout');
    mkdirSync(pnpmRoot, { recursive: true });
    mkdirSync(checkout, { recursive: true });
    symlinkSync(checkout, join(pnpmRoot, 'saros-proxy'), symlinkType());
    const harness = makeDeps({
      packageRoot: checkout,
      pnpmRoot,
      yarnGlobalDir: null,
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.execs.map(formatExec)).toEqual([
      'npm root -g',
      'pnpm root -g',
      'yarn global dir',
    ]);
    expect(harness.events).not.toContain('daemon-stop');
    expect(out.all()).toContain('not a global npm, pnpm or yarn package');
  });

  it('refuses an npm link without installing anything', async () => {
    const globalRoot = join(tempDir, 'node_modules');
    const checkout = join(tempDir, 'checkout');
    mkdirSync(globalRoot, { recursive: true });
    mkdirSync(checkout, { recursive: true });
    symlinkSync(checkout, join(globalRoot, 'saros-proxy'), symlinkType());
    const harness = makeDeps({
      packageRoot: checkout,
      globalRoot,
      pnpmRoot: null,
      yarnGlobalDir: null,
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.execs.map(formatExec)).toEqual([
      'npm root -g',
      'pnpm root -g',
      'yarn global dir',
    ]);
    expect(harness.events).not.toContain('daemon-stop');
    expect(out.all()).toContain('not a global npm, pnpm or yarn package');
  });

  it('refuses a non-global checkout without --force, and updates with it', async () => {
    const checkout = makeDeps({ packageRoot: '/home/user/Projetos/saros-proxy' });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], checkout.deps)).toBe(1);
    expect(checkout.execs.map(formatExec)).toEqual([
      'npm root -g',
      'pnpm root -g',
      'yarn global dir',
    ]);
    expect(checkout.events).toEqual([
      'exec:npm root -g',
      'exec:pnpm root -g',
      'exec:yarn global dir',
    ]);
    expect(out.all()).toContain('not a global npm, pnpm or yarn package');
    expect(out.all()).toContain('npm root -g');
    expect(out.all()).toContain('pnpm root -g');
    expect(out.all()).toContain('yarn global dir');

    const forced = makeDeps({ packageRoot: '/home/user/Projetos/saros-proxy' });
    const forcedOut = captureOutput();
    expect(await runUpdateCommand(['--yes', '--force'], forced.deps)).toBe(0);
    expect(forced.execs.map(formatExec)).toEqual([
      'npm root -g',
      'pnpm root -g',
      'yarn global dir',
      'npm install -g saros-proxy@1.1.3',
    ]);
    expect(forcedOut.all()).toContain('Updated to 1.1.3');
  });

  it('refuses when no package manager owns the install', async () => {
    const harness = makeDeps({ globalRoot: null });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);
    expect(out.all()).toContain('not a global npm, pnpm or yarn package');
    expect(harness.execs.map(formatExec)).toEqual([
      'npm root -g',
      'pnpm root -g',
      'yarn global dir',
    ]);
    expect(harness.events).not.toContain('daemon-stop');
  });

  it('reports when no package manager can name a global prefix', async () => {
    const harness = makeDeps({
      globalRoot: null,
      pnpmRoot: null,
      yarnGlobalDir: null,
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);
    expect(out.all()).toContain('Could not determine');
    expect(out.all()).toContain('npm root -g');
    expect(out.all()).toContain('pnpm root -g');
    expect(out.all()).toContain('yarn global dir');
    expect(harness.events).not.toContain('daemon-stop');
  });

  it('keeps the npm entry point for --force with an empty package root', async () => {
    const harness = makeDeps({ packageRoot: '' });

    expect(await runUpdateCommand(['--yes', '--force'], harness.deps)).toBe(0);

    expect(harness.execs.map(formatExec)).toEqual([
      'npm root -g',
      'pnpm root -g',
      'yarn global dir',
      'npm install -g saros-proxy@1.1.3',
    ]);
    expect(harness.startOptions).toEqual([
      expect.objectContaining({
        entryPoint: '/usr/lib/node_modules/saros-proxy/dist/index.js',
      }),
    ]);
  });

  it('does not start anything when the daemon was stopped', async () => {
    const harness = makeDeps({
      getDaemonState: async () => ({
        running: false,
        port: 3000,
        pidDir: '/home/u/.config/saros',
        legacyPidFile: null,
      }),
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

  it('repairs an inactive systemd unit after installing', async () => {
    const pnpm = makePnpmInstall();
    const harness = makeDeps({
      packageRoot: pnpm.packageRoot,
      pnpmRoot: pnpm.pnpmRoot,
      daemonRunning: false,
    });

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(0);

    expect(harness.refreshes).toEqual([pnpm.entryPoint]);
    expect(harness.events).not.toContain('systemd-start');
  });

  it('repairs the systemd unit after a daemon-mode install', async () => {
    const pnpm = makePnpmInstall();
    const harness = makeDeps({
      packageRoot: pnpm.packageRoot,
      pnpmRoot: pnpm.pnpmRoot,
    });

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(0);

    expect(harness.refreshes).toEqual([pnpm.entryPoint]);
    expect(harness.events).toContain('daemon-start');
  });

  it('repairs an inactive systemd unit when already on the latest version', async () => {
    const pnpm = makePnpmInstall();
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonRunning: false,
      packageRoot: pnpm.packageRoot,
      pnpmRoot: pnpm.pnpmRoot,
    });
    const out = captureOutput();

    expect(await runUpdateCommand([], harness.deps)).toBe(0);

    expect(harness.refreshes).toEqual([pnpm.entryPoint]);
    expect(harness.systemdStarts).toEqual([]);
    expect(harness.execs.map(formatExec)).toEqual(['npm root -g', 'pnpm root -g']);
    expect(out.all()).toContain('Already on 1.1.3');
  });

  it('repairs an inactive unit from a forced checkout with the npm global entry', async () => {
    const harness = makeDeps({ packageRoot: '/home/user/Projetos/saros-proxy' });
    captureOutput();

    expect(await runUpdateCommand(['--yes', '--force'], harness.deps)).toBe(0);

    const globalEntry = '/usr/lib/node_modules/saros-proxy/dist/index.js';
    expect(harness.refreshes).toEqual([globalEntry]);
    expect(harness.systemdStarts).toEqual([]);
  });

  it('does not rewrite autostart when the forced entry point resolves inside the checkout', async () => {
    const globalRoot = join(tempDir, 'node_modules');
    const checkout = join(tempDir, 'checkout');
    mkdirSync(globalRoot, { recursive: true });
    mkdirSync(join(checkout, 'dist'), { recursive: true });
    writeFileSync(join(checkout, 'dist', 'index.js'), '');
    // npm link: the global entry is a link back to the checkout, so --force
    // falls back to npm's root while the entry point resolves into the checkout.
    symlinkSync(checkout, join(globalRoot, 'saros-proxy'), symlinkType());
    const harness = makeDeps({
      packageRoot: checkout,
      globalRoot,
      pnpmRoot: null,
      yarnGlobalDir: null,
    });
    captureOutput();

    expect(await runUpdateCommand(['--yes', '--force'], harness.deps)).toBe(0);

    expect(harness.refreshes).toEqual([]);
    expect(harness.startOptions).toEqual([
      expect.objectContaining({
        entryPoint: join(globalRoot, 'saros-proxy', 'dist', 'index.js'),
      }),
    ]);
  });

  it('passes the detected entry point to a stale systemd restart', async () => {
    const pnpm = makePnpmInstall();
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonHealthVersion: '1.1.2',
      packageRoot: pnpm.packageRoot,
      pnpmRoot: pnpm.pnpmRoot,
      systemdActive: () => true,
    });
    captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(0);

    expect(harness.systemdStarts).toEqual([pnpm.entryPoint]);
  });

  it('does not pass a checkout entry point to a stale systemd restart', async () => {
    const checkout = join(tempDir, 'checkout');
    mkdirSync(checkout, { recursive: true });
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonHealthVersion: '1.1.2',
      packageRoot: checkout,
      systemdActive: () => true,
    });
    captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(0);

    expect(harness.systemdStarts).toEqual([undefined]);
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
      getDaemonState: async () => ({
        running: false,
        port: 3000,
        pidDir: '/home/u/.config/saros',
        legacyPidFile: null,
      }),
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

  describe('unmanaged listener on the configured port', () => {
    const DEFAULT_OWNER = {
      pid: 999,
      command: 'node /srv/orphan/dist/index.js serve',
      starttime: '123456',
    };

    /**
     * A listener no PID file owns. findPortOwner reports it while it holds the
     * port and null once it is gone; the restarted daemon answers /health.
     */
    function unmanagedListener(
      overrides: DepOptions = {},
      owner: { pid: number; command: string; starttime: string } | null = DEFAULT_OWNER,
    ) {
      const harness = makeDeps({
        daemonPid: null,
        daemonRunning: true,
        daemonHealthVersion: '1.1.2',
        ...overrides,
      });
      const ownerLookups: number[] = [];
      const killedPids: number[] = [];
      const probes: number[] = [];
      let phase: 'serving' | 'released' | 'restarted' = 'serving';
      harness.deps.findPortOwner = (port) => {
        ownerLookups.push(port);
        return phase === 'released' ? null : owner;
      };
      harness.deps.killPortOwner = (pid) => {
        killedPids.push(pid);
        phase = 'released';
      };
      harness.deps.probeHealth = async (port) => {
        probes.push(port);
        return {
          ok: true,
          body: { status: 'ok', version: phase === 'restarted' ? '1.1.3' : '1.1.2' },
        };
      };
      const start = harness.deps.daemonStart;
      harness.deps.daemonStart = async (callOptions) => {
        phase = 'restarted';
        await start(callOptions);
      };
      return { harness, ownerLookups, killedPids, probes };
    }

    it('kills the owner after confirmation and continues the update', async () => {
      const { harness, ownerLookups, killedPids, probes } = unmanagedListener();
      const out = captureOutput();

      expect(await runUpdateCommand([], harness.deps)).toBe(0);

      expect(ownerLookups).toEqual([3000, 3000, 3000]);
      expect(killedPids).toEqual([999]);
      expect(harness.confirms).toHaveLength(2);
      expect(harness.confirms[1]).toBe('Kill the process using port 3000 and continue?');
      expect(harness.events).not.toContain('daemon-stop');
      expect(harness.events).toContain('daemon-start');
      expect(harness.execs.map((call) => call.args.join(' '))).toEqual([
        'root -g',
        'install -g saros-proxy@1.1.3',
      ]);
      // Only the updated proxy's /health: release is measured on the listener.
      expect(probes).toEqual([3000]);
      expect(out.all()).toContain('served by PID 999 (node /srv/orphan/dist/index.js serve)');
      expect(out.all()).toContain('not owned by the PID file in /home/u/.config/saros');
      expect(out.all()).toContain('Sent SIGTERM to PID 999');
      expect(out.all()).toContain('Updated to 1.1.3 and restarted the proxy on port 3000.');
    });

    it('aborts without killing anything when the kill confirmation is declined', async () => {
      const { harness, killedPids } = unmanagedListener();
      harness.deps.confirm = async (message) =>
        !message.includes('Kill the process using port');
      const out = captureOutput();

      expect(await runUpdateCommand([], harness.deps)).toBe(1);

      expect(killedPids).toEqual([]);
      expect(harness.events).not.toContain('daemon-start');
      expect(harness.events).not.toContain('exec:npm install -g saros-proxy@1.1.3');
      expect(out.all()).toContain('Update cancelled.');
    });

    it('treats --yes as consent but still names what it killed', async () => {
      const { harness, killedPids } = unmanagedListener();
      const out = captureOutput();

      expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(0);

      expect(harness.confirms).toEqual([]);
      expect(killedPids).toEqual([999]);
      expect(out.all()).toContain('served by PID 999');
      expect(out.all()).toContain('Sent SIGTERM to PID 999');
      expect(out.all()).toContain('Updated to 1.1.3');
    });

    it('names the PID alone when its command line is unreadable', async () => {
      const { harness } = unmanagedListener({}, { pid: 999, command: '', starttime: '' });
      const out = captureOutput();

      expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(0);

      expect(out.all()).toContain('served by PID 999 (command line not readable)');
    });

    it('aborts when the owner of the port cannot be identified', async () => {
      const { harness, killedPids } = unmanagedListener({}, null);
      const out = captureOutput();

      expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

      expect(killedPids).toEqual([]);
      expect(harness.events).not.toContain('exec:npm install -g saros-proxy@1.1.3');
      expect(out.all()).toContain(
        'Port 3000 is served by a process that could not be identified',
      );
    });

    it('aborts when SIGTERM leaves the socket bound, naming the holder', async () => {
      const { harness, ownerLookups, killedPids } = unmanagedListener();
      // A silent but live process (or a child that inherited the socket):
      // /health no longer answers, yet the port is still bound.
      harness.deps.killPortOwner = (pid) => {
        killedPids.push(pid);
      };
      harness.deps.probeHealth = async () => ({ ok: false });
      const out = captureOutput();

      expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

      expect(killedPids).toEqual([999]);
      // Discovery, revalidation, then one lookup per release attempt.
      expect(ownerLookups).toHaveLength(22);
      expect(harness.events).not.toContain('daemon-start');
      expect(out.all()).not.toContain('Port 3000 released');
      expect(out.all()).toContain('Port 3000 is still held by PID 999');
    });

    it('aborts when SIGTERM cannot be delivered', async () => {
      const { harness } = unmanagedListener();
      harness.deps.killPortOwner = () => {
        throw new Error('EPERM: operation not permitted');
      };
      const out = captureOutput();

      expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

      expect(harness.events).not.toContain('daemon-start');
      expect(out.all()).toContain('Could not stop PID 999: EPERM');
    });

    it('kills the owner before restarting an already-installed-but-outdated proxy', async () => {
      const install = makeGlobalInstall();
      const { harness, killedPids, probes } = unmanagedListener({
        currentVersion: '1.1.3',
        fetchLatestVersion: async () => '1.1.3',
        globalRoot: install.globalRoot,
        packageRoot: install.packageRoot,
      });
      const out = captureOutput();

      expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(0);

      // --yes consented, and the kill prompt is skipped for it.
      expect(harness.confirms).toEqual([]);
      expect(killedPids).toEqual([999]);
      expect(harness.events).not.toContain('daemon-stop');
      expect(harness.startOptions).toEqual([{ entryPoint: install.entryPoint }]);
      expect(probes).toEqual([3000]);
      expect(out.all()).toContain('Sent SIGTERM to PID 999');
      expect(out.all()).toContain('Restarted saros-proxy 1.1.3');
    });

    it('aborts a stale restart when the listener cannot be identified', async () => {
      const install = makeGlobalInstall();
      const { harness, killedPids } = unmanagedListener(
        {
          currentVersion: '1.1.3',
          fetchLatestVersion: async () => '1.1.3',
          globalRoot: install.globalRoot,
          packageRoot: install.packageRoot,
        },
        null,
      );
      const out = captureOutput();

      expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

      expect(killedPids).toEqual([]);
      expect(harness.events).not.toContain('daemon-start');
      expect(out.all()).toContain(
        'Port 3000 is served by a process that could not be identified',
      );
    });

    it('warns about the process before prompting and before signalling it', async () => {
      const { harness } = unmanagedListener();
      const timeline: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        timeline.push(`out:${args.map(String).join(' ')}`);
      });
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        timeline.push(`err:${args.map(String).join(' ')}`);
      });
      harness.deps.confirm = async (message) => {
        timeline.push(`prompt:${message}`);
        return true;
      };
      const kill = harness.deps.killPortOwner;
      harness.deps.killPortOwner = (pid) => {
        timeline.push('kill');
        kill(pid);
      };

      expect(await runUpdateCommand([], harness.deps)).toBe(0);

      const warning = timeline.findIndex((line) => line.includes('is served by PID 999'));
      const prompt = timeline.findIndex((line) =>
        line.startsWith('prompt:Kill the process using port 3000'),
      );
      const killed = timeline.indexOf('kill');
      expect(warning).toBeGreaterThan(-1);
      expect(prompt).toBeGreaterThan(warning);
      expect(killed).toBeGreaterThan(prompt);
    });

    it('does not signal a PID that no longer matches the listener', async () => {
      const { harness, ownerLookups, killedPids } = unmanagedListener();
      const discover = harness.deps.findPortOwner;
      let lookups = 0;
      harness.deps.findPortOwner = (port) => {
        lookups++;
        // Same PID, different start time: the listener exited while the
        // prompt was open and its PID was reused.
        return lookups === 1
          ? discover(port)
          : { ...DEFAULT_OWNER, starttime: '999999' };
      };
      const out = captureOutput();

      expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

      expect(ownerLookups).toEqual([3000]);
      expect(killedPids).toEqual([]);
      expect(harness.events).not.toContain('daemon-start');
      expect(out.all()).toContain('no longer the listener on port 3000');
      expect(out.all()).toContain('could not be identified');
    });

    it('does not signal when the listener disappeared while the prompt was open', async () => {
      const { harness, killedPids } = unmanagedListener();
      const discover = harness.deps.findPortOwner;
      let lookups = 0;
      harness.deps.findPortOwner = (port) => {
        lookups++;
        return lookups === 1 ? discover(port) : null;
      };
      const out = captureOutput();

      expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

      expect(killedPids).toEqual([]);
      expect(harness.events).not.toContain('daemon-start');
      expect(out.all()).toContain('no longer the listener on port 3000');
    });

    it('reports a pre-0.11 PID file and stops before offering the kill', async () => {
      const { harness, ownerLookups, killedPids } = unmanagedListener({
        legacyPidFile: '/home/u/.config/saros/daemon.pid',
      });
      const out = captureOutput();

      expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

      expect(ownerLookups).toEqual([]);
      expect(killedPids).toEqual([]);
      expect(harness.confirms).toEqual([]);
      expect(harness.events).not.toContain('exec:npm install -g saros-proxy@1.1.3');
      expect(out.all()).toContain(
        'A pre-0.11 PID file exists at /home/u/.config/saros/daemon.pid.',
      );
      expect(out.all()).toContain('SAROS_ALLOW_LEGACY_PID=1');
      expect(out.all()).toContain('nothing was stopped');
    });

    it('does not claim a saros-proxy listener was never launched', async () => {
      const { harness } = unmanagedListener(
        {},
        {
          pid: 999,
          command: 'node /usr/lib/node_modules/saros-proxy/dist/index.js serve',
          starttime: '123456',
        },
      );
      const out = captureOutput();

      expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(0);

      expect(out.all()).not.toContain('did not launch');
      expect(out.all()).toContain('started outside this state dir (/home/u/.config/saros)');
    });

    it('follows --port instead of the default port', async () => {
      const { harness, ownerLookups, killedPids, probes } = unmanagedListener({
        daemonPort: 4545,
      });
      const out = captureOutput();

      expect(await runUpdateCommand(['--yes', '--port', '4545'], harness.deps)).toBe(0);

      expect(ownerLookups).toEqual([4545, 4545, 4545]);
      expect(killedPids).toEqual([999]);
      expect(probes).toEqual([4545]);
      expect(harness.startOptions[0]).toMatchObject({ port: 4545 });
      expect(out.all()).toContain('Updated to 1.1.3 and restarted the proxy on port 4545.');
    });

    it('asks for the kill in the stale restart path and honours a refusal', async () => {
      const install = makeGlobalInstall();
      const { harness, killedPids } = unmanagedListener({
        currentVersion: '1.1.3',
        fetchLatestVersion: async () => '1.1.3',
        globalRoot: install.globalRoot,
        packageRoot: install.packageRoot,
        isTTY: true,
      });
      const confirm = harness.deps.confirm;
      harness.deps.confirm = async (message) => {
        const approved = await confirm(message);
        return message.includes('Kill the process using port') ? false : approved;
      };
      const out = captureOutput();

      expect(await runUpdateCommand([], harness.deps)).toBe(1);

      expect(killedPids).toEqual([]);
      expect(harness.confirms).toEqual([
        'The package is already 1.1.3, but the proxy on port 3000 reports 1.1.2. Restart it?',
        'Kill the process using port 3000 and continue?',
      ]);
      expect(harness.events).not.toContain('daemon-start');
      expect(out.all()).toContain('Update cancelled.');
    });

    it('names the process still holding the port when the restarted proxy never answers', async () => {
      const { harness } = unmanagedListener({ healthAttempts: 1 });
      harness.deps.probeHealth = async () => ({ ok: false });
      const out = captureOutput();

      expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

      expect(out.all()).toContain('did not answer /health');
      expect(out.all()).toContain('Port 3000 is still held by PID 999');
    });

    it('leaves the managed daemon path untouched', async () => {
      const harness = makeDeps({ daemonPid: '4242', daemonHealthVersion: '1.1.2' });
      const out = captureOutput();

      expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(0);

      expect(harness.ownerLookups).toEqual([]);
      expect(harness.killedPids).toEqual([]);
      expect(harness.events).toContain('daemon-stop');
      expect(out.all()).toContain('Updated to 1.1.3');
    });
  });

  it('reports a health failure with the daemon log and status hint', async () => {
    // Nothing is listening when the health probe gives up: no holder to name.
    const harness = makeDeps({ healthOk: false, healthAttempts: 3, findPortOwner: () => null });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    // Three probes for the new version, then three for the rollback.
    expect(harness.probes).toHaveLength(6);
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

  it('reinstalls the previous version when the new proxy fails to start', async () => {
    const harness = makeDeps({
      probeHealth: async () => ({ ok: true, body: { status: 'ok', version: '1.1.2' } }),
    });
    const originalStart = harness.deps.daemonStart;
    let starts = 0;
    harness.deps.daemonStart = async (options) => {
      starts++;
      if (starts === 1) throw new Error('EADDRINUSE');
      await originalStart(options);
    };
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(starts).toBe(2);
    expect(harness.execs.map((call) => call.args.join(' '))).toEqual([
      'root -g',
      'install -g saros-proxy@1.1.3',
      'install -g saros-proxy@1.1.2',
    ]);
    expect(out.all()).toContain('failed to start: EADDRINUSE');
    expect(out.all()).toContain('Restarted saros-proxy 1.1.2 (the previous install).');
  });

  it('reinstalls the previous version when the new proxy never reports the new version', async () => {
    const harness = makeDeps({ healthVersion: '1.1.2' });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.execs.map((call) => call.args.join(' '))).toEqual([
      'root -g',
      'install -g saros-proxy@1.1.3',
      'install -g saros-proxy@1.1.2',
    ]);
    expect(harness.events.filter((event) => event === 'daemon-stop')).toHaveLength(2);
    expect(harness.events.filter((event) => event === 'daemon-start')).toHaveLength(2);
    expect(harness.probes).toEqual([3000, 3000, 3000]);
    expect(out.all()).toContain('reports version 1.1.2');
    expect(out.all()).toContain('Restarted saros-proxy 1.1.2 (the previous install).');
  });

  it('starts the package on disk and says so when the previous version cannot be reinstalled', async () => {
    const harness = makeDeps({
      failInstall: true,
      failReinstall: true,
      probeHealth: async () => ({ ok: true, body: { status: 'ok', version: '1.1.3' } }),
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(out.all()).toContain('Could not reinstall saros-proxy 1.1.2');
    expect(out.all()).toContain('Starting the package currently on disk instead.');
    expect(out.all()).toContain('Started the package currently on disk (version 1.1.3)');
    expect(out.all()).toContain('saros-proxy 1.1.2 could not be reinstalled');
  });

  it('restarts a running daemon that reports an older version when the package is already latest', async () => {
    const install = makeGlobalInstall();
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonHealthVersion: '1.1.2',
      globalRoot: install.globalRoot,
      packageRoot: install.packageRoot,
    });
    const out = captureOutput();

    // No --yes: the TTY confirmation is the consent for the restart.
    expect(await runUpdateCommand([], harness.deps)).toBe(0);

    expect(harness.confirms).toHaveLength(1);
    expect(harness.execs.map((call) => call.args.join(' '))).toEqual(['root -g']);
    expect(harness.stopOptions).toEqual([{}]);
    expect(harness.startOptions).toEqual([{ entryPoint: install.entryPoint }]);
    expect(harness.probes).toEqual([3000]);
    expect(out.all()).toContain('reports 1.1.2');
    expect(out.all()).toContain('Restarted saros-proxy 1.1.3');
  });

  it('does not restart a stale daemon without consent (non-TTY, no --yes)', async () => {
    const install = makeGlobalInstall();
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonHealthVersion: '1.1.2',
      isTTY: false,
      globalRoot: install.globalRoot,
      packageRoot: install.packageRoot,
    });
    const out = captureOutput();

    expect(await runUpdateCommand([], harness.deps)).toBe(0);

    expect(harness.events).toEqual(['daemon-state']);
    expect(harness.execs).toEqual([]);
    expect(harness.confirms).toEqual([]);
    expect(out.all()).toContain('saros-proxy update --yes');
    expect(out.all()).not.toContain('Restarting it.');
  });

  it('does not restart a stale daemon when the operator declines', async () => {
    const install = makeGlobalInstall();
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonHealthVersion: '1.1.2',
      globalRoot: install.globalRoot,
      packageRoot: install.packageRoot,
      confirm: async () => false,
    });
    const out = captureOutput();

    expect(await runUpdateCommand([], harness.deps)).toBe(0);

    expect(harness.events).toEqual(['daemon-state']);
    expect(harness.execs).toEqual([]);
    expect(harness.stopOptions).toEqual([]);
    expect(harness.startOptions).toEqual([]);
    expect(out.all()).toContain('Restart cancelled.');
  });

  it('refuses to restart the daemon from a checkout without --force', async () => {
    const install = makeGlobalInstall();
    const checkout = join(tempDir, 'checkout');
    mkdirSync(checkout, { recursive: true });
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonHealthVersion: '1.1.2',
      packageRoot: checkout,
      globalRoot: install.globalRoot,
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.events).toEqual([
      'daemon-state',
      'exec:npm root -g',
      'exec:pnpm root -g',
      'exec:yarn global dir',
    ]);
    expect(harness.stopOptions).toEqual([]);
    expect(harness.startOptions).toEqual([]);
    expect(out.all()).toContain('not a global npm, pnpm or yarn package');
  });

  it('does not restart a daemon when the installed package entry point is missing', async () => {
    const globalRoot = join(tempDir, 'node_modules');
    const packageRoot = join(globalRoot, 'saros-proxy');
    mkdirSync(packageRoot, { recursive: true });
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonHealthVersion: '1.1.2',
      packageRoot,
      globalRoot,
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.stopOptions).toEqual([]);
    expect(harness.startOptions).toEqual([]);
    expect(out.all()).toContain('entry point');
    expect(out.all()).toContain('saros-proxy restart');
  });

  it('does not restart a daemon when the global prefix cannot be determined', async () => {
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonHealthVersion: '1.1.2',
      globalRoot: null,
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes', '--force'], harness.deps)).toBe(1);

    expect(harness.stopOptions).toEqual([]);
    expect(harness.startOptions).toEqual([]);
    expect(out.all()).toContain('Cannot restart the proxy from the installed package');
  });

  it('restarts an active systemd unit without a daemon entry point', async () => {
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonHealthVersion: '1.1.2',
      systemdActive: () => true,
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(0);

    expect(harness.events).toContain('systemd-stop');
    expect(harness.events).toContain('systemd-start');
    expect(harness.events).not.toContain('daemon-stop');
    expect(harness.startOptions).toEqual([]);
    expect(harness.probes).toEqual([3000]);
    expect(out.all()).toContain('Restarted saros-proxy 1.1.3');
  });

  it('restarts a stale daemon that does not report its version', async () => {
    const install = makeGlobalInstall();
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonPid: '4242',
      daemonHealthVersion: null,
      daemonPort: 3100,
      globalRoot: install.globalRoot,
      packageRoot: install.packageRoot,
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes', '--port', '3100'], harness.deps)).toBe(0);

    expect(harness.stopOptions).toEqual([{ port: 3100 }]);
    expect(harness.startOptions).toEqual([
      { port: 3100, entryPoint: install.entryPoint },
    ]);
    expect(out.all()).toContain('does not report its version');
  });

  it('reports a stale-daemon restart that fails to start', async () => {
    const install = makeGlobalInstall();
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonHealthVersion: '1.1.2',
      globalRoot: install.globalRoot,
      packageRoot: install.packageRoot,
      daemonStart: async () => {
        throw new Error('EADDRINUSE');
      },
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.events).toContain('daemon-stop');
    expect(out.all()).toContain('the restart failed: EADDRINUSE');
  });

  it('refuses to guess the stale daemon port without --port', async () => {
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonPid: '4242',
      daemonHealthVersion: null,
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.stopOptions).toEqual([]);
    expect(harness.startOptions).toEqual([]);
    expect(out.all()).toContain('--port');
  });

  it('reports a stale-daemon stop that throws', async () => {
    const install = makeGlobalInstall();
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonHealthVersion: '1.1.2',
      globalRoot: install.globalRoot,
      packageRoot: install.packageRoot,
      daemonStop: async () => {
        throw new Error('EACCES');
      },
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.startOptions).toEqual([]);
    expect(out.all()).toContain('Could not stop the running proxy: EACCES');
  });

  it('reports when the stale daemon cannot be stopped', async () => {
    const install = makeGlobalInstall();
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonHealthVersion: '1.1.2',
      globalRoot: install.globalRoot,
      packageRoot: install.packageRoot,
      daemonStop: async () => false,
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.events).not.toContain('daemon-start');
    expect(harness.startOptions).toEqual([]);
    expect(out.all()).toContain('Could not stop the running proxy');
  });

  it('reports a stale-daemon restart that never reports the package version', async () => {
    const install = makeGlobalInstall();
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonHealthVersion: '1.1.2',
      globalRoot: install.globalRoot,
      packageRoot: install.packageRoot,
      healthVersion: '1.1.2',
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.startOptions).toEqual([{ entryPoint: install.entryPoint }]);
    expect(out.all()).toContain('reports version 1.1.2');
  });

  it('leaves a daemon serving the already-installed version alone', async () => {
    const harness = makeDeps({
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      daemonHealthVersion: '1.1.3',
    });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(0);

    expect(harness.events).toEqual(['daemon-state']);
    expect(out.all()).toContain('Already on 1.1.3');
  });

  it('refuses to guess the daemon port when a PID is alive and /health is silent', async () => {
    const harness = makeDeps({ daemonPid: '4242', daemonHealthVersion: null });
    const out = captureOutput();

    expect(await runUpdateCommand(['--yes'], harness.deps)).toBe(1);

    expect(harness.execs.map((call) => call.args.join(' '))).toEqual(['root -g']);
    expect(harness.events).not.toContain('daemon-stop');
    expect(harness.events).not.toContain('exec:npm install -g saros-proxy@1.1.3');
    expect(out.all()).toContain('--port');
  });

  it('passes --port and --config to stop, start and the health probe', async () => {
    const harness = makeDeps({
      daemonPid: '4242',
      daemonHealthVersion: null,
      daemonPort: 3100,
    });
    captureOutput();

    expect(
      await runUpdateCommand(
        ['--yes', '--port', '3100', '--config', '/tmp/saros.yaml'],
        harness.deps,
      ),
    ).toBe(0);

    expect(harness.stopOptions).toEqual([
      { port: 3100, configPath: '/tmp/saros.yaml' },
    ]);
    expect(harness.startOptions).toEqual([
      {
        port: 3100,
        configPath: '/tmp/saros.yaml',
        entryPoint: '/usr/lib/node_modules/saros-proxy/dist/index.js',
      },
    ]);
    expect(harness.probes).toEqual([3100]);
  });

  it('rejects a registry version that is not plain semver before any exec', async () => {
    const harness = makeDeps({
      fetchLatestVersion: async () => '1.1.3; touch /tmp/pwned',
    });
    const out = captureOutput();

    expect(await runUpdateCommand([], harness.deps)).toBe(1);

    expect(harness.execs).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(out.all()).toContain('invalid version');
  });

  it('treats an installed prerelease as older than the stable release', async () => {
    const check = makeDeps({ currentVersion: '1.1.3-rc.1' });
    const out = captureOutput();

    expect(await runUpdateCommand(['--check'], check.deps)).toBe(1);
    expect(out.all()).toContain('installed 1.1.3-rc.1 / latest 1.1.3');

    const update = makeDeps({ currentVersion: '1.1.3-rc.1' });
    expect(await runUpdateCommand(['--yes'], update.deps)).toBe(0);
    expect(update.execs.map((call) => call.args.join(' '))).toContain(
      'install -g saros-proxy@1.1.3',
    );
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

  it('updates a pnpm systemd unit and starts the repaired stable entry', async () => {
    const pnpm = makePnpmInstall();
    const xdgHome = join(tempDir, 'xdg');
    const unitPath = join(xdgHome, 'systemd', 'user', 'saros-proxy.service');
    const oldEntry = join(
      tempDir,
      'pnpm',
      'global',
      '5',
      '.pnpm',
      'saros-proxy@1.3.3',
      'node_modules',
      'saros-proxy',
      'dist',
      'index.js',
    );
    mkdirSync(join(xdgHome, 'systemd', 'user'), { recursive: true });
    writeFileSync(
      unitPath,
      `[Service]\nExecStart="${process.execPath}" "${oldEntry}" serve\n`,
      'utf-8',
    );
    vi.stubEnv('XDG_CONFIG_HOME', xdgHome);
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'npm' && args[0] === 'root') return '/usr/lib/node_modules\n';
      if (command === 'pnpm' && args[0] === 'root') return `${pnpm.pnpmRoot}\n`;
      if (command === 'systemctl' && args.includes('is-active')) return 'active\n';
      return '';
    });
    mockGetDaemonState.mockResolvedValue({ running: true, port: 3000 });
    mockProbeProxyHealth.mockResolvedValue({
      ok: true,
      body: { status: 'ok', version: '1.1.3' },
    });
    captureOutput();

    const code = await runUpdateCommand(['--yes'], {
      currentVersion: '1.1.2',
      fetchLatestVersion: async () => '1.1.3',
      readInstalledVersion: () => '1.1.3',
      packageRoot: pnpm.packageRoot,
      isTTY: true,
      daemonLogPath: join(tempDir, 'daemon.log'),
      sleep: async () => {},
      healthAttempts: 1,
      healthDelayMs: 1,
      platform: 'linux',
    });

    expect(code).toBe(0);
    const unit = readFileSync(unitPath, 'utf-8');
    expect(unit).not.toContain('.pnpm/saros-proxy@');
    expect(unit).not.toContain('saros-proxy@1.3.3');
    expect(unit).toContain(join(pnpm.pnpmRoot, 'saros-proxy', 'dist', 'index.js'));
    const commands = mockExecFileSync.mock.calls.map((call) =>
      [call[0], ...(call[1] as string[])].join(' '),
    );
    expect(commands).toContain('systemctl --user stop saros-proxy.service');
    expect(commands).toContain('systemctl --user daemon-reload');
    expect(commands).toContain('systemctl --user start saros-proxy.service');
    expect(commands).toContain('pnpm add -g saros-proxy@1.1.3');
    expect(commands.indexOf('systemctl --user daemon-reload')).toBeLessThan(
      commands.indexOf('systemctl --user start saros-proxy.service'),
    );
  });

  it('rewrites an inactive systemd unit after a pnpm install', async () => {
    const pnpm = makePnpmInstall();
    const { unitPath } = makeVersionedUnit(' --port 4242');
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'npm' && args[0] === 'root') return '/usr/lib/node_modules\n';
      if (command === 'pnpm' && args[0] === 'root') return `${pnpm.pnpmRoot}\n`;
      if (command === 'systemctl' && args.includes('is-active')) return 'inactive\n';
      return '';
    });
    mockGetDaemonState.mockResolvedValue({ running: false, port: 3000 });
    captureOutput();

    const code = await runUpdateCommand(['--yes'], {
      currentVersion: '1.1.2',
      fetchLatestVersion: async () => '1.1.3',
      readInstalledVersion: () => '1.1.3',
      packageRoot: pnpm.packageRoot,
      isTTY: true,
      daemonLogPath: join(tempDir, 'daemon.log'),
      sleep: async () => {},
      healthAttempts: 1,
      healthDelayMs: 1,
      platform: 'linux',
    });

    expect(code).toBe(0);
    const unit = readFileSync(unitPath, 'utf-8');
    expect(unit).toContain(join(pnpm.pnpmRoot, 'saros-proxy', 'dist', 'index.js'));
    expect(unit).not.toContain('.pnpm/saros-proxy@');
    expect(unit).toContain('serve --port 4242');
    const commands = mockExecFileSync.mock.calls.map((call) =>
      [call[0], ...(call[1] as string[])].join(' '),
    );
    expect(commands).toContain('systemctl --user daemon-reload');
    expect(commands).not.toContain('systemctl --user start saros-proxy.service');
  });

  it('repairs a stale pnpm systemd unit before restarting it', async () => {
    const pnpm = makePnpmInstall();
    const { unitPath } = makeVersionedUnit();
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'npm' && args[0] === 'root') return '/usr/lib/node_modules\n';
      if (command === 'pnpm' && args[0] === 'root') return `${pnpm.pnpmRoot}\n`;
      if (command === 'systemctl' && args.includes('is-active')) return 'active\n';
      return '';
    });
    mockGetDaemonState.mockResolvedValue({
      running: true,
      port: 3000,
      health: { status: 'ok', version: '1.1.2' },
    });
    mockProbeProxyHealth.mockResolvedValue({
      ok: true,
      body: { status: 'ok', version: '1.1.3' },
    });
    captureOutput();

    const code = await runUpdateCommand(['--yes'], {
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      packageRoot: pnpm.packageRoot,
      isTTY: true,
      daemonLogPath: join(tempDir, 'daemon.log'),
      sleep: async () => {},
      healthAttempts: 1,
      healthDelayMs: 1,
      platform: 'linux',
    });

    expect(code).toBe(0);
    const unit = readFileSync(unitPath, 'utf-8');
    expect(unit).toContain(join(pnpm.pnpmRoot, 'saros-proxy', 'dist', 'index.js'));
    expect(unit).not.toContain('.pnpm/saros-proxy@');
    const commands = mockExecFileSync.mock.calls.map((call) =>
      [call[0], ...(call[1] as string[])].join(' '),
    );
    expect(commands.indexOf('systemctl --user daemon-reload')).toBeLessThan(
      commands.indexOf('systemctl --user start saros-proxy.service'),
    );
  });

  it('rewrites the inactive unit when already on the latest version', async () => {
    const pnpm = makePnpmInstall();
    const { unitPath } = makeVersionedUnit(' --port 4242');
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'npm' && args[0] === 'root') return '/usr/lib/node_modules\n';
      if (command === 'pnpm' && args[0] === 'root') return `${pnpm.pnpmRoot}\n`;
      if (command === 'systemctl' && args.includes('is-active')) return 'inactive\n';
      return '';
    });
    mockGetDaemonState.mockResolvedValue({ running: false, port: 3000 });
    captureOutput();

    const code = await runUpdateCommand([], {
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      packageRoot: pnpm.packageRoot,
      isTTY: true,
      daemonLogPath: join(tempDir, 'daemon.log'),
      sleep: async () => {},
      healthAttempts: 1,
      healthDelayMs: 1,
      platform: 'linux',
    });

    expect(code).toBe(0);
    const unit = readFileSync(unitPath, 'utf-8');
    expect(unit).toContain(join(pnpm.pnpmRoot, 'saros-proxy', 'dist', 'index.js'));
    expect(unit).not.toContain('.pnpm/saros-proxy@');
    expect(unit).toContain('serve --port 4242');
    const commands = mockExecFileSync.mock.calls.map((call) =>
      [call[0], ...(call[1] as string[])].join(' '),
    );
    expect(commands).toContain('systemctl --user daemon-reload');
    expect(commands).not.toContain('systemctl --user start saros-proxy.service');
  });

  it('rewrites an active unit from a forced checkout and starts the npm global entry', async () => {
    const checkout = join(tempDir, 'checkout');
    mkdirSync(checkout, { recursive: true });
    const { unitPath } = makeVersionedUnit(' --port 4242');
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'npm' && args[0] === 'root') return '/usr/lib/node_modules\n';
      if (command === 'systemctl' && args.includes('is-active')) return 'active\n';
      return '';
    });
    mockGetDaemonState.mockResolvedValue({ running: true, port: 3000 });
    mockProbeProxyHealth.mockResolvedValue({
      ok: true,
      body: { status: 'ok', version: '1.1.3' },
    });
    captureOutput();

    const code = await runUpdateCommand(['--yes', '--force'], {
      currentVersion: '1.1.2',
      fetchLatestVersion: async () => '1.1.3',
      readInstalledVersion: () => '1.1.3',
      packageRoot: checkout,
      isTTY: true,
      daemonLogPath: join(tempDir, 'daemon.log'),
      sleep: async () => {},
      healthAttempts: 1,
      healthDelayMs: 1,
      platform: 'linux',
    });

    expect(code).toBe(0);
    const unit = readFileSync(unitPath, 'utf-8');
    expect(unit).toContain('/usr/lib/node_modules/saros-proxy/dist/index.js');
    expect(unit).not.toContain('.pnpm/saros-proxy@');
    expect(unit).toContain('serve --port 4242');
    const commands = mockExecFileSync.mock.calls.map((call) =>
      [call[0], ...(call[1] as string[])].join(' '),
    );
    const reload = commands.indexOf('systemctl --user daemon-reload');
    const start = commands.indexOf('systemctl --user start saros-proxy.service');
    expect(reload).toBeGreaterThan(-1);
    expect(reload).toBeLessThan(start);
  });

  it('warns about a Windows VBS entry pinned to the old pnpm store', async () => {
    const pnpm = makePnpmInstall();
    const appData = join(tempDir, 'appdata');
    const startup = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    mkdirSync(startup, { recursive: true });
    const vbs = join(startup, 'saros-proxy-daemon.vbs');
    writeFileSync(
      vbs,
      'shell.Run "node ""C:\\Users\\u\\.pnpm\\saros-proxy@1.1.2\\node_modules\\saros-proxy\\dist\\index.js"" start", 0, False\n',
      'utf-8',
    );
    vi.stubEnv('APPDATA', appData);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'npm' && args[0] === 'root') return '/usr/lib/node_modules\n';
      if (command === 'pnpm' && args[0] === 'root') return `${pnpm.pnpmRoot}\n`;
      return '';
    });
    mockGetDaemonState.mockResolvedValue({ running: false, port: 3000 });
    captureOutput();

    const code = await runUpdateCommand(['--yes'], {
      currentVersion: '1.1.2',
      fetchLatestVersion: async () => '1.1.3',
      readInstalledVersion: () => '1.1.3',
      packageRoot: pnpm.packageRoot,
      isTTY: true,
      daemonLogPath: join(tempDir, 'daemon.log'),
      sleep: async () => {},
      healthAttempts: 1,
      healthDelayMs: 1,
      platform: 'win32',
    });

    expect(code).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('saros-proxy autostart install --method %s'),
      vbs,
      expect.stringContaining('.pnpm'),
      'vbs',
    );
  });

  it('warns about a stale Windows entry when already on the latest version', async () => {
    const appData = join(tempDir, 'appdata');
    const startup = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    mkdirSync(startup, { recursive: true });
    const vbs = join(startup, 'saros-proxy-daemon.vbs');
    writeFileSync(
      vbs,
      'shell.Run "node ""C:\\Users\\u\\.pnpm\\saros-proxy@1.1.2\\node_modules\\saros-proxy\\dist\\index.js"" start", 0, False\n',
      'utf-8',
    );
    vi.stubEnv('APPDATA', appData);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mockExecFileSync.mockImplementation(() => '');
    mockGetDaemonState.mockResolvedValue({ running: false, port: 3000 });
    captureOutput();

    const code = await runUpdateCommand([], {
      currentVersion: '1.1.3',
      fetchLatestVersion: async () => '1.1.3',
      packageRoot: '/home/user/Projetos/saros-proxy',
      isTTY: true,
      daemonLogPath: join(tempDir, 'daemon.log'),
      sleep: async () => {},
      healthAttempts: 1,
      healthDelayMs: 1,
      platform: 'win32',
    });

    expect(code).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('autostart install --method %s'),
      vbs,
      expect.stringContaining('saros-proxy@1.1.2'),
      'vbs',
    );
  });

  it('runs pnpm and yarn through a shell on Windows', async () => {
    await withProcessPlatform('win32', async () => {
      const pnpm = makePnpmInstall();
      mockExecFileSync.mockImplementation((command: string) => {
        if (command === 'npm') return '/usr/lib/node_modules\n';
        if (command === 'pnpm') return `${pnpm.pnpmRoot}\n`;
        return '';
      });
      mockGetDaemonState.mockResolvedValue({ running: false, port: 3000 });
      captureOutput();

      expect(
        await runUpdateCommand(['--yes'], {
          currentVersion: '1.1.2',
          fetchLatestVersion: async () => '1.1.3',
          readInstalledVersion: () => '1.1.3',
          packageRoot: pnpm.packageRoot,
          isTTY: true,
          sleep: async () => {},
          healthAttempts: 1,
          healthDelayMs: 1,
          platform: 'win32',
        }),
      ).toBe(0);

      const pnpmCalls = mockExecFileSync.mock.calls.filter((call) => call[0] === 'pnpm');
      expect(pnpmCalls.length).toBeGreaterThanOrEqual(2);
      for (const call of pnpmCalls) expect(call[2]).toMatchObject({ shell: true });

      const yarn = makeYarnInstall();
      mockExecFileSync.mockReset();
      mockExecFileSync.mockImplementation((command: string) => {
        if (command === 'npm') return '/usr/lib/node_modules\n';
        if (command === 'yarn') return `${yarn.yarnDir}\n`;
        return '';
      });
      captureOutput();

      expect(
        await runUpdateCommand(['--yes'], {
          currentVersion: '1.1.2',
          fetchLatestVersion: async () => '1.1.3',
          readInstalledVersion: () => '1.1.3',
          packageRoot: yarn.packageRoot,
          isTTY: true,
          sleep: async () => {},
          healthAttempts: 1,
          healthDelayMs: 1,
          platform: 'win32',
        }),
      ).toBe(0);

      const yarnCalls = mockExecFileSync.mock.calls.filter((call) => call[0] === 'yarn');
      expect(yarnCalls.length).toBeGreaterThanOrEqual(2);
      for (const call of yarnCalls) expect(call[2]).toMatchObject({ shell: true });
    });
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
      entryPoint: '/usr/lib/node_modules/saros-proxy/dist/index.js',
    });
    expect(mockProbeProxyHealth).toHaveBeenCalledWith(3100);
  });

  it('starts the global package entry point from a forced checkout and threads port/config', async () => {
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'npm' && args[0] === 'root') return '/usr/lib/node_modules\n';
      if (command === 'systemctl' && args[1] === 'is-active') return 'inactive\n';
      return '';
    });
    mockGetDaemonState.mockResolvedValue({
      running: true,
      port: 3100,
      pid: '1234',
      health: { status: 'ok', version: '1.1.3' },
    });
    mockDaemonStop.mockResolvedValue(true);
    mockDaemonStart.mockResolvedValue(undefined);
    mockProbeProxyHealth.mockResolvedValue({
      ok: true,
      body: { status: 'ok', version: '1.1.3' },
    });
    captureOutput();

    const code = await runUpdateCommand(
      ['--yes', '--force', '--port', '3100', '--config', '/tmp/saros.yaml'],
      {
        currentVersion: '1.1.2',
        fetchLatestVersion: async () => '1.1.3',
        readInstalledVersion: () => '1.1.3',
        packageRoot: '/home/user/Projetos/saros-proxy',
        sleep: async () => {},
        healthAttempts: 2,
        healthDelayMs: 1,
        platform: 'linux',
      },
    );

    expect(code).toBe(0);
    expect(mockGetDaemonState).toHaveBeenCalledWith({
      port: 3100,
      configPath: '/tmp/saros.yaml',
    });
    expect(mockDaemonStop).toHaveBeenCalledWith({
      exitOnComplete: false,
      port: 3100,
      configPath: '/tmp/saros.yaml',
    });
    expect(mockDaemonStart).toHaveBeenCalledWith(3100, '/tmp/saros.yaml', {
      exitOnComplete: false,
      entryPoint: '/usr/lib/node_modules/saros-proxy/dist/index.js',
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

  describe('default port-owner adapters', () => {
    /** ss reports an unmanaged listener on 3100; npm/systemd stay quiet. */
    let listening = true;

    function stubUnmanagedListener(): void {
      // The listener is this very process: it is alive, /proc is readable, and
      // no real signal is ever sent (process.kill is spied in each test).
      listening = true;
      mockExecFileSync.mockImplementation((command: string, args: string[]) => {
        if (command === 'npm' && args[0] === 'root') return '/usr/lib/node_modules\n';
        if (command === 'systemctl' && args[1] === 'is-active') return 'inactive\n';
        if (command === 'ss') {
          return listening
            ? `LISTEN 0 511 127.0.0.1:3100 0.0.0.0:* users:(("node",pid=${process.pid},fd=22))\n`
            : '';
        }
        return '';
      });
      mockGetDaemonState.mockResolvedValue({
        running: true,
        port: 3100,
        pid: null,
        health: { status: 'ok', version: '1.1.2' },
        pidDir: '/home/u/.config/saros',
        legacyPidFile: null,
      });
      mockDaemonStart.mockResolvedValue(undefined);
      mockProbeProxyHealth.mockResolvedValue({
        ok: true,
        body: { status: 'ok', version: '1.1.3' },
      });
    }

    const deps: Partial<UpdateDependencies> = {
      currentVersion: '1.1.2',
      fetchLatestVersion: async () => '1.1.3',
      readInstalledVersion: () => '1.1.3',
      packageRoot: '/usr/lib/node_modules/saros-proxy',
      sleep: async () => {},
      healthAttempts: 2,
      healthDelayMs: 1,
      platform: 'linux',
    };

    it('finds the PID with ss and sends the default SIGTERM', async () => {
      stubUnmanagedListener();
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        listening = false;
        return true;
      });
      const out = captureOutput();

      const code = await runUpdateCommand(['--yes'], deps);

      expect(code).toBe(0);
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      expect(out.all()).toContain(`Sent SIGTERM to PID ${process.pid}`);
      expect(out.all()).toContain('Updated to 1.1.3');
    });

    it('treats an already-exited PID (ESRCH) as stopped', async () => {
      stubUnmanagedListener();
      vi.spyOn(process, 'kill').mockImplementation(() => {
        listening = false;
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      });
      const out = captureOutput();

      const code = await runUpdateCommand(['--yes'], deps);

      expect(code).toBe(0);
      expect(out.all()).not.toContain('Could not stop');
      expect(out.all()).toContain('Updated to 1.1.3');
    });

    it('reports a signal the OS refuses (EPERM)', async () => {
      stubUnmanagedListener();
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('EPERM: operation not permitted'), {
          code: 'EPERM',
        });
      });
      const out = captureOutput();

      expect(await runUpdateCommand(['--yes'], deps)).toBe(1);

      expect(mockDaemonStart).not.toHaveBeenCalled();
      expect(out.all()).toContain(`Could not stop PID ${process.pid}: EPERM`);
    });
  });
});
