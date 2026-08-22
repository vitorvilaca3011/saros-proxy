#!/usr/bin/env node

/**
 * index.ts — Entry point for Saros.
 *
 * Usage:
 *   saros-proxy                       # Overview: status, harnesses, keys
 *   saros-proxy serve [--port <p>]    # Run the proxy in the foreground
 *   saros-proxy start [--port <p>]    # Run the proxy as a background daemon
 *   saros-proxy setup                 # Run the interactive setup wizard
 */

import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type ProxyConfig } from './config.js';
import { createProxyApp } from './proxy.js';
import { flushModelStats } from './model-stats.js';
import { logger, maskKey } from './logger.js';
import { FORCE_SHUTDOWN_TIMEOUT_MS } from './constants.js';
import { daemonStart, daemonStop, daemonStatus, daemonRestart } from './cli/daemon.js';
import { runUsageCommand } from './cli/usage.js';
import { getDefaultOpencodeConfigPath } from './cli/opencode-config.js';
import { autostartInstall, autostartUninstall, autostartStatus, type AutostartMethod } from './cli/autostart.js';
import { checkForUpdate } from './cli/update-check.js';
import { getModelsFromOpencodeConfig } from './models-sync.js';
import {
  readHarnessSettings,
  parseHarnessCommandArgs,
  updateHarnessSettings,
  syncModelsInAllHarnesses,
} from './cli/harness-sync.js';
import { probeModel } from './model-probe.js';
import { getCachedProbe, setCachedProbe } from './probe-cache.js';
import type { ModelProbe } from './probe-cache.js';
import chalk from 'chalk';
import { printHelp } from './cli/help.js';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Help text (re-exported for testing)
// ---------------------------------------------------------------------------

export { printHelp } from './cli/help.js';

// ---------------------------------------------------------------------------
// Probe result formatter
// ---------------------------------------------------------------------------

function formatProbeStatus(status: string): string {
  switch (status) {
    case 'ok': return chalk.green('✓ ok');
    case 'unsupported': return chalk.yellow('? unsupported');
    case 'error': return chalk.red('✗ error');
    case 'rate_limited': return chalk.yellow('! rate_limited');
    default: return status;
  }
}

function printProbeResult(probe: ModelProbe): void {
  const livenessDetail = probe.liveness.details ? ` (${probe.liveness.details})` : '';
  const reasoningDetail = probe.reasoning.details ? ` (${probe.reasoning.details})` : '';
  const toolDetail = probe.toolCalling.details ? ` (${probe.toolCalling.details})` : '';

  console.log(`  Liveness:     ${formatProbeStatus(probe.liveness.status)}${livenessDetail}`);
  console.log(`  Reasoning:    ${formatProbeStatus(probe.reasoning.status)}${reasoningDetail}`);
  console.log(`  Tool Calling: ${formatProbeStatus(probe.toolCalling.status)}${toolDetail}`);
}

// ---------------------------------------------------------------------------
// Subcommand dispatch — if/else if prevents fallthrough to server code
// ---------------------------------------------------------------------------

const subcommand = process.argv[2];

if (subcommand === 'start') {
  const args = process.argv.slice(3);
  let port: number | undefined;
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = Number(args[++i]);
    } else if (args[i] === '--config' && args[i + 1]) {
      configPath = args[++i];
    }
  }
  daemonStart(port, configPath);
  // daemonStart owns its own exit path via setTimeout
} else if (subcommand === 'stop') {
  daemonStop();
} else if (subcommand === 'status') {
  daemonStatus();
} else if (subcommand === 'restart') {
  const args = process.argv.slice(3);
  let port: number | undefined;
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = Number(args[++i]);
    } else if (args[i] === '--config' && args[i + 1]) {
      configPath = args[++i];
    }
  }
  daemonRestart(port, configPath);
  // daemonRestart owns its own exit path via setTimeout -> daemonStart
} else if (subcommand === 'setup') {
  const { setup } = await import('./cli/setup.js');
  const { getDefaultConfigPath } = await import('./config.js');
  await setup(dirname(getDefaultConfigPath()));
  process.exit(0);
} else if (subcommand === 'autostart') {
  const action = process.argv[3];
  if (action === 'install') {
    const args = process.argv.slice(4);
    let port: number | undefined;
    let method: AutostartMethod | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--port' && args[i + 1]) {
        port = Number(args[++i]);
      } else if (args[i] === '--method' && args[i + 1]) {
        const m = args[++i];
        if (m === 'vbs' || m === 'registry' || m === 'auto') {
          method = m;
        }
      }
    }
    await autostartInstall(port, method);
    process.exit(0);
  } else if (action === 'uninstall') {
    const args = process.argv.slice(4);
    let method: AutostartMethod | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--method' && args[i + 1]) {
        const m = args[++i];
        if (m === 'vbs' || m === 'registry' || m === 'auto') {
          method = m;
        }
      }
    }
    autostartUninstall(method);
    process.exit(0);
  } else {
    const args = process.argv.slice(4);
    let method: AutostartMethod | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--method' && args[i + 1]) {
        const m = args[++i];
        if (m === 'vbs' || m === 'registry' || m === 'auto') {
          method = m;
        }
      }
    }
    autostartStatus(method);
    process.exit(0);
  }
} else if (subcommand === '--version' || subcommand === '-v') {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf-8')) as { version: string };
  console.log(pkg.version);
  process.exit(0);
} else if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
  printHelp();
  process.exit(0);
} else if (subcommand === 'sync-upstream') {
  let syncConfig: ProxyConfig;
  try {
    syncConfig = loadConfig();
  } catch (err) {
    console.error(chalk.red('Failed to load config:'), err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const results = await syncModelsInAllHarnesses(syncConfig);
  if (results.length === 0) {
    console.error(chalk.red('✗ No harnesses enabled. Run `saros-proxy configharness` first.'));
    process.exit(1);
  }
  for (const r of results) {
    if (r.result.success) {
      console.log(chalk.green(`✓ ${r.harness} synced to ${r.result.path}`));
    } else {
      console.error(chalk.red(`✗ ${r.harness}: ${r.result.error}`));
    }
  }
  process.exit(results.every((r) => r.result.success) ? 0 : 1);
} else if (subcommand === 'configharness') {
  const args = process.argv.slice(3);
  if (args.length === 0) {
    const cur = readHarnessSettings();
    console.log(chalk.cyan('Enabled harnesses: ' + (cur.join(', ') || '(none)')));
    process.exit(0);
  }
  const { add, remove, clear, errors } = parseHarnessCommandArgs(args);
  if (errors.length > 0) {
    console.error(chalk.red('Unknown harness: ' + errors.join(', ')));
    process.exit(1);
  }
  if (clear && (add.length > 0 || remove.length > 0)) {
    console.error(chalk.red('Cannot combine --clear with harness names.'));
    process.exit(1);
  }
  if (args.includes('--remove') && remove.length === 0) {
    console.error(chalk.red('Missing harness name after --remove.'));
    process.exit(1);
  }
  const ids = updateHarnessSettings({ add, remove, clear });
  console.log(chalk.green('Enabled harnesses: ' + (ids.join(', ') || '(none)')));
  process.exit(0);
} else if (subcommand === 'probe') {
  let probeConfig: ProxyConfig;
  try {
    probeConfig = loadConfig();
  } catch (err) {
    console.error('Failed to load config:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const configPath = getDefaultOpencodeConfigPath();
  const allModelIds = getModelsFromOpencodeConfig(configPath);

  if (allModelIds.length === 0) {
    console.error(chalk.red('✗ No models found in opencode config'));
    process.exit(1);
  }

  const targetModelId = process.argv[3];
  let modelsToProbe: string[];
  if (targetModelId) {
    if (!allModelIds.includes(targetModelId)) {
      console.error(chalk.red(`✗ Model "${targetModelId}" not found in opencode config`));
      process.exit(1);
    }
    modelsToProbe = [targetModelId];
  } else {
    modelsToProbe = allModelIds;
  }

  // Check cache for each model
  const toProbe: string[] = [];
  const cached: string[] = [];
  for (const id of modelsToProbe) {
    if (getCachedProbe(id)) {
      cached.push(id);
    } else {
      toProbe.push(id);
    }
  }

  // Probe uncached models sequentially
  for (const id of toProbe) {
    console.log(chalk.cyan(`Probing ${id}...`));
    try {
      const result = await probeModel(probeConfig, id);
      // Only cache results where at least one probe succeeded.
      // Don't cache error or rate_limited — those may be transient (e.g.
      // proxy was down on first run). An 'ok' result definitively
      // confirms a capability, so it's safe to cache for the TTL.
      if (result.liveness.status === 'ok' || result.reasoning.status === 'ok' || result.toolCalling.status === 'ok') {
        setCachedProbe(id, result);
      }
      printProbeResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  Error: ${message}`);
    }
  }

  // Print cached results
  for (const id of cached) {
    const cachedResult = getCachedProbe(id);
    if (cachedResult) {
      console.log(chalk.dim(`${id} (cached)`));
      printProbeResult(cachedResult);
    }
  }

  console.log(chalk.dim(`\nSummary: ${toProbe.length + cached.length}/${modelsToProbe.length} models probed, ${cached.length} skipped (cached)`));
  process.exit(0);
} else if (subcommand === 'usage') {
  process.exit(await runUsageCommand());
} else if (subcommand === 'serve') {
  // -----------------------------------------------------------------------
  // --port/--config are picked up by loadConfig()'s CLI-arg parsing.
  // -----------------------------------------------------------------------

  let config: ProxyConfig;
  try {
    config = loadConfig();
  } catch (err) {
    logger.error({ err }, 'Failed to load configuration');
    process.exit(1);
  }

  logger.info('Loaded %d API key(s):', config.keys.length);
  for (const k of config.keys) {
    logger.info('  - %s: %s', k.label, maskKey(k.key));
  }

  // -----------------------------------------------------------------------
  // Security startup banner
  // -----------------------------------------------------------------------

  function logSecurityWarnings(cfg: ProxyConfig): void {
    if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost') {
      logger.warn(
        'Proxy binding to "%s" — not localhost. Ensure firewall rules are set.',
        cfg.host,
      );
    }

    if (cfg.requestTimeoutMs > 60_000) {
      logger.warn(
        'Request timeout is %dms (>60s) — may cause resource exhaustion',
        cfg.requestTimeoutMs,
      );
    }

    if (cfg.allowedOrigins.length === 0) {
      logger.warn('CORS allows all origins — restrict in production');
    }

    logger.info(
      'Security: %d API keys loaded (all masked in logs)',
      cfg.keys.length,
    );
  }

  logSecurityWarnings(config);

  // Fire-and-forget version check
  checkForUpdate();

  // -----------------------------------------------------------------------
  // Server
  // -----------------------------------------------------------------------

  const app = createProxyApp(config);

  const server: ServerType = serve(
    { fetch: app.fetch, port: config.port, hostname: config.host },
    (info: { address: string; port: number }) => {
      logger.info('Proxy listening on http://%s:%d', info.address, info.port);
      logger.info('Upstream: %s', config.upstreamBaseUrl);
      logger.info('API keys loaded: %d', config.keys.length);
    },
  );

  // -----------------------------------------------------------------------
  // Graceful shutdown
  // -----------------------------------------------------------------------

  let isShuttingDown = false;

  function gracefulShutdown(signal: string): void {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info('Received %s, starting graceful shutdown...', signal);
    // Persist model counters that are still sitting in the debounce window
    flushModelStats();
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, FORCE_SHUTDOWN_TIMEOUT_MS);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
} else {
  // -----------------------------------------------------------------------
  // No subcommand — print an overview. Bare invocation never starts a
  // server: use `saros-proxy start` (daemon) or `saros-proxy serve`.
  // -----------------------------------------------------------------------

  const { printOverview } = await import('./cli/overview.js');
  await printOverview();
  process.exit(0);
}
