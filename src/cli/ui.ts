/**
 * ui.ts — Centralized CLI UI abstraction for Saros.
 *
 * Thin wrapper around @clack/prompts. All CLI output goes through here
 * so that future migration to Ink, Blessed, or web dashboards only requires
 * changing this file.
 *
 * Principles:
 *   - Semantic colors only (green=success, red=error, yellow=warn, blue=info)
 *   - Minimal visual noise
 *   - Consistent spacing and symbols
 *   - No business logic
 */

import { outro, log, note, isCancel } from '@clack/prompts';
import chalk from 'chalk';
import { maskKey } from '../logger.js';
import type { SetupConfig } from './setup.js';

// ---------------------------------------------------------------------------
// Re-exports — setup.ts imports from here so migration is localized
// ---------------------------------------------------------------------------

export { outro };
export { intro, spinner, text, confirm, password, select } from '@clack/prompts';

// ---------------------------------------------------------------------------
// Status messages (thin wrappers around @clack/log)
// ---------------------------------------------------------------------------

export function info(msg: string): void {
  log.info(chalk.blue(msg));
}

export function success(msg: string): void {
  log.success(chalk.green(msg));
}

export function warn(msg: string): void {
  log.warn(chalk.yellow(msg));
}

export function error(msg: string): void {
  log.error(chalk.red(msg));
}

export function step(title: string): void {
  log.step(chalk.cyan(title));
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

export function panel(title: string, body: string): void {
  note(body, title);
}

// ---------------------------------------------------------------------------
// Config summary (replaces manual Unicode box-drawing)
// ---------------------------------------------------------------------------

export function printConfigSummary(
  cfg: SetupConfig,
  encryptionEnabled = false,
  envSaved = false,
): void {
  const lines: string[] = [
    `${chalk.dim('Proxy port:')}      ${cfg.port}`,
    `${chalk.dim('Upstream API:')}    ${cfg.upstreamBaseUrl}`,
    `${chalk.dim('API keys:')}        ${cfg.keys.length}`,
  ];

  if (encryptionEnabled) {
    lines.push(`${chalk.dim('Encryption:')}     AES-256-GCM (${cfg.keys.length} key(s))`);
  } else {
    for (const k of cfg.keys) {
      lines.push(`${chalk.dim(k.label.padEnd(16))} ${maskKey(k.key)}`);
    }
  }

  if (cfg.scrapingAccounts && cfg.scrapingAccounts.length > 0) {
    lines.push(
      '',
      `${chalk.dim('Scraping accounts:')} ${cfg.scrapingAccounts.length}`,
      `${chalk.dim('Usage threshold:')}  ${cfg.scrapingThreshold ?? 50}%`,
      `${chalk.dim('Check interval:')}   ${((cfg.scrapingIntervalMs ?? 90_000) / 1000)}s`,
    );
  }

  note(lines.join('\n'), 'Configuration Summary');

  if (encryptionEnabled && !envSaved) {
    log.warn('Your API keys are encrypted.');
    info('Set OPENCODE_GO_ENCRYPTION_KEY before starting:');
    console.log(chalk.dim('    $ export OPENCODE_GO_ENCRYPTION_KEY="your-master-key"'));
    console.log(chalk.dim('    $ npm run dev'));
  }
}

// ---------------------------------------------------------------------------
// Next steps
// ---------------------------------------------------------------------------

export function printNextSteps(port: number): void {
  const bullet = chalk.dim('•');
  log.step('Next Steps');
  console.log(`  ${bullet} Start the proxy:      ${chalk.dim('$ npm run dev')}`);
  const extensionUrl = `http://127.0.0.1:${port}`;
  console.log(`  ${bullet} Extension endpoint:   ${chalk.dim(extensionUrl)}`);
  console.log(`  ${bullet} Health check:         ${chalk.dim(`$ curl ${extensionUrl}/health`)}`);
  console.log('');
  log.step('OpenCode Client');
  console.log(`  ${bullet} Select provider:      ${chalk.dim('saros-proxy')}`);
  console.log(`  ${bullet} Or set as default:    ${chalk.dim('"model": "saros-proxy/glm-5"')}`);
  console.log('');
  log.step('Manage');
  console.log(`  ${bullet} Re-run setup anytime: ${chalk.dim('$ npm run setup')}`);
  console.log(`  ${bullet} Edit config.yaml directly (circuit breaker, CORS, timeouts)`);
}

// ---------------------------------------------------------------------------
// Workspace list
// ---------------------------------------------------------------------------

export function listWorkspaces(workspaceIds: string[]): void {
  info('Workspaces found in Firefox history:');
  for (let w = 0; w < workspaceIds.length; w++) {
    const number = `${w + 1})`;
    const ws = workspaceIds[w]!;
    const url = `https://opencode.ai/workspace/${ws}/go`;
    console.log(`  ${chalk.cyan(number)} ${ws}`);
    console.log(`     ${chalk.dim(url)}`);
  }
}

// ---------------------------------------------------------------------------
// Cancellation helper
// ---------------------------------------------------------------------------

export function assertNotCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    outro(chalk.red('Setup cancelled.'));
    process.exit(1);
  }
  return value;
}
