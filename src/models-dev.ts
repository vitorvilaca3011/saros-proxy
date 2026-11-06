/**
 * models-dev.ts — Read models.dev canonical metadata per provider.
 *
 * `GET https://models.dev/api.json` is one document keyed by provider id
 * (235 providers, ~2 MB). Saros only consumes the providers it proxies;
 * this module owns the fetch, the per-provider extraction and the TTL cache
 * so every consumer (opencode.json sync, pi/omp harness sync) reads the same
 * slice the same way.
 *
 * models.dev sits behind Cloudflare: a request without a `User-Agent` gets
 * 403. Always send one.
 */

import {
  MODELS_DEV_CACHE_TTL_MS,
  MODELS_DEV_PROVIDER_ID,
  MODELS_DEV_SAFE_FIELDS,
  MODELS_DEV_TIMEOUT_MS,
  MODELS_DEV_URL,
} from './constants.js';

/** Model id → models.dev metadata entry. */
export type ModelsDevModelMap = Record<string, Record<string, unknown>>;

/**
 * Providers whose metadata saros consumes. opencode-go first — it is the
 * default upstream, so `MODELS_DEV_PROVIDER_ID` keeps pointing at it.
 */
export const MODELS_DEV_PROVIDER_IDS = [MODELS_DEV_PROVIDER_ID, 'commandcode'] as const;

export type ModelsDevProviderId = (typeof MODELS_DEV_PROVIDER_IDS)[number];

/** Identity sent to models.dev. Without a UA, Cloudflare returns 403. */
export const MODELS_DEV_USER_AGENT = 'saros-proxy';

/** Cached parsed document. Null = never fetched / reset. */
let documentCache: { ts: number; parsed: Record<string, unknown> } | null = null;

/**
 * Extract one provider's model map from a parsed models.dev document.
 *
 * Pure — callers handle JSON parsing and error recovery.
 *
 * @param parsed — Parsed models.dev JSON (`{ providerId: { models: {...} } }`)
 * @param providerId — models.dev provider id (e.g. "opencode-go")
 * @returns Model id → metadata map, or `{}` when the provider is absent
 *          or malformed
 */
export function extractProviderModels(
  parsed: Record<string, unknown>,
  providerId: string,
): ModelsDevModelMap {
  const provider = parsed[providerId] as { models?: unknown } | undefined;
  if (typeof provider !== 'object' || provider === null) return {};
  const models = provider.models;
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return {};
  return models as ModelsDevModelMap;
}

/**
 * Pick only whitelisted fields from a models.dev metadata entry.
 *
 * Whitelisting keeps provider-specific/unknown keys (e.g. `provider`,
 * `release_date`) out of configs written by saros.
 */
export function pickModelsDevFields(entry: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of MODELS_DEV_SAFE_FIELDS) {
    if (key in entry) {
      result[key] = entry[key];
    }
  }
  return result;
}

/**
 * Normalize a model id for cross-catalog matching: strip a provider routing
 * suffix (`…@commandcode`), keep the last path segment, lowercase and turn
 * underscores into hyphens.
 */
function bareModelName(modelId: string): string {
  const withoutSuffix = modelId.split('@')[0];
  const parts = withoutSuffix.split('/');
  return parts[parts.length - 1].toLowerCase().replaceAll('_', '-');
}

/**
 * Find a model entry inside one provider's slice.
 *
 * Exact id first, then the bare name: live catalogs prefix ids
 * (`deepseek/deepseek-v4-flash`) while models.dev may key the same model
 * bare, and vice versa. Matching stays inside the provider slice so a
 * commandcode model never receives opencode-go prices.
 *
 * @returns The metadata entry, or undefined when not found
 */
export function findProviderModel(
  models: ModelsDevModelMap,
  modelId: string,
): Record<string, unknown> | undefined {
  const exact = models[modelId] as unknown;
  if (typeof exact === 'object' && exact !== null && !Array.isArray(exact)) {
    return exact as Record<string, unknown>;
  }

  const bare = bareModelName(modelId);
  if (!bare) return undefined;

  for (const [id, entry] of Object.entries(models)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    if (bareModelName(id) === bare) return entry;
  }
  return undefined;
}

/**
 * Fetch (or reuse) the parsed models.dev document.
 *
 * Returns null on any failure and does not cache failures, so a later call
 * retries. A successful document is cached for `MODELS_DEV_CACHE_TTL_MS`.
 */
async function fetchModelsDevDocument(): Promise<Record<string, unknown> | null> {
  if (documentCache !== null && Date.now() - documentCache.ts < MODELS_DEV_CACHE_TTL_MS) {
    return documentCache.parsed;
  }

  try {
    const response = await fetch(MODELS_DEV_URL, {
      headers: {
        'User-Agent': MODELS_DEV_USER_AGENT,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const parsed: unknown = JSON.parse(await response.text());
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

    documentCache = { ts: Date.now(), parsed: parsed as Record<string, unknown> };
    return documentCache.parsed;
  } catch {
    return null;
  }
}

/**
 * Fetch one provider's model map, with the shared TTL cache.
 *
 * The document is fetched once and split per provider, so asking for both
 * opencode-go and commandcode costs a single request.
 *
 * @returns Model id → metadata map; `{}` when the provider is absent;
 *          null when the document could not be fetched/parsed
 */
export async function fetchModelsDevProvider(
  providerId: string,
): Promise<ModelsDevModelMap | null> {
  const parsed = await fetchModelsDevDocument();
  if (parsed === null) return null;
  return extractProviderModels(parsed, providerId);
}

/** Clear the models.dev document cache (test helper). */
export function resetModelsDevCache(): void {
  documentCache = null;
}
