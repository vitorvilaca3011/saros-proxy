/**
 * models-dev.ts — Read models.dev canonical metadata per provider.
 *
 * `GET https://models.dev/api.json` is one document keyed by provider id
 * (235 providers, 5.9 MB on 2026-11-06). Saros only consumes the providers it
 * proxies; this module owns the fetch, the per-provider extraction and the TTL
 * cache so every consumer (opencode.json sync, pi/omp harness sync) reads the
 * same slice the same way.
 *
 * The request sends a stable CLI `User-Agent`. models.dev's edge has answered
 * 403 to a library-default UA while `User-Agent: cli` got 200 (measured
 * 2026-11-06); a recheck minutes later returned 200 for both, so treat the
 * header as a fixed contract — it keeps the fetch independent of whatever UA
 * the local HTTP stack defaults to — not as a reproducible gate.
 */

import {
  MODELS_DEV_CACHE_TTL_MS,
  MODELS_DEV_SAFE_FIELDS,
  MODELS_DEV_TIMEOUT_MS,
  MODELS_DEV_URL,
} from './constants.js';
import { logger } from './logger.js';

/** Model id → models.dev metadata entry. */
export type ModelsDevModelMap = Record<string, Record<string, unknown>>;

/** Identity sent to models.dev — a stable CLI UA, never the HTTP stack default. */
export const MODELS_DEV_USER_AGENT = 'saros-proxy';

/** Cached parsed document. Null = never fetched / reset. */
let documentCache: { ts: number; parsed: Record<string, unknown> } | null = null;

/**
 * Fetch in progress, if any. Concurrent cold-cache callers await this instead
 * of each pulling the 5.9 MB document.
 */
let documentRequest: Promise<Record<string, unknown> | null> | null = null;

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

/** Catalogs already checked for bare-name collisions (one warning per slice). */
const collisionReported = new WeakSet<object>();

/**
 * Bare names that two or more entries of one catalog normalize to.
 *
 * Matching by such a name would return whichever entry `Object.keys` yields
 * first — silently pricing/limiting the wrong model — so callers must fall
 * back to exact ids. `models-refresh` aborts the generation on the same
 * condition; runtime stays lenient but warns once per slice.
 *
 * @param models — id → entry catalog (models.dev slice or bundled catalog)
 * @param normalize — id → bare name function for that catalog's id shape
 */
export function collidingBareNames(
  models: Record<string, unknown>,
  normalize: (id: string) => string,
): Set<string> {
  const counts = new Map<string, number>();
  for (const [id, entry] of Object.entries(models)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const bare = normalize(id);
    if (!bare) continue;
    counts.set(bare, (counts.get(bare) ?? 0) + 1);
  }

  const collisions = new Set(
    [...counts].filter(([, count]) => count > 1).map(([bare]) => bare),
  );
  if (collisions.size > 0 && !collisionReported.has(models)) {
    collisionReported.add(models);
    logger.warn(
      { bareNames: [...collisions] },
      'model catalog has bare-name collisions; only exact ids will match',
    );
  }
  return collisions;
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
  // Two ids share this bare name: matching one of them would be arbitrary.
  if (collidingBareNames(models, bareModelName).has(bare)) return undefined;

  for (const [id, entry] of Object.entries(models)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    if (bareModelName(id) === bare) return entry;
  }
  return undefined;
}

/**
 * Fetch and parse the models.dev document. Never throws; failures are not
 * cached, so a later call retries.
 */
async function loadModelsDevDocument(): Promise<Record<string, unknown> | null> {
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
 * Fetch (or reuse) the parsed models.dev document.
 *
 * Concurrent cold-cache callers share one request: the pending promise is
 * cached, not just its result. A successful document is then cached for
 * `MODELS_DEV_CACHE_TTL_MS`.
 */
async function fetchModelsDevDocument(): Promise<Record<string, unknown> | null> {
  if (documentCache !== null && Date.now() - documentCache.ts < MODELS_DEV_CACHE_TTL_MS) {
    return documentCache.parsed;
  }
  if (documentRequest !== null) return documentRequest;

  const request = loadModelsDevDocument().finally(() => {
    // Only clear our own request: a reset() may already have installed one.
    if (documentRequest === request) documentRequest = null;
  });
  documentRequest = request;
  return request;
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
  documentRequest = null;
}
