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
    if (!(await stopService(mode, deps, serviceOptions))) {
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
  try {
    if (!(await stopService(mode, deps, serviceOptions))) {
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
