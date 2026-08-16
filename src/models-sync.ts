/**
 * models-sync.ts — Auto-sync models from upstream to opencode.json.
 *
 * Tier 1 of the auto model discovery plan.
 * Fetches upstream model IDs, diffs against opencode.json, and adds
 * any missing models with minimal stubs.
 */

import { constants, existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { getDefaultOpencodeConfigPath, stripJsoncComments } from './cli/opencode-config.js';
import { getModelsList } from './models-fetcher.js';
import {
  MODELS_DEV_URL,
  MODELS_DEV_CACHE_TTL_MS,
  MODELS_DEV_TIMEOUT_MS,
  MODELS_DEV_PROVIDER_ID,
  MODELS_DEV_SAFE_FIELDS,
} from './constants.js';
import { loadModelsFromJson } from './cli/opencode-config.js';
import { logger } from './logger.js';
import type { ProxyConfig } from './config.js';
import type { OpencodeConfigResult } from './cli/opencode-config.js';

// ---------------------------------------------------------------------------
// Title-case helper
// ---------------------------------------------------------------------------

/**
 * Convert a model ID into a human-readable title.
 *
 * Splits on hyphens, capitalises the first letter of each segment,
 * and joins with spaces. Segments with 3 or fewer characters are
 * fully uppercased (e.g. "glm" → "GLM", "v2" → "V2").
 *
 * When a segment is purely numeric (e.g. "5", "3.7") it is attached
 * to the preceding word with a hyphen (e.g. "GLM-5").
 *
 * Letter-number boundaries are split when 3+ letters precede a digit
 * (e.g. "qwen3.7" → "Qwen 3.7").
 */
function toTitleCase(id: string): string {
  const parts = id.split('-');
  const titled: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    // Purely numeric segments (e.g. "5", "3.7") attach to previous
    if (/^\d+(\.\d+)?$/.test(part)) {
      if (titled.length > 0) {
        titled[titled.length - 1] += '-' + part;
      } else {
        titled.push(part);
      }
      continue;
    }

    // Insert space before a digit when preceded by 3+ letters
    const expanded = part.replace(/([a-z]{3,})(\d)/gi, '$1 $2');
    const words = expanded.split(/\s+/);
    const processed = words.map((w: string) => {
      if (w.length <= 3) {
        // Words with uppercase letters or digits are codes/abbreviations → fully uppercase
        // All-lowercase letter-only short words → title-case (e.g. "new" → "New")
        if (/[A-Z0-9]/.test(w)) {
          return w.toUpperCase();
        }
        return w.charAt(0).toUpperCase() + w.slice(1);
      }
      return w.charAt(0).toUpperCase() + w.slice(1);
    });
    titled.push(processed.join(' '));
  }

  return titled.join(' ');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch model IDs from the upstream OpenCode-Go API.
 *
 * Calls `getModelsList(config)` to obtain the /v1/models response,
 * then extracts `data[].id` values.
 *
 * @param config — Proxy configuration
 * @returns Array of model ID strings, or empty array on any failure
 */
export async function fetchUpstreamModelIds(config: ProxyConfig): Promise<string[]> {
  try {
    const response = await getModelsList(config);
    const body: unknown = await response.json();

    if (typeof body !== 'object' || body === null) {
      logger.warn('fetchUpstreamModelIds: upstream response is not an object');
      return [];
    }

    const data = (body as Record<string, unknown>).data;
    if (!Array.isArray(data)) {
      logger.warn('fetchUpstreamModelIds: upstream response has no data array');
      return [];
    }

    return data
      .map((entry: unknown) => {
        if (typeof entry === 'object' && entry !== null) {
          return (entry as Record<string, unknown>).id as string;
        }
        return '';
      })
      .filter(Boolean) as string[];
  } catch (err) {
    logger.warn({ err }, 'fetchUpstreamModelIds: failed to fetch upstream models');
    return [];
  }
}

/**
 * Return model IDs from `upstream` that are NOT present in `current`.
 *
 * Preserves upstream order and deduplicates the result.
 *
 * @param current — Currently configured model IDs
 * @param upstream — Model IDs from the upstream API
 * @returns Missing model IDs (ordered and deduplicated)
 */
export function getMissingModels(current: string[], upstream: string[]): string[] {
  const currentSet = new Set(current);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const id of upstream) {
    if (!currentSet.has(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }

  return result;
}

/**
 * Safely pick only whitelisted fields from a models.dev metadata entry.
 */
function pickSafeFields(entry: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of MODELS_DEV_SAFE_FIELDS) {
    if (key in entry) {
      result[key] = entry[key];
    }
  }
  return result;
}

/**
 * Build a minimal model stub for use in opencode.json.
 *
 * Priority (first match wins):
 *   1. models.dev metadata (if provided and found for modelId)
 *   2. OPENCODE_MODELS bundled constants
 *   3. Heuristic title-case of the ID with default limits
 *
 * @param modelId — The upstream model ID (e.g. "glm-5", "kimi-k2.7-code")
 * @param modelsDevMetadata — Optional map from models.dev (takes precedence)
 * @returns A stub object with `id`, `name`, `tool_call`, and `reasoning`
 */
export function buildMinimalStub(
  modelId: string,
  modelsDevMetadata?: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  // 1. models.dev metadata (highest priority)
  if (modelsDevMetadata && modelId in modelsDevMetadata) {
    const raw = modelsDevMetadata[modelId];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      // Edge case: if the dev entry exists but has none of our safe fields,
      // the result is a valid { id } stub — Tiers 2/3 are intentionally skipped
      // because the model is "known" via dev metadata.
      const safe = pickSafeFields(raw);
      safe.id = modelId;
      return safe;
    }
  }

  // 2. models.json bundled definitions
  const bundled = loadModelsFromJson();
  const known = bundled[modelId];
  if (known && typeof known === 'object' && !Array.isArray(known)) {
    return { ...(known as Record<string, unknown>), id: modelId };
  }

  // 3. Heuristic fallback with sensible defaults
  return {
    id: modelId,
    name: toTitleCase(modelId),
    limit: { context: 262144, output: 65536 },
    tool_call: true,
    reasoning: true,
  };
}

/**
 * Read the set of currently configured model IDs from opencode.json.
 *
 * Extracts the keys of `provider["saros-proxy"].models`.
 *
 * @param configPath — Path to opencode.json
 * @returns Array of model ID strings, or empty array on any failure
 */
export function getModelsFromOpencodeConfig(configPath: string): string[] {
  try {
    if (!existsSync(configPath)) return [];

    const raw = readFileSync(configPath, 'utf-8');
    const clean = configPath.endsWith('.jsonc') ? stripJsoncComments(raw) : raw;
    const config = JSON.parse(clean) as Record<string, unknown>;

    const provider = config.provider as Record<string, unknown> | undefined;
    if (!provider) return [];

    const sarosProvider = provider['saros-proxy'] as Record<string, unknown> | undefined;
    if (!sarosProvider || typeof sarosProvider !== 'object') return [];

    const models = sarosProvider.models as Record<string, unknown> | undefined;
    if (!models || typeof models !== 'object') return [];

    return Object.keys(models);
  } catch {
    return [];
  }
}

/**
 * Add missing model stubs to the saros-proxy.models map in opencode.json.
 *
 * 1. Reads the config file.
 * 2. Ensures `saros-proxy` provider exists.
 * 3. Creates a `.backup` copy.
 * 4. Merges `buildMinimalStub(id)` for each missing ID.
 * 5. Writes the updated JSON.
 * 6. Validates the written file — restores from backup on failure.
 *
 * @param configPath — Path to opencode.json
 * @param missingIds — Model IDs to add
 * @param modelsDevMetadata — Optional models.dev metadata (passed to buildMinimalStub)
 * @returns Result with success status and optional error message
 */
export function addMissingModelsToOpencodeConfig(
  configPath: string,
  missingIds: string[],
  modelsDevMetadata?: Record<string, Record<string, unknown>>,
): OpencodeConfigResult {
  try {
    if (!existsSync(configPath)) {
      return {
        success: false,
        error: `opencode config not found at ${configPath}`,
      };
    }

    let config: Record<string, unknown>;

    try {
      const raw = readFileSync(configPath, 'utf-8');
      const clean = configPath.endsWith('.jsonc') ? stripJsoncComments(raw) : raw;
      config = JSON.parse(clean) as Record<string, unknown>;
    } catch {
      return {
        success: false,
        error: 'Existing opencode config contains invalid JSON/JSONC',
      };
    }

    const provider = config.provider as Record<string, unknown> | undefined;
    if (!provider) {
      return { success: false, error: 'Config has no "provider" section' };
    }

    const sarosProvider = provider['saros-proxy'];
    if (!sarosProvider || typeof sarosProvider !== 'object' || Array.isArray(sarosProvider)) {
      return {
        success: false,
        error: 'saros-proxy provider config is missing or malformed',
      };
    }

    // Ensure models field exists
    const sarosObj = sarosProvider as Record<string, unknown>;
    if (!sarosObj.models || typeof sarosObj.models !== 'object' || Array.isArray(sarosObj.models)) {
      sarosObj.models = {};
    }

    const models = sarosObj.models as Record<string, unknown>;

    let changed = false;

    // Add missing models
    if (missingIds.length > 0) {
      for (const id of missingIds) {
        models[id] = buildMinimalStub(id, modelsDevMetadata);
      }
      changed = true;
    }

    // Enrich existing models with models.dev metadata (add missing fields only)
    if (modelsDevMetadata) {
      for (const [id, model] of Object.entries(models)) {
        const devEntry = modelsDevMetadata[id];
        if (!devEntry || typeof devEntry !== 'object' || Array.isArray(devEntry)) continue;

        const additions = pickSafeFields(devEntry);
        const modelObj = model as Record<string, unknown>;
        let enriched = false;

        for (const key of Object.keys(additions)) {
          if (!(key in modelObj)) {
            modelObj[key] = additions[key];
            enriched = true;
          }
        }

        if (enriched) {
          changed = true;
        }
      }
    }

    // Nothing changed — skip backup and write
    if (!changed) {
      return { success: true, path: configPath, error: undefined, created: undefined };
    }

    // Backup before modifying (never overwrite existing backup)
    const backupPath = configPath + '.backup';
    try {
      copyFileSync(configPath, backupPath, constants.COPYFILE_EXCL);
    } catch {
      // Backup already exists — keep it
    }

    // Write updated config
    const json = JSON.stringify(config, null, 2);
    writeFileSync(configPath, json, 'utf-8');

    // Validate: re-read and parse to ensure we didn't corrupt it
    try {
      const verifyRaw = readFileSync(configPath, 'utf-8');
      JSON.parse(verifyRaw);
    } catch {
      // Restore from backup
      try {
        copyFileSync(backupPath, configPath);
      } catch {
        // No backup to restore — report the failure as-is
      }
      return {
        success: false,
        path: configPath,
        error: 'Failed to write valid JSON. Original file restored from backup.',
      };
    }

    return { success: true, path: configPath };
  } catch (err) {
    // Restore from backup if available
    const backupPath = configPath + '.backup';
    if (existsSync(backupPath)) {
      try {
        copyFileSync(backupPath, configPath);
      } catch {
        // Ignore restore errors — the backup file itself may be gone
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, path: configPath, error: message };
  }
}

/**
 * Orchestrator: sync opencode.json models with upstream.
 *
 * Flow:
 *   fetchModelsDevMetadata()
 *   → fetchUpstreamModelIds(config)
 *   → getModelsFromOpencodeConfig(configPath)
 *   → getMissingModels(current, upstream)
 *   → addMissingModelsToOpencodeConfig(configPath, missing, devMetadata)
 *
 * @param config — Proxy configuration for upstream fetch
 * @param configPath — Path to opencode.json (defaults to platform default)
 * @returns Result with success status and optional error message
 */
export async function syncOpencodeModelsWithUpstream(
  config: ProxyConfig,
  configPath?: string,
): Promise<OpencodeConfigResult> {
  const path = configPath ?? getDefaultOpencodeConfigPath();

  // Best-effort fetch of models.dev metadata (never throws, null → undefined)
  const devMetadata = (await fetchModelsDevMetadata()) ?? undefined;

  const upstreamIds = await fetchUpstreamModelIds(config);
  if (upstreamIds.length === 0) {
    logger.warn('syncOpencodeModelsWithUpstream: no upstream models returned, skipping sync');
    return { success: false, error: 'No upstream models returned' };
  }

  const currentIds = getModelsFromOpencodeConfig(path);
  const missingIds = getMissingModels(currentIds, upstreamIds);

  if (missingIds.length > 0) {
    logger.info(
      'syncOpencodeModelsWithUpstream: adding %d missing models to opencode.json',
      missingIds.length,
    );
  }

  return addMissingModelsToOpencodeConfig(path, missingIds, devMetadata);
}

// ---------------------------------------------------------------------------
// models.dev metadata fetching
// ---------------------------------------------------------------------------

/** Module-level cache for models.dev response. Null = unset. */
type ModelsDevCache = { ts: number; data: Record<string, Record<string, unknown>> };
let _modelsDevCache: ModelsDevCache | null = null;

/**
 * Extract the opencode-go provider's models from a models.dev API response.
 *
 * Pure function — callers handle JSON parsing and error recovery.
 *
 * @param parsed — Parsed models.dev JSON object (result of `JSON.parse`)
 * @returns Model ID → metadata map, or empty object if provider not found
 */
export function extractOpencodeGoModels(
  parsed: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  // The API returns a flat dictionary keyed by provider ID, e.g.:
  // { "opencode-go": { id, env, npm, api, name, doc, models: { ... } }, ... }
  const entry = parsed[MODELS_DEV_PROVIDER_ID];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {};

  const models = (entry as Record<string, unknown>).models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return {};

  return models as Record<string, Record<string, unknown>>;
}

/**
 * Fetch and cache models.dev metadata for opencode-go models.
 *
 * Caches in memory with TTL. Never throws — returns null on any failure.
 * Skips in-flight deduplication (YAGNI — single orchestrator path).
 *
 * @returns Model ID → metadata map, null on failure, empty on missing provider
 */
export async function fetchModelsDevMetadata(): Promise<Record<string, Record<string, unknown>> | null> {
  // Return cached data if within TTL
  if (_modelsDevCache !== null && Date.now() - _modelsDevCache.ts < MODELS_DEV_CACHE_TTL_MS) {
    return _modelsDevCache.data;
  }

  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const text = await response.text();
    const parsed: Record<string, unknown> = JSON.parse(text);

    const data = extractOpencodeGoModels(parsed);
    _modelsDevCache = { ts: Date.now(), data };
    return data;
  } catch {
    return null;
  }
}

/**
 * Clear the models.dev in-memory cache (test helper).
 */
export function resetModelsDevCacheState(): void {
  _modelsDevCache = null;
}
