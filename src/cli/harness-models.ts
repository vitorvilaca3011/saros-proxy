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

export interface PiOmpModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
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
 * Build the canonical model map (id → opencode-shaped entry).
 *
 * Live path (config provided, not offline): fetch upstream model IDs and
 * enrich each with models.dev metadata via buildMinimalStub. Falls back to
 * the bundled models.json when the upstream fetch yields nothing.
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
    for (const id of ids) {
      map[id] = buildMinimalStub(id, meta ?? undefined);
    }
    return map;
  }

  return loadModelsFromJson();
}
