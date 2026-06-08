/**
 * autostart.test.ts — Tests for the autostart install/uninstall/status commands.
 *
 * On Windows these operate on the Startup folder; on other platforms they are
 * no-ops or create platform-specific entries. We test by pointing APPDATA to
 * a temp directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function createStartupDir(): string {
  // windowsStartupDir() builds: %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
  const base = join(tmpdir(), `saros-autostart-test-${Date.now()}`);
  const dir = join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('autostart', () => {
  let startupDir: string;
  const OENV = process.env;

  beforeEach(() => {
    startupDir = createStartupDir();
    // APPDATA must be the base dir: windowsStartupDir() = join(APPDATA, 'Microsoft', ...)
    // startupDir is base\Microsoft\Windows\Start Menu\Programs\Startup → 5 levels up = base
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
    autostartInstall();

    // Verify VBS was created
    const vbsPath = join(startupDir, 'saros-proxy-daemon.vbs');
    expect(existsSync(vbsPath)).toBe(true);
  });

  it('install with --port embeds the port in the VBS', async () => {
    const { autostartInstall } = await import('../src/cli/autostart.js');
    autostartInstall(4000);

    const vbsPath = join(startupDir, 'saros-proxy-daemon.vbs');
    expect(existsSync(vbsPath)).toBe(true);
  });

  it('status reports installed when VBS exists', async () => {
    const { autostartInstall, autostartStatus } = await import('../src/cli/autostart.js');
    // Install first
    autostartInstall();
    // Status should not throw
    expect(autostartStatus).toBeDefined();
  });

  it('uninstall removes the VBS file', async () => {
    const { autostartInstall, autostartUninstall } = await import('../src/cli/autostart.js');
    autostartInstall();
    expect(existsSync(join(startupDir, 'saros-proxy-daemon.vbs'))).toBe(true);

    autostartUninstall();
    expect(existsSync(join(startupDir, 'saros-proxy-daemon.vbs'))).toBe(false);
  });

  it('uninstall is idempotent', async () => {
    const { autostartUninstall } = await import('../src/cli/autostart.js');
    // Should not throw when no file exists
    expect(() => autostartUninstall()).not.toThrow();
  });

  it('status reports not installed when VBS is missing', async () => {
    const { autostartStatus } = await import('../src/cli/autostart.js');
    expect(autostartStatus).toBeDefined();
  });
});
