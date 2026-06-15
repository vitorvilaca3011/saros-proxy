/**
 * models-fetcher.ts — Fetches model list from the upstream OpenCode-Go API
 * and serves it to clients, with fallback to hardcoded model IDs.
 *
 * Public API:
 *   fetchModelsFromUpstream(config)  — raw fetch + validation
 *   getModelsList(config)            — orchestrator with warm buffer & in-flight dedup
 *   buildFallbackResponse()          — minimal fallback from OPENCODE_MODELS
 *   resetModelsFetcherState()        — test helper to clear module-level state
 */

import { MODELS_FETCH_TIMEOUT_MS, MODELS_WARM_BUFFER_MS } from './constants.js';
import { loadModelsFromJson } from './cli/opencode-config.js';
import type { ProxyConfig } from './config.js';

// ---------------------------------------------------------------------------
// Module-level state (hidden from callers)
// ---------------------------------------------------------------------------

let lastGood: { ts: number; data: { object: string; data: unknown[] } } | null = null;
let inFlightP: Promise<{ object: string; data: unknown[] } | null> | null = null;

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/** Reset module-level state — used by tests to get a fresh state between runs. */
export function resetModelsFetcherState(): void {
  lastGood = null;
  inFlightP = null;
}

// ---------------------------------------------------------------------------
// Fetch from upstream
// ---------------------------------------------------------------------------

/**
 * Fetch the model list from the upstream OpenCode-Go public endpoint.
 *
 * GETs `${config.upstreamBaseUrl}/zen/go/v1/models` without auth.
 * Uses a 5-second timeout via AbortSignal.
 *
 * @returns Parsed `{ object, data }` on success, or `null` on any error or
 *          shape mismatch. An empty data array IS valid (passthrough).
 */
export async function fetchModelsFromUpstream(
  config: ProxyConfig,
): Promise<{ object: string; data: unknown[] } | null> {
  try {
    const response = await fetch(`${config.upstreamBaseUrl}/zen/go/v1/models`, {
      method: 'GET',
      signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const text = await response.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }

    if (typeof parsed !== 'object' || parsed === null) return null;

    const obj = parsed as Record<string, unknown>;
    if (obj.object !== 'list') return null;
    if (!Array.isArray(obj.data)) return null;

    return { object: 'list', data: obj.data };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

/**
 * Build a 200 JSON Response from upstream-shaped data.
 * Private helper.
 */
function buildResponse(data: { object: string; data: unknown[] }): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Build a 200 JSON Response using the hardcoded OPENCODE_MODELS list.
 * Used when the upstream endpoint is unreachable.
 *
 * Each entry gets `{ id, object: 'model', created: <unix ts>, owned_by: 'saros' }`.
 */
export function buildFallbackResponse(): Response {
  const models = loadModelsFromJson();
  const now = Math.floor(Date.now() / 1000);
  const data = Object.keys(models).map((id) => ({
    id,
    object: 'model' as const,
    created: now,
    owned_by: 'saros' as const,
  }));

  return new Response(JSON.stringify({ object: 'list', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Get the model list response, with:
 *   1. Warm buffer — cached data served for up to 60 seconds.
 *   2. In-flight dedup — concurrent calls share a single upstream request.
 *   3. Fallback — hardcoded models when upstream is unreachable.
 *
 * @returns A 200 JSON Response with upstream data or fallback models.
 */
export async function getModelsList(config: ProxyConfig): Promise<Response> {
  // 1. Warm buffer: serve cached response if within 60s.
  // lastGood is intentionally NOT cleared on upstream failure — a
  // server outage shouldn't reset the cache to nothing.
  if (lastGood && Date.now() - lastGood.ts < MODELS_WARM_BUFFER_MS) {
    return buildResponse(lastGood.data);
  }

  // 2. In-flight dedup: reuse an existing upstream request
  if (inFlightP) {
    const result = await inFlightP;
    return result ? buildResponse(result) : buildFallbackResponse();
  }

  // 3. Start a new upstream request
  inFlightP = fetchModelsFromUpstream(config)
    .then((result) => {
      if (result) {
        lastGood = { ts: Date.now(), data: result };
      }
      return result;
    })
    .finally(() => {
      inFlightP = null;
    });

  const result = await inFlightP;
  return result ? buildResponse(result) : buildFallbackResponse();
}
