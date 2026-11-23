/**
 * update.ts — `saros-proxy update`: replace a global npm, pnpm or yarn
 * install and restart whatever was serving.
 *
 * Safety rules:
 *   - only a package living in a package manager's global prefix is updated
 *     (--force overrides), so a git checkout is never replaced behind the
 *     user's back;
 *   - the running proxy is stopped first and is always restarted after a
 *     failed install, so the host is never left without a proxy;
 *   - success is verified by reading the installed package.json and by
 *     checking the restarted proxy's /health version, not by the install
 *     command's exit code.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { confirm, isCancel } from './ui.js';
import { findPortOwner, type PortOwner } from './port-owner.js';
import { getSarosDir } from '../config.js';
import { getVersion } from '../version.js';
import {
  compareVersions,
  fetchLatestVersion as fetchRegistryLatestVersion,
  isValidVersion,
} from './update-check.js';
import {
  daemonStart,
  daemonStop,
  getDaemonState as readDaemonState,
  probeProxyHealth,
} from './daemon.js';
import {
  isSystemdUnitActive,
  refreshSystemdUnitEntry,
  startSystemdUnit,
  stopSystemdUnit,
  warnStaleWindowsAutostart,
} from './autostart.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UpdateArgs {
  check: boolean;
  yes: boolean;
  force: boolean;
  /** Port override for stop/start/health (`--port`). */
  port?: number;
  /** Config path override for stop/start/health (`--config`). */
  config?: string;
  error?: string;
}

/** Where and how to stop/start the proxy for this update. */
export interface ServiceOptions {
  port?: number;
  configPath?: string;
  /** Entry point of the package that must serve after the update. */
  entryPoint?: string;
  /**
   * Entry point that may be written into an existing systemd unit. Absent for
   * a `--force` checkout: autostart must never point systemd at a checkout.
   */
  systemdEntryPoint?: string;
}

export interface DaemonStateSnapshot {
  running: boolean;
  port: number;
  pid?: string | null;
  health?: Record<string, unknown>;
  /** State dir whose PID file the daemon module read. */
  pidDir: string;
  /** Pre-0.11 PID file waiting for SAROS_ALLOW_LEGACY_PID, or null. */
  legacyPidFile: string | null;
}

export interface UpdateDependencies {
  currentVersion: string;
  /** Registry lookup; rejects with a human-readable reason. */
  fetchLatestVersion: () => Promise<string>;
  /** Run npm/pnpm/yarn/systemctl. Throws on non-zero; returns trimmed stdout. */
  exec: (command: string, args: readonly string[], options?: ExecOptions) => string;
  packageRoot: string;
  readInstalledVersion: (packageRoot: string) => string | null;
  isTTY: boolean;
  confirm: (message: string) => Promise<boolean>;
  getDaemonState: () => Promise<DaemonStateSnapshot>;
  daemonStop: (options: ServiceOptions) => Promise<boolean>;
  daemonStart: (options: ServiceOptions) => Promise<void>;
  systemdActive: () => boolean;
  systemdStop: () => void;
  systemdStart: (entryPoint?: string) => void;
  /** Rewrite an installed systemd unit's ExecStart to this entry point. */
  refreshSystemdUnit: (entryPoint: string) => void;
  probeHealth: (
    port: number,
  ) => Promise<{ ok: boolean; body?: Record<string, unknown> }>;
  /** Process listening on a port, or null when it cannot be determined. */
  findPortOwner: (port: number) => PortOwner | null;
  /** Send SIGTERM to a port owner; a PID that already exited is not an error. */
  killPortOwner: (pid: number) => void;
  daemonLogPath: string;
  sleep: (ms: number) => Promise<void>;
  healthAttempts: number;
  healthDelayMs: number;
  platform: NodeJS.Platform;
}

export interface ExecOptions {
  /** Inherit stdio so npm's progress/errors reach the user directly. */
  inherit?: boolean;
}

/** Restart path: systemd unit, PID-file daemon, or nothing was running. */
export type RestartMode = 'systemd' | 'daemon' | 'none';

/** Package manager that owns a global install. */
export type PackageManager = 'npm' | 'pnpm' | 'yarn';

/** A global install whose `saros-proxy` child is the running package. */
export interface GlobalInstall {
  manager: PackageManager;
  /** Directory whose `saros-proxy` child is the installed package. */
  root: string;
}

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

/** Parse `update` arguments. The first invalid option is reported. */
export function parseUpdateArgs(argv: readonly string[]): UpdateArgs {
  const args: UpdateArgs = { check: false, yes: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      args.check = true;
    } else if (arg === '--yes') {
      args.yes = true;
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--port') {
      const value = argv[++i];
      const port = Number(value);
      if (value === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
        args.error = `--port requires a port between 1 and 65535 (got: ${value ?? 'nothing'})`;
        return args;
      }
      args.port = port;
    } else if (arg === '--config') {
      const value = argv[++i];
      if (value === undefined || value === '') {
        args.error = '--config requires a path';
        return args;
      }
      args.config = value;
    } else {
      args.error = `Unknown option: ${arg}`;
      return args;
    }
  }
  return args;
}

/**
 * The proxy to restart: an active systemd unit outranks the PID-file daemon
 * (a unit-managed process usually has no PID file), and nothing is started
 * when neither was running before the update.
 */
export function chooseRestartMode(
  daemonRunning: boolean,
  systemdActive: boolean,
): RestartMode {
  if (systemdActive) return 'systemd';
  return daemonRunning ? 'daemon' : 'none';
}

interface GlobalDiscovery {
  manager: PackageManager;
  command: string;
  args: readonly string[];
  /** Turn the command's output into a directory with a `saros-proxy` child. */
  rootFromOutput: (output: string) => string;
}

/**
 * npm is probed first so an npm install keeps the resolution path it always
 * had. The commands disagree on the layout: yarn's `global dir` is the
 * prefix, and its packages live under `node_modules`.
 */
const GLOBAL_DISCOVERIES: readonly GlobalDiscovery[] = [
  { manager: 'npm', command: 'npm', args: ['root', '-g'], rootFromOutput: (output) => output },
  { manager: 'pnpm', command: 'pnpm', args: ['root', '-g'], rootFromOutput: (output) => output },
  {
    manager: 'yarn',
    command: 'yarn',
    args: ['global', 'dir'],
    rootFromOutput: (output) => join(output, 'node_modules'),
  },
];

const INSTALL_ARGS: Record<PackageManager, readonly string[]> = {
  npm: ['install', '-g'],
  pnpm: ['add', '-g'],
  yarn: ['global', 'add'],
};

function installInvocation(
  manager: PackageManager,
  version: string,
): { command: string; args: string[] } {
  return {
    command: manager,
    args: [...INSTALL_ARGS[manager], `saros-proxy@${version}`],
  };
}

function formatInvocation(command: string, args: readonly string[]): string {
  return `${command} ${args.join(' ')}`;
}

/** Compare two paths whether or not they traverse symlinks. */
function samePath(
  actualPath: string,
  expectedPath: string,
  platform: NodeJS.Platform,
): boolean {
  const actual = canonicalPath(actualPath);
  const expected = canonicalPath(expectedPath);
  return platform === 'win32'
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
}

/** Is `file` the same as `dir` or inside it? Both paths are already canonical. */
function isInsidePath(file: string, dir: string, platform: NodeJS.Platform): boolean {
  const normalizedFile = platform === 'win32' ? file.toLowerCase() : file;
  const normalizedDir = platform === 'win32' ? dir.toLowerCase() : dir;
  return (
    normalizedFile === normalizedDir ||
    normalizedFile.startsWith(`${normalizedDir}${sep}`)
  );
}

/**
 * Is the entry a link? `lstat` is the fast path, but a Windows junction can be
 * reported as a plain directory; `readlink` still answers for junctions and
 * symlinks, so either signal means "do not fall back to a plain path compare".
 */
function isLinkEntry(entryPath: string): boolean {
  try {
    if (lstatSync(entryPath).isSymbolicLink()) return true;
  } catch {
    // Missing path: readlink below decides.
  }
  try {
    readlinkSync(entryPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * pnpm's global entry is normally a symlink into its store. Accept it only
 * when the link resolves inside `dirname(root)`, the pnpm global directory: a
 * link to a checkout (`pnpm link`) lives outside it and must hit the same
 * refusal as `npm link`, or the update would replace the user's checkout. A
 * custom `virtual-store-dir` inside the global directory still matches. A
 * broken symlink never resolves, so it never matches. A non-link entry
 * (hoisted layout) keeps the plain canonical comparison.
 */
function matchesPnpmInstall(
  packageRoot: string,
  root: string,
  platform: NodeJS.Platform,
): boolean {
  const expectedPath = join(root, 'saros-proxy');
  if (!isLinkEntry(expectedPath)) {
    return samePath(packageRoot, expectedPath, platform);
  }
  let target: string;
  try {
    target = realpathSync(expectedPath);
  } catch {
    return false;
  }
  const globalDir = canonicalPath(dirname(root));
  if (!isInsidePath(target, globalDir, platform)) return false;
  const actual = canonicalPath(packageRoot);
  return platform === 'win32'
    ? actual.toLowerCase() === target.toLowerCase()
    : actual === target;
}

/** Is the running package the one npm considers global? */
export function isGlobalInstall(
  packageRoot: string,
  npmGlobalRoot: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (packageRoot === '' || npmGlobalRoot === '') return false;
  const expectedPath = join(npmGlobalRoot, 'saros-proxy');
  // `npm link` leaves a symlink in the global prefix. Canonicalizing both
  // sides would make the checkout look like the global install, and the
  // update would replace the link (and the checkout) behind the user's back.
  try {
    if (lstatSync(expectedPath).isSymbolicLink()) return false;
  } catch {
    // Missing path: fall through to the canonical comparison (tests and a
    // first install both reach this).
  }
  return samePath(packageRoot, expectedPath, platform);
}

interface GlobalInstallProbe {
  /** The manager that owns `packageRoot`, when one matched. */
  install: GlobalInstall | null;
  /** `npm root -g` when it answered; `--force` uses it for a checkout. */
  npmRoot: string | null;
  /** Discovery commands that exited successfully (empty output included). */
  answered: number;
}

/**
 * Ask each package manager where its global packages live and compare that
 * location with the running package. A missing binary is not an error: it
 * simply has no candidate. pnpm's global entry is normally a symlink into its
 * store; it matches only when the link resolves there. npm keeps its stricter
 * `npm link` guard.
 */
function probeGlobalInstall(
  packageRoot: string,
  exec: (command: string, args: readonly string[]) => string,
  platform: NodeJS.Platform,
): GlobalInstallProbe {
  let npmRoot: string | null = null;
  let answered = 0;
  for (const discovery of GLOBAL_DISCOVERIES) {
    let output: string;
    try {
      output = exec(discovery.command, discovery.args).trim();
    } catch {
      continue;
    }
    answered++;
    if (output === '') continue;
    const root = discovery.rootFromOutput(output);
    if (discovery.manager === 'npm') npmRoot = root;
    if (packageRoot === '') continue;
    const matched =
      discovery.manager === 'npm'
        ? isGlobalInstall(packageRoot, root, platform)
        : discovery.manager === 'pnpm'
          ? matchesPnpmInstall(packageRoot, root, platform)
          : samePath(packageRoot, join(root, 'saros-proxy'), platform);
    if (matched) return { install: { manager: discovery.manager, root }, npmRoot, answered };
  }
  return { install: null, npmRoot, answered };
}

/** Which package manager owns `packageRoot`, or null when none does. */
export function detectGlobalInstall(
  packageRoot: string,
  exec: (command: string, args: readonly string[]) => string,
  platform: NodeJS.Platform = process.platform,
): GlobalInstall | null {
  return probeGlobalInstall(packageRoot, exec, platform).install;
}

/** Read `<packageRoot>/package.json`'s version, or null when unusable. */
export function readPackageVersion(packageRoot: string): string | null {
  try {
    const raw = readFileSync(join(packageRoot, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0
      ? pkg.version
      : null;
  } catch {
    return null;
  }
}

/**
 * Poll /health until it answers `status: ok` with the expected version.
 * The version check is what distinguishes the freshly installed proxy from
 * the old process that is still shutting down on the same port; `null`
 * accepts any version, for a rollback that cannot know which release npm
 * left on disk.
 */
export async function waitForUpdatedProxy(
  probe: () => Promise<{ ok: boolean; body?: Record<string, unknown> }>,
  expectedVersion: string | null,
  attempts: number,
  delayMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ ok: boolean; body?: Record<string, unknown> }> {
  let result: { ok: boolean; body?: Record<string, unknown> } = { ok: false };
  for (let attempt = 0; attempt < attempts; attempt++) {
    result = await probe();
    const versionMatches =
      expectedVersion === null || result.body?.version === expectedVersion;
    if (result.ok && versionMatches) return result;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Default dependencies
// ---------------------------------------------------------------------------

function canonicalPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return resolve(file);
  }
}

function thisPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Package-manager CLIs are `.cmd` shims on Windows and need a shell. */
const WINDOWS_SHIM_COMMANDS: Record<string, true> = { npm: true, pnpm: true, yarn: true };

function defaultExec(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): string {
  const output = execFileSync(command, [...args], {
    encoding: 'utf-8',
    // CreateProcess cannot run a `.cmd` without a shell on Windows.
    shell: process.platform === 'win32' && WINDOWS_SHIM_COMMANDS[command] === true,
    ...(options.inherit
      ? { stdio: 'inherit' as const }
      : { stdio: 'pipe' as const, timeout: 30_000 }),
  });
  return typeof output === 'string' ? output.trim() : '';
}

async function confirmInTerminal(message: string): Promise<boolean> {
  const answer = await confirm({ message });
  return !isCancel(answer) && answer === true;
}

/**
 * SIGTERM the process holding the port. ESRCH means it exited between the
 * discovery and the signal, which is the outcome this call wanted.
 */
function terminatePortOwner(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

function defaultDaemonLogPath(): string {
  try {
    return join(getSarosDir(), 'daemon.log');
  } catch {
    // No determinable home: keep the hint generic instead of failing the run.
    return 'daemon.log';
  }
}

/** Only the options the user actually supplied, so defaults stay defaults. */
function definedServiceOptions(args: UpdateArgs): ServiceOptions {
  const options: ServiceOptions = {};
  if (args.port !== undefined) options.port = args.port;
  if (args.config !== undefined) options.configPath = args.config;
  return options;
}

function resolveDependencies(
  overrides: Partial<UpdateDependencies>,
  args: UpdateArgs,
): UpdateDependencies {
  const platform = overrides.platform ?? process.platform;
  const serviceOptions = definedServiceOptions(args);
  return {
    currentVersion: overrides.currentVersion ?? getVersion(),
    fetchLatestVersion:
      overrides.fetchLatestVersion ?? (() => fetchRegistryLatestVersion()),
    exec: overrides.exec ?? defaultExec,
    packageRoot: overrides.packageRoot ?? thisPackageRoot(),
    readInstalledVersion: overrides.readInstalledVersion ?? readPackageVersion,
    isTTY: overrides.isTTY ?? Boolean(process.stdin.isTTY),
    confirm: overrides.confirm ?? confirmInTerminal,
    getDaemonState:
      overrides.getDaemonState ??
      (async () => {
        const state = await readDaemonState(serviceOptions);
        return {
          running: state.running,
          port: state.port,
          pid: state.pid,
          health: state.health,
          pidDir: state.pidDir,
          legacyPidFile: state.legacyPidFile,
        };
      }),
    daemonStop:
      overrides.daemonStop ??
      ((options) =>
        daemonStop({
          exitOnComplete: false,
          ...(options.port === undefined ? {} : { port: options.port }),
          ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
        })),
    daemonStart:
      overrides.daemonStart ??
      ((options) =>
        daemonStart(options.port, options.configPath, {
          exitOnComplete: false,
          entryPoint: options.entryPoint,
        })),
    systemdActive: overrides.systemdActive ?? isSystemdUnitActive,
    systemdStop: overrides.systemdStop ?? stopSystemdUnit,
    systemdStart:
      overrides.systemdStart ?? ((entryPoint) => startSystemdUnit(entryPoint)),
    refreshSystemdUnit: overrides.refreshSystemdUnit ?? refreshSystemdUnitEntry,
    probeHealth: overrides.probeHealth ?? probeProxyHealth,
    findPortOwner: overrides.findPortOwner ?? findPortOwner,
    killPortOwner: overrides.killPortOwner ?? terminatePortOwner,
    daemonLogPath: overrides.daemonLogPath ?? defaultDaemonLogPath(),
    sleep: overrides.sleep ?? delay,
    healthAttempts: overrides.healthAttempts ?? 20,
    healthDelayMs: overrides.healthDelayMs ?? 500,
    platform,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Service lifecycle (shared by the success and rollback paths)
// ---------------------------------------------------------------------------

/** The subset of service options the daemon adapter understands. */
function daemonServiceOptions(options: ServiceOptions): ServiceOptions {
  const daemonOptions: ServiceOptions = {};
  if (options.port !== undefined) daemonOptions.port = options.port;
  if (options.configPath !== undefined) daemonOptions.configPath = options.configPath;
  if (options.entryPoint !== undefined) daemonOptions.entryPoint = options.entryPoint;
  return daemonOptions;
}

async function startService(
  mode: RestartMode,
  deps: UpdateDependencies,
  options: ServiceOptions,
): Promise<void> {
  if (mode === 'systemd') deps.systemdStart(options.systemdEntryPoint);
  else if (mode === 'daemon') await deps.daemonStart(daemonServiceOptions(options));
}

async function stopService(
  mode: RestartMode,
  deps: UpdateDependencies,
  options: ServiceOptions,
): Promise<boolean> {
  if (mode === 'systemd') {
    deps.systemdStop();
    return true;
  }
  if (mode === 'daemon') return deps.daemonStop(options);
  return true;
}

function healthFailureDetail(
  health: { ok: boolean; body?: Record<string, unknown> },
): string {
  if (!health.ok) return 'did not answer /health';
  const reported = health.body?.version;
  return typeof reported === 'string'
    ? `reports version ${reported}`
    : 'does not report its version';
}

interface ResolvedGlobalInstall {
  install: GlobalInstall;
  /** False when `--force` fell back to npm for a checkout. */
  detected: boolean;
}

/**
 * Resolve which package manager owns the global install and where its root
 * is. Prints the reason and returns null when the caller must not touch the
 * install. A failed discovery is not fatal: `--force` falls back to npm's
 * root (when it answered) so a checkout can still restart the global package.
 */
function resolveGlobalInstall(
  deps: UpdateDependencies,
  args: UpdateArgs,
): ResolvedGlobalInstall | null {
  const probe = probeGlobalInstall(deps.packageRoot, deps.exec, deps.platform);
  if (probe.install !== null) {
    console.log(
      chalk.dim(
        `Detected the ${probe.install.manager} global install at ${probe.install.root}.`,
      ),
    );
    return { install: probe.install, detected: true };
  }
  if (args.force) {
    return { install: { manager: 'npm', root: probe.npmRoot ?? '' }, detected: false };
  }
  const probes = GLOBAL_DISCOVERIES.map((discovery) =>
    formatInvocation(discovery.command, discovery.args),
  ).join(', ');
  if (probe.answered === 0) {
    console.error(
      chalk.red('✗ Could not determine the global prefix of any package manager.'),
    );
    console.error(chalk.dim(`Tried: ${probes}.`));
    return null;
  }
  console.error(
    chalk.red(
      '✗ This install is not a global npm, pnpm or yarn package — update the checkout instead.',
    ),
  );
  console.error(chalk.dim(`Checked: ${probes}.`));
  return null;
}

/**
 * After a successful install, repair autostart entries independent of the
 * restart mode: an inactive unit or a Windows login entry left on the old pnpm
 * store path starts stale code on the next boot. Systemd is rewritten only
 * when a global entry point was detected (never a checkout); existing Windows
 * entries are reported rather than rewritten blindly.
 */
function repairAutostartAfterInstall(
  deps: UpdateDependencies,
  entryPoint: string | undefined,
  version: string,
): void {
  if (deps.platform === 'linux' && entryPoint !== undefined) {
    try {
      deps.refreshSystemdUnit(entryPoint);
    } catch (err) {
      console.error(
        chalk.yellow(
          `! Could not update the systemd autostart unit: ${errorMessage(err)}`,
        ),
      );
    }
  }
  if (deps.platform === 'win32') warnStaleWindowsAutostart(version, deps.platform);
}

// ---------------------------------------------------------------------------
// Unmanaged port owner (update only — `stop` keeps refusing to kill)
// ---------------------------------------------------------------------------

/** Poll for the listener this many times, PORT_RELEASE_DELAY_MS apart. */
const PORT_RELEASE_ATTEMPTS = 20;
const PORT_RELEASE_DELAY_MS = 250;

/**
 * A process serves the configured port but no PID file claims it. An active
 * systemd unit owns its processes, so its listeners are never treated as
 * unmanaged here. A pre-0.11 PID file and a PID file in another state dir are
 * indistinguishable from this process, hence the guard in
 * `stopUnmanagedPortOwner`.
 */
function servesWithoutManagedPid(
  state: DaemonStateSnapshot,
  systemdActive: boolean,
): boolean {
  return !systemdActive && state.running && !state.pid && state.health !== undefined;
}

/** "PID 999 (node ...)" or "PID 999 (command line not readable)". */
function describePortOwner(owner: PortOwner): string {
  return owner.command === ''
    ? `PID ${owner.pid} (command line not readable)`
    : `PID ${owner.pid} (${owner.command})`;
}

function unidentifiedPortMessage(port: number): string {
  return `✗ Port ${port} is served by a process that could not be identified. Stop it manually, then re-run \`saros-proxy update\`.`;
}

/**
 * The pre-0.11 handle the current state dir does not hold. `stop` asks the
 * operator to opt in with SAROS_ALLOW_LEGACY_PID; update says the same rather
 * than killing a daemon whose PID file it cannot read.
 */
function printLegacyPidHint(legacyFile: string): void {
  console.log(chalk.yellow(`A pre-0.11 PID file exists at ${legacyFile}.`));
  console.log(
    chalk.cyan('Re-run with SAROS_ALLOW_LEGACY_PID=1 to let this command read and stop it.'),
  );
}

/**
 * Wait for the port to stop being listened on. /health is not the measure: a
 * process that answers 503, stops answering, or passed the socket to a child
 * still holds the port. Returns null when released, else the last owner seen.
 */
async function waitForPortRelease(
  deps: UpdateDependencies,
  port: number,
): Promise<PortOwner | null> {
  let holder: PortOwner | null = null;
  for (let attempt = 0; attempt < PORT_RELEASE_ATTEMPTS; attempt++) {
    holder = deps.findPortOwner(port);
    if (holder === null) return null;
    if (attempt < PORT_RELEASE_ATTEMPTS - 1) {
      await deps.sleep(PORT_RELEASE_DELAY_MS);
    }
  }
  return holder;
}

/** Name whoever still holds the port when a restarted proxy cannot answer. */
function reportPortHolder(deps: UpdateDependencies, port: number): void {
  const owner = deps.findPortOwner(port);
  if (owner === null) return;
  console.error(chalk.dim(`Port ${port} is still held by ${describePortOwner(owner)}.`));
}

/**
 * Stop the process serving the configured port when no managed daemon owns
 * it, so the update can install and start its replacement. Returns whether
 * the update may continue.
 *
 * Never guesses: an owner this process cannot verify aborts the update. The
 * signal is sent only after re-reading the listener, so a PID that exited
 * while the prompt was open is not reused. `stop` keeps its historical
 * refusal; this path exists only for `update`.
 */
async function stopUnmanagedPortOwner(
  deps: UpdateDependencies,
  args: UpdateArgs,
  state: DaemonStateSnapshot,
  alreadyApproved: boolean,
): Promise<boolean> {
  const port = state.port;
  if (state.legacyPidFile) {
    printLegacyPidHint(state.legacyPidFile);
    console.error(
      chalk.red(`✗ Port ${port} is served by a pre-0.11 instance; nothing was stopped.`),
    );
    return false;
  }
  const owner = deps.findPortOwner(port);
  if (owner === null) {
    console.error(chalk.red(unidentifiedPortMessage(port)));
    return false;
  }
  const ownership = owner.command.includes('saros-proxy')
    ? `a saros-proxy process started outside this state dir (${state.pidDir})`
    : `not owned by the PID file in ${state.pidDir}`;
  console.error(
    chalk.yellow(`! Port ${port} is served by ${describePortOwner(owner)}, ${ownership}.`),
  );
  if (
    !alreadyApproved &&
    !args.yes &&
    !(await deps.confirm(`Kill the process using port ${port} and continue?`))
  ) {
    console.log(chalk.yellow('Update cancelled.'));
    return false;
  }
  // The prompt can wait; the PID may not. Field 22 keeps a recycled PID from
  // receiving a signal meant for the listener that owned the port.
  const confirmed = deps.findPortOwner(port);
  if (
    confirmed === null ||
    confirmed.pid !== owner.pid ||
    confirmed.starttime !== owner.starttime
  ) {
    console.error(
      chalk.yellow(
        `! PID ${owner.pid} is no longer the listener on port ${port}; nothing was signalled.`,
      ),
    );
    console.error(chalk.red(unidentifiedPortMessage(port)));
    return false;
  }
  try {
    deps.killPortOwner(owner.pid);
  } catch (err) {
    console.error(chalk.red(`✗ Could not stop PID ${owner.pid}: ${errorMessage(err)}`));
    return false;
  }
  console.error(
    chalk.yellow(
      `! Sent SIGTERM to PID ${owner.pid}; waiting for port ${port} to be released.`,
    ),
  );
  const holder = await waitForPortRelease(deps, port);
  if (holder !== null) {
    console.error(
      chalk.red(
        `✗ Port ${port} is still held by ${describePortOwner(holder)} after SIGTERM. Stop PID ${holder.pid} manually, then re-run \`saros-proxy update\`.`,
      ),
    );
    return false;
  }
  console.log(chalk.green(`✓ Port ${port} released; continuing the update.`));
  return true;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * Run `saros-proxy update [--check] [--yes] [--force]`.
 * Returns the process exit code; never calls process.exit so the whole flow
 * is testable.
 */
export async function runUpdateCommand(
  argv: readonly string[],
  overrides: Partial<UpdateDependencies> = {},
): Promise<number> {
  const args = parseUpdateArgs(argv);
  if (args.error) {
    console.error(chalk.red(`✗ ${args.error}`));
    return 1;
  }

  const deps = resolveDependencies(overrides, args);
  const current = deps.currentVersion;
  const serviceOptions = definedServiceOptions(args);

  let latest: string;
  try {
    latest = await deps.fetchLatestVersion();
  } catch (err) {
    console.error(
      chalk.red(`✗ Could not reach the npm registry: ${errorMessage(err)}`),
    );
    return 1;
  }

  if (!isValidVersion(latest)) {
    console.error(
      chalk.red(`✗ The npm registry returned an invalid version: ${latest}`),
    );
    return 1;
  }

  const comparison = compareVersions(current, latest);

  if (args.check) {
    console.log(`installed ${current} / latest ${latest}`);
    return comparison < 0 ? 1 : 0;
  }

  if (comparison === 0) {
    return restartIfDaemonIsStale(deps, args, current, serviceOptions);
  }

  if (comparison > 0 && !args.force) {
    console.log(
      chalk.yellow(
        `Installed ${current} is newer than the npm latest ${latest}; nothing to update. Re-run with --force to install ${latest} anyway.`,
      ),
    );
    return 0;
  }

  // Refuse before touching npm/systemd when the answer would have to be
  // assumed: piped stdin is never treated as consent.
  if (!args.yes && !deps.isTTY) {
    console.error(
      chalk.red(
        '✗ Refusing to update without a TTY. Re-run with --yes to skip confirmation.',
      ),
    );
    return 1;
  }

  const resolved = resolveGlobalInstall(deps, args);
  if (resolved === null) return 1;
  const install = resolved.install;

  console.log(chalk.cyan(`Updating saros-proxy: ${current} → ${latest}`));
  if (!args.yes) {
    const approved = await deps.confirm(
      `Update saros-proxy ${current} → ${latest}?`,
    );
    if (!approved) {
      console.log(chalk.yellow('Update cancelled.'));
      return 1;
    }
  }

  const before = await deps.getDaemonState();
  if (pidWithoutHealth(before, args)) {
    return refuseUnknownDaemonPort(before);
  }
  const systemdActive = deps.platform === 'linux' && deps.systemdActive();
  const unmanagedOwner = servesWithoutManagedPid(before, systemdActive);
  if (unmanagedOwner && !(await stopUnmanagedPortOwner(deps, args, before, false))) {
    return 1;
  }
  const mode = chooseRestartMode(before.running, systemdActive);
  const entryPoint =
    install.root === ''
      ? undefined
      : join(install.root, 'saros-proxy', 'dist', 'index.js');
  const systemdEntryPoint = resolved.detected ? entryPoint : undefined;
  const restartOptions: ServiceOptions = {
    ...serviceOptions,
    ...(entryPoint === undefined ? {} : { entryPoint }),
    ...(systemdEntryPoint === undefined ? {} : { systemdEntryPoint }),
  };

  try {
    if (!unmanagedOwner && !(await stopService(mode, deps, serviceOptions))) {
      console.error(
        chalk.red('✗ Could not stop the running proxy; aborting before install.'),
      );
      return 1;
    }
  } catch (err) {
    console.error(
      chalk.red(`✗ Could not stop the running proxy: ${errorMessage(err)}`),
    );
    return 1;
  }

  const invocation = installInvocation(install.manager, latest);
  try {
    deps.exec(invocation.command, invocation.args, { inherit: true });
  } catch (err) {
    console.error(
      chalk.red(
        `✗ ${formatInvocation(invocation.command, invocation.args)} failed: ${errorMessage(err)}`,
      ),
    );
    await rollback(
      mode,
      deps,
      before.port,
      current,
      restartOptions,
      false,
      install.manager,
    );
    return 1;
  }

  const installedRoot =
    install.root === '' ? deps.packageRoot : join(install.root, 'saros-proxy');
  const installedVersion = deps.readInstalledVersion(installedRoot);
  if (installedVersion !== latest) {
    console.error(
      chalk.red(
        `✗ The global package reports ${installedVersion ?? 'no version'}, expected ${latest}.`,
      ),
    );
    await rollback(
      mode,
      deps,
      before.port,
      current,
      restartOptions,
      false,
      install.manager,
    );
    return 1;
  }

  repairAutostartAfterInstall(deps, systemdEntryPoint, latest);

  if (mode === 'none') {
    console.log(
      chalk.green(
        `✓ Installed saros-proxy ${latest}. The daemon was not running, so it was left stopped.`,
      ),
    );
    return 0;
  }

  try {
    await startService(mode, deps, restartOptions);
  } catch (err) {
    console.error(
      chalk.red(`✗ Updated to ${latest}, but the proxy failed to start: ${errorMessage(err)}`),
    );
    await rollback(
      mode,
      deps,
      before.port,
      current,
      restartOptions,
      false,
      install.manager,
    );
    return 1;
  }

  const health = await waitForUpdatedProxy(
    () => deps.probeHealth(before.port),
    latest,
    deps.healthAttempts,
    deps.healthDelayMs,
    deps.sleep,
  );

  if (!health.ok || health.body?.version !== latest) {
    console.error(
      chalk.red(
        `✗ saros-proxy ${latest} is installed, but the proxy on port ${before.port} ${healthFailureDetail(health)}.`,
      ),
    );
    reportPortHolder(deps, before.port);
    await rollback(
      mode,
      deps,
      before.port,
      current,
      restartOptions,
      true,
      install.manager,
    );
    return 1;
  }

  console.log(
    chalk.green(
      `✓ Updated to ${latest} and restarted the proxy on port ${before.port}.`,
    ),
  );
  return 0;
}

/**
 * Consent for restarting a stale proxy. Returns the exit code to use when the
 * restart must not happen, or null when it may proceed. No prompt is read
 * from piped stdin.
 */
async function consentToRestart(
  deps: UpdateDependencies,
  args: UpdateArgs,
  current: string,
  state: DaemonStateSnapshot,
  serving: string,
): Promise<number | null> {
  if (args.yes) return null;
  if (!deps.isTTY) {
    console.log(
      chalk.yellow(
        `The package is already ${current}, but the proxy on port ${state.port} ${serving}. Re-run with \`saros-proxy update --yes\` to restart it.`,
      ),
    );
    return 0;
  }
  const approved = await deps.confirm(
    `The package is already ${current}, but the proxy on port ${state.port} ${serving}. Restart it?`,
  );
  if (approved) return null;
  console.log(chalk.yellow('Restart cancelled.'));
  return 0;
}

/**
 * Entry point of the installed package for a daemon restart, or null after
 * printing why it cannot be used. The command must start the global package,
 * never whichever checkout ran it.
 */
function installedEntryPoint(
  deps: UpdateDependencies,
  args: UpdateArgs,
  current: string,
): string | null {
  const resolved = resolveGlobalInstall(deps, args);
  if (resolved === null) return null;
  const install = resolved.install;
  const entryPoint =
    install.root === ''
      ? ''
      : join(install.root, 'saros-proxy', 'dist', 'index.js');
  if (entryPoint !== '' && existsSync(entryPoint)) return entryPoint;
  const reinstall = installInvocation(install.manager, current);
  console.error(
    chalk.red(
      `✗ Cannot restart the proxy from the installed package: its entry point${entryPoint === '' ? '' : ` (${entryPoint})`} is not available. Reinstall it with \`${formatInvocation(reinstall.command, reinstall.args)}\`, then run \`saros-proxy restart\`.`,
    ),
  );
  return null;
}

/**
 * Global entry point for autostart repair, without messages: a checkout and a
 * missing entry point both return null, which leaves the unit untouched.
 */
function detectGlobalEntryPoint(deps: UpdateDependencies): string | null {
  const probe = probeGlobalInstall(deps.packageRoot, deps.exec, deps.platform);
  if (probe.install === null || probe.install.root === '') return null;
  const entryPoint = join(probe.install.root, 'saros-proxy', 'dist', 'index.js');
  return existsSync(entryPoint) ? entryPoint : null;
}

/**
 * The package is already `current`, but the process serving may not be: a
 * manual install or an interrupted update leaves an old daemon behind. Restart
 * it when its `/health` reports another version (or no version at all); do
 * nothing when it matches.
 */
async function restartIfDaemonIsStale(
  deps: UpdateDependencies,
  args: UpdateArgs,
  current: string,
  serviceOptions: ServiceOptions,
): Promise<number> {
  const state = await deps.getDaemonState();
  if (pidWithoutHealth(state, args)) {
    return refuseUnknownDaemonPort(state);
  }
  if (!state.running) {
    console.log(chalk.green(`✓ Already on ${current}.`));
    return 0;
  }
  const reported =
    typeof state.health?.version === 'string' ? state.health.version : null;
  if (reported === current) {
    console.log(chalk.green(`✓ Already on ${current}.`));
    return 0;
  }
  const serving =
    reported === null ? 'does not report its version' : `reports ${reported}`;

  const consent = await consentToRestart(deps, args, current, state, serving);
  if (consent !== null) return consent;

  const systemdActive = deps.platform === 'linux' && deps.systemdActive();
  const mode = chooseRestartMode(state.running, systemdActive);
  const restartOptions: ServiceOptions = { ...serviceOptions };
  if (mode === 'daemon') {
    const entryPoint = installedEntryPoint(deps, args, current);
    if (entryPoint === null) return 1;
    restartOptions.entryPoint = entryPoint;
  } else if (mode === 'systemd') {
    const entryPoint = detectGlobalEntryPoint(deps);
    if (entryPoint !== null) restartOptions.systemdEntryPoint = entryPoint;
  }

  console.log(
    chalk.cyan(
      `Package is already ${current}; the running proxy ${serving}. Restarting it.`,
    ),
  );
  // An unmanaged listener on the port: the restart prompt did not mention the
  // process or that it would die, so the kill needs its own consent.
  const unmanagedOwner = servesWithoutManagedPid(state, systemdActive);
  if (unmanagedOwner && !(await stopUnmanagedPortOwner(deps, args, state, false))) {
    return 1;
  }
  try {
    if (!unmanagedOwner && !(await stopService(mode, deps, serviceOptions))) {
      console.error(
        chalk.red(
          '✗ Could not stop the running proxy; stop it manually, then run `saros-proxy start`.',
        ),
      );
      return 1;
    }
  } catch (err) {
    console.error(
      chalk.red(`✗ Could not stop the running proxy: ${errorMessage(err)}`),
    );
    return 1;
  }

  try {
    await startService(mode, deps, restartOptions);
  } catch (err) {
    console.error(
      chalk.red(`✗ saros-proxy ${current} is installed, but the restart failed: ${errorMessage(err)}`),
    );
    console.error(
      chalk.dim(`Check ${deps.daemonLogPath} and run \`saros-proxy status\`.`),
    );
    return 1;
  }

  const health = await waitForUpdatedProxy(
    () => deps.probeHealth(state.port),
    current,
    deps.healthAttempts,
    deps.healthDelayMs,
    deps.sleep,
  );
  if (!health.ok || health.body?.version !== current) {
    console.error(
      chalk.red(
        `✗ saros-proxy ${current} is installed, but the proxy on port ${state.port} ${healthFailureDetail(health)}.`,
      ),
    );
    reportPortHolder(deps, state.port);
    console.error(
      chalk.dim(`Check ${deps.daemonLogPath} and run \`saros-proxy status\`.`),
    );
    return 1;
  }

  console.log(
    chalk.green(
      `✓ Restarted saros-proxy ${current}; it was serving ${reported ?? 'an unknown version'}.`,
    ),
  );
  return 0;
}

/** A PID-file daemon exists but its port cannot be inferred from the config. */
function pidWithoutHealth(state: DaemonStateSnapshot, args: UpdateArgs): boolean {
  return Boolean(state.pid) && !state.health && args.port === undefined;
}

function refuseUnknownDaemonPort(state: DaemonStateSnapshot): number {
  console.error(
    chalk.red(
      `✗ A proxy daemon (PID ${state.pid}) is running, but /health did not answer on port ${state.port}. Re-run with --port <the port it serves> (and --config <path> if it uses one) so the update stops and restarts the right instance.`,
    ),
  );
  return 1;
}

/**
 * Put the previous version back after a failed attempt: reinstall it (the
 * package manager may already have removed the old tree), then start it and
 * verify. When the reinstall itself fails, start whatever is on disk and say
 * so; never pretend the old version is back.
 */
async function rollback(
  mode: RestartMode,
  deps: UpdateDependencies,
  port: number,
  version: string,
  options: ServiceOptions,
  stopFirst: boolean,
  manager: PackageManager,
): Promise<void> {
  if (mode === 'none') {
    console.log(
      chalk.yellow('The daemon was not running before the update; it was left stopped.'),
    );
    return;
  }

  if (stopFirst) {
    try {
      if (!(await stopService(mode, deps, options))) {
        console.error(
          chalk.yellow(
            '! Could not stop the failed instance; continuing with the rollback.',
          ),
        );
      }
    } catch (err) {
      console.error(
        chalk.yellow(
          `! Could not stop the failed instance: ${errorMessage(err)}; continuing with the rollback.`,
        ),
      );
    }
  }

  let reinstalled = false;
  const invocation = installInvocation(manager, version);
  try {
    deps.exec(invocation.command, invocation.args, { inherit: true });
    reinstalled = true;
  } catch (err) {
    console.error(
      chalk.yellow(
        `! Could not reinstall saros-proxy ${version}: ${errorMessage(err)}. Starting the package currently on disk instead.`,
      ),
    );
  }

  try {
    await startService(mode, deps, options);
  } catch (err) {
    console.error(
      chalk.red(`✗ Could not restart saros-proxy ${version}: ${errorMessage(err)}`),
    );
    console.error(
      chalk.dim(`Check ${deps.daemonLogPath} and run \`saros-proxy status\`.`),
    );
    return;
  }

  const health = await waitForUpdatedProxy(
    () => deps.probeHealth(port),
    reinstalled ? version : null,
    deps.healthAttempts,
    deps.healthDelayMs,
    deps.sleep,
  );
  const expectedMet = reinstalled ? health.body?.version === version : true;
  if (!health.ok || !expectedMet) {
    console.error(
      chalk.red(
        reinstalled
          ? `✗ saros-proxy ${version} was not running after the failed update: the proxy on port ${port} ${healthFailureDetail(health)}.`
          : `✗ The package currently on disk did not become healthy on port ${port}: ${healthFailureDetail(health)}.`,
      ),
    );
    console.error(
      chalk.dim(`Check ${deps.daemonLogPath} and run \`saros-proxy status\`.`),
    );
    return;
  }

  if (reinstalled) {
    console.log(chalk.green(`✓ Restarted saros-proxy ${version} (the previous install).`));
    return;
  }
  const reported = health.body?.version;
  console.log(
    chalk.yellow(
      `✓ Started the package currently on disk${typeof reported === 'string' ? ` (version ${reported})` : ''}; saros-proxy ${version} could not be reinstalled.`,
    ),
  );
}
