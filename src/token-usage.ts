/**
 * token-usage.ts — Persisted per-key token counters.
 *
 * The proxy records the token usage every upstream response reports (the
 * final SSE `usage` chunk for streams, the `usage` object for non-streaming
 * bodies) so `saros-proxy usage` can show real consumption per key. For
 * providers with no queryable quota API (CommandCode) this is the only
 * usage signal saros can obtain; for the rest it complements the quota
 * percentages with absolute numbers.
 *
 * Storage mirrors model-stats.ts: a tiny JSON file in the saros config dir,
 * written behind a debounce so the request path never blocks on I/O.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { TOKEN_USAGE_SAVE_DEBOUNCE_MS } from './constants.js';
import { getSarosDir } from './config.js';
import { logger } from './logger.js';

export interface KeyTokenUsage {
  /** Upstream responses that reported token counts for this key. */
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Epoch ms of the most recent recorded response. */
  lastAt: number;
}

/** Token counts extracted from one upstream `usage` object. */
export interface TokenCounts {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface TokenUsageFile {
  /** Epoch ms of the first recorded response. */
  since: number;
  keys: Record<string, KeyTokenUsage>;
}

export function getTokenUsagePath(): string {
  return getSarosDir() + '/token-usage.json';
}

// Bound on stored key labels: keeps the map and the usage file bounded even
// with a hostile/oversized config. Labels come from config, one per key.
const MAX_TRACKED_KEYS = 200;

const counters = new Map<string, KeyTokenUsage>();
let since = 0;
let loaded = false;
let saveTimer: NodeJS.Timeout | undefined = undefined;

/** Non-negative finite integer, or 0 for anything else. */
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** Plain object (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extract token counts from an upstream `usage` object. Returns null when it
 * carries no counts at all — providers emit `usage: null` on every
 * intermediate streaming chunk, and non-chat routes (e.g. a proxied usage
 * API) have an unrelated `usage` object.
 */
export function parseTokenCounts(usage: unknown): TokenCounts | null {
  if (!isPlainObject(usage)) return null;
  // Chat completions report prompt/completion; the OpenAI Responses and
  // Anthropic shapes report input/output instead. Accept both so a request
  // through /v1/responses or /v1/messages is not booked as zero.
  const promptTokens = tokenCount(usage.prompt_tokens) || tokenCount(usage.input_tokens);
  const completionTokens = tokenCount(usage.completion_tokens) || tokenCount(usage.output_tokens);
  const total = tokenCount(usage.total_tokens);
  if (promptTokens === 0 && completionTokens === 0 && total === 0) {
    const reported = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']
      .some((field) => typeof usage[field] === 'number');
    if (!reported) return null;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens: total || promptTokens + completionTokens,
  };
}

function load(): void {
  loaded = true;
  try {
    const path = getTokenUsagePath();
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<TokenUsageFile>;
    if (typeof parsed.since === 'number') since = parsed.since;
    if (isPlainObject(parsed.keys)) {
      for (const [label, entry] of Object.entries(parsed.keys)) {
        if (!isPlainObject(entry)) continue;
        const requests = tokenCount(entry.requests);
        if (requests === 0) continue;
        counters.set(label, {
          requests,
          promptTokens: tokenCount(entry.promptTokens),
          completionTokens: tokenCount(entry.completionTokens),
          totalTokens: tokenCount(entry.totalTokens),
          lastAt: tokenCount(entry.lastAt),
        });
      }
    }
  } catch (err) {
    logger.debug({ err }, 'failed to load token usage — starting fresh');
  }
}

function persist(): void {
  try {
    const path = getTokenUsagePath();
    mkdirSync(dirname(path), { recursive: true });
    const file: TokenUsageFile = {
      since: since || Date.now(),
      keys: Object.fromEntries([...counters.entries()].sort()),
    };
    // Atomic write (temp + rename): a crash mid-write never truncates the
    // file and erases accumulated history.
    const tmpPath = path + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(file, null, 2), 'utf-8');
    renameSync(tmpPath, path);
  } catch (err) {
    logger.debug({ err }, 'failed to persist token usage');
  }
}

function schedulePersist(): void {
  // Throttle, not reset: under sustained load the write must still happen at
  // least once per debounce window instead of being pushed forever.
  if (saveTimer !== undefined) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    persist();
  }, TOKEN_USAGE_SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

/**
 * Record one upstream response's `usage` object for `keyLabel`.
 * Best-effort: never throws, ignores objects without token counts.
 */
export function recordKeyTokens(keyLabel: string, usage: unknown): void {
  const counts = parseTokenCounts(usage);
  if (!counts) return;
  // Strip control/ANSI characters and cap length before storing (labels come
  // from config and land in a file the CLI re-reads).
  const label = keyLabel.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 128);
  if (label.length === 0) return;
  if (!loaded) load();
  if (!since) since = Date.now();

  const entry = counters.get(label) ?? {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    lastAt: 0,
  };
  entry.requests += 1;
  entry.promptTokens += counts.promptTokens;
  entry.completionTokens += counts.completionTokens;
  entry.totalTokens += counts.totalTokens;
  entry.lastAt = Date.now();
  counters.set(label, entry);

  // Evict the least-used entry when over the cap (rare: 200+ distinct keys)
  if (counters.size > MAX_TRACKED_KEYS) {
    let least: string | null = null;
    let leastRequests = Infinity;
    for (const [name, value] of counters) {
      if (value.requests < leastRequests) {
        least = name;
        leastRequests = value.requests;
      }
    }
    if (least !== null && least !== label) counters.delete(least);
  }
  schedulePersist();
}

/** Flush any pending write immediately (called on graceful shutdown). */
export function flushTokenUsage(): void {
  // Never overwrite accumulated history with an empty map: only flush when
  // this process actually recorded responses.
  if (!loaded || counters.size === 0) return;
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  persist();
}

/**
 * Snapshot of recorded token usage: `since` (epoch ms, 0 when nothing was
 * ever recorded) plus per-label counters.
 */
export function getKeyTokenUsage(): { since: number; keys: Record<string, KeyTokenUsage> } {
  if (!loaded) load();
  return { since, keys: Object.fromEntries(counters) };
}

/** Test seam: drop in-memory state and any pending debounced write. */
export function resetTokenUsage(): void {
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  counters.clear();
  since = 0;
  loaded = false;
}
