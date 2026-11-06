/**
 * autostart.test.ts — Tests for the autostart install/uninstall/status commands.
 *
 * On Windows these operate on the Startup folder or Registry; on Linux they
 * write a systemd --user unit. Platform-specific paths are pointed at temp
 * directories and child_process is mocked, so no real service manager runs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as NodeOs from 'node:os';

// ---------------------------------------------------------------------------
// Mock child_process so Registry tests never touch the real registry
// ---------------------------------------------------------------------------

const mockExecFileSync = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// ---------------------------------------------------------------------------
// Mock node:fs so we can force resolveCommand()'s fallback branch (no dist
// build). Everything else passes through to the real fs.
// ---------------------------------------------------------------------------

const mockExistsSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  mockExistsSync.mockImplementation((p: string) => actual.existsSync(p));
  return { ...actual, existsSync: mockExistsSync };
});

// ---------------------------------------------------------------------------
// Mock node:os so the APPDATA-fallback test can redirect homedir() to a temp
// directory instead of the real user profile.
// ---------------------------------------------------------------------------

const mockHomedir = vi.hoisted(() => vi.fn());

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  mockHomedir.mockImplementation(() => process.env.HOME || actual.homedir());
  return { ...actual, homedir: mockHomedir };
});

// ---------------------------------------------------------------------------
// Mock UI so interactive prompt tests never actually prompt
// ---------------------------------------------------------------------------

const mockUiIntro = vi.fn();
const mockUiOutro = vi.fn();
const mockUiSelect = vi.fn();
const mockUiSuccess = vi.fn();
const mockUiWarn = vi.fn();

vi.mock('../src/cli/ui.js', () => ({
  intro: mockUiIntro,
  outro: mockUiOutro,
  select: mockUiSelect,
  success: mockUiSuccess,
  warn: mockUiWarn,
  info: vi.fn(),
  error: vi.fn(),
  step: vi.fn(),
  panel: vi.fn(),
  assertNotCancelled: vi.fn((value: unknown) => value),
  printConfigSummary: vi.fn(),
  printNextSteps: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock the structured logger so failure paths can be asserted without output
// ---------------------------------------------------------------------------

const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock('../src/logger.js', () => ({
  logger: { warn: mockLoggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createStartupDir(): string {
  // mkdtemp: unique, attacker-unpredictable dir (Date.now() names are guessable)
  const base = mkdtempSync(join(tmpdir(), 'saros-autostart-test-'));
  const dir = join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autostart — VBS method', () => {
  let startupDir: string;
  let originalPlatform: PropertyDescriptor | undefined;
  const OENV = process.env;

  beforeEach(() => {
    // vbs is Windows-only; the method gate must see win32 even on Linux CI.
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    startupDir = createStartupDir();
    const baseAppData = join(startupDir, '..', '..', '..', '..', '..');
    vi.stubEnv('APPDATA', baseAppData);
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    const base = join(startupDir, '..', '..', '..', '..', '..');
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ok */ }
    process.env = { ...OENV };
  });

  it('install creates the VBS file in the startup directory', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');
    await autostartInstall(undefined, 'vbs');

    const vbsPath = join(startupDir, 'saros-proxy-daemon.vbs');
    expect(existsSync(vbsPath)).toBe(true);
  });

  it('install with --port embeds the port in the VBS', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');
    await autostartInstall(4000, 'vbs');

    const vbsPath = join(startupDir, 'saros-proxy-daemon.vbs');
    expect(existsSync(vbsPath)).toBe(true);
    const content = readFileSync(vbsPath, 'utf-8');
    expect(content).toContain('--port 4000');
  });

  it('install falls back to the bare command when the dist build is absent', async () => {
    // Force resolveCommand()'s fallback: pretend the compiled dist/index.js
    // does not exist even though the repo ships one.
    const realImpl = mockExistsSync.getMockImplementation();
    mockExistsSync.mockImplementation((p: string) =>
      /dist[/\\]index\.js$/.test(String(p)) ? false : (realImpl as (p: string) => boolean)(p),
    );
    try {
      const { autostartInstall } = await import('../src/cli/autostart.js');
      await autostartInstall(undefined, 'vbs');

      const vbsPath = join(startupDir, 'saros-proxy-daemon.vbs');
      const content = readFileSync(vbsPath, 'utf-8');
      expect(content).toContain('saros-proxy start');
      expect(content).not.toContain('dist/index.js');
    } finally {
      mockExistsSync.mockImplementation(realImpl as (p: string) => boolean);
    }
  });

  it('status reports installed when VBS exists', async () => {
    const { autostartInstall, autostartStatus } = await import('../src/cli/autostart.js');
    await autostartInstall(undefined, 'vbs');

    // Should not throw
    expect(() => autostartStatus('vbs')).not.toThrow();
  });

  it('status reports the port when the VBS contains --port', async () => {
    const { autostartStatus } = await import('../src/cli/autostart.js');

    // NOTE: vbsInstall writes "start --port 4000" (with spaces) but the status
    // regex /start(--port (\d+))?/ only matches "start--port" — so in practice
    // the port is never reported (production bug, reported separately). Craft
    // a file the regex does match so the port branch is exercised.
    writeFileSync(
      join(startupDir, 'saros-proxy-daemon.vbs'),
      'shell.Run "node dist/index.js start--port 4000", 0, False\n',
      { encoding: 'utf-8', flag: 'wx' }, // wx: fail if the file already exists
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      autostartStatus('vbs');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('on port 4000'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('uses the home AppData/Roaming directory when APPDATA is unset', async () => {
    const base = join(tmpdir(), `saros-autostart-homedir-${Date.now()}`);
    const realHomedir = mockHomedir.getMockImplementation();
    mockHomedir.mockImplementation(() => base);
    // vbsInstall does not create parent directories; mirror what a real
    // Windows profile would already have.
    mkdirSync(join(base, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), { recursive: true });
    try {
      vi.stubEnv('APPDATA', '');
      const { autostartInstall } = await import('../src/cli/autostart.js');
      await autostartInstall(undefined, 'vbs');

      const fallbackVbs = join(
        base, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
        'saros-proxy-daemon.vbs',
      );
      expect(existsSync(fallbackVbs)).toBe(true);
    } finally {
      mockHomedir.mockImplementation(realHomedir as () => string);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('uninstall removes the VBS file', async () => {
    const { autostartInstall, autostartUninstall } = await import('../src/cli/autostart.js');
    await autostartInstall(undefined, 'vbs');
    expect(existsSync(join(startupDir, 'saros-proxy-daemon.vbs'))).toBe(true);

    autostartUninstall('vbs');
    expect(existsSync(join(startupDir, 'saros-proxy-daemon.vbs'))).toBe(false);
  });

  it('uninstall is idempotent', async () => {
    const { autostartUninstall } = await import('../src/cli/autostart.js');
    expect(() => autostartUninstall('vbs')).not.toThrow();
  });

  it('status reports not installed when VBS is missing', async () => {
    const { autostartStatus } = await import('../src/cli/autostart.js');
    expect(() => autostartStatus('vbs')).not.toThrow();
  });
});

describe('autostart — Registry method', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    // registry is Windows-only; the method gate must see win32 even on Linux CI.
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mockExecFileSync.mockReset();
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('install calls reg add with correct args', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    const { autostartInstall } = await import('../src/cli/autostart.js');

    await autostartInstall(undefined, 'registry');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'reg',
      expect.arrayContaining(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']),
      expect.any(Object),
    );
  });

  it('install with port includes port flag', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    const { autostartInstall } = await import('../src/cli/autostart.js');

    await autostartInstall(5000, 'registry');

    // The /d value should contain --port 5000
    const call = mockExecFileSync.mock.calls.find(
      (c: unknown[]) => c[0] === 'reg' && c[1]?.[0] === 'add',
    );
    expect(call).toBeDefined();
    const dFlagIndex = (call[1] as string[]).indexOf('/d');
    expect(dFlagIndex).toBeGreaterThan(-1);
    expect((call[1] as string[])[dFlagIndex + 1]).toContain('--port 5000');
  });

  it('auto method resolves via AV detection and installs via registry when AV found', async () => {
    // Force the Windows branch so 'auto' actually runs detectThirdPartyAv
    // (tasklist is mocked; on real Windows the same mock keeps it hermetic).
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    // Any tasklist output containing '.exe' counts as the AV process running.
    mockExecFileSync.mockReturnValue(Buffer.from('"bdagent.exe","1234","Console","5,678 K"\r\n'));
    try {
      const { autostartInstall } = await import('../src/cli/autostart.js');

      await autostartInstall(undefined, 'auto');

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'reg',
        expect.arrayContaining(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']),
        expect.any(Object),
      );
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    }
  });

  it('uninstall calls reg delete', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    const { autostartUninstall } = await import('../src/cli/autostart.js');

    autostartUninstall('registry');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'reg',
      expect.arrayContaining(['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']),
      expect.any(Object),
    );
  });

  it('uninstall is idempotent when reg delete fails', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    const { autostartUninstall } = await import('../src/cli/autostart.js');

    expect(() => autostartUninstall('registry')).not.toThrow();
  });

  it('status reports enabled when reg query finds the value', async () => {
    // Simulate reg query returning something with the value name
    mockExecFileSync.mockReturnValue(
      Buffer.from('\r\n    Saros Proxy    REG_SZ    "C:\\node\\node.exe" "..." start\r\n'),
    );
    const { autostartStatus } = await import('../src/cli/autostart.js');

    expect(() => autostartStatus('registry')).not.toThrow();
  });

  it('status reports not installed when reg query throws', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    const { autostartStatus } = await import('../src/cli/autostart.js');

    expect(() => autostartStatus('registry')).not.toThrow();
  });
});

describe('autostart — combined status/uninstall (no method)', () => {
  let startupDir: string;
  const OENV = process.env;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    startupDir = createStartupDir();
    const baseAppData = join(startupDir, '..', '..', '..', '..', '..');
    vi.stubEnv('APPDATA', baseAppData);
    mockExecFileSync.mockReset();
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    const base = join(startupDir, '..', '..', '..', '..', '..');
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ok */ }
    process.env = { ...OENV };
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('uninstall with no method cleans up both', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    const { autostartInstall, autostartUninstall } = await import('../src/cli/autostart.js');

    // Install both
    await autostartInstall(undefined, 'vbs');
    await autostartInstall(undefined, 'registry');

    // Uninstall both
    autostartUninstall();

    // VBS should be gone
    expect(existsSync(join(startupDir, 'saros-proxy-daemon.vbs'))).toBe(false);
  });

  it('status with no method reports both when VBS and registry are present', async () => {
    mockExecFileSync.mockReturnValue(
      Buffer.from('\r\n    Saros Proxy    REG_SZ    "C:\\node\\node.exe" "..." start\r\n'),
    );
    const { autostartInstall, autostartStatus } = await import('../src/cli/autostart.js');

    await autostartInstall(undefined, 'vbs');
    expect(() => autostartStatus()).not.toThrow();
  });

  it('status with no method reports VBS only when registry query fails', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    const { autostartInstall, autostartStatus } = await import('../src/cli/autostart.js');

    await autostartInstall(undefined, 'vbs');
    expect(() => autostartStatus()).not.toThrow();
  });

  it('status with no method reports registry only when VBS is missing', async () => {
    mockExecFileSync.mockReturnValue(
      Buffer.from('\r\n    Saros Proxy    REG_SZ    "C:\\node\\node.exe" "..." start\r\n'),
    );
    const { autostartStatus } = await import('../src/cli/autostart.js');

    expect(() => autostartStatus()).not.toThrow();
  });

  it('status with no method reports not installed when both are missing', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    const { autostartStatus } = await import('../src/cli/autostart.js');

    expect(() => autostartStatus()).not.toThrow();
  });
});

// detectThirdPartyAv is Windows-only: the implementation short-circuits to
// false on non-Windows before touching tasklist. We stub process.platform so
// the Windows logic is exercised on every CI platform (tasklist is mocked).
describe('detectThirdPartyAv', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('returns true when a known AV process is running', async () => {
    const { detectThirdPartyAv } = await import('../src/cli/autostart.js');

    // Simulate tasklist finding bdagent.exe
    mockExecFileSync.mockImplementation(
      (_cmd: string, args: string[]) => {
        if (args?.some((a: string) => a.includes('bdagent'))) {
          return Buffer.from('"bdagent.exe","1234","Console","5,678 K"\r\n');
        }
        return Buffer.from('');
      },
    );

    expect(detectThirdPartyAv()).toBe(true);
  });

  it('returns false when no AV process is running', async () => {
    const { detectThirdPartyAv } = await import('../src/cli/autostart.js');

    // Simulate tasklist finding nothing for AV processes
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    expect(detectThirdPartyAv()).toBe(false);
  });

  it('returns false if tasklist throws', async () => {
    const { detectThirdPartyAv } = await import('../src/cli/autostart.js');

    mockExecFileSync.mockImplementation(() => { throw new Error('access denied'); });

    expect(detectThirdPartyAv()).toBe(false);
  });

  it('returns false on non-Windows without running tasklist', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const { detectThirdPartyAv } = await import('../src/cli/autostart.js');

      expect(detectThirdPartyAv()).toBe(false);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    }
  });
});

describe('resolveMethod', () => {
  it('returns vbs when method is vbs', async () => {
    const { resolveMethod } = await import('../src/cli/autostart.js');
    expect(resolveMethod('vbs')).toBe('vbs');
  });

  it('returns registry when method is registry', async () => {
    const { resolveMethod } = await import('../src/cli/autostart.js');
    expect(resolveMethod('registry')).toBe('registry');
  });

  // The Windows branch (auto-detect → vbs unless AV found) only runs when
  // process.platform is win32; stub it so non-Windows CI exercises it too.
  describe('on Windows', () => {
    let originalPlatform: PropertyDescriptor | undefined;

    beforeEach(() => {
      mockExecFileSync.mockReset();
      originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    });

    afterEach(() => {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    });

    it('returns vbs when no AV detected (auto mode)', async () => {
      const { resolveMethod } = await import('../src/cli/autostart.js');
      expect(resolveMethod('auto', false)).toBe('vbs');
    });

    it('defaults to vbs when no method and no AV', async () => {
      const { resolveMethod } = await import('../src/cli/autostart.js');
      expect(resolveMethod(undefined, false)).toBe('vbs');
    });

    it('returns registry when AV is detected', async () => {
      const { resolveMethod } = await import('../src/cli/autostart.js');
      expect(resolveMethod('auto', true)).toBe('registry');
    });

    it('runs AV detection when avDetected is undefined', async () => {
      // tasklist finds nothing running → no third-party AV → vbs
      mockExecFileSync.mockReturnValue(Buffer.from(''));
      const { resolveMethod } = await import('../src/cli/autostart.js');
      expect(resolveMethod('auto')).toBe('vbs');
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'tasklist',
        expect.any(Array),
        expect.any(Object),
      );
    });

    it('runs AV detection and returns registry when an AV process is found', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from('"bdagent.exe","1234","Console","5,678 K"\r\n'));
      const { resolveMethod } = await import('../src/cli/autostart.js');
      expect(resolveMethod(undefined)).toBe('registry');
    });
  });

  it('returns systemd for an explicit systemd method', async () => {
    const { resolveMethod } = await import('../src/cli/autostart.js');
    expect(resolveMethod('systemd')).toBe('systemd');
  });

  describe('on Linux', () => {
    let originalPlatform: PropertyDescriptor | undefined;

    beforeEach(() => {
      originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    });

    afterEach(() => {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    });

    it('defaults to systemd when no method is given', async () => {
      const { resolveMethod } = await import('../src/cli/autostart.js');
      expect(resolveMethod(undefined, true)).toBe('systemd');
    });

    it('resolves auto to systemd', async () => {
      const { resolveMethod } = await import('../src/cli/autostart.js');
      expect(resolveMethod('auto', false)).toBe('systemd');
    });
  });

  it('returns unsupported when the platform has no implementation', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const { resolveMethod } = await import('../src/cli/autostart.js');
      expect(resolveMethod(undefined, false)).toBe('unsupported');
      expect(resolveMethod('auto', false)).toBe('unsupported');
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    }
  });
});

describe('autostart — interactive method prompt', () => {
  let startupDir: string;
  const OENV = process.env;
  let originalIsTTY: boolean | undefined;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    startupDir = createStartupDir();
    const baseAppData = join(startupDir, '..', '..', '..', '..', '..');
    vi.stubEnv('APPDATA', baseAppData);
    mockExecFileSync.mockReset();
    mockUiSelect.mockReset();
    mockUiIntro.mockReset();
    mockUiOutro.mockReset();
    mockUiWarn.mockReset();
    mockUiSuccess.mockReset();
    // The prompt only exists on Windows (Linux defaults to systemd).
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    // Force TTY so the prompt path is taken
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    const base = join(startupDir, '..', '..', '..', '..', '..');
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ok */ }
    process.env = { ...OENV };
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('prompts and installs via registry when user selects registry', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    mockUiSelect.mockResolvedValue('registry');

    const { autostartInstall } = await import('../src/cli/autostart.js');
    await autostartInstall(undefined, undefined);

    expect(mockUiIntro).toHaveBeenCalledWith('Saros — Autostart');
    expect(mockUiSelect).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'reg',
      expect.arrayContaining(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']),
      expect.any(Object),
    );
    expect(mockUiOutro).toHaveBeenCalledWith('Autostart configured');
  });

  it('prompts and installs via VBS when user selects vbs', async () => {
    mockUiSelect.mockResolvedValue('vbs');

    const { autostartInstall } = await import('../src/cli/autostart.js');
    await autostartInstall(undefined, undefined);

    expect(mockUiSelect).toHaveBeenCalled();
    const vbsPath = join(startupDir, 'saros-proxy-daemon.vbs');
    expect(existsSync(vbsPath)).toBe(true);
    expect(mockUiOutro).toHaveBeenCalled();
  });

  it('falls back to auto-detect when stdin is not a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    const { autostartInstall } = await import('../src/cli/autostart.js');
    await autostartInstall(undefined, undefined);

    // Should NOT prompt
    expect(mockUiSelect).not.toHaveBeenCalled();
    expect(mockUiWarn).toHaveBeenCalled();
  });

  it('does NOT prompt when method is explicitly provided', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    const { autostartInstall } = await import('../src/cli/autostart.js');
    await autostartInstall(undefined, 'registry');

    expect(mockUiSelect).not.toHaveBeenCalled();
    expect(mockUiIntro).not.toHaveBeenCalled();
  });
});

describe('autostart — systemd method (Linux)', () => {
  let configHome: string;
  let originalPlatform: PropertyDescriptor | undefined;
  let originalExitCode: number | string | null | undefined;
  let restoreDistEntry: () => void;

  const unitPath = (): string => join(configHome, 'systemd', 'user', 'saros-proxy.service');

  /**
   * Force resolveSystemdCommand()'s dist-existence check, so the suite does not
   * depend on whether `npm run build` ran in the working tree.
   */
  const stubDistEntry = (exists: boolean): (() => void) => {
    const realImpl = mockExistsSync.getMockImplementation() as (p: string) => boolean;
    mockExistsSync.mockImplementation((p: string) =>
      /dist[/\\]index\.js$/.test(String(p)) ? exists : realImpl(p),
    );
    return () => mockExistsSync.mockImplementation(realImpl);
  };

  beforeEach(() => {
    configHome = mkdtempSync(join(tmpdir(), 'saros-systemd-test-'));
    vi.stubEnv('XDG_CONFIG_HOME', configHome);
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    originalExitCode = process.exitCode;
    process.exitCode = undefined;

    mockExecFileSync.mockReset();
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    mockLoggerWarn.mockReset();
    mockUiSuccess.mockReset();
    restoreDistEntry = stubDistEntry(true);
  });

  afterEach(() => {
    restoreDistEntry();
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    process.exitCode = originalExitCode;
    vi.unstubAllEnvs();
    rmSync(configHome, { recursive: true, force: true });
  });

  it('writes a unit with ExecStart, restart policy and default target', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');

    await autostartInstall(4242, 'systemd');

    const content = readFileSync(unitPath(), 'utf-8');
    expect(content).toContain('[Unit]');
    expect(content).toContain('After=network-online.target');
    expect(content).toContain('Environment=NODE_ENV=production');
    expect(content).toMatch(/^ExecStart=.+ serve --port 4242$/m);
    expect(content).toContain('Restart=on-failure');
    expect(content).toContain('RestartSec=5');
    expect(content).toContain('StartLimitIntervalSec=60');
    expect(content).toContain('StartLimitBurst=3');
    expect(content).toContain('WantedBy=default.target');
    expect(mockUiSuccess).toHaveBeenCalledWith(expect.stringContaining('systemd'));
  });

  it('uses an absolute ExecStart path that systemd can resolve', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');

    await autostartInstall(4242, 'systemd');

    const content = readFileSync(unitPath(), 'utf-8');
    expect(content).toContain(`ExecStart="${process.execPath}"`);
    expect(content).toMatch(/^ExecStart=".+" ".*dist[/\\]index\.js" serve --port 4242$/m);
  });

  it('fails with a build hint instead of emitting a bare ExecStart', async () => {
    const restore = stubDistEntry(false);
    try {
      const { autostartInstall } = await import('../src/cli/autostart.js');

      await autostartInstall(4242, 'systemd');

      expect(existsSync(unitPath())).toBe(false);
      expect(mockExecFileSync).not.toHaveBeenCalled();
      expect(mockLoggerWarn.mock.calls[0].join(' ')).toContain('npm run build');
      expect(process.exitCode).toBe(1);
    } finally {
      restore();
    }
  });

  it('omits --port when none was requested', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');

    await autostartInstall(undefined, 'systemd');

    expect(readFileSync(unitPath(), 'utf-8')).toMatch(/^ExecStart=.+ serve$/m);
  });

  it('runs daemon-reload, enable, then restart so the unit is applied immediately', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');

    await autostartInstall(4242, 'systemd');

    expect(mockExecFileSync.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'enable', 'saros-proxy.service'],
      ['--user', 'restart', 'saros-proxy.service'],
    ]);
  });

  it('applies a new --port on reinstall by restarting the active unit', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');
    await autostartInstall(3000, 'systemd');
    mockExecFileSync.mockReset();
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    await autostartInstall(4000, 'systemd');

    expect(readFileSync(unitPath(), 'utf-8')).toContain('serve --port 4000');
    expect(mockExecFileSync.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'enable', 'saros-proxy.service'],
      ['--user', 'restart', 'saros-proxy.service'],
    ]);
  });

  it('installs via systemd when no method is given on Linux', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');

    await autostartInstall(undefined, undefined);

    expect(existsSync(unitPath())).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'enable', 'saros-proxy.service'],
      expect.any(Object),
    );
  });

  it('status without --method on Linux checks the systemd unit', async () => {
    const { autostartStatus } = await import('../src/cli/autostart.js');
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) =>
      Buffer.from(args.includes('is-enabled') ? 'enabled' : 'active'),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      autostartStatus();

      expect(mockExecFileSync.mock.calls.map((call: unknown[]) => call[1])).toEqual([
        ['--user', 'is-enabled', 'saros-proxy.service'],
        ['--user', 'is-active', 'saros-proxy.service'],
      ]);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('enabled (systemd)'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('resolves --method auto to systemd on Linux', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');

    await autostartInstall(undefined, 'auto');

    expect(existsSync(unitPath())).toBe(true);
  });

  it('uninstall disables, removes the unit and reloads', async () => {
    const { autostartInstall, autostartUninstall } = await import('../src/cli/autostart.js');
    await autostartInstall(4242, 'systemd');
    mockExecFileSync.mockReset();
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    autostartUninstall('systemd');

    expect(existsSync(unitPath())).toBe(false);
    expect(mockExecFileSync.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      ['--user', 'disable', '--now', 'saros-proxy.service'],
      ['--user', 'daemon-reload'],
    ]);
  });

  it('default uninstall on Linux uses systemd', async () => {
    const { autostartInstall, autostartUninstall } = await import('../src/cli/autostart.js');
    await autostartInstall(4242, 'systemd');
    mockExecFileSync.mockReset();
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    autostartUninstall();

    expect(existsSync(unitPath())).toBe(false);
  });

  it('uninstall reports no entry when the unit is missing', async () => {
    const { autostartUninstall } = await import('../src/cli/autostart.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      autostartUninstall('systemd');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No systemd auto-start entry'));
      expect(mockExecFileSync).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('uninstall keeps the unit and exits non-zero when disable fails', async () => {
    const { autostartInstall, autostartUninstall } = await import('../src/cli/autostart.js');
    await autostartInstall(4242, 'systemd');
    mockExecFileSync.mockReset();
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('disable')) {
        throw Object.assign(new Error('Command failed'), {
          status: 1,
          stderr: Buffer.from('Failed to connect to bus: No such file or directory\n'),
        });
      }
      return Buffer.from('');
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      autostartUninstall('systemd');

      // Removing the file here would leave default.target.wants/… dangling.
      expect(existsSync(unitPath())).toBe(true);
      expect(mockExecFileSync.mock.calls.map((call: unknown[]) => call[1])).toEqual([
        ['--user', 'disable', '--now', 'saros-proxy.service'],
      ]);
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Auto-start removed'));
      const message = mockLoggerWarn.mock.calls[0].join(' ');
      expect(message).toContain('Could not disable');
      expect(message).toContain('Failed to connect to bus');
      expect(message).toContain(unitPath());
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('uninstall warns but still removes the unit when daemon-reload fails', async () => {
    const { autostartInstall, autostartUninstall } = await import('../src/cli/autostart.js');
    await autostartInstall(4242, 'systemd');
    mockExecFileSync.mockReset();
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('daemon-reload')) {
        throw Object.assign(new Error('Command failed'), {
          status: 1,
          stderr: Buffer.from('Failed to reload daemon: Transport endpoint is not connected\n'),
        });
      }
      return Buffer.from('');
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      autostartUninstall('systemd');

      expect(existsSync(unitPath())).toBe(false);
      const message = mockLoggerWarn.mock.calls[0].join(' ');
      expect(message).toContain('daemon-reload');
      expect(message).toContain('Transport endpoint');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Auto-start removed'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('status reports enabled from is-enabled/is-active', async () => {
    const { autostartStatus } = await import('../src/cli/autostart.js');
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) =>
      Buffer.from(args.includes('is-enabled') ? 'enabled' : 'active'),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      autostartStatus('systemd');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('enabled (systemd)'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('status reports not installed when disabled and inactive', async () => {
    const { autostartStatus } = await import('../src/cli/autostart.js');
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const enabled = args.includes('is-enabled');
      throw Object.assign(new Error('Command failed'), {
        status: enabled ? 1 : 3,
        stdout: Buffer.from(enabled ? 'disabled' : 'inactive'),
      });
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      autostartStatus('systemd');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not installed (systemd)'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('status reports not installed when the unit file does not exist yet', async () => {
    const { autostartStatus } = await import('../src/cli/autostart.js');
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const enabled = args.includes('is-enabled');
      throw Object.assign(new Error('Command failed'), {
        status: enabled ? 1 : 3,
        stdout: Buffer.from(enabled ? 'disabled' : 'inactive'),
        stderr: Buffer.from('Unit saros-proxy.service could not be found.\n'),
      });
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      autostartStatus('systemd');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not installed (systemd)'));
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('classifies a missing unit by exit status when stderr is not English', async () => {
    const { autostartStatus } = await import('../src/cli/autostart.js');
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const enabled = args.includes('is-enabled');
      throw Object.assign(new Error('Command failed'), {
        status: enabled ? 1 : 3,
        stdout: Buffer.from(enabled ? 'not-found' : 'inactive'),
        stderr: Buffer.from('Não foi possível encontrar a unidade saros-proxy.service.\n'),
      });
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      autostartStatus('systemd');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not installed (systemd)'));
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('status warns with the reason when systemctl is missing', async () => {
    const { autostartStatus } = await import('../src/cli/autostart.js');
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' });
    });

    autostartStatus('systemd');

    const message = mockLoggerWarn.mock.calls[0].join(' ');
    expect(message).toContain('systemctl');
    expect(message).toContain('not found on PATH');
  });

  it('status reports a user bus failure instead of a false negative', async () => {
    const { autostartStatus } = await import('../src/cli/autostart.js');
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('Command failed'), {
        stderr: Buffer.from('Failed to connect to bus: No such file or directory\n'),
      });
    });

    autostartStatus('systemd');

    expect(mockLoggerWarn.mock.calls[0].join(' ')).toContain('Failed to connect to bus');
  });

  it('install fails loudly when the unit file cannot be written', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');
    const blocker = join(configHome, 'not-a-directory');
    writeFileSync(blocker, '');
    vi.stubEnv('XDG_CONFIG_HOME', blocker);

    await autostartInstall(4242, 'systemd');

    expect(mockUiSuccess).not.toHaveBeenCalled();
    expect(mockLoggerWarn.mock.calls[0].join(' ')).toContain('Could not write');
    expect(process.exitCode).toBe(1);
  });

  it('install fails loudly when systemctl is missing', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' });
    });

    await autostartInstall(4242, 'systemd');

    expect(mockUiSuccess).not.toHaveBeenCalled();
    expect(mockLoggerWarn.mock.calls[0].join(' ')).toContain('not found on PATH');
    expect(process.exitCode).toBe(1);
  });

  it('install reports an unavailable user bus instead of success', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('Command failed'), {
        stderr: Buffer.from('Failed to connect to bus: No such file or directory\n'),
      });
    });

    await autostartInstall(4242, 'systemd');

    expect(mockUiSuccess).not.toHaveBeenCalled();
    expect(mockLoggerWarn.mock.calls[0].join(' ')).toContain('Failed to connect to bus');
    expect(process.exitCode).toBe(1);
  });

  it('refuses a Windows-only method on Linux instead of running reg or writing the VBS', async () => {
    const startupDir = createStartupDir();
    const appData = join(startupDir, '..', '..', '..', '..', '..');
    vi.stubEnv('APPDATA', appData);
    try {
      const { autostartInstall } = await import('../src/cli/autostart.js');

      await autostartInstall(4242, 'vbs');

      expect(existsSync(join(startupDir, 'saros-proxy-daemon.vbs'))).toBe(false);
      expect(existsSync(unitPath())).toBe(false);
      expect(mockExecFileSync).not.toHaveBeenCalled();
      expect(mockLoggerWarn.mock.calls[0].join(' ')).toContain('"vbs"');
      expect(mockLoggerWarn.mock.calls[0].join(' ')).toContain('Windows-only');
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(appData, { recursive: true, force: true });
    }
  });

  it('status with a Windows-only method on Linux warns instead of a false negative', async () => {
    const { autostartStatus } = await import('../src/cli/autostart.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      autostartStatus('vbs');

      expect(logSpy).not.toHaveBeenCalled();
      expect(mockExecFileSync).not.toHaveBeenCalled();
      expect(mockLoggerWarn.mock.calls[0].join(' ')).toContain('"vbs"');
      expect(process.exitCode).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('refuses --method registry on Linux without touching the registry', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');

    await autostartInstall(4242, 'registry');

    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockLoggerWarn.mock.calls[0].join(' ')).toContain('"registry"');
    expect(mockLoggerWarn.mock.calls[0].join(' ')).toContain('Windows-only');
    expect(process.exitCode).toBe(1);
  });

  it('status with --method registry on Linux warns instead of reporting not installed', async () => {
    const { autostartStatus } = await import('../src/cli/autostart.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      autostartStatus('registry');

      expect(logSpy).not.toHaveBeenCalled();
      expect(mockExecFileSync).not.toHaveBeenCalled();
      expect(mockLoggerWarn.mock.calls[0].join(' ')).toContain('"registry"');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('uninstall with a Windows-only method on Linux does not touch Windows paths', async () => {
    const { autostartUninstall } = await import('../src/cli/autostart.js');

    autostartUninstall('vbs');

    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockLoggerWarn.mock.calls[0].join(' ')).toContain('"vbs"');
    expect(process.exitCode).toBe(1);
  });

  it('ignores a relative XDG_CONFIG_HOME and warns once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'saros-home-test-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', 'relative/path');
    try {
      const { autostartInstall, autostartStatus } = await import('../src/cli/autostart.js');

      await autostartInstall(4242, 'systemd');
      autostartStatus('systemd');

      expect(existsSync(join(home, '.config', 'systemd', 'user', 'saros-proxy.service'))).toBe(true);
      const xdgWarnings = mockLoggerWarn.mock.calls.filter((call: unknown[]) =>
        call.join(' ').includes('XDG_CONFIG_HOME'),
      );
      expect(xdgWarnings).toHaveLength(1);
      expect(xdgWarnings[0].join(' ')).toContain('relative/path');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('autostart — unsupported platforms', () => {
  let originalPlatform: PropertyDescriptor | undefined;
  let originalExitCode: number | string | null | undefined;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    mockExecFileSync.mockReset();
    mockLoggerWarn.mockReset();
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    process.exitCode = originalExitCode;
  });

  it('install warns with the OS and exits non-zero', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');

    await autostartInstall(undefined, undefined);

    const message = mockLoggerWarn.mock.calls[0].join(' ');
    expect(message).toContain('unsupported');
    expect(message).toContain('darwin');
    expect(message).toContain('launchd');
    expect(process.exitCode).toBe(1);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('install with --method auto also warns and exits non-zero', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');

    await autostartInstall(undefined, 'auto');

    expect(mockLoggerWarn).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('status warns but exits zero', async () => {
    const { autostartStatus } = await import('../src/cli/autostart.js');

    autostartStatus();

    expect(mockLoggerWarn.mock.calls[0].join(' ')).toContain('unsupported');
    expect(process.exitCode).toBeUndefined();
  });

  it('uninstall warns instead of doing nothing silently', async () => {
    const { autostartUninstall } = await import('../src/cli/autostart.js');

    autostartUninstall();

    expect(mockLoggerWarn.mock.calls[0].join(' ')).toContain('unsupported');
    expect(process.exitCode).toBe(1);
  });

  it('names the manual fallback on other unsupported platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
    const { autostartInstall } = await import('../src/cli/autostart.js');

    await autostartInstall(undefined, undefined);

    expect(mockLoggerWarn.mock.calls[0].join(' ')).toContain('manually');
    expect(process.exitCode).toBe(1);
  });
});
