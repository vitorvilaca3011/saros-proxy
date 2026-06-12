/**
 * autostart.test.ts — Tests for the autostart install/uninstall/status commands.
 *
 * On Windows these operate on the Startup folder or Registry; on other platforms
 * they are no-ops or create platform-specific entries. We test by pointing APPDATA
 * to a temp directory and mocking child_process for Registry operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mock child_process so Registry tests never touch the real registry
// ---------------------------------------------------------------------------

const mockExecFileSync = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createStartupDir(): string {
  const base = join(tmpdir(), `saros-autostart-test-${Date.now()}`);
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
    autostartInstall(undefined, 'vbs');

    const vbsPath = join(startupDir, 'saros-proxy-daemon.vbs');
    expect(existsSync(vbsPath)).toBe(true);
  });

  it('install with --port embeds the port in the VBS', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');
    autostartInstall(4000, 'vbs');

    const vbsPath = join(startupDir, 'saros-proxy-daemon.vbs');
    expect(existsSync(vbsPath)).toBe(true);
    const content = readFileSync(vbsPath, 'utf-8');
    expect(content).toContain('--port 4000');
  });

  it('status reports installed when VBS exists', async () => {
    const { autostartInstall, autostartStatus } = await import('../src/cli/autostart.js');
    autostartInstall(undefined, 'vbs');

    // Should not throw
    expect(() => autostartStatus('vbs')).not.toThrow();
  });

  it('uninstall removes the VBS file', async () => {
    const { autostartInstall, autostartUninstall } = await import('../src/cli/autostart.js');
    autostartInstall(undefined, 'vbs');
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

    autostartInstall(undefined, 'registry');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'reg',
      expect.arrayContaining(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']),
      expect.any(Object),
    );
  });

  it('install with port includes port flag', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    const { autostartInstall } = await import('../src/cli/autostart.js');

    autostartInstall(5000, 'registry');

    // The /d value should contain --port 5000
    const call = mockExecFileSync.mock.calls.find(
      (c: unknown[]) => c[0] === 'reg' && c[1]?.[0] === 'add',
    );
    expect(call).toBeDefined();
    const dFlagIndex = (call[1] as string[]).indexOf('/d');
    expect(dFlagIndex).toBeGreaterThan(-1);
    expect((call[1] as string[])[dFlagIndex + 1]).toContain('--port 5000');
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
    autostartInstall(undefined, 'vbs');
    autostartInstall(undefined, 'registry');

    // Uninstall both
    autostartUninstall();

    // VBS should be gone
    expect(existsSync(join(startupDir, 'saros-proxy-daemon.vbs'))).toBe(false);
  });
});

describe('detectThirdPartyAv', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
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

  it('returns vbs when no AV detected (auto mode)', async () => {
    const { resolveMethod } = await import('../src/cli/autostart.js');
    expect(resolveMethod('auto', false)).toBe('vbs');
  });

  it('defaults to vbs when no method and no AV', async () => {
    const { resolveMethod } = await import('../src/cli/autostart.js');
    expect(resolveMethod(undefined, false)).toBe('vbs');
  });

  it('defaults to registry when no method and AV detected', async () => {
    const { resolveMethod } = await import('../src/cli/autostart.js');
    expect(resolveMethod(undefined, true)).toBe('registry');
  });
});
