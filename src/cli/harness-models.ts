/**
 * harness-models.ts — Shared model-shape helpers for pi/omp harness configs.
 *
 * Transforms the canonical saros model map (opencode-shaped entries:
 * { id, name, tool_call, reasoning, limit:{context,output},
 *   modalities:{input,output}, cost? }) into the array shape the pi and
 * oh-my-pi harnesses expect, and builds that canonical map from the live
 * upstream + models.dev metadata (falling back to bundled `assets/models.json`).
 */

import type { ProxyConfig } from '../config.js';
import { loadModelsFromJson } from './opencode-config.js';
import { buildMinimalStub, fetchModelsDevMetadata, fetchUpstreamModelIds } from '../models-sync.js';
import {
  collidingBareNames,
  fetchModelsDevProvider,
  findProviderModel,
  pickModelsDevFields,
} from '../models-dev.js';
import type { ModelsDevModelMap } from '../models-dev.js';
import { loadModelsCatalog } from '../models-catalog.js';
import { allProviders, getProvider, inferProvider } from '../providers/index.js';
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
 * Conservative effort ladder for a reasoning model whose metadata declares no
 * effort levels (models.dev ships an empty ladder or a bare toggle for some
 * CommandCode models). Copied verbatim, that absence makes the harness invent
 * a ladder that includes `minimal`, which the CommandCode gateway rejects;
 * low|medium|high is accepted everywhere.
 */
const CONSERVATIVE_EFFORT_VALUES = ['low', 'medium', 'high'] as const;

/** Fresh effort ladder entry — callers may keep or mutate the array. */
function conservativeEffortOptions(): Array<{ type: 'effort'; values: string[] }> {
  return [{ type: 'effort', values: [...CONSERVATIVE_EFFORT_VALUES] }];
}

/** Does any reasoning option declare an effort ladder? */
function hasEffortOption(options: unknown): boolean {
  if (!Array.isArray(options)) return false;
  return options.some(
    (option) =>
      typeof option === 'object' &&
      option !== null &&
      !Array.isArray(option) &&
      (option as Record<string, unknown>).type === 'effort',
  );
}

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
 * Normalize a provider model id to its bare name for cross-provider
 * matching: 'deepseek/deepseek-v4-flash' → 'deepseek-v4-flash';
 * 'glm-5' → 'glm-5'. Case- and separator-insensitive.
 */
export function bareModelName(modelId: string): string {
  const last = modelId.split('/').pop() ?? modelId;
  return last.toLowerCase().replaceAll('_', '-');
}

/**
 * Annotate a display name with how many keys can serve the model,
 * e.g. "DeepSeek V4 Flash (3)". Communicates rotation width: '(3)' rotates
 * across 3 accounts (possibly cross-provider), '(1)' is a single key.
 */
export function annotateName(name: string, keyCount: number): string {
  if (keyCount <= 0) return name;
  return `${name} (${keyCount})`;
}

/**
 * Count how many of the user's keys can serve a bare model name.
 *
 * The owning provider (whose catalog the entry came from) always serves it.
 * Every OTHER provider must claim the model definitively ('yes' via
 * bare-name/affinity check) — a structural 'maybe' does not count, or
 * blanket-maybe providers (opencode-go) would overcount models they don't
 * actually have (e.g. claude-*).
 */
function countServingKeys(
  config: ProxyConfig,
  bareName: string,
  owner: ProviderId,
): number {
  return (config.keys ?? []).filter((k) => {
    const provider = getProvider(inferProvider(k));
    if (!provider) return false;
    if (provider.id === owner) return true;
    const byName = provider.modelAffinityByName?.(bareName);
    if (byName) return byName === 'yes';
    return provider.modelAffinity(bareName) === 'yes';
  }).length;
}

/**
 * Bundled `assets/models.json` entry for a provider-native id, when present.
 *
 * Exact id first, then bare name: the live catalog prefixes ids
 * ('deepseek/deepseek-v4-pro') while the bundle keys the bare model
 * ('deepseek-v4-pro').
 */
function bundledModel(nativeId: string): Record<string, unknown> | undefined {
  const catalog = loadModelsCatalog();
  const direct = catalog[nativeId];
  if (typeof direct === 'object' && direct !== null && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }

  const bare = bareModelName(nativeId);
  const colliding = collidingBareNames(catalog, bareModelName);
  for (const [id, entry] of Object.entries(catalog)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const candidate = bareModelName(id);
    if (candidate === bare && !colliding.has(candidate)) return entry as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Map one provider-catalog entry into the canonical opencode-shaped entry.
 *
 * Metadata priority (first match wins):
 *   1. models.dev slice of the owning provider (exact id, then bare name)
 *   2. bundled `assets/models.json`
 *   3. the live catalog's own fields, then safe defaults
 *
 * Providers always keep their `owned_by` hint and the entry id carries the
 * `@provider` routing suffix. A model absent from models.dev and the bundle
 * still surfaces — enrichment never drops it.
 */
function providerCatalogToCanonical(
  modelId: string,
  nativeId: string,
  entry: Record<string, unknown>,
  keyCount: number,
  devModels: ModelsDevModelMap,
): Record<string, unknown> {
  const devEntry = findProviderModel(devModels, nativeId);
  const bundled = devEntry ? undefined : bundledModel(nativeId);
  const catalogName = typeof entry.name === 'string' ? entry.name : modelId;

  let canonical: Record<string, unknown>;
  if (devEntry) {
    canonical = { ...pickModelsDevFields(devEntry), id: modelId };
  } else if (bundled) {
    canonical = { ...bundled, id: modelId };
  } else {
    const context = typeof entry.context_length === 'number' ? entry.context_length : undefined;
    canonical = {
      id: modelId,
      name: catalogName,
      tool_call: true,
      reasoning: true,
      limit: {
        context: context ?? 262144,
        output: 65536,
      },
      modalities: { input: ['text'], output: ['text'] },
      // Conservative effort ladder for models with no metadata anywhere: the
      // commandcode gateway accepts low|medium|high|xhigh and rejects
      // minimal — better declared here than invented by the harness.
      reasoning_options: conservativeEffortOptions(),
    };
  }

  // models.dev (and the bundle generated from it) sometimes marks a model
  // `reasoning: true` with an empty ladder or a toggle only. Copied verbatim,
  // that absence lets the harness invent a ladder with `minimal`, which the
  // CommandCode gateway rejects — declare the conservative ladder instead.
  if (canonical.reasoning === true && !hasEffortOption(canonical.reasoning_options)) {
    canonical.reasoning_options = conservativeEffortOptions();
  }

  canonical.name = annotateName(
    typeof canonical.name === 'string' ? canonical.name : catalogName,
    keyCount,
  );
  if (typeof entry.owned_by === 'string') canonical.owned_by = entry.owned_by;
  return canonical;
}

/**
 * Fetch model entries from the given providers and merge them into the map.
 *
 * Cross-provider aliasing: when a provider catalog serves the SAME model
 * under a different id (bare name matches an existing entry — e.g.
 * 'deepseek/deepseek-v4-flash' on commandcode vs 'deepseek-v4-flash' on
 * opencode-go), the existing entry gains the new provider as an alias:
 * requests naming either id rotate across all serving keys.
 *
 * Provider-only models (claude-*, unique vendor ids) are added as
 * `<id>@<providerId>` suffixed entries.
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

  // Bare-name index of what's already in the map (from the primary upstream)
  const byBareName = new Map<string, string>();
  for (const id of existingIds) {
    const bare = bareModelName(id);
    if (!byBareName.has(bare)) byBareName.set(bare, id);
  }

  await Promise.all(
    providers.map(async (provider) => {
      const catalog = await provider.fetchCatalog();
      if (!catalog) return;
      // models.dev slice for this provider, consulted per entry. Shared TTL
      // cache: when buildMinimalStub already fetched opencode-go this is free.
      const devModels = (await fetchModelsDevProvider(provider.id)) ?? {};
      for (const entry of catalog) {
        const rawId = typeof entry.id === 'string' ? entry.id : '';
        if (!rawId) continue;
        const bare = bareModelName(rawId);
        const existingId = byBareName.get(bare);
        if (existingId) {
          // Same model served by both providers → alias it onto the existing
          // entry so either id routes to the full serving key pool.
          const entryRec = map[existingId] as Record<string, unknown>;
          const aliases = Array.isArray(entryRec?.aliases)
            ? (entryRec.aliases as string[])
            : [];
          if (!aliases.includes(rawId)) aliases.push(rawId);
          entryRec.aliases = aliases;
          continue;
        }
        if (provider.modelAffinity(rawId) !== 'yes') continue; // not uniquely claimable
        const suffixedId = `${rawId}${PROVIDER_MODEL_SUFFIX}${provider.id}`;
        if (existingIds.has(suffixedId)) continue;
        existingIds.add(suffixedId);
        byBareName.set(bare, suffixedId);
        map[suffixedId] = providerCatalogToCanonical(
          suffixedId,
          rawId,
          entry,
          countServingKeys(config, bare, provider.id),
          devModels,
        );
      }
    }),
  );
}

/**
 * Build the canonical model map (id → opencode-shaped entry).
 *
 * Live path (config provided, not offline): fetch upstream model IDs and
 * enrich each with models.dev metadata via buildMinimalStub, then append
 * provider-specific catalog models (@commandcode etc.) enriched from that
 * provider's own models.dev slice. Falls back to the bundled
 * `assets/models.json` when the upstream fetch yields nothing.
 * Offline path (or no config): bundled `assets/models.json` only.
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
    // Rotation-width annotation on the primary (opencode-go) entries:
    // "DeepSeek V4 Flash (3)" = 3 keys can serve this model.
    for (const [id, entry] of Object.entries(map)) {
      if (id.includes(PROVIDER_MODEL_SUFFIX)) continue;
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const rec = entry as Record<string, unknown>;
        if (typeof rec.name === 'string') {
          rec.name = annotateName(
            rec.name,
            countServingKeys(config, bareModelName(id), 'opencode-go'),
          );
        }
      }
    }
    return map;
  }

  return loadModelsFromJson();
}
