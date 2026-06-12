/**
 * autostart.ts — Register/unregister the daemon to start on user login.
 *
 * Methods:
 *   registry  — HKCU\Software\Microsoft\Windows\CurrentVersion\Run (default)
 *   vbs       — VBScript in Windows Startup folder (legacy, may trigger AV)
 *   auto      — detect third-party AV → registry, else vbs
 *
 * macOS:    creates a launchd agent plist (TODO)
 * Linux:    creates a systemd --user service (TODO)
 */

import { existsSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutostartMethod = 'vbs' | 'registry' | 'auto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REG_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_VALUE_NAME = 'Saros Proxy';

/** Known third-party antivirus process names (lowercase, without .exe). */
const AV_PROCESS_NAMES = new Set([
  'bdagent',       // Bitdefender
  'bdservicehost', // Bitdefender
  'vsserv',        // Bitdefender
  'ccsvchst',      // Norton
  'ns',            // Norton
  'avp',           // Kaspersky
  'avastui',       // Avast
  'aswidsagenta',  // Avast
  'mctray',        // McAfee
  'masvc',         // McAfee
  'ekrn',          // ESET
  'egui',          // ESET
  'avgui',         // AVG
  'avgsvc',        // AVG
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Windows Startup folder (%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup) */
function windowsStartupDir(): string {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function vbsPath(): string {
  return join(windowsStartupDir(), 'saros-proxy-daemon.vbs');
}

/**
 * Resolve the saros-proxy command path.
 * On Windows with a global install this is typically %APPDATA%\npm\saros-proxy.cmd.
 * Falls back to the bare command name which works if the npm bin directory is on PATH.
 */
function resolveCommand(): string {
  const viaDist = join(import.meta.dirname!, '..', '..', 'dist', 'index.js');
  if (existsSync(viaDist)) {
    return `"${process.execPath}" "${viaDist}"`;
  }
  // Fallback: assume `saros-proxy` is on PATH
  return 'saros-proxy';
}

/** Build the full command string to put in the registry or VBS. */
function fullCommand(port?: number): string {
  const cmd = resolveCommand();
  const portArg = port ? ` --port ${port}` : '';
  return `${cmd} start${portArg}`;
}

// ---------------------------------------------------------------------------
// AV detection
// ---------------------------------------------------------------------------

/**
 * Check if a specific process name is running (Windows).
 * Returns true if found, false on any failure.
 */
function isProcessRunning(name: string): boolean {
  try {
    const out = execFileSync('tasklist', ['/nh', '/fo', 'csv', '/fi', `IMAGENAME eq ${name}.exe`], {
      windowsHide: true,
      stdio: 'pipe',
      timeout: 5000,
    });
    // If tasklist finds the process, output contains more than just the header
    return out.toString().includes('.exe');
  } catch {
    return false;
  }
}

/**
 * Detect third-party antivirus by scanning running processes.
 * Exported for testing.
 */
export function detectThirdPartyAv(): boolean {
  if (process.platform !== 'win32') return false;
  for (const name of AV_PROCESS_NAMES) {
    if (isProcessRunning(name)) return true;
  }
  return false;
}

/**
 * Resolve the effective method based on user preference and environment.
 * Exported for testing.
 */
export function resolveMethod(method?: AutostartMethod, avDetected?: boolean): 'vbs' | 'registry' {
  if (method === 'vbs') return 'vbs';
  if (method === 'registry') return 'registry';
  // auto or undefined → detect
  if (process.platform !== 'win32') return 'registry';
  const hasAv = avDetected ?? detectThirdPartyAv();
  if (hasAv) return 'registry';
  // No third-party AV — use VBS (lighter, no registry noise)
  return 'vbs';
}

// ---------------------------------------------------------------------------
// Registry method (HKCU\...\Run)
// ---------------------------------------------------------------------------

function registryInstall(port?: number): void {
  const cmd = fullCommand(port);
  execFileSync('reg', [
    'add', REG_RUN_KEY,
    '/v', REG_VALUE_NAME,
    '/d', cmd,
    '/f',
  ], { windowsHide: true, stdio: 'pipe', timeout: 5000 });
  console.log(`Auto-start installed via Registry: ${REG_RUN_KEY}\\${REG_VALUE_NAME}`);
}

function registryUninstall(): void {
  try {
    execFileSync('reg', [
      'delete', REG_RUN_KEY,
      '/v', REG_VALUE_NAME,
      '/f',
    ], { windowsHide: true, stdio: 'pipe', timeout: 5000 });
    console.log(`Auto-start removed from Registry: ${REG_RUN_KEY}\\${REG_VALUE_NAME}`);
  } catch {
    console.log('No auto-start entry found in Registry.');
  }
}

function registryStatus(): boolean {
  try {
    const out = execFileSync('reg', [
      'query', REG_RUN_KEY,
      '/v', REG_VALUE_NAME,
    ], { windowsHide: true, stdio: 'pipe', timeout: 5000 });
    return out.toString().includes(REG_VALUE_NAME);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// VBS method (Startup folder)
// ---------------------------------------------------------------------------

function vbsInstall(port?: number): void {
  const cmd = resolveCommand();
  const portArg = port ? ` --port ${port}` : '';
  // VBScript strings use " as delimiter; inline quotes must be doubled ("").
  const escapedCommand = cmd.replace(/"/g, '""');
  const vbs = [
    "' Saros proxy auto-start (generated by `saros-proxy autostart install`)",
    'Dim shell',
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${escapedCommand} start${portArg}", 0, False`,
    'Set shell = Nothing',
  ].join('\n');

  writeFileSync(vbsPath(), vbs, 'utf-8');
  console.log(`Auto-start installed via VBS: ${vbsPath()}`);
}

function vbsUninstall(): void {
  const path = vbsPath();
  if (!existsSync(path)) {
    console.log('No VBS auto-start entry found.');
    return;
  }
  rmSync(path);
  console.log(`Auto-start removed: ${path}`);
}

function vbsExists(): boolean {
  return existsSync(vbsPath());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function autostartInstall(port?: number, method?: AutostartMethod): void {
  const resolved = resolveMethod(method);
  if (resolved === 'registry') {
    registryInstall(port);
  } else {
    vbsInstall(port);
  }
}

export function autostartUninstall(method?: AutostartMethod): void {
  if (method === 'vbs') {
    vbsUninstall();
  } else if (method === 'registry') {
    registryUninstall();
  } else {
    // Unspecified — clean up both
    vbsUninstall();
    registryUninstall();
  }
}

export function autostartStatus(method?: AutostartMethod): void {
  if (method === 'vbs') {
    const path = vbsPath();
    if (vbsExists()) {
      const content = readFileSync(path, 'utf-8').trim();
      const match = content.match(/start(--port (\d+))?/);
      const portInfo = match?.[2] ? ` on port ${match[2]}` : '';
      console.log(`Auto-start is enabled (VBS)${portInfo}. File: ${path}`);
    } else {
      console.log('Auto-start is not installed (VBS).');
    }
    return;
  }

  if (method === 'registry') {
    if (registryStatus()) {
      console.log(`Auto-start is enabled (Registry). Key: ${REG_RUN_KEY}\\${REG_VALUE_NAME}`);
    } else {
      console.log('Auto-start is not installed (Registry).');
    }
    return;
  }

  // Check both
  const vbs = vbsExists();
  const reg = registryStatus();
  if (vbs || reg) {
    console.log('Auto-start is enabled:');
    if (vbs) console.log(`  VBS: ${vbsPath()}`);
    if (reg) console.log(`  Registry: ${REG_RUN_KEY}\\${REG_VALUE_NAME}`);
  } else {
    console.log('Auto-start is not installed.');
  }
}
