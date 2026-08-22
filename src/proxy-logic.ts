/**
 * proxy-logic.ts — Pure production logic. Saros picks the best key per request.
 *
 * No I/O, no console.log, no HTTP — completely portable and testable.
 *
 * Critical fixes over prototype:
 *   C1. Circuit breaker cooldown (lazy auto-re-enable via disabledAt)
 *   C2. Error classification (KeyFault | RequestFault | ServerFault)
 *   C3. Read-only KeySnapshot returned instead of mutable ApiKey reference
 *   C4. Request-scoped key tracking (activeRequests map)
 */

import { DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS } from './constants.js';

// ---------------------------------------------------------------------------
// Interfaces & Types
// ---------------------------------------------------------------------------

interface ApiKey {
  label: string;
  key: string;
  enabled: boolean;
  consecutiveFailures: number;
  lastUsed: number | null;
  disabledAt: number | null; // C1: timestamp when key was disabled for cooldown
  /** Worst-window used percent (0-100) reported by the upstream usage API. */
  usagePercent: number | null;
  /** Smooth weighted round-robin state (nginx-style). */
  currentWeight: number;
}

/** Read-only projection returned to callers — cannot mutate internal state. */
export interface KeySnapshot {
  label: string;
  key: string;
}

/** Tracks a single HTTP request's key usage through its lifecycle. */
interface RequestContext {
  requestId: string;
  triedKeys: string[]; // keys already attempted for this request (for failover)
  currentKey: KeySnapshot | null; // the key currently in use by this request
}

export interface ProxyState {
  keys: ApiKey[];
  currentIndex: number;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
  activeRequests: Map<string, RequestContext>; // C4
}

/**
 * Error classification for HTTP responses.
 * - KeyFault: the API key should be penalised (invalid, revoked, quota exhausted)
 * - RequestFault: the request itself is bad — no key penalisation
 * - ServerFault: transient server issue — key penalised (normal circuit-breaker)
 * - NetworkFault: timeout / connection error — no key penalisation. The
 *   upstream base URL is shared by every key, so network-level failures are
 *   not a per-key fault; disabling keys for them caused total-blackout
 *   lockups ("all keys unavailable") when the upstream hung. Failover still
 *   tries the next key for this request.
 */
export type ErrorType = 'KeyFault' | 'RequestFault' | 'ServerFault' | 'NetworkFault';

// ---------------------------------------------------------------------------
// State Factory
// ---------------------------------------------------------------------------

export function createProxyState(
  keys: Array<{ label: string; key: string }>,
  options?: {
    circuitBreakerThreshold?: number;
    circuitBreakerCooldownMs?: number;
  },
): ProxyState {
  return {
    keys: keys.map((k) => ({
      label: k.label,
      key: k.key,
      enabled: true,
      consecutiveFailures: 0,
      lastUsed: null,
      disabledAt: null,
      usagePercent: null,
      currentWeight: 0,
    })),
    currentIndex: 0,
    circuitBreakerThreshold: options?.circuitBreakerThreshold ?? 3,
    circuitBreakerCooldownMs: options?.circuitBreakerCooldownMs ?? DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
    activeRequests: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Internal: return a read-only snapshot of the key already selected.
 * (Keeps mutation paths through markKeyFailed / markKeySucceeded.)
 */
function toSnapshot(key: ApiKey): KeySnapshot {
  return { label: key.label, key: key.key };
}

/**
 * Internal: check whether a key is available (enabled & under threshold).
 * If the key is disabled but past its cooldown window, it is lazily re-enabled
 * (C1 — fixes dead-code cooldown).
 */
function isKeyAvailable(state: ProxyState, key: ApiKey): boolean {
  if (key.enabled && key.consecutiveFailures < state.circuitBreakerThreshold) {
    return true;
  }

  // C1: lazy auto-re-enable after cooldown expires
  if (!key.enabled && key.disabledAt !== null) {
    const elapsed = Date.now() - key.disabledAt;
    if (elapsed >= state.circuitBreakerCooldownMs) {
      key.enabled = true;
      key.consecutiveFailures = 0;
      key.disabledAt = null;
      return true;
    }
  }

  return false;
}

/**
 * Internal: return the set of key labels that are currently *in use* by
 * active requests (C4 double-booking avoidance).
 *
 * Previously this collected ALL ctx.triedKeys, which meant an abandoned key
 * (one a request failed over from) stayed globally excluded even though
 * nobody was using it.  Now it only tracks the key each request is actively
 * using (ctx.currentKey).  Tried keys are still excluded per-request via
 * the per-request excludeLabels in selectKeyForRequest/failoverRequest.
 */
function buildBookedLabels(state: ProxyState): Set<string> {
  const booked = new Set<string>();
  for (const [, ctx] of state.activeRequests) {
    if (ctx.currentKey) {
      booked.add(ctx.currentKey.label);
    }
  }
  return booked;
}

/**
 * Internal: find the next available key, skipping:
 *  - disabled / under-cooldown keys
 *  - labels in `excludeLabels`
 *
 * Selection strategy (smooth weighted round-robin, nginx-style):
 *  - When usage data is known for the candidates, keys with more remaining
 *    quota are proportionally preferred. E.g. key X at 30% used and key Y at
 *    70% used receive ~70%/30% of requests — exact proportions over a cycle,
 *    not random sampling.
 *  - Without usage data (or when every candidate is exhausted), falls back to
 *    plain round-robin ordering.
 */
function findNextKey(
  state: ProxyState,
  excludeLabels: Set<string>,
): KeySnapshot | null {
  const n = state.keys.length;
  if (n === 0) return null;

  const candidates: ApiKey[] = [];
  for (let i = 0; i < n; i++) {
    const key = state.keys[(state.currentIndex + i) % n];
    if (excludeLabels.has(key.label)) continue;
    if (!isKeyAvailable(state, key)) continue;
    candidates.push(key);
  }
  if (candidates.length === 0) return null;

  const picked = pickWeighted(state, candidates);
  state.currentIndex = (state.keys.indexOf(picked) + 1) % n;
  picked.lastUsed = Date.now();
  return toSnapshot(picked);
}

/**
 * Internal: smooth weighted round-robin over the candidates.
 * Falls back to the first candidate (round-robin order) when usage data is
 * missing for any candidate or when no candidate has remaining capacity.
 */
function pickWeighted(state: ProxyState, candidates: ApiKey[]): ApiKey {
  const known = candidates.filter((k) => k.usagePercent !== null);
  if (known.length === 0) return candidates[0];

  let weights = candidates.map((k) => Math.max(0, 100 - (k.usagePercent ?? 0)));
  // Keys missing usage data get the median of the known weights — neutral,
  // so one flaky key no longer disables weighting for the whole pool.
  const sorted = known.map((k) => 100 - (k.usagePercent ?? 0)).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  weights = weights.map((w, i) => (candidates[i].usagePercent === null ? median : w));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) return candidates[0];

  let best = candidates[0];
  let bestWeight = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    candidates[i].currentWeight += weights[i];
    if (candidates[i].currentWeight > bestWeight) {
      bestWeight = candidates[i].currentWeight;
      best = candidates[i];
    }
  }
  best.currentWeight -= totalWeight;
  return best;
}

/**
 * Update per-key usage data (worst-window used percent, 0-100).
 * Keys absent from the map keep their previous value.
 */
export function updateKeyUsage(state: ProxyState, usage: Map<string, number>): void {
  for (const key of state.keys) {
    const percent = usage.get(key.label);
    if (typeof percent === 'number') key.usagePercent = percent;
  }
}

// ---------------------------------------------------------------------------
// Request-Scoped Key Tracking (C4)
// ---------------------------------------------------------------------------

/**
 * Obtain a key for a new (or in-flight) request.
 * Creates a RequestContext if one does not already exist for this requestId.
 * Skips keys that have already been tried for this request AND keys booked
 * by any other active request.
 */
export function selectKeyForRequest(
  state: ProxyState,
  requestId: string,
): KeySnapshot | null {
  // If context already exists, return the already-assigned current key
  const existing = state.activeRequests.get(requestId);
  if (existing) {
    return existing.currentKey;
  }

  // Create new context and pick a fresh key
  const ctx: RequestContext = { requestId, triedKeys: [], currentKey: null };
  state.activeRequests.set(requestId, ctx);

  // Tier 1: prefer a key not booked by another active request (spread load)
  const excludeLabels = new Set(ctx.triedKeys);
  const booked = buildBookedLabels(state);
  for (const label of booked) {
    excludeLabels.add(label);
  }

  let snapshot = findNextKey(state, excludeLabels);

  // Tier 2: all healthy keys are booked — share one via round-robin.
  // Better to share a key than return 503 when concurrent requests
  // outnumber the key pool.
  if (!snapshot) {
    snapshot = findNextKey(state, new Set(ctx.triedKeys));
  }

  ctx.currentKey = snapshot;
  return snapshot;
}

/**
 * Failover: record the current key of this request as failed and pick the next
 * available key.  The caller should also call markKeyFailed() with the
 * appropriate ErrorType; this function only manages the request-context
 * tracking (adds the current key to triedKeys).
 */
export function failoverRequest(
  state: ProxyState,
  requestId: string,
): KeySnapshot | null {
  const ctx = state.activeRequests.get(requestId);
  if (!ctx) return null;

  // Record current key as tried
  if (ctx.currentKey) {
    ctx.triedKeys.push(ctx.currentKey.label);
  }

  // Tier 1: prefer a key not tried AND not booked by another request
  const excludeLabels = new Set(ctx.triedKeys);
  const booked = buildBookedLabels(state);
  for (const label of booked) {
    excludeLabels.add(label);
  }

  let snapshot = findNextKey(state, excludeLabels);

  // Tier 2: all remaining healthy keys are booked — share one.
  // Still respects per-request triedKeys (don't re-use a key this
  // request already failed on).
  if (!snapshot) {
    snapshot = findNextKey(state, new Set(ctx.triedKeys));
  }

  ctx.currentKey = snapshot;
  return snapshot;
}

/**
 * Complete a request: if successful, mark the current key as succeeded;
 * always clean up the request context.
 */
export function completeRequest(
  state: ProxyState,
  requestId: string,
  success: boolean,
): void {
  const ctx = state.activeRequests.get(requestId);
  if (!ctx) return;

  if (success && ctx.currentKey) {
    markKeySucceeded(state, ctx.currentKey.label);
  }

  state.activeRequests.delete(requestId);
}

// ---------------------------------------------------------------------------
// Key Status Mutations
// ---------------------------------------------------------------------------

/**
 * Mark a key as failed according to the error type (C2).
 * - KeyFault / ServerFault: penalise the key (KeyFault disables immediately)
 * - RequestFault / NetworkFault: no penalisation (bad request, or network
 *   trouble that is not the key's fault)
 */
export function markKeyFailed(
  state: ProxyState,
  keyLabel: string,
  errorType: ErrorType,
): void {
  if (errorType === 'RequestFault' || errorType === 'NetworkFault') return;

  const key = state.keys.find((k) => k.label === keyLabel);
  if (!key) return;

  if (errorType === 'KeyFault') {
    // Disable immediately — the key is compromised / rate-limited
    key.consecutiveFailures = state.circuitBreakerThreshold;
    key.enabled = false;
    key.disabledAt = Date.now(); // C1: start cooldown timer
  } else {
    // ServerFault: normal circuit-breaker increment
    key.consecutiveFailures++;
    if (key.consecutiveFailures >= state.circuitBreakerThreshold) {
      key.enabled = false;
      key.disabledAt = Date.now(); // C1: start cooldown timer
    }
  }
}

/**
 * Mark a key as succeeded — resets consecutive failures.
 */
export function markKeySucceeded(state: ProxyState, keyLabel: string): void {
  const key = state.keys.find((k) => k.label === keyLabel);
  if (!key) return;
  key.consecutiveFailures = 0;
  // C1: clear cooldown on success so next selection isn't penalised
  key.disabledAt = null;
}

// ---------------------------------------------------------------------------
// Status Queries
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Error Classification (C2)
// ---------------------------------------------------------------------------

/**
 * Classify an HTTP error status + optional response body into an ErrorType.
 *
 * Rules:
 *  401               → KeyFault  (invalid/revoked key — immediate disable)
 *  429               → ServerFault (transient rate-limit — incremental circuit breaker)
 *  500 / 502 / 503   → KeyFault if body mentions quota/balance, else ServerFault
 *  400 / 404 / 422   → RequestFault (bad request — don't penalise the key)
 *  everything else   → ServerFault
 */
export function classifyHttpError(status: number, _body?: string): ErrorType {
  if (status === 401) return 'KeyFault';
  if (status === 429) return 'ServerFault';
  if (status === 400 || status === 404 || status === 422) return 'RequestFault';
  if (status === 500 || status === 502 || status === 503) {
    // Server errors: if the body hints at a quota/balance issue treat as KeyFault
    if (_body && /quota|balance|insufficient|limit/i.test(_body)) {
      return 'KeyFault';
    }
    return 'ServerFault';
  }
  return 'ServerFault';
}


