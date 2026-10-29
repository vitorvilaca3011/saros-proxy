/**
 * overview.ts — Output for the bare `saros-proxy` command (no subcommand).
 *
 * Shows whether the proxy is running (pid file + os-agnostic /health probe),
 * the enabled harnesses, the configured API keys (masked), and the config
 * path. Starting the proxy requires an explicit `start` (daemon) or `serve`
 * (foreground) — bare invocation never starts a server.
 */

import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDaemonState } from './daemon.js';
import { readHarnessSettings } from './harness-sync.js';
import { loadConfig, getDefaultConfigPath } from '../config.js';
import { maskKey, logger } from '../logger.js';

export function getVersion(): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf-8')) as {
    version: string;
  };
  return pkg.version;
}

/**
 * Render one key's `/health` entry: why it is out of rotation and when it can
 * return. `entry` is undefined when the daemon is not serving (or predates the
 * per-key block), in which case there is nothing to add.
 */
export function formatKeyState(entry: Record<string, unknown> | undefined): string {
  if (!entry) return '';
  if (entry.entitled === false) return chalk.red(' — no plan for this provider');
  if (entry.enabled !== false) return '';
  const lastError = entry.lastError as { status?: number | null; reason?: string } | null | undefined;
  const reason = lastError?.reason ? ` ${lastError.reason}` : '';
  const status = typeof lastError?.status === 'number' ? ` (${lastError.status})` : '';
  const retry =
    typeof entry.retryAfterMs === 'number' && entry.retryAfterMs > 0
      ? `, retry in ${Math.ceil(entry.retryAfterMs / 1000)}s`
      : '';
  return chalk.red(` — disabled:${reason}${status}${retry}`);
}

export async function printOverview(): Promise<void> {
  // Reporting command — silence pino (config load logs) so the output is a
  // clean report. The process exits right after, so no restore needed.
  logger.level = 'silent';

  console.log(chalk.bold(`saros-proxy ${getVersion()}`) + chalk.dim(' — overview'));
  console.log('');

  const state = await getDaemonState();
  if (state.running) {
    const pidText = state.pid ? ` (PID ${state.pid})` : '';
    console.log(`Status:    ${chalk.green('✓ running')} on port ${state.port}${pidText}`);
  } else {
    console.log(`Status:    ${chalk.red('✗ not running')}`);
  }

  const harnesses = readHarnessSettings();
  console.log(`Harnesses: ${harnesses.join(', ') || chalk.dim('(none)')}`);

  let keys: Array<{ label: string; key: string; provider?: string }> = [];
  try {
    keys = loadConfig().keys;
  } catch {
    // Config missing or unreadable — keys stay empty.
  }

  const health = state.health;
  const enabledText =
    health &&
    typeof health.enabledCount === 'number' &&
    typeof health.keyCount === 'number'
      ? `${health.enabledCount}/${health.keyCount} enabled, `
      : '';
  const labels = keys.map((k) => k.label).join(', ');
  console.log(`API keys:  ${enabledText}${keys.length} configured${labels ? ` (${labels})` : ''}`);
  const healthKeys = Array.isArray(health?.keys)
    ? (health.keys as Array<Record<string, unknown>>)
    : [];
  for (const k of keys) {
    const provider = k.provider ? chalk.dim(` [${k.provider}]`) : '';
    const state = formatKeyState(healthKeys.find((entry) => entry.label === k.label));
    console.log(`           ${k.label}: ${maskKey(k.key)}${provider}${state}`);
  }

  console.log(`Config:    ${getDefaultConfigPath()}`);
  console.log('');
  console.log(
    chalk.dim('Run `saros-proxy start` to start the daemon, `saros-proxy help` for all commands.'),
  );
}
