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

  let keys: Array<{ label: string; key: string }> = [];
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
  for (const k of keys) {
    console.log(`           ${k.label}: ${maskKey(k.key)}`);
  }

  console.log(`Config:    ${getDefaultConfigPath()}`);
  console.log('');
  console.log(
    chalk.dim('Run `saros-proxy start` to start the daemon, `saros-proxy help` for all commands.'),
  );
}
