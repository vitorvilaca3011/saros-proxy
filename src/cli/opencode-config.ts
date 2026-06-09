/**
 * opencode-config.ts — OpenCode client configuration management.
 *
 * Handles reading, merging, and writing the user's opencode.json
 * to add or update the proxy provider configuration.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Path detection
// ---------------------------------------------------------------------------

/** Return the default opencode.json path for the current platform. */
export function getDefaultOpencodeConfigPath(): string {
  const home = homedir();
  return join(home, '.config', 'opencode', 'opencode.json');
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface OpencodeConfigResult {
  success: boolean;
  path?: string;
  created?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Core update function
// ---------------------------------------------------------------------------

/**
 * Update or create the user's opencode.json with the proxy provider.
 *
 * @param port — The proxy port to use in baseURL
 * @param options.configPath — Explicit path to opencode.json (optional)
 * @returns Result object with success status and path
 */
export function updateOpencodeConfig(
  port: number,
  options: { configPath?: string } = {},
): OpencodeConfigResult {
  const configPath = options.configPath ?? getDefaultOpencodeConfigPath();

  try {
    let config: Record<string, unknown>;
    let created = false;

    if (existsSync(configPath)) {
      // Read and parse existing config
      const raw = readFileSync(configPath, 'utf-8');
      try {
        config = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return {
          success: false,
          path: configPath,
          error: 'Existing opencode.json contains invalid JSON. Please fix it manually.',
        };
      }

      // Create backup before modifying
      const backupPath = `${configPath}.backup`;
      copyFileSync(configPath, backupPath);
    } else {
      // Create new config
      config = {};
      created = true;

      // Ensure parent directories exist
      const dir = dirname(configPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    // Build provider configuration (models discovered dynamically from /v1/models)
    const providerConfig = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Saros',
      options: {
        baseURL: `http://127.0.0.1:${port}/zen/go/v1`,
        apiKey: 'not-used',
      },
    };

    // Merge into existing config
    const existingProvider = (config.provider as Record<string, unknown> | undefined) ?? {};
    config.provider = {
      ...existingProvider,
      'saros-proxy': providerConfig,
    };

    // Write updated config
    const json = JSON.stringify(config, null, 2);
    writeFileSync(configPath, json, 'utf-8');

    // Validate: re-read and parse to ensure we didn't corrupt it
    try {
      const verifyRaw = readFileSync(configPath, 'utf-8');
      JSON.parse(verifyRaw);
    } catch {
      // Restore from backup if available
      const backupPath = `${configPath}.backup`;
      if (existsSync(backupPath)) {
        copyFileSync(backupPath, configPath);
      }
      return {
        success: false,
        path: configPath,
        error: 'Failed to write valid JSON. Original file restored from backup.',
      };
    }

    return { success: true, path: configPath, created };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, path: configPath, error: message };
  }
}

// ---------------------------------------------------------------------------
// Manual config snippet (for users who decline automatic setup)
// ---------------------------------------------------------------------------

/**
 * Remove models from saros-proxy provider config.
 * Models are discovered dynamically from /v1/models — no need to store them in opencode.json.
 *
 * @param options.configPath — Explicit path to opencode.json (optional, for testing)
 * @returns Result object with success status and path
 */
export function syncModelsToOpencodeConfig(
  options: { configPath?: string } = {},
): OpencodeConfigResult {
  const configPath = options.configPath ?? getDefaultOpencodeConfigPath();

  if (!existsSync(configPath)) {
    return { success: false, error: 'opencode.json not found at ' + configPath };
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;

    const provider = config.provider as Record<string, unknown> | undefined;
    if (!provider) {
      return { success: false, error: 'Config has no "provider" section' };
    }

    const sarosProvider = provider['saros-proxy'];
    if (!sarosProvider || typeof sarosProvider !== 'object' || Array.isArray(sarosProvider)) {
      return { success: false, error: 'saros-proxy provider config is missing or malformed' };
    }

    // Remove models if present — they're discovered dynamically from /v1/models
    const hadModels = 'models' in (sarosProvider as Record<string, unknown>);
    delete (sarosProvider as Record<string, unknown>).models;

    if (!hadModels) {
      return { success: true, path: configPath };
    }

    // Backup before modifying
    const backupPath = `${configPath}.backup`;
    copyFileSync(configPath, backupPath);

    // Write
    const json = JSON.stringify(config, null, 2);
    writeFileSync(configPath, json, 'utf-8');

    // Validate: re-read to ensure we didn't corrupt it
    try {
      const verifyRaw = readFileSync(configPath, 'utf-8');
      JSON.parse(verifyRaw);
    } catch {
      if (existsSync(backupPath)) {
        copyFileSync(backupPath, configPath);
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

/**
 * Generate a manual configuration snippet that users can paste.
 * Models are discovered dynamically from /v1/models — no need to include them.
 */
export function generateManualConfigSnippet(port: number): string {
  const providerConfig = {
    npm: '@ai-sdk/openai-compatible',
      name: 'Saros',
      options: {
        baseURL: `http://127.0.0.1:${port}/zen/go/v1`,
        apiKey: 'not-used',
      },
    };

  return JSON.stringify({
    provider: {
      'saros-proxy': providerConfig,
    },
  }, null, 2);
}
