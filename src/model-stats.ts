/**
 * model-stats.ts — Persisted per-model request counters.
 *
 * The proxy records one increment per forwarded completion request so
 * `saros-proxy usage` can show the most-used models across restarts.
 * Storage is a tiny JSON file in the saros config dir; writes are debounced
 * (write-behind) to keep the request path free of I/O.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
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
    // Atomic write (temp + rename): a crash mid-write never truncates the
    // stats file and erases accumulated history.
    const tmpPath = path + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(file, null, 2), 'utf-8');
    renameSync(tmpPath, path);
  } catch (err) {
    logger.debug({ err }, 'failed to persist model stats');
  }
}

function schedulePersist(): void {
  // Throttle, not reset: under sustained load the write must still happen
  // at least once per debounce window instead of being pushed forever.
  if (saveTimer !== undefined) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    persist();
  }, MODEL_STATS_SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

/** Record one forwarded request for `model` (best-effort, never throws). */
// Bound on stored model-name keys: keeps the map and stats file bounded even
// under hostile/varied model fields.
const MAX_TRACKED_MODELS = 200;

/** Strip control/ANSI characters and cap length before storing. */
function sanitizeModel(model: string): string {
  const cleaned = model.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 128);
  return cleaned;
}

/** Record one forwarded request for `model` (best-effort, never throws). */
export function recordModelRequest(model: string): void {
  const clean = sanitizeModel(model);
  if (clean.length === 0) return;
  if (!loaded) load();
  if (!since) since = Date.now();
  counters.set(clean, (counters.get(clean) ?? 0) + 1);

  // Evict the least-used entry when over the cap (rare: 200+ distinct models)
  if (counters.size > MAX_TRACKED_MODELS) {
    let least: string | null = null;
    let leastCount = Infinity;
    for (const [name, count] of counters) {
      if (count < leastCount) {
        least = name;
        leastCount = count;
      }
    }
    if (least !== null) counters.delete(least);
  }
  schedulePersist();
}

/** Flush any pending write immediately (called on graceful shutdown). */
export function flushModelStats(): void {
  // Never overwrite accumulated history with an empty map: only flush when
  // this process actually recorded requests (i.e. the map was loaded and
  // has entries). A restart with zero traffic must not erase past counts.
  if (!loaded || counters.size === 0) return;
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  persist();
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
