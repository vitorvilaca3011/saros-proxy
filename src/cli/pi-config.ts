/**
 * pi-config.ts — pi harness (pi-coding-agent) client configuration management.
 *
 * Reads, merges, and writes ~/.pi/agent/models.json to add or update the
 * saros-proxy provider + model list. JSON format. Only updates an existing
 * config in place — never creates one from scratch — and preserves every
 * user field except `providers["saros-proxy"].models`.
 */

import { constants, existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { toPiOmpModelArray } from './harness-models.js';
import type { OpencodeConfigResult } from './opencode-config.js';

/** Default pi config path: ~/.pi/agent/models.json */
export function getDefaultPiConfigPath(): string {
  return join(homedir(), '.pi', 'agent', 'models.json');
}

const SAROS_PROVIDER_KEY = 'saros-proxy';

/**
 * Sync the saros-proxy provider + model list into the pi models.json.
 *
 * @param modelsMap — Canonical model map (id → opencode-shaped entry)
 * @param port — Proxy port for a fresh provider's baseUrl (existing baseUrl wins)
 * @param options.configPath — Explicit config path (for testing)
 * @returns Result with success status and path
 */
export function syncModelsToPiConfig(
  modelsMap: Record<string, unknown>,
  port: number,
  options: { configPath?: string } = {},
): OpencodeConfigResult {
  const configPath = options.configPath ?? getDefaultPiConfigPath();

  if (!existsSync(configPath)) {
    return { success: false, error: 'config not found at ' + configPath };
  }

  try {
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      return { success: false, path: configPath, error: 'pi config contains invalid JSON' };
    }

    const providers = (config.providers as Record<string, unknown> | undefined) ?? {};
    const rawExisting = providers[SAROS_PROVIDER_KEY];
    const existing =
      rawExisting && typeof rawExisting === 'object' && !Array.isArray(rawExisting)
        ? (rawExisting as Record<string, unknown>)
        : {};
    const isNew = Object.keys(existing).length === 0;

    const baseUrl =
      typeof existing.baseUrl === 'string'
        ? existing.baseUrl
        : `http://127.0.0.1:${port}/zen/go/v1`;

    // Fresh-provider stub; existing fields always win for non-models keys.
    const freshStub = isNew
      ? {
          name: 'Saros',
          apiKey: 'not-used',
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            maxTokensField: 'max_tokens',
          },
        }
      : {};

    providers[SAROS_PROVIDER_KEY] = {
      ...freshStub,
      ...existing,
      baseUrl,
      api: typeof existing.api === 'string' ? existing.api : 'openai-completions',
      models: toPiOmpModelArray(modelsMap),
    };
    config.providers = providers;

    // Backup before modifying (never overwrite an existing backup)
    const backupPath = `${configPath}.backup`;
    try {
      copyFileSync(configPath, backupPath, constants.COPYFILE_EXCL);
    } catch {
      // Backup already exists — keep it
    }

    // Write
    const json = JSON.stringify(config, null, 2);
    writeFileSync(configPath, json, 'utf-8');

    // Validate: re-read to ensure we didn't corrupt it
    try {
      JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      try {
        copyFileSync(backupPath, configPath);
      } catch {
        // No backup to restore — report the failure as-is
      }
      return {
        success: false,
        path: configPath,
        error: 'Failed to write valid JSON after sync. Restored from backup.',
      };
    }

    return { success: true, path: configPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, path: configPath, error: message };
  }
}
