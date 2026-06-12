#!/usr/bin/env node

/**
 * index.ts — Entry point for Saros.
 *
 * Usage:
 *   tsx src/index.ts
 *   tsx src/index.ts --config my-config.yaml
 *   tsx src/index.ts --port 4000 --host 0.0.0.0
 *   tsx src/index.ts setup                     # Run the interactive setup wizard
 */

import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { dirname } from 'node:path';
import { loadConfig, type ProxyConfig } from './config.js';
import { createProxyApp } from './proxy.js';
import { logger, maskKey } from './logger.js';
import { startScraper, stopScraper } from './scraper.js';
import { FORCE_SHUTDOWN_TIMEOUT_MS } from './constants.js';
import { daemonStart, daemonStop, daemonStatus } from './cli/daemon.js';
import { syncModelsToOpencodeConfig } from './cli/opencode-config.js';
import { autostartInstall, autostartUninstall, autostartStatus, type AutostartMethod } from './cli/autostart.js';
import { checkForUpdate } from './cli/update-check.js';

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
} else if (subcommand === 'sync-models') {
  const result = syncModelsToOpencodeConfig();
  if (result.success) {
    console.log(`Models synced to ${result.path}`);
    process.exit(0);
  } else {
    console.error(`Failed: ${result.error}`);
    process.exit(1);
  }
} else if (process.argv[2] === 'setup') {
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
    autostartInstall(port, method);
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
} else {
  // -----------------------------------------------------------------------
  // No subcommand — start proxy in foreground (original behavior)
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

      if (config.scraping?.enabled && config.scraping.accounts.length > 0) {
        startScraper(config.scraping.accounts, config.scraping.intervalMs);
      } else {
        logger.info('Usage-based scraping disabled (not configured or no accounts)');
      }
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

    stopScraper();

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
}
