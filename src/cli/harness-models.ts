/**
 * harness-models.ts — Shared model-shape helpers for pi/omp harness configs.
 *
 * Transforms the canonical saros model map (opencode-shaped entries:
 * { id, name, tool_call, reasoning, limit:{context,output},
 *   modalities:{input,output}, cost? }) into the array shape the pi and
 * oh-my-pi harnesses expect, and builds that canonical map from the live
 * upstream + models.dev metadata (falling back to bundled models.json).
 */

import type { ProxyConfig } from '../config.js';
import { loadModelsFromJson } from './opencode-config.js';
import { buildMinimalStub, fetchModelsDevMetadata, fetchUpstreamModelIds } from '../models-sync.js';
import { allProviders, inferProvider } from '../providers/index.js';
import type { KeyProvider, ProviderId } from '../providers/index.js';

/**
 * Suffix for provider-specific model ids in synced harness configs.
 * Commandcode-only models (claude-*, vendor/model) are exposed to harnesses
 * as `<id>@commandcode`; the proxy strips the suffix on the way upstream.
 */
export const PROVIDER_MODEL_SUFFIX = '@';

export interface PiOmpModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Explicit thinking surface (pi/omp schema). Absent → harness infers one. */
  thinking?: { mode: 'effort'; efforts: string[] };
}

/** Canonical effort vocabulary, least → most intensive (pi/omp schema). */
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Extract the effort ladder from models.dev `reasoning_options`
 * (`[{ type: 'effort', values: [...] }]`). Keeps only values in the pi/omp
 * thinking schema vocabulary; deduplicates and orders least → most intensive.
 */
function parseEfforts(entry: Record<string, unknown>): string[] {
  const options = entry.reasoning_options;
  if (!Array.isArray(options)) return [];
  const found = new Set<string>();
  for (const option of options) {
    if (!option || typeof option !== 'object' || Array.isArray(option)) continue;
    if ((option as Record<string, unknown>).type !== 'effort') continue;
    const values = (option as Record<string, unknown>).values;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value === 'string') found.add(value);
    }
  }
  return EFFORT_ORDER.filter((effort) => found.has(effort));
}

/**
 * Transform one canonical (opencode-shaped) model entry into the
 * pi/omp model shape. Unknown metadata falls back to safe defaults
 * (262144 context, 65536 output, text-only input, reasoning off).
 */
export function toPiOmpModel(entry: Record<string, unknown>): PiOmpModel {
  const limit = (entry.limit ?? {}) as Record<string, unknown>;
  const modalities = (entry.modalities ?? {}) as Record<string, unknown>;
  const rawInput = Array.isArray(modalities.input) ? (modalities.input as string[]) : [];
  const input = rawInput.filter((m): m is 'text' | 'image' => m === 'text' || m === 'image');
  const id = typeof entry.id === 'string' ? entry.id : '';
  const model: PiOmpModel = {
    id,
    name: typeof entry.name === 'string' ? entry.name : id,
    reasoning: entry.reasoning === true,
    input: input.length > 0 ? input : ['text'],
    contextWindow: typeof limit.context === 'number' ? limit.context : 262144,
    maxTokens: typeof limit.output === 'number' ? limit.output : 65536,
  };

  // Explicit thinking metadata: models.dev effort options → pi/omp
  // `thinking.efforts`. Without it the harness infers a generic ladder that
  // can disagree with the model's real contract (e.g. ox-alpha only accepts
  // low/high/max).
  if (model.reasoning) {
    const efforts = parseEfforts(entry);
    if (efforts.length > 0) model.thinking = { mode: 'effort', efforts };
  }

  // Cost is optional; accept both camelCase (pi/omp) and snake_case (models.dev).
  const rawCost = entry.cost as Record<string, unknown> | undefined;
  if (rawCost && typeof rawCost === 'object' && !Array.isArray(rawCost)) {
    const { input: ci, output: co } = rawCost;
    if (typeof ci === 'number' && typeof co === 'number') {
      const cacheRead = rawCost.cacheRead ?? rawCost.cache_read ?? 0;
      const cacheWrite = rawCost.cacheWrite ?? rawCost.cache_write ?? 0;
      model.cost = {
        input: ci,
        output: co,
        cacheRead: typeof cacheRead === 'number' ? cacheRead : 0,
        cacheWrite: typeof cacheWrite === 'number' ? cacheWrite : 0,
      };
    }
  }

  return model;
}

/** Transform the canonical model map into a pi/omp `models` array. */
export function toPiOmpModelArray(models: Record<string, unknown>): PiOmpModel[] {
  return Object.values(models).map((entry) => toPiOmpModel(entry as Record<string, unknown>));
}

/**
 * Map one provider-catalog entry into the canonical opencode-shaped entry.
 * Uses the catalog's own fields when present (commandcode serves name +
 * context_length); models.dev metadata is not available for these providers.
 */
function providerCatalogToCanonical(modelId: string, entry: Record<string, unknown>): Record<string, unknown> {
  const context = typeof entry.context_length === 'number' ? entry.context_length : undefined;
  const name = typeof entry.name === 'string' ? entry.name : modelId;
  return {
    id: modelId,
    name,
    tool_call: true,
    reasoning: true,
    limit: {
      context: context ?? 262144,
      output: 65536,
    },
    modalities: { input: ['text'], output: ['text'] },
    // Hint consumed by display tooling; harmless to harnesses that ignore it.
    ...(typeof entry.owned_by === 'string' ? { owned_by: entry.owned_by } : {}),
  };
}

/**
 * Fetch model entries from the given providers and merge them into the map
 * under `<id>@<providerId>` (only for ids the provider uniquely claims —
 * affinity 'yes'), skipping ids already present.
 *
 * Only providers the user actually has keys for are merged: exposing
 * provider-only models without a usable key would create broken entries in
 * harness configs.
 */
async function appendProviderCatalogModels(
  map: Record<string, unknown>,
  existingIds: Set<string>,
  config: ProxyConfig,
): Promise<void> {
  const configured = new Set<ProviderId>((config.keys ?? []).map((k) => inferProvider(k)));
  const providers = allProviders().filter(
    (p): p is KeyProvider & { fetchCatalog: NonNullable<KeyProvider['fetchCatalog']> } =>
      configured.has(p.id) && typeof p.fetchCatalog === 'function',
  );
  await Promise.all(
    providers.map(async (provider) => {
      const catalog = await provider.fetchCatalog();
      if (!catalog) return;
      for (const entry of catalog) {
        const rawId = typeof entry.id === 'string' ? entry.id : '';
        if (!rawId) continue;
        if (provider.modelAffinity(rawId) !== 'yes') continue; // shared ids → primary provider's entry
        const suffixedId = `${rawId}${PROVIDER_MODEL_SUFFIX}${provider.id}`;
        if (existingIds.has(suffixedId)) continue;
        existingIds.add(suffixedId);
        map[suffixedId] = providerCatalogToCanonical(suffixedId, entry);
      }
    }),
  );
}

/**
 * Build the canonical model map (id → opencode-shaped entry).
 *
 * Live path (config provided, not offline): fetch upstream model IDs and
 * enrich each with models.dev metadata via buildMinimalStub, then append
 * provider-specific catalog models (@commandcode etc.). Falls back to the
 * bundled models.json when the upstream fetch yields nothing.
 * Offline path (or no config): bundled models.json only.
 */
export async function buildCanonicalModels(
  config?: ProxyConfig,
  opts?: { offline?: boolean },
): Promise<Record<string, unknown>> {
  if (opts?.offline || !config) {
    return loadModelsFromJson();
  }

  let ids: string[] | null = null;
  try {
    ids = await fetchUpstreamModelIds(config);
  } catch {
    ids = null;
  }

  const meta = await fetchModelsDevMetadata();

  if (ids && ids.length > 0) {
    const map: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const id of ids) {
      map[id] = buildMinimalStub(id, meta ?? undefined);
      seen.add(id);
    }
    await appendProviderCatalogModels(map, seen, config);
    return map;
  }

  return loadModelsFromJson();
}
