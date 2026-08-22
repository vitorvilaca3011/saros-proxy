/**
 * model-stats.ts — Persisted per-model request counters.
 *
 * The proxy records one increment per forwarded completion request so
 * `saros-proxy usage` can show the most-used models across restarts.
 * Storage is a tiny JSON file in the saros config dir; writes are debounced
 * (write-behind) to keep the request path free of I/O.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MODEL_STATS_SAVE_DEBOUNCE_MS } from './constants.js';
import { getSarosDir } from './config.js';
import { logger } from './logger.js';

export function getModelStatsPath(): string {
  return getSarosDir() + '/model-stats.json';
}

interface ModelStatsFile {
  /** Epoch ms of the first recorded request. */
  since: number;
  counts: Record<string, number>;
}

const counters = new Map<string, number>();
let since = 0;
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined = undefined;

function load(): void {
  loaded = true;
  try {
    const path = getModelStatsPath();
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ModelStatsFile>;
    if (typeof parsed.since === 'number') since = parsed.since;
    if (parsed.counts && typeof parsed.counts === 'object') {
      for (const [model, count] of Object.entries(parsed.counts)) {
        if (typeof count === 'number' && count > 0) counters.set(model, count);
      }
    }
  } catch (err) {
    logger.debug({ err }, 'failed to load model stats — starting fresh');
  }
}

function persist(): void {
  try {
    const path = getModelStatsPath();
    mkdirSync(dirname(path), { recursive: true });
    const file: ModelStatsFile = {
      since: since || Date.now(),
      counts: Object.fromEntries([...counters.entries()].sort()),
    };
    writeFileSync(path, JSON.stringify(file, null, 2), 'utf-8');
  } catch (err) {
    logger.debug({ err }, 'failed to persist model stats');
  }
}

function schedulePersist(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    persist();
  }, MODEL_STATS_SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

/** Record one forwarded request for `model` (best-effort, never throws). */
export function recordModelRequest(model: string): void {
  if (!loaded) load();
  if (!since) since = Date.now();
  counters.set(model, (counters.get(model) ?? 0) + 1);
  schedulePersist();
}

/** Snapshot sorted by count desc. Empty when nothing was ever recorded. */
export function getModelStats(): Array<{ model: string; count: number }> {
  if (!loaded) load();
  return [...counters.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count);
}

/** Test seam: drop in-memory state and any pending debounced write. */
export function resetModelStats(): void {
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  counters.clear();
  since = 0;
  loaded = false;
}
