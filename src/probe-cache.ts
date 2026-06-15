/**
 * probe-cache.ts — Persistent cache for model probe results.
 *
 * Stores probe results to ~/.config/saros/probe-cache.json with a 7-day TTL.
 * Avoids re-probing models that have been successfully probed recently.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { PROBE_CACHE_TTL_MS } from './constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProbeResult {
  status: 'ok' | 'error' | 'rate_limited' | 'unsupported';
  ts: number;
  details?: string;
}

export interface ModelProbe {
  modelId: string;
  liveness: ProbeResult;
  reasoning: ProbeResult;
  toolCalling: ProbeResult;
}

export interface ProbeCacheFile {
  version: 1;
  probes: Record<string, ModelProbe>;
}

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

/**
 * Return the file path for the probe cache.
 * Always uses `~/.config/saros/probe-cache.json` (matches daemon PID file convention).
 */
export function getProbeCachePath(): string {
  return join(homedir(), '.config', 'saros', 'probe-cache.json');
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

/**
 * Load the probe cache from disk.
 * Returns an empty cache if the file is missing or corrupt.
 *
 * @param cachePath — Path to the cache file (defaults to getProbeCachePath())
 */
export function loadProbeCache(cachePath: string = getProbeCachePath()): ProbeCacheFile {
  if (!existsSync(cachePath)) {
    return { version: 1, probes: {} };
  }

  try {
    const raw = readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw);

    // Basic structure validation
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.version === 1 &&
      parsed.probes &&
      typeof parsed.probes === 'object' &&
      !Array.isArray(parsed.probes)
    ) {
      return parsed as ProbeCacheFile;
    }

    return { version: 1, probes: {} };
  } catch {
    // Corrupt JSON or read error — return fresh cache
    return { version: 1, probes: {} };
  }
}

/**
 * Write the probe cache to disk.
 * Creates the parent directory if it does not exist.
 *
 * @param cache — Cache data to write
 * @param cachePath — Path to the cache file (defaults to getProbeCachePath())
 */
export function saveProbeCache(cache: ProbeCacheFile, cachePath: string = getProbeCachePath()): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * Retrieve a cached probe result for the given model.
 * Returns null if the model is not cached or the entry is older than TTL.
 *
 * @param modelId — Model ID to look up
 * @param cachePath — Path to the cache file (defaults to getProbeCachePath())
 */
export function getCachedProbe(modelId: string, cachePath: string = getProbeCachePath()): ModelProbe | null {
  const cache = loadProbeCache(cachePath);
  const probe = cache.probes[modelId];

  if (!probe) return null;

  // Check TTL using the liveness timestamp
  const now = Date.now();
  if (now - probe.liveness.ts >= PROBE_CACHE_TTL_MS) {
    return null;
  }

  return probe;
}

/**
 * Store a probe result for the given model.
 * Loads existing cache, merges, and saves back to disk.
 *
 * @param modelId — Model ID to store
 * @param probe — Probe result to store
 * @param cachePath — Path to the cache file (defaults to getProbeCachePath())
 */
export function setCachedProbe(modelId: string, probe: ModelProbe, cachePath: string = getProbeCachePath()): void {
  const cache = loadProbeCache(cachePath);
  cache.probes[modelId] = probe;
  saveProbeCache(cache, cachePath);
}
