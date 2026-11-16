/**
 * update.ts — `saros-proxy update`: replace a global npm install and restart
 * whatever was serving.
 *
 * Safety rules:
 *   - only a package living in the npm global prefix is updated (--force
 *     overrides), so a git checkout is never replaced behind the user's back;
 *   - the running proxy is stopped first and is always restarted after a
 *     failed install, so the host is never left without a proxy;
 *   - success is verified by reading the installed package.json and by
 *     checking the restarted proxy's /health version, not by npm's exit code.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  startSystemdUnit,
  stopSystemdUnit,
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
  /** Run npm/systemctl. Throws on non-zero; returns trimmed stdout. */
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
  systemdStart: () => void;
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
  const actual = canonicalPath(packageRoot);
  const expected = canonicalPath(expectedPath);
  return platform === 'win32'
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
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

function defaultExec(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): string {
  const output = execFileSync(command, [...args], {
    encoding: 'utf-8',
    // npm is npm.cmd on Windows; CreateProcess cannot run a .cmd without a shell.
    shell: process.platform === 'win32' && command === 'npm',
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
    systemdStart: overrides.systemdStart ?? startSystemdUnit,
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

async function startService(
  mode: RestartMode,
  deps: UpdateDependencies,
  options: ServiceOptions,
): Promise<void> {
  if (mode === 'systemd') deps.systemdStart();
  else if (mode === 'daemon') await deps.daemonStart(options);
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

/**
 * Resolve the npm global prefix the package must live in. Prints the reason
 * and returns null when the caller must not touch the install. `--force`
 * only bypasses a failed `npm root -g`; a checkout still needs it to find
 * the installed package's entry point.
 */
function resolveGlobalRoot(
  deps: UpdateDependencies,
  args: UpdateArgs,
): string | null {
  let globalRoot = '';
  try {
    globalRoot = deps.exec('npm', ['root', '-g']);
  } catch (err) {
    if (!args.force) {
      console.error(
        chalk.red(
          `✗ Could not determine the npm global prefix: ${errorMessage(err)}`,
        ),
      );
      return null;
    }
  }

  if (
    !isGlobalInstall(deps.packageRoot, globalRoot, deps.platform) &&
    !args.force
  ) {
    console.error(
      chalk.red(
        '✗ This install is not a global npm package — update the checkout instead.',
      ),
    );
    return null;
  }
  return globalRoot;
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

  const globalRoot = resolveGlobalRoot(deps, args);
  if (globalRoot === null) return 1;

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
    globalRoot === ''
      ? undefined
      : join(globalRoot, 'saros-proxy', 'dist', 'index.js');
  const restartOptions: ServiceOptions = {
    ...serviceOptions,
    ...(entryPoint === undefined ? {} : { entryPoint }),
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

  try {
    deps.exec('npm', ['install', '-g', `saros-proxy@${latest}`], {
      inherit: true,
    });
  } catch (err) {
    console.error(
      chalk.red(`✗ npm install -g saros-proxy@${latest} failed: ${errorMessage(err)}`),
    );
    await rollback(mode, deps, before.port, current, restartOptions, false);
    return 1;
  }

  const installedRoot =
    globalRoot === '' ? deps.packageRoot : join(globalRoot, 'saros-proxy');
  const installedVersion = deps.readInstalledVersion(installedRoot);
  if (installedVersion !== latest) {
    console.error(
      chalk.red(
        `✗ The global package reports ${installedVersion ?? 'no version'}, expected ${latest}.`,
      ),
    );
    await rollback(mode, deps, before.port, current, restartOptions, false);
    return 1;
  }

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
    await rollback(mode, deps, before.port, current, restartOptions, false);
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
    await rollback(mode, deps, before.port, current, restartOptions, true);
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
  const globalRoot = resolveGlobalRoot(deps, args);
  if (globalRoot === null) return null;
  const entryPoint =
    globalRoot === '' ? '' : join(globalRoot, 'saros-proxy', 'dist', 'index.js');
  if (entryPoint !== '' && existsSync(entryPoint)) return entryPoint;
  console.error(
    chalk.red(
      `✗ Cannot restart the proxy from the installed package: its entry point${entryPoint === '' ? '' : ` (${entryPoint})`} is not available. Reinstall it with \`npm install -g saros-proxy@${current}\`, then run \`saros-proxy restart\`.`,
    ),
  );
  return null;
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
 * Put the previous version back after a failed attempt: reinstall it (npm may
 * already have removed the old tree), then start it and verify. When the
 * reinstall itself fails, start whatever is on disk and say so; never pretend
 * the old version is back.
 */
async function rollback(
  mode: RestartMode,
  deps: UpdateDependencies,
  port: number,
  version: string,
  options: ServiceOptions,
  stopFirst: boolean,
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
  try {
    deps.exec('npm', ['install', '-g', `saros-proxy@${version}`], {
      inherit: true,
    });
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
