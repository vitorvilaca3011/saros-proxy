/**
 * opencode-config.ts — OpenCode client configuration management.
 *
 * Handles reading, merging, and writing the user's opencode.json
 * or opencode.jsonc to add or update the proxy provider configuration.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { OPENCODE_MODELS } from '../constants.js';

// ---------------------------------------------------------------------------
// JSONC support
// ---------------------------------------------------------------------------

/**
 * Strip JSONC comments (both single-line and multi-line) from a string,
 * preserving string contents. JSONC allows comments that JSON does not.
 */
export function stripJsoncComments(text: string): string {
  const result: string[] = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    // Handle strings — preserve everything inside
    if (ch === '"') {
      let s = '"';
      i++;
      while (i < len) {
        const c = text[i];
        s += c;
        if (c === '\\') {
          i++;
          if (i < len) { s += text[i]; i++; }
        } else if (c === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      result.push(s);
      continue;
    }

    // Handle single-line comment
    if (ch === '/' && i + 1 < len && text[i + 1] === '/') {
      i += 2;
      while (i < len && text[i] !== '\n') i++;
      continue;
    }

    // Handle multi-line comment
    if (ch === '/' && i + 1 < len && text[i + 1] === '*') {
      i += 2;
      while (i < len) {
        if (text[i] === '*' && i + 1 < len && text[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    result.push(ch);
    i++;
  }

  return result.join('');
}

/**
 * Read and parse a JSON or JSONC config file.
 * For `.jsonc` files, comments are stripped before parsing.
 */
function readJsoncConfigFile(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf-8');
  const clean = path.endsWith('.jsonc') ? stripJsoncComments(raw) : raw;
  return JSON.parse(clean) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Path detection
// ---------------------------------------------------------------------------

/** Return the default opencode config path for the current platform.
 *
 * Detects `opencode.jsonc` vs `opencode.json` — prefers `.jsonc` if it
 * exists (modern OpenCode default), falls back to `.json`, and defaults
 * to `.jsonc` for new setups.
 */
export function getDefaultOpencodeConfigPath(): string {
  const home = homedir();
  const dir = join(home, '.config', 'opencode');
  const jsoncPath = join(dir, 'opencode.jsonc');
  const jsonPath = join(dir, 'opencode.json');

  if (existsSync(jsoncPath)) return jsoncPath;
  if (existsSync(jsonPath)) return jsonPath;
  return jsoncPath; // default to jsonc for new installs
}

/** Return the path to models.json (source of truth for model definitions). */
export function getModelsJsonPath(): string {
  const home = homedir();
  return join(home, '.config', 'saros', 'models.json');
}

/**
 * Load models from models.json, falling back to bundled defaults.
 * @param configPath — Explicit path to models.json (optional, for testing)
 */
export function loadModelsFromJson(configPath?: string): Record<string, unknown> {
  const path = configPath ?? getModelsJsonPath();
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Fall through to bundled defaults
    }
  }
  // Fallback: use bundled constants
  return OPENCODE_MODELS;
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
      // Read existing config (supports JSONC)
      let raw: string;
      try {
        raw = readFileSync(configPath, 'utf-8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, path: configPath, error: message };
      }

      try {
        const clean = configPath.endsWith('.jsonc') ? stripJsoncComments(raw) : raw;
        config = JSON.parse(clean) as Record<string, unknown>;
      } catch {
        return {
          success: false,
          path: configPath,
          error: 'Existing opencode config contains invalid JSON/JSONC. Please fix it manually.',
        };
      }

      // Create backup before modifying (never overwrite existing backup)
      const backupPath = `${configPath}.backup`;
      if (!existsSync(backupPath)) {
        copyFileSync(configPath, backupPath);
      }
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

    // Build provider configuration (models from bundled models.json)
    const providerConfig = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Saros',
      options: {
        baseURL: `http://127.0.0.1:${port}/zen/go/v1`,
        apiKey: 'not-used',
      },
      models: loadModelsFromJson(),
    };

    // Merge into existing config, preserving any user customizations
    const existingProvider = (config.provider as Record<string, unknown> | undefined) ?? {};
    const rawSaros = existingProvider['saros-proxy'];
    const existingSaros = (rawSaros && typeof rawSaros === 'object' && !Array.isArray(rawSaros))
      ? rawSaros as Record<string, unknown>
      : {};
    config.provider = {
      ...existingProvider,
      'saros-proxy': {
        ...providerConfig,
        ...existingSaros,       // user wins for non-models fields; models always synced from bundled source
        models: providerConfig.models, // always sync models from bundled source
      },
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
        return {
          success: false,
          path: configPath,
          error: 'Failed to write valid JSON. Original file restored from backup.',
        };
      }
      return {
        success: false,
        path: configPath,
        error: 'Failed to write valid JSON. No backup available to restore.',
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
 * Sync models from models.json into an existing opencode.json.
 * Only replaces the `saros-proxy.models` field — preserves everything else.
 *
 * @param options.configPath — Explicit path to opencode.json (optional, for testing)
 * @param options.modelsPath — Explicit path to models.json (optional, for testing)
 * @returns Result object with success status and path
 */
export function syncModelsToOpencodeConfig(
  options: { configPath?: string; modelsPath?: string } = {},
): OpencodeConfigResult {
  const configPath = options.configPath ?? getDefaultOpencodeConfigPath();

  if (!existsSync(configPath)) {
    return { success: false, error: 'opencode config not found at ' + configPath };
  }

  try {
    const config = readJsoncConfigFile(configPath);

    const provider = config.provider as Record<string, unknown> | undefined;
    if (!provider) {
      return { success: false, error: 'Config has no "provider" section' };
    }

    const sarosProvider = provider['saros-proxy'];
    if (!sarosProvider || typeof sarosProvider !== 'object' || Array.isArray(sarosProvider)) {
      return { success: false, error: 'saros-proxy provider config is missing or malformed' };
    }

    // Backup before modifying (never overwrite existing backup)
    const backupPath = `${configPath}.backup`;
    if (!existsSync(backupPath)) {
      copyFileSync(configPath, backupPath);
    }

    // Load models from models.json (source of truth)
    const models = loadModelsFromJson(options.modelsPath);
    (sarosProvider as Record<string, unknown>).models = models;

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
        return {
          success: false,
          path: configPath,
          error: 'Failed to write valid JSON after sync. Restored from backup.',
        };
      }
      return {
        success: false,
        path: configPath,
        error: 'Failed to write valid JSON after sync. No backup available to restore.',
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
 */
export function generateManualConfigSnippet(port: number): string {
  const models = loadModelsFromJson();
  const providerConfig = {
    npm: '@ai-sdk/openai-compatible',
      name: 'Saros',
      options: {
        baseURL: `http://127.0.0.1:${port}/zen/go/v1`,
        apiKey: 'not-used',
      },
      models,
    };

  return JSON.stringify({
    provider: {
      'saros-proxy': providerConfig,
    },
  }, null, 2);
}
