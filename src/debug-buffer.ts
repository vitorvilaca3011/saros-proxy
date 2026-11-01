/**
 * debug-buffer.ts — In-memory ring buffer of the last proxied requests.
 *
 * Pure state: no Hono, no I/O. The proxy app owns one instance and pushes
 * from the same place it emits `evt:"request.complete"`, so `GET /debug/recent`
 * and the access log cannot drift.
 *
 * Never store credentials, headers or bodies — only the public key label.
 */

import { RECENT_REQUESTS_CAPACITY } from './constants.js';

/** One proxied request, exactly as it appears in the access log. */
export interface RecentRequestEntry {
  requestId: string;
  /**
   * ISO timestamp of when the downstream response was produced (for a stream,
   * its headers — not the end of the stream). Same instant as the
   * `request.complete` line.
   */
  at: string;
  method: string;
  path: string;
  /** Raw model id from the request body (`model@provider` keeps the suffix). */
  model: string | null;
  /** Provider of the key that served (or last tried) the request. */
  provider: string | null;
  /**
   * Public key label — never the credential. The serving key, or the last key
   * tried when the proxy answers 502 or a 503 raised after keys were tried;
   * null only when no key was ever selected.
   */
  keyLabel: string | null;
  status: number;
  durationMs: number;
  stream: boolean;
  /** One-based attempt number. */
  attempt: number;
}

export interface RecentRequestsSnapshot {
  capacity: number;
  count: number;
  /** Oldest first (append order). */
  entries: RecentRequestEntry[];
}

export interface RecentRequestBuffer {
  readonly capacity: number;
  push(entry: RecentRequestEntry): void;
  snapshot(): RecentRequestsSnapshot;
}

/**
 * `SAROS_DEBUG_BUFFER=0` disables the buffer (endpoint answers 404 and nothing
 * is stored). Any other value, or unset, keeps it enabled.
 */
export function isDebugBufferEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SAROS_DEBUG_BUFFER !== '0';
}

/**
 * Fixed-capacity buffer: once full, each push evicts the oldest entry.
 * 200 entries of a dozen small fields is a few tens of KB — not worth a
 * head-index ring; `shift()` on a 200-element array is noise.
 */
export function createRecentRequestBuffer(
  capacity: number = RECENT_REQUESTS_CAPACITY,
): RecentRequestBuffer {
  const entries: RecentRequestEntry[] = [];

  return {
    capacity,
    push(entry) {
      entries.push(entry);
      if (entries.length > capacity) entries.shift();
    },
    snapshot() {
      return {
        capacity,
        count: entries.length,
        // Detached copies: a caller must not mutate the buffer.
        entries: entries.map((entry) => ({ ...entry })),
      };
    },
  };
}
