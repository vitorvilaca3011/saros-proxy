/**
 * autostart.test.ts — Tests for the autostart install/uninstall/status commands.
 *
 * On Windows these operate on the Startup folder or Registry; on other platforms
 * they are no-ops or create platform-specific entries. We test by pointing APPDATA
 * to a temp directory and mocking child_process for Registry operations.
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
  mockHomedir.mockImplementation(() => actual.homedir());
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
  const OENV = process.env;

  beforeEach(() => {
    startupDir = createStartupDir();
    const baseAppData = join(startupDir, '..', '..', '..', '..', '..');
    vi.stubEnv('APPDATA', baseAppData);
  });

  afterEach(() => {
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
  beforeEach(() => {
    mockExecFileSync.mockReset();
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

  beforeEach(() => {
    startupDir = createStartupDir();
    const baseAppData = join(startupDir, '..', '..', '..', '..', '..');
    vi.stubEnv('APPDATA', baseAppData);
    mockExecFileSync.mockReset();
  });

  afterEach(() => {
    const base = join(startupDir, '..', '..', '..', '..', '..');
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ok */ }
    process.env = { ...OENV };
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

  it('returns registry when AV is detected (auto mode)', async () => {
    const { resolveMethod } = await import('../src/cli/autostart.js');
    expect(resolveMethod('auto', true)).toBe('registry');
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

  it('defaults to registry when no method and AV detected', async () => {
    const { resolveMethod } = await import('../src/cli/autostart.js');
    expect(resolveMethod(undefined, true)).toBe('registry');
  });
});

describe('autostart — interactive method prompt', () => {
  let startupDir: string;
  const OENV = process.env;
  let originalIsTTY: boolean | undefined;

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
    // Force TTY so the prompt path is taken
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    const base = join(startupDir, '..', '..', '..', '..', '..');
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ok */ }
    process.env = { ...OENV };
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
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
