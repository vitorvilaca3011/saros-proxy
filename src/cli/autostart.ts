/**
 * autostart.ts — Register/unregister the daemon to start on user login.
 *
 * Methods:
 *   registry  — HKCU\Software\Microsoft\Windows\CurrentVersion\Run
 *   vbs       — VBScript in Windows Startup folder (legacy, may trigger AV)
 *   systemd   — ~/.config/systemd/user/saros-proxy.service (Linux default)
 *   auto      — platform default: systemd on Linux, AV-aware vbs/registry on Windows
 *
 * macOS:    not implemented (reported as unsupported, never a silent no-op)
 */

import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { logger } from '../logger.js';
import * as ui from './ui.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutostartMethod = 'vbs' | 'registry' | 'systemd' | 'auto';
type ResolvedMethod = 'vbs' | 'registry' | 'systemd';
export type ResolvedAutostartMethod = ResolvedMethod | 'unsupported';

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

/** Path of the compiled entry point, relative to this module. */
function distEntryPath(): string {
  return join(import.meta.dirname!, '..', '..', 'dist', 'index.js');
}

/**
 * Resolve the saros-proxy command path.
 * On Windows with a global install this is typically %APPDATA%\npm\saros-proxy.cmd.
 * Falls back to the bare command name which works if the npm bin directory is on PATH.
 */
function resolveCommand(): string {
  const viaDist = distEntryPath();
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
 * Explicit methods are returned as-is; unknown platforms return 'unsupported'
 * so callers can warn instead of silently doing nothing.
 * Exported for testing.
 */
export function resolveMethod(method?: AutostartMethod, avDetected?: boolean): ResolvedAutostartMethod {
  if (method === 'vbs' || method === 'registry' || method === 'systemd') return method;
  if (process.platform === 'linux') return 'systemd';
  if (process.platform !== 'win32') return 'unsupported';
  // auto or undefined → detect
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
  ui.success(`Auto-start installed via Registry: ${REG_RUN_KEY}\\${REG_VALUE_NAME}`);
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
  ui.success(`Auto-start installed via VBS: ${vbsPath()}`);
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

function vbsStatus(): void {
  const path = vbsPath();
  if (!vbsExists()) {
    console.log('Auto-start is not installed (VBS).');
    return;
  }
  const content = readFileSync(path, 'utf-8').trim();
  const match = content.match(/start\s*--port\s+(\d+)/);
  const portInfo = match?.[1] ? ` on port ${match[1]}` : '';
  console.log(`Auto-start is enabled (VBS)${portInfo}. File: ${path}`);
}

// ---------------------------------------------------------------------------
// systemd method (Linux user manager)
// ---------------------------------------------------------------------------

/** Unit name shared with commands that restart the service (`update`). */
export const SYSTEMD_UNIT_NAME = 'saros-proxy.service';
const SYSTEMCTL_TIMEOUT_MS = 10_000;

/**
 * Exit statuses systemctl documents as answers: `is-enabled` returns 0
 * (enabled) or 1 (disabled/not-found); `is-active` returns 0 (active) or 3
 * (inactive). Anything else — missing binary, no user bus, timeout — is a
 * failure to answer.
 */
const IS_ENABLED_ANSWER_STATUSES: readonly number[] = [0, 1];
const IS_ACTIVE_ANSWER_STATUSES: readonly number[] = [0, 3];

/** Set once so a relative XDG_CONFIG_HOME is reported on the first use only. */
let warnedRelativeXdg = false;

/** `$XDG_CONFIG_HOME/systemd/user`, defaulting to `~/.config/systemd/user`. */
function systemdUserDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME;
  if (configHome && isAbsolute(configHome)) {
    return join(configHome, 'systemd', 'user');
  }
  if (configHome && !warnedRelativeXdg) {
    // The XDG spec requires relative values to be ignored, not resolved against the cwd.
    warnedRelativeXdg = true;
    logger.warn(
      'Ignoring relative XDG_CONFIG_HOME=%s; using %s instead.',
      configHome,
      join(homedir(), '.config'),
    );
  }
  return join(homedir(), '.config', 'systemd', 'user');
}

function systemdUnitPath(): string {
  return join(systemdUserDir(), SYSTEMD_UNIT_NAME);
}

/**
 * Command for `ExecStart`. systemd resolves a bare command name only in
 * /usr/local/bin, /usr/bin, /bin and /sbin — not in the PATH of the shell that
 * ran `install` — so an absolute path is mandatory.
 */
function resolveSystemdCommand(): string {
  const viaDist = distEntryPath();
  if (!existsSync(viaDist)) {
    throw new Error(
      `cannot find ${viaDist}; run \`npm run build\` before installing the systemd unit`,
    );
  }
  return `"${process.execPath}" "${viaDist}"`;
}

/** Build the unit file contents. Exported for testing. */
export function buildSystemdUnit(port?: number): string {
  const portArg = port ? ` --port ${port}` : '';
  return [
    '[Unit]',
    'Description=Saros proxy',
    'After=network-online.target',
    'Wants=network-online.target',
    'StartLimitIntervalSec=60',
    'StartLimitBurst=3',
    '',
    '[Service]',
    'Type=simple',
    // The journal keeps the JSON lines; human rendering is CLI-only.
    'Environment=NODE_ENV=production',
    `ExecStart=${resolveSystemdCommand()} serve${portArg}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** Run `systemctl --user …`, returning trimmed stdout. Throws on failure. */
function runSystemctl(args: string[]): string {
  return execFileSync('systemctl', ['--user', ...args], {
    stdio: 'pipe',
    timeout: SYSTEMCTL_TIMEOUT_MS,
  }).toString().trim();
}

/** Explain why systemctl failed in a way the CLI can print verbatim. */
function describeSystemctlError(err: unknown): string {
  const execError = err as {
    code?: string;
    message?: string;
    stderr?: Buffer | string;
  };
  if (execError.code === 'ENOENT') {
    return '`systemctl` was not found on PATH';
  }
  const stderr = execError.stderr?.toString().trim().split('\n')[0];
  if (stderr) return stderr;
  return execError.message ?? String(err);
}

interface SystemctlQuery {
  output: string;
  /** Set only when the command could not be run (missing binary, no bus). */
  reason?: string;
}

/**
 * Run a read-only systemctl query. Classifies by exit status only: stderr is
 * localised (LANG=pt_BR translates "could not be found"), so it is kept for
 * display and never inspected to decide whether systemd answered.
 */
function querySystemctl(args: string[]): SystemctlQuery {
  try {
    return { output: runSystemctl(args) };
  } catch (err) {
    const execError = err as {
      code?: string;
      status?: number | null;
      stdout?: Buffer | string;
    };
    const output = execError.stdout?.toString().trim() ?? '';
    if (execError.code === 'ENOENT') {
      return { output, reason: describeSystemctlError(err) };
    }
    const answerStatuses = args[0] === 'is-active'
      ? IS_ACTIVE_ANSWER_STATUSES
      : IS_ENABLED_ANSWER_STATUSES;
    if (typeof execError.status === 'number' && answerStatuses.includes(execError.status)) {
      return { output };
    }
    return { output, reason: describeSystemctlError(err) };
  }
}

function systemdInstall(port?: number): void {
  const unitPath = systemdUnitPath();

  let unit: string;
  try {
    unit = buildSystemdUnit(port);
  } catch (err) {
    logger.warn('Cannot install the systemd autostart unit: %s', (err as Error).message);
    process.exitCode = 1;
    return;
  }

  try {
    mkdirSync(systemdUserDir(), { recursive: true });
    writeFileSync(unitPath, unit, 'utf-8');
  } catch (err) {
    logger.warn('Could not write the systemd unit file at %s: %s', unitPath, describeSystemctlError(err));
    process.exitCode = 1;
    return;
  }

  try {
    runSystemctl(['daemon-reload']);
    runSystemctl(['enable', SYSTEMD_UNIT_NAME]);
    // `enable --now` is a no-op start for an active unit, so a reinstall with a
    // new --port would keep the old process. `restart` covers active and inactive.
    runSystemctl(['restart', SYSTEMD_UNIT_NAME]);
  } catch (err) {
    logger.warn(
      'systemd autostart could not be enabled or started: %s. The unit file is at %s; check that `systemctl --user` works on this host (containers and WSL without systemd do not provide it).',
      describeSystemctlError(err),
      unitPath,
    );
    process.exitCode = 1;
    return;
  }

  ui.success(`Auto-start installed via systemd --user: ${unitPath}`);
}

function systemdUninstall(): void {
  const unitPath = systemdUnitPath();
  if (!existsSync(unitPath)) {
    console.log('No systemd auto-start entry found.');
    return;
  }

  try {
    runSystemctl(['disable', '--now', SYSTEMD_UNIT_NAME]);
  } catch (err) {
    // Deleting the unit while the enable symlink survives leaves
    // default.target.wants/saros-proxy.service dangling: the next login logs
    // "Failed to load" and `is-enabled` still answers enabled. Keep it so the
    // user can retry.
    logger.warn(
      'Could not disable the systemd unit: %s. The unit file was kept at %s; run `systemctl --user disable --now %s` and retry the uninstall.',
      describeSystemctlError(err).replace(/\.$/, ''),
      unitPath,
      SYSTEMD_UNIT_NAME,
    );
    process.exitCode = 1;
    return;
  }

  rmSync(unitPath, { force: true });

  try {
    runSystemctl(['daemon-reload']);
  } catch (err) {
    logger.warn('The systemd unit file was removed, but `daemon-reload` failed: %s', describeSystemctlError(err));
  }

  console.log(`Auto-start removed: ${unitPath}`);
}

/**
 * True when the user unit is active. Exported for `update`, which must stop
 * and restart the systemd-managed proxy instead of the PID-file daemon.
 */
export function isSystemdUnitActive(): boolean {
  const active = querySystemctl(['is-active', SYSTEMD_UNIT_NAME]);
  return active.output === 'active';
}

/** Stop the user unit (used by `update` before reinstalling). */
export function stopSystemdUnit(): void {
  runSystemctl(['stop', SYSTEMD_UNIT_NAME]);
}

/** Start the user unit (used by `update` after reinstalling). */
export function startSystemdUnit(): void {
  runSystemctl(['start', SYSTEMD_UNIT_NAME]);
}

function systemdStatus(): void {
  const enabled = querySystemctl(['is-enabled', SYSTEMD_UNIT_NAME]);
  const active = querySystemctl(['is-active', SYSTEMD_UNIT_NAME]);
  const reason = enabled.reason ?? active.reason;
  if (reason) {
    logger.warn('Cannot determine systemd autostart status: %s', reason);
    return;
  }

  if (enabled.output === 'enabled' || active.output === 'active') {
    console.log(`Auto-start is enabled (systemd). Unit: ${systemdUnitPath()}`);
  } else {
    console.log('Auto-start is not installed (systemd).');
  }
}

// ---------------------------------------------------------------------------
// Platform dispatch
// ---------------------------------------------------------------------------

/** Platform that implements a method. */
function methodPlatform(method: ResolvedMethod): 'Linux' | 'Windows' {
  return method === 'systemd' ? 'Linux' : 'Windows';
}

/** A method exists only on the platform that implements it. */
function isMethodSupported(method: ResolvedMethod, platform: string = process.platform): boolean {
  if (method === 'systemd') return platform === 'linux';
  return platform === 'win32';
}

function isExplicitMethod(method?: AutostartMethod): method is ResolvedMethod {
  return method === 'vbs' || method === 'registry' || method === 'systemd';
}

/** Warn (never silently succeed) when this platform has no implementation. */
function reportUnsupported(action: 'install' | 'uninstall' | 'status', method?: AutostartMethod): void {
  const alternative = process.platform === 'darwin'
    ? 'On macOS, create a launchd LaunchAgent or start `saros-proxy serve` from a login item.'
    : 'Start `saros-proxy serve` manually or use the platform login mechanism.';
  if (method && method !== 'auto') {
    logger.warn(
      `Autostart method ${JSON.stringify(method)} is ${methodPlatform(method)}-only; this host runs ${process.platform}, so ${action} does nothing. ${alternative}`,
    );
    return;
  }
  logger.warn(
    'Autostart is unsupported on %s; %s does nothing. %s',
    process.platform,
    action,
    alternative,
  );
}

async function resolveInstallMethod(
  method?: AutostartMethod,
): Promise<{ resolved: ResolvedAutostartMethod; prompted: boolean }> {
  if (isExplicitMethod(method)) {
    return {
      resolved: isMethodSupported(method) ? method : 'unsupported',
      prompted: false,
    };
  }
  if (method === 'auto' || process.platform !== 'win32') {
    return { resolved: resolveMethod(method), prompted: false };
  }

  // Windows without an explicit method: let the user pick.
  if (!process.stdin.isTTY) {
    ui.warn('No --method specified and stdin is not a TTY. Using auto-detect. Pass --method <vbs|registry|auto> to skip this.');
    return { resolved: resolveMethod(undefined), prompted: false };
  }

  ui.intro('Saros — Autostart');
  const choice = ui.assertNotCancelled(await ui.select<AutostartMethod>({
    message: 'Choose an autostart method',
    options: [
      { value: 'registry', label: 'Windows Registry', hint: 'recommended' },
      { value: 'vbs', label: 'VBScript in Startup folder', hint: 'lighter, may trigger AV' },
      { value: 'auto', label: 'Detect automatically', hint: 'picks based on AV detection' },
    ],
  }));
  return { resolved: resolveMethod(choice), prompted: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function autostartInstall(port?: number, method?: AutostartMethod): Promise<void> {
  const { resolved, prompted } = await resolveInstallMethod(method);

  if (resolved === 'unsupported') {
    reportUnsupported('install', method);
    process.exitCode = 1;
    return;
  }

  if (resolved === 'systemd') {
    systemdInstall(port);
  } else if (resolved === 'registry') {
    registryInstall(port);
  } else {
    vbsInstall(port);
  }

  if (prompted) {
    ui.outro('Autostart configured');
  }
}

export function autostartUninstall(method?: AutostartMethod): void {
  if (isExplicitMethod(method)) {
    if (!isMethodSupported(method)) {
      reportUnsupported('uninstall', method);
      process.exitCode = 1;
      return;
    }
    if (method === 'systemd') systemdUninstall();
    else if (method === 'vbs') vbsUninstall();
    else registryUninstall();
    return;
  }

  if (process.platform === 'linux') {
    systemdUninstall();
  } else if (process.platform === 'win32') {
    // Unspecified — clean up both Windows entries
    vbsUninstall();
    registryUninstall();
  } else {
    reportUnsupported('uninstall');
    process.exitCode = 1;
  }
}

export function autostartStatus(method?: AutostartMethod): void {
  if (isExplicitMethod(method)) {
    if (!isMethodSupported(method)) {
      reportUnsupported('status', method);
      return;
    }
    if (method === 'systemd') {
      systemdStatus();
    } else if (method === 'vbs') {
      vbsStatus();
    } else if (registryStatus()) {
      console.log(`Auto-start is enabled (Registry). Key: ${REG_RUN_KEY}\\${REG_VALUE_NAME}`);
    } else {
      console.log('Auto-start is not installed (Registry).');
    }
    return;
  }

  if (process.platform === 'linux') {
    systemdStatus();
    return;
  }

  if (process.platform !== 'win32') {
    reportUnsupported('status');
    return;
  }

  // Check both Windows entries
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
