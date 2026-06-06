/**
 * opencode-config.ts — OpenCode client configuration management.
 *
 * Handles reading, merging, and writing the user's opencode.json
 * to add or update the proxy provider configuration.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { OPENCODE_MODELS } from '../constants.js';

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

    // Build provider configuration
    const providerConfig = {
      npm: '@ai-sdk/openai-compatible',
      name: 'OpenCode-Go Proxy',
      options: {
        baseURL: `http://127.0.0.1:${port}/zen/go/v1`,
        apiKey: 'not-used',
      },
      models: OPENCODE_MODELS,
    };

    // Merge into existing config
    const existingProvider = (config.provider as Record<string, unknown> | undefined) ?? {};
    config.provider = {
      ...existingProvider,
      'opencode-go-proxy': providerConfig,
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
 * Generate a manual configuration snippet that users can paste.
 */
export function generateManualConfigSnippet(port: number): string {
  const providerConfig = {
    npm: '@ai-sdk/openai-compatible',
    name: 'OpenCode-Go Proxy',
    options: {
      baseURL: `http://127.0.0.1:${port}/zen/go/v1`,
      apiKey: 'not-used',
    },
    models: OPENCODE_MODELS,
  };

  return JSON.stringify({
    provider: {
      'opencode-go-proxy': providerConfig,
    },
  }, null, 2);
}
