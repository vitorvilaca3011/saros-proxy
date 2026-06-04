/**
 * config.ts — Configuration loading from YAML file or environment variables.
 */

import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { logger, maskKey } from './logger.js';

export interface ProxyConfig {
  port: number;
  host: string;
  keys: Array<{ label: string; key: string }>;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
  upstreamBaseUrl: string;
  requestTimeoutMs: number;
  allowedOrigins: string[];
}

interface YamlConfig {
  port?: number;
  host?: string;
  upstreamBaseUrl?: string;
  circuitBreakerThreshold?: number;
  circuitBreakerCooldownMs?: number;
  requestTimeoutMs?: number;
  allowedOrigins?: string[];
  keys?: Array<{ label: string; key: string }>;
}

/**
 * Parse --key value pairs from process.argv.
 */
function parseCliArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = 'true';
      }
    }
  }
  return args;
}

/**
 * Validate and normalize a partial config object.
 * Logs warnings for invalid values that fall back to defaults.
 * Throws an error if no valid API keys are present (critical issue).
 */
export function validateConfig(config: Partial<ProxyConfig>): ProxyConfig {
  // --- Port ---
  let port = config.port ?? 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    logger.warn('Invalid port %d, defaulting to 3000', port);
    port = 3000;
  }

  // --- Host ---
  let host = config.host ?? '127.0.0.1';
  // Simple validation: only allow alphanumeric, dots, hyphens, colons (for IPv6), brackets
  const hostRegex = /^[a-zA-Z0-9._:\-[\]]+$/;
  if (!hostRegex.test(host)) {
    logger.warn('Invalid host "%s", defaulting to 127.0.0.1', host);
    host = '127.0.0.1';
  }

  // --- Upstream URL (SSRF prevention — must be HTTPS) ---
  let upstreamBaseUrl = config.upstreamBaseUrl ?? 'https://opencode.ai';
  try {
    const parsed = new URL(upstreamBaseUrl);
    if (parsed.protocol !== 'https:') {
      logger.warn(
        'Upstream URL "%s" must use HTTPS, defaulting to https://opencode.ai',
        upstreamBaseUrl,
      );
      upstreamBaseUrl = 'https://opencode.ai';
    }
  } catch {
    logger.warn(
      'Invalid upstream URL "%s", defaulting to https://opencode.ai',
      upstreamBaseUrl,
    );
    upstreamBaseUrl = 'https://opencode.ai';
  }

  // --- API keys (must start with sk- and be >= 20 chars) ---
  const rawKeys = config.keys ?? [];
  const validKeys = rawKeys.filter((k) => {
    if (!k.key.startsWith('sk-') || k.key.length < 20) {
      logger.warn('Invalid key "%s", filtering out', maskKey(k.key));
      return false;
    }
    return true;
  });

  if (validKeys.length === 0) {
    throw new Error('No valid API keys configured');
  }

  // --- Circuit breaker threshold ---
  let circuitBreakerThreshold = config.circuitBreakerThreshold ?? 3;
  if (
    !Number.isInteger(circuitBreakerThreshold) ||
    circuitBreakerThreshold < 1 ||
    circuitBreakerThreshold > 10
  ) {
    logger.warn(
      'Invalid circuitBreakerThreshold %d, defaulting to 3',
      circuitBreakerThreshold,
    );
    circuitBreakerThreshold = 3;
  }

  // --- Circuit breaker cooldown ---
  let circuitBreakerCooldownMs = config.circuitBreakerCooldownMs ?? 60_000;
  if (
    !Number.isInteger(circuitBreakerCooldownMs) ||
    circuitBreakerCooldownMs < 1_000 ||
    circuitBreakerCooldownMs > 3_600_000
  ) {
    logger.warn(
      'Invalid circuitBreakerCooldownMs %d, defaulting to 60000',
      circuitBreakerCooldownMs,
    );
    circuitBreakerCooldownMs = 60_000;
  }

  // --- Request timeout ---
  let requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1_000 ||
    requestTimeoutMs > 300_000
  ) {
    logger.warn(
      'Invalid requestTimeoutMs %d, defaulting to 30000',
      requestTimeoutMs,
    );
    requestTimeoutMs = 30_000;
  }

  // --- Allowed origins (CORS) ---
  const allowedOrigins = config.allowedOrigins ?? [
    'http://localhost:*',
    'http://127.0.0.1:*',
  ];

  return {
    port,
    host,
    keys: validKeys,
    circuitBreakerThreshold,
    circuitBreakerCooldownMs,
    upstreamBaseUrl,
    requestTimeoutMs,
    allowedOrigins,
  };
}

/**
 * Load config from YAML file (default: config.yaml in cwd) or env vars.
 *
 * Priority order (highest to lowest):
 *   1. CLI args (--config, --port, --host)
 *   2. YAML config file
 *   3. Environment variables
 *   4. Hardcoded defaults
 */
export function loadConfig(configPath?: string): ProxyConfig {
  const cliArgs = parseCliArgs();

  // --- Step 1: defaults ---
  const config: ProxyConfig = {
    port: 3000,
    host: '127.0.0.1',
    keys: [],
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
    upstreamBaseUrl: 'https://opencode.ai',
    requestTimeoutMs: 30_000,
    allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],
  };

  // --- Step 2: environment variables (lowest-priority source) ---
  if (process.env.PROXY_PORT) {
    config.port = parseInt(process.env.PROXY_PORT, 10);
  }
  if (process.env.PROXY_HOST) {
    config.host = process.env.PROXY_HOST;
  }
  if (process.env.UPSTREAM_BASE_URL) {
    config.upstreamBaseUrl = process.env.UPSTREAM_BASE_URL;
  }
  const envKeysRaw = process.env.OPENCODE_GO_KEYS;
  if (envKeysRaw) {
    config.keys = envKeysRaw.split(',').map((pair) => {
      const colonIdx = pair.indexOf(':');
      if (colonIdx === -1) {
        return { label: pair.trim(), key: '' };
      }
      return {
        label: pair.slice(0, colonIdx).trim(),
        key: pair.slice(colonIdx + 1).trim(),
      };
    }).filter((k) => k.key.startsWith('sk-'));
  }

  // --- Step 3: YAML config file ---
  const yamlPath = configPath || cliArgs.config || 'config.yaml';
  if (existsSync(yamlPath)) {
    try {
      const raw = readFileSync(yamlPath, 'utf-8');
      const yaml = parseYaml(raw) as YamlConfig;

      if (yaml.port !== undefined) config.port = yaml.port;
      if (yaml.host !== undefined) config.host = yaml.host;
      if (yaml.upstreamBaseUrl !== undefined) config.upstreamBaseUrl = yaml.upstreamBaseUrl;
      if (yaml.circuitBreakerThreshold !== undefined) config.circuitBreakerThreshold = yaml.circuitBreakerThreshold;
      if (yaml.circuitBreakerCooldownMs !== undefined) config.circuitBreakerCooldownMs = yaml.circuitBreakerCooldownMs;
      if (yaml.requestTimeoutMs !== undefined) config.requestTimeoutMs = yaml.requestTimeoutMs;
      if (yaml.allowedOrigins !== undefined) config.allowedOrigins = yaml.allowedOrigins;
      if (yaml.keys && yaml.keys.length > 0) config.keys = yaml.keys;

      logger.info('Loaded config from %s', yamlPath);
    } catch (err) {
      logger.error({ err }, 'Failed to parse config file %s', yamlPath);
    }
  } else {
    logger.info('No config file found at %s, using env/defaults', yamlPath);
  }

  // --- Step 4: CLI overrides (highest priority) ---
  if (cliArgs.port) {
    config.port = parseInt(cliArgs.port, 10);
  }
  if (cliArgs.host) {
    config.host = cliArgs.host;
  }

  // --- Step 5: Validate and normalize ---
  return validateConfig(config);
}
