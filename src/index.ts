/**
 * index.ts — Entry point for the OpenCode-Go Multi-Account Proxy.
 *
 * Usage:
 *   tsx src/index.ts
 *   tsx src/index.ts --config my-config.yaml
 *   tsx src/index.ts --port 4000 --host 0.0.0.0
 */

import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { loadConfig, type ProxyConfig } from './config.js';
import { createProxyApp } from './proxy.js';
import { logger, maskKey } from './logger.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Security startup banner
// ---------------------------------------------------------------------------

function logSecurityWarnings(cfg: ProxyConfig): void {
  // Not binding to localhost — warn about exposure
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost') {
    logger.warn(
      'Proxy binding to "%s" — not localhost. Ensure firewall rules are set.',
      cfg.host,
    );
  }

  // Unusually long request timeout
  if (cfg.requestTimeoutMs > 60_000) {
    logger.warn(
      'Request timeout is %dms (>60s) — may cause resource exhaustion',
      cfg.requestTimeoutMs,
    );
  }

  // CORS allowing all origins (empty allowedOrigins means all are allowed)
  if (cfg.allowedOrigins.length === 0) {
    logger.warn('CORS allows all origins — restrict in production');
  }

  logger.info(
    'Security: %d API keys loaded (all masked in logs)',
    cfg.keys.length,
  );
}

logSecurityWarnings(config);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const app = createProxyApp(config);

const server: ServerType = serve(
  { fetch: app.fetch, port: config.port, hostname: config.host },
  (info: { address: string; port: number }) => {
    logger.info('Proxy listening on http://%s:%d', info.address, info.port);
    logger.info('Upstream: %s', config.upstreamBaseUrl);
    logger.info('API keys loaded: %d', config.keys.length);
  },
);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let isShuttingDown = false;

function gracefulShutdown(signal: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Received %s, starting graceful shutdown...', signal);

  // Stop accepting new connections
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 5_000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
