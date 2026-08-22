/**
 * omp-config.ts — oh-my-pi harness (omp) client configuration management.
 *
 * Reads, merges, and writes ~/.omp/agent/models.yml to add or update the
 * saros-proxy provider + model list. YAML format. Only updates an existing
 * config in place — never creates one from scratch — and preserves every
 * user field except `providers["saros-proxy"].models`.
 *
 * ~/.omp/agent/models.db is an auto-managed omp cache reconciled to
 * models.yml — it is never edited here.
 */

import { constants, existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { toPiOmpModelArray } from './harness-models.js';
import type { OpencodeConfigResult } from './opencode-config.js';

/** Default oh-my-pi config path: ~/.omp/agent/models.yml */
export function getDefaultOmpConfigPath(): string {
  return join(homedir(), '.omp', 'agent', 'models.yml');
}

const SAROS_PROVIDER_KEY = 'saros-proxy';

/**
 * Sync the saros-proxy provider + model list into the oh-my-pi models.yml.
 *
 * @param modelsMap — Canonical model map (id → opencode-shaped entry)
 * @param port — Proxy port for a fresh provider's baseUrl (existing baseUrl wins)
 * @param options.configPath — Explicit config path (for testing)
 * @returns Result with success status and path
 */
export function syncModelsToOmpConfig(
  modelsMap: Record<string, unknown>,
  port: number,
  options: { configPath?: string } = {},
): OpencodeConfigResult {
  const configPath = options.configPath ?? getDefaultOmpConfigPath();

  if (!existsSync(configPath)) {
    return { success: false, error: 'config not found at ' + configPath };
  }

  try {
    let config: Record<string, unknown>;
    try {
      const parsed = parseYaml(readFileSync(configPath, 'utf-8'));
      config = (parsed as Record<string, unknown>) ?? {};
    } catch {
      return { success: false, path: configPath, error: 'oh-my-pi config contains invalid YAML' };
    }
    if (typeof config !== 'object' || Array.isArray(config)) {
      return { success: false, path: configPath, error: 'oh-my-pi config contains invalid YAML' };
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

    // Fresh-provider stub (omp has no provider-level `name`); existing fields
    // always win for non-models keys.
    const freshStub = isNew
      ? {
          apiKey: 'not-used',
          auth: 'none',
          compat: {
            supportsDeveloperRole: false,
            maxTokensField: 'max_tokens',
          },
        }
      : {};

    // saros owns `compat.supportsReasoningEffort`: the proxy forwards
    // reasoning_effort verbatim, and a stale `false` (pre-efforts sync
    // default) makes the harness omit the wire parameter entirely.
    const rawCompat =
      existing.compat && typeof existing.compat === 'object' && !Array.isArray(existing.compat)
        ? (existing.compat as Record<string, unknown>)
        : {};

    providers[SAROS_PROVIDER_KEY] = {
      ...freshStub,
      ...existing,
      baseUrl,
      api: typeof existing.api === 'string' ? existing.api : 'openai-completions',
      models: toPiOmpModelArray(modelsMap),
      compat: {
        ...((freshStub as { compat?: Record<string, unknown> }).compat ?? {}),
        ...rawCompat,
        supportsReasoningEffort: true,
      },
    };
    config.providers = providers;

    // Backup before modifying (never overwrite an existing backup)
    const backupPath = `${configPath}.backup`;
    try {
      // COPYFILE_EXCL fails if the backup already exists — no check-then-act race
      copyFileSync(configPath, backupPath, constants.COPYFILE_EXCL);
    } catch {
      // Backup already exists — keep it
    }

    // Write (YAML round-trip drops comments — consistent with JSONC rewrite)
    const yaml = stringifyYaml(config);
    writeFileSync(configPath, yaml, 'utf-8');

    // Validate: re-read to ensure we didn't corrupt it
    try {
      parseYaml(readFileSync(configPath, 'utf-8'));
    } catch {
      try {
        copyFileSync(backupPath, configPath);
      } catch {
        // No backup to restore — report the failure as-is
      }
      return {
        success: false,
        path: configPath,
        error: 'Failed to write valid YAML after sync. Restored from backup.',
      };
    }

    return { success: true, path: configPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, path: configPath, error: message };
  }
}
