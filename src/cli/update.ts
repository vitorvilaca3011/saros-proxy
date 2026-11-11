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
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { confirm, isCancel } from './ui.js';
import { getSarosDir } from '../config.js';
import { getVersion } from './overview.js';
import {
  compareVersions,
  fetchLatestVersion as fetchRegistryLatestVersion,
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
  error?: string;
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
  getDaemonState: () => Promise<{ running: boolean; port: number }>;
  daemonStop: () => Promise<boolean>;
  daemonStart: () => Promise<void>;
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

/** Parse `update` arguments. The first unknown option is reported. */
export function parseUpdateArgs(argv: readonly string[]): UpdateArgs {
  const args: UpdateArgs = { check: false, yes: false, force: false };
  for (const arg of argv) {
    if (arg === '--check') {
      args.check = true;
    } else if (arg === '--yes') {
      args.yes = true;
    } else if (arg === '--force') {
      args.force = true;
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
  const actual = canonicalPath(packageRoot);
  const expected = canonicalPath(join(npmGlobalRoot, 'saros-proxy'));
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
 * the old process that is still shutting down on the same port.
 */
export async function waitForUpdatedProxy(
  probe: () => Promise<{ ok: boolean; body?: Record<string, unknown> }>,
  expectedVersion: string,
  attempts: number,
  delayMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ ok: boolean; body?: Record<string, unknown> }> {
  let result: { ok: boolean; body?: Record<string, unknown> } = { ok: false };
  for (let attempt = 0; attempt < attempts; attempt++) {
    result = await probe();
    if (result.ok && result.body?.version === expectedVersion) return result;
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

function resolveDependencies(
  overrides: Partial<UpdateDependencies>,
): UpdateDependencies {
  const platform = overrides.platform ?? process.platform;
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
        const state = await readDaemonState();
        return { running: state.running, port: state.port };
      }),
    daemonStop:
      overrides.daemonStop ?? (() => daemonStop({ exitOnComplete: false })),
    daemonStart:
      overrides.daemonStart ??
      (() => daemonStart(undefined, undefined, { exitOnComplete: false })),
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
): Promise<void> {
  if (mode === 'systemd') deps.systemdStart();
  else if (mode === 'daemon') await deps.daemonStart();
}

async function stopService(
  mode: RestartMode,
  deps: UpdateDependencies,
): Promise<boolean> {
  if (mode === 'systemd') {
    deps.systemdStop();
    return true;
  }
  if (mode === 'daemon') return deps.daemonStop();
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

  const deps = resolveDependencies(overrides);
  const current = deps.currentVersion;

  let latest: string;
  try {
    latest = await deps.fetchLatestVersion();
  } catch (err) {
    console.error(
      chalk.red(`✗ Could not reach the npm registry: ${errorMessage(err)}`),
    );
    return 1;
  }

  const comparison = compareVersions(current, latest);

  if (args.check) {
    console.log(`installed ${current} / latest ${latest}`);
    return comparison < 0 ? 1 : 0;
  }

  if (comparison === 0) {
    console.log(chalk.green(`✓ Already on ${current}.`));
    return 0;
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
      return 1;
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
    return 1;
  }

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
  const systemdActive = deps.platform === 'linux' && deps.systemdActive();
  const mode = chooseRestartMode(before.running, systemdActive);

  try {
    if (!(await stopService(mode, deps))) {
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
    await rollback(mode, deps, before.port, current);
    return 1;
  }

  const installedVersion = deps.readInstalledVersion(
    globalRoot === '' ? deps.packageRoot : join(globalRoot, 'saros-proxy'),
  );
  if (installedVersion !== latest) {
    console.error(
      chalk.red(
        `✗ The global package reports ${installedVersion ?? 'no version'}, expected ${latest}.`,
      ),
    );
    await rollback(mode, deps, before.port, current);
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
    await startService(mode, deps);
  } catch (err) {
    console.error(
      chalk.red(`✗ Updated to ${latest}, but the proxy failed to start: ${errorMessage(err)}`),
    );
    console.error(
      chalk.dim(`Check ${deps.daemonLogPath} and run \`saros-proxy status\`.`),
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
    console.error(
      chalk.dim(`Check ${deps.daemonLogPath} and run \`saros-proxy status\`.`),
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
 * After a failed install the previous package is still on disk; start it again
 * so the host is not left without a proxy. Exit code stays 1 in the caller.
 */
async function rollback(
  mode: RestartMode,
  deps: UpdateDependencies,
  port: number,
  version: string,
): Promise<void> {
  if (mode === 'none') {
    console.log(
      chalk.yellow('The daemon was not running before the update; it was left stopped.'),
    );
    return;
  }

  try {
    await startService(mode, deps);
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
    version,
    deps.healthAttempts,
    deps.healthDelayMs,
    deps.sleep,
  );
  if (!health.ok || health.body?.version !== version) {
    console.error(
      chalk.red(
        `✗ saros-proxy ${version} was not running after the failed update: the proxy on port ${port} ${healthFailureDetail(health)}.`,
      ),
    );
    console.error(
      chalk.dim(`Check ${deps.daemonLogPath} and run \`saros-proxy status\`.`),
    );
    return;
  }
  console.log(chalk.green(`✓ Restarted saros-proxy ${version} (the previous install).`));
}
