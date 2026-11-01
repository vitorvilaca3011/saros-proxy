/**
 * config.ts — Configuration loading from YAML file or environment variables.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { logger, maskKey } from './logger.js';
import { redactErrorMessage } from './log-redact.js';
import { decryptKey, isEncryptedKey } from './key-encryption.js';
import { decryptValue, isEnvelope } from './secrets/envelope.js';
import {
  NO_PASSPHRASE_MESSAGE,
  SecretSourceError,
  decryptFailureMessage,
  readEnvPassphrase,
  readStorePassphrase,
} from './secrets/source.js';
import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_UPSTREAM_URL,
  DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from './constants.js';
import { isValidPort, isValidHttpsUrl, isValidApiKey } from './validation.js';
import type { ProviderId } from './providers/index.js';
import { inferProvider, type KeyEntry } from './providers/infer.js';

export type { KeyEntry };

export interface ProxyConfig {
  port: number;
  host: string;
  keys: KeyEntry[];
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
  /** Default upstream (opencode-go). Per-provider overrides in upstreams. */
  upstreamBaseUrl: string;
  /** Per-provider upstream override map, e.g. { commandcode: 'https://…' }. */
  upstreams?: Partial<Record<ProviderId, string>>;
  requestTimeoutMs: number;
  allowedOrigins: string[];
}

interface YamlConfig {
  port?: number;
  host?: string;
  upstreamBaseUrl?: string;
  upstreams?: Partial<Record<ProviderId, string>>;
  circuitBreakerThreshold?: number;
  circuitBreakerCooldownMs?: number;
  requestTimeoutMs?: number;
  allowedOrigins?: string[];
  keys?: KeyEntry[];
}

export interface LoadConfigOptions {
  /**
   * Passphrase already resolved by a foreground `serve` (which may have used
   * the TTY prompt). When absent, loading uses SAROS_PASSPHRASE, then the OS
   * store; it never prompts, so reporting commands cannot hang.
   */
  passphrase?: string;
}

/**
 * Return the OS-native user config directory path for saros.
 *
 * Windows: %LOCALAPPDATA%\saros\
 * macOS/Linux: ~/.config/saros/ (XDG)
 */
export function getSarosDir(): string {
  return dirname(getDefaultConfigPath());
}

/**
 * Return the OS-native user config file path for saros.
 */
export function getDefaultConfigPath(): string {
  const home = homedir();
  if (!home) {
    throw new Error(
      'Cannot determine home directory — set XDG_CONFIG_HOME or LOCALAPPDATA environment variable',
    );
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(localAppData, 'saros', 'config.yaml');
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, '.config');
  return join(xdgConfig, 'saros', 'config.yaml');
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
 * Normalize one key entry: resolve its provider and drop a malformed `enabled`.
 * A non-boolean `enabled` is a config typo, not a retirement order — warning and
 * keeping the key enabled beats silently taking a credential out of rotation.
 */
function normalizeKeyEntry(entry: KeyEntry): KeyEntry {
  const provider = inferProvider(entry);
  if (entry.enabled === undefined) return { ...entry, provider };
  if (typeof entry.enabled !== 'boolean') {
    logger.warn('Key "%s": "enabled" must be true or false — ignoring it', entry.label);
    return { ...entry, enabled: undefined, provider };
  }
  return { ...entry, provider };
}

/**
 * Validate and normalize a partial config object.
 * Logs warnings for invalid values that fall back to defaults.
 * Throws an error if no valid API keys are present (critical issue).
 */
export function validateConfig(config: Partial<ProxyConfig>): ProxyConfig {
  // --- Port ---
  let port = config.port ?? DEFAULT_PORT;
  if (!isValidPort(port)) {
    logger.warn('Invalid port %d, defaulting to %d', port, DEFAULT_PORT);
    port = DEFAULT_PORT;
  }

  // --- Host ---
  let host = config.host ?? DEFAULT_HOST;
  // Simple validation: only allow alphanumeric, dots, hyphens, colons (for IPv6), brackets
  const hostRegex = /^[a-zA-Z0-9._:\-[\]]+$/;
  if (!hostRegex.test(host)) {
    logger.warn('Invalid host "%s", defaulting to %s', host, DEFAULT_HOST);
    host = DEFAULT_HOST;
  }

  // --- Upstream URL (SSRF prevention — must be HTTPS) ---
  let upstreamBaseUrl = config.upstreamBaseUrl ?? DEFAULT_UPSTREAM_URL;
  if (!isValidHttpsUrl(upstreamBaseUrl)) {
    logger.warn(
      'Upstream URL "%s" must use HTTPS, defaulting to %s',
      upstreamBaseUrl,
      DEFAULT_UPSTREAM_URL,
    );
    upstreamBaseUrl = DEFAULT_UPSTREAM_URL;
  }

  // --- API keys (structurally valid for some provider, >= 20 chars) ---
  const rawKeys = config.keys ?? [];
  const validKeys = rawKeys.filter((k) => {
    if (!isValidApiKey(k.key)) {
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
  let circuitBreakerCooldownMs = config.circuitBreakerCooldownMs ?? DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS;
  if (
    !Number.isInteger(circuitBreakerCooldownMs) ||
    circuitBreakerCooldownMs < 1_000 ||
    circuitBreakerCooldownMs > 3_600_000
  ) {
    logger.warn(
      'Invalid circuitBreakerCooldownMs %d, defaulting to %d',
      circuitBreakerCooldownMs,
      DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
    );
    circuitBreakerCooldownMs = DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS;
  }

  // --- Request timeout ---
  let requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1_000 ||
    requestTimeoutMs > 300_000
  ) {
    logger.warn(
      'Invalid requestTimeoutMs %d, defaulting to %d',
      requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  }

  // --- Allowed origins (CORS) ---
  const allowedOrigins = config.allowedOrigins ?? [
    'http://localhost:*',
    'http://127.0.0.1:*',
  ];

  // --- Per-provider upstreams (SSRF: every value must be HTTPS) ---
  const upstreams: Partial<Record<ProviderId, string>> = {};
  for (const [id, url] of Object.entries(config.upstreams ?? {})) {
    if (!url) continue;
    if (!isValidHttpsUrl(url)) {
      logger.warn('Upstream URL for provider "%s" must use HTTPS, ignoring', id);
      continue;
    }
    upstreams[id as ProviderId] = url.replace(/\/$/, '');
  }

  return {
    port,
    host,
    keys: validKeys.map(normalizeKeyEntry),
    circuitBreakerThreshold,
    circuitBreakerCooldownMs,
    upstreamBaseUrl,
    upstreams,
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
export function loadConfig(configPath?: string, options: LoadConfigOptions = {}): ProxyConfig {
  const cliArgs = parseCliArgs();
  const config = getBaseConfig();

  applyEnvConfig(config);

  const yamlPath = resolveConfigPath(configPath);
  const yaml = loadYamlOverrides(yamlPath);
  if (yaml) {
    applyYamlConfig(config, yaml);
    warnPlaintextKeys(yaml, yamlPath);
  }

  resolveEncryptedKeys(config, options.passphrase);

  applyCliOverrides(config, cliArgs);

  return validateConfig(config);
}

function getBaseConfig(): ProxyConfig {
  return {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    keys: [],
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
    upstreamBaseUrl: DEFAULT_UPSTREAM_URL,
    upstreams: {},
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],
  };
}

function applyEnvConfig(config: ProxyConfig): void {
  if (process.env.PROXY_PORT) {
    config.port = Number.parseInt(process.env.PROXY_PORT, 10);
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
    }).filter((k) => isValidApiKey(k.key));
  }
}

function resolveYamlPath(cliConfigArg: string | undefined, explicitPath: string | undefined): string {
  if (explicitPath) return explicitPath;
  if (cliConfigArg) return cliConfigArg;

  const defaultPath = getDefaultConfigPath();
  if (existsSync(defaultPath)) return defaultPath;

  if (existsSync('config.yaml')) {
    logger.warn('Config loaded from current directory (config.yaml). Consider moving it to %s', defaultPath);
    return 'config.yaml';
  }
  return defaultPath;
}

/**
 * The path `loadConfig` would read, honouring `--config` and falling back to
 * the OS config directory (or ./config.yaml when that is all that exists).
 * Exported so `keys encrypt` rewrites the same file the proxy reads.
 */
export function resolveConfigPath(explicitPath?: string): string {
  return resolveYamlPath(parseCliArgs().config, explicitPath);
}

function loadYamlOverrides(yamlPath: string): YamlConfig | null {
  if (!existsSync(yamlPath)) {
    logger.info('No config file found at %s, using env/defaults', yamlPath);
    return null;
  }
  try {
    const raw = readFileSync(yamlPath, 'utf-8');
    const yaml = parseYaml(raw) as YamlConfig;
    logger.info('Loaded config from %s', yamlPath);
    return yaml;
  } catch (err) {
    // YAMLParseError.message embeds the offending line — possibly a key.
    logger.error('Failed to parse config file %s: %s', yamlPath, redactErrorMessage(err));
    return null;
  }
}

function applyYamlConfig(config: ProxyConfig, yaml: YamlConfig): void {
  if (yaml.port !== undefined) config.port = yaml.port;
  if (yaml.host !== undefined) config.host = yaml.host;
  if (yaml.upstreamBaseUrl !== undefined) config.upstreamBaseUrl = yaml.upstreamBaseUrl;
  if (yaml.upstreams !== undefined) config.upstreams = yaml.upstreams;
  if (yaml.circuitBreakerThreshold !== undefined) config.circuitBreakerThreshold = yaml.circuitBreakerThreshold;
  if (yaml.circuitBreakerCooldownMs !== undefined) config.circuitBreakerCooldownMs = yaml.circuitBreakerCooldownMs;
  if (yaml.requestTimeoutMs !== undefined) config.requestTimeoutMs = yaml.requestTimeoutMs;
  if (yaml.allowedOrigins !== undefined) config.allowedOrigins = yaml.allowedOrigins;
  if (yaml.keys && yaml.keys.length > 0) config.keys = yaml.keys;
}

/**
 * Warn once at load time when the YAML file still holds plaintext credentials.
 * Env-provided keys (`OPENCODE_GO_KEYS`) are plaintext by design and are not
 * part of this warning.
 */
function warnPlaintextKeys(yaml: YamlConfig, yamlPath: string): void {
  if (!Array.isArray(yaml.keys)) return;
  const hasPlaintext = yaml.keys.some(
    (entry) =>
      typeof entry?.key === 'string' && !isEnvelope(entry.key) && !isEncryptedKey(entry.key),
  );
  if (!hasPlaintext) return;
  logger.warn(
    { evt: 'security.plaintext-keys' },
    'API keys are stored in plaintext in %s — run `saros-proxy keys encrypt` to encrypt them',
    yamlPath,
  );
}

/** Plaintext entries must not be able to claim `encrypted: true` in YAML. */
function withoutEncryptedFlag(entry: KeyEntry): KeyEntry {
  const copy = { ...entry };
  delete copy.encrypted;
  return copy;
}

/** Resolve every `enc:` entry before validation; a failure aborts boot. */
function resolveEncryptedKeys(config: ProxyConfig, explicitPassphrase: string | undefined): void {
  const hasEnvelopes = config.keys.some((key) => isEnvelope(key.key));
  const passphrase = hasEnvelopes ? resolveEnvelopePassphrase(explicitPassphrase) : '';
  config.keys = config.keys.map((entry) => {
    if (isEnvelope(entry.key)) return decryptEnvelopeEntry(entry, passphrase);
    if (typeof entry.key === 'string' && isEncryptedKey(entry.key)) {
      return { ...entry, key: decryptLegacyEntry(entry), encrypted: true };
    }
    return withoutEncryptedFlag(entry);
  });
}

/**
 * Envelope passphrase: the value already resolved by `serve`, then the env
 * var, then the OS store. Deliberately never prompts — reporting commands and
 * the daemon child must not block on a terminal that is not there.
 */
function resolveEnvelopePassphrase(explicitPassphrase: string | undefined): string {
  if (explicitPassphrase !== undefined && explicitPassphrase.length > 0) return explicitPassphrase;

  const env = readEnvPassphrase();
  if (env.ok) return env.value;

  const store = readStorePassphrase();
  if (store.ok) return store.value;

  throw new SecretSourceError(`${NO_PASSPHRASE_MESSAGE}\nStore: ${store.reason}`);
}

function decryptEnvelopeEntry(entry: KeyEntry, passphrase: string): KeyEntry {
  const result = decryptValue(entry.key, passphrase, entry.label);
  if (!result.ok) {
    throw new SecretSourceError(decryptFailureMessage(entry.label, result.error.message));
  }
  return { ...entry, key: result.value, encrypted: true };
}

/** `enc:scrypt:` values predate the v1 envelope; keep them readable. */
function decryptLegacyEntry(entry: KeyEntry): string {
  const legacyKey = process.env.OPENCODE_GO_ENCRYPTION_KEY;
  if (!legacyKey) {
    throw new Error(
      'Found encrypted API key(s) but OPENCODE_GO_ENCRYPTION_KEY environment variable is not set',
    );
  }
  try {
    const plaintext = decryptKey(entry.key, legacyKey);
    logger.warn(
      { evt: 'security.legacy-encryption' },
      'Key "%s" uses legacy enc:scrypt encryption with OPENCODE_GO_ENCRYPTION_KEY — replace it with plaintext and run `saros-proxy keys encrypt` to migrate',
      entry.label,
    );
    return plaintext;
  } catch {
    throw new Error(`Failed to decrypt API key "${entry.label}" — check OPENCODE_GO_ENCRYPTION_KEY`);
  }
}

function applyCliOverrides(config: ProxyConfig, cliArgs: Record<string, string>): void {
  if (cliArgs.port) {
    config.port = Number.parseInt(cliArgs.port, 10);
  }
  if (cliArgs.host) {
    config.host = cliArgs.host;
  }
}
