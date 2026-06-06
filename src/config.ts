/**
 * config.ts — Configuration loading from YAML file or environment variables.
 */

import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { logger, maskKey } from './logger.js';
import { decryptKey, isEncryptedKey } from './key-encryption.js';

export interface ProxyConfig {
  port: number;
  host: string;
  keys: Array<{ label: string; key: string }>;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
  upstreamBaseUrl: string;
  requestTimeoutMs: number;
  allowedOrigins: string[];
  scraping?: ScrapingConfig;
}

export interface ScrapingAccount {
  workspaceId: string;
  authCookie: string;
}

export interface ScrapingConfig {
  enabled: boolean;
  intervalMs: number;
  usageThreshold: number;
  accounts: ScrapingAccount[];
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
  scraping?: {
    enabled?: boolean;
    intervalMs?: number;
    usageThreshold?: number;
    accounts?: ScrapingAccount[];
  };
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

  // --- Scraping config (optional) ---
  let scraping: ScrapingConfig | undefined;
  if (config.scraping) {
    const s = config.scraping;

    // enabled: default false
    const enabled = s.enabled ?? false;

    // intervalMs: default 90000, range 10000-3600000
    let intervalMs = s.intervalMs ?? 90_000;
    if (!Number.isInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 3_600_000) {
      logger.warn('Invalid scraping.intervalMs %d, defaulting to 90000', intervalMs);
      intervalMs = 90_000;
    }

    // usageThreshold: default 50, range 1-100
    let usageThreshold = s.usageThreshold ?? 50;
    if (!Number.isInteger(usageThreshold) || usageThreshold < 1 || usageThreshold > 100) {
      logger.warn('Invalid scraping.usageThreshold %d, defaulting to 50', usageThreshold);
      usageThreshold = 50;
    }

    // accounts: filter invalid entries
    const rawAccounts = s.accounts ?? [];
    const validAccounts = rawAccounts.filter((acc) => {
      // workspaceId must match wrk_[A-Za-z0-9]+
      if (!/^wrk_[A-Za-z0-9]+$/.test(acc.workspaceId)) {
        logger.warn('Invalid scraping account workspaceId "%s", filtering out', acc.workspaceId);
        return false;
      }
      // authCookie must not be empty
      if (!acc.authCookie || acc.authCookie.trim() === '') {
        logger.warn('Invalid scraping account authCookie for "%s", filtering out', acc.workspaceId);
        return false;
      }
      return true;
    });

    scraping = {
      enabled,
      intervalMs,
      usageThreshold,
      accounts: validAccounts,
    };
  }

  return {
    port,
    host,
    keys: validKeys,
    circuitBreakerThreshold,
    circuitBreakerCooldownMs,
    upstreamBaseUrl,
    requestTimeoutMs,
    allowedOrigins,
    scraping,
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
    scraping: undefined,
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
  // Note: OPENCODE_GO_KEYS env var keys are always plaintext (CI/CD use case)
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
      if (yaml.scraping !== undefined) {
        config.scraping = {
          enabled: yaml.scraping.enabled ?? false,
          intervalMs: yaml.scraping.intervalMs ?? 90_000,
          usageThreshold: yaml.scraping.usageThreshold ?? 50,
          accounts: yaml.scraping.accounts ?? [],
        };
      }

      logger.info('Loaded config from %s', yamlPath);
    } catch (err) {
      logger.error({ err }, 'Failed to parse config file %s', yamlPath);
    }
  } else {
    logger.info('No config file found at %s, using env/defaults', yamlPath);
  }

  // --- Step 3.5: Decrypt encrypted keys ---
  const encryptionKey = process.env.OPENCODE_GO_ENCRYPTION_KEY;
  if (encryptionKey) {
    config.keys = config.keys.map((k) => {
      if (isEncryptedKey(k.key)) {
        try {
          return { ...k, key: decryptKey(k.key, encryptionKey) };
        } catch (err) {
          logger.error('Failed to decrypt key "%s": %s', k.label, err instanceof Error ? err.message : String(err));
          throw new Error(`Failed to decrypt API key "${k.label}" — check OPENCODE_GO_ENCRYPTION_KEY`);
        }
      }
      return k; // plaintext key, use as-is
    });

    // Decrypt encrypted authCookies in scraping accounts
    if (config.scraping?.accounts) {
      config.scraping.accounts = config.scraping.accounts.map((acc) => {
        if (isEncryptedKey(acc.authCookie)) {
          try {
            return { ...acc, authCookie: decryptKey(acc.authCookie, encryptionKey) };
          } catch (err) {
            logger.error('Failed to decrypt authCookie for workspace "%s": %s', acc.workspaceId, err instanceof Error ? err.message : String(err));
            throw new Error(`Failed to decrypt authCookie for workspace "${acc.workspaceId}" — check OPENCODE_GO_ENCRYPTION_KEY`);
          }
        }
        return acc; // plaintext cookie, use as-is
      });
    }
  } else {
    // Check if any keys are encrypted but no encryption key provided
    const encryptedKeys = config.keys.filter((k) => isEncryptedKey(k.key));
    if (encryptedKeys.length > 0) {
      throw new Error(
        `Found ${encryptedKeys.length} encrypted API key(s) but OPENCODE_GO_ENCRYPTION_KEY environment variable is not set`
      );
    }

    // Check if any authCookies are encrypted but no encryption key provided
    const encryptedCookies = config.scraping?.accounts?.filter((acc) => isEncryptedKey(acc.authCookie)) ?? [];
    if (encryptedCookies.length > 0) {
      throw new Error(
        `Found ${encryptedCookies.length} encrypted authCookie(s) but OPENCODE_GO_ENCRYPTION_KEY environment variable is not set`
      );
    }
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
