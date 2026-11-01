/**
 * boot.ts — Boot-time passphrase resolution and the structured boot log line.
 *
 * `serve` calls {@link prepareBootPassphrase} before `loadConfig`: it only
 * prompts when the config actually contains `enc:v1:` values, and only when
 * the caller allows it (foreground serve, never the daemon child). The
 * loader then decrypts synchronously with the resolved value.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { resolveConfigPath, type ProxyConfig } from '../config.js';
import { isEnvelope } from './envelope.js';
import {
  NO_PASSPHRASE_MESSAGE,
  SecretSourceError,
  resolvePassphrase,
  type ResolveOptions,
} from './source.js';

export interface BootPassphraseOptions extends ResolveOptions {
  configPath?: string;
}

/** True when the YAML file has at least one `enc:v1:` key value. */
export function configHasEnvelopeKeys(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  try {
    const yaml = parseYaml(readFileSync(configPath, 'utf-8')) as {
      keys?: Array<{ key?: unknown }>;
    };
    return Array.isArray(yaml?.keys) && yaml.keys.some((entry) => isEnvelope(entry?.key));
  } catch {
    // A malformed config is loadConfig's error to report, not boot's.
    return false;
  }
}

/**
 * Resolve the passphrase only when it is needed. Returns undefined for a
 * config with no envelopes. Throws {@link SecretSourceError} naming the three
 * sources when every source failed.
 */
export async function prepareBootPassphrase(
  options: BootPassphraseOptions = {},
): Promise<string | undefined> {
  const configPath = options.configPath ?? resolveConfigPath();
  if (!configHasEnvelopeKeys(configPath)) return undefined;

  const allowTty = options.allowTty ?? process.env.SAROS_DAEMON !== '1';
  const resolved = await resolvePassphrase({ ...options, allowTty });
  if (resolved.ok) return resolved.value;

  const attempts = resolved.attempts
    .map((entry) => `  ${entry.source}: ${entry.reason}`)
    .join('\n');
  throw new SecretSourceError(`${NO_PASSPHRASE_MESSAGE}\nAttempts:\n${attempts}`);
}

export interface BootMetadata {
  version: string;
  node: string;
  platform: string;
  bundledModels: number;
  logLevel: string;
}

/**
 * Fields for the one structured `evt:"boot"` line. Key material is reduced to
 * label + provider + encrypted flag; never the key, ciphertext or passphrase.
 */
export function buildBootLog(
  config: ProxyConfig,
  configPath: string,
  metadata: BootMetadata,
): Record<string, unknown> {
  return {
    evt: 'boot',
    version: metadata.version,
    node: metadata.node,
    platform: metadata.platform,
    configPath,
    port: config.port,
    host: config.host,
    keys: config.keys.map((key) => ({
      label: key.label,
      provider: key.provider,
      encrypted: key.encrypted === true,
    })),
    bundledModels: metadata.bundledModels,
    logLevel: metadata.logLevel,
  };
}
