/**
 * proxy-logic.ts — Pure production logic module for Multi-Account OpenCode-Go Proxy
 *
 * No I/O, no console.log, no HTTP — completely portable and testable.
 *
 * Critical fixes over prototype:
 *   C1. Circuit breaker cooldown (lazy auto-re-enable via disabledAt)
 *   C2. Error classification (KeyFault | RequestFault | ServerFault)
 *   C3. Read-only KeySnapshot returned instead of mutable ApiKey reference
 *   C4. Request-scoped key tracking (activeRequests map)
 */

// ---------------------------------------------------------------------------
// Interfaces & Types
// ---------------------------------------------------------------------------

export interface ApiKey {
  label: string;
  key: string;
  enabled: boolean;
  consecutiveFailures: number;
  lastUsed: number | null;
  disabledAt: number | null; // C1: timestamp when key was disabled for cooldown
}

/** Read-only projection returned to callers — cannot mutate internal state. */
export interface KeySnapshot {
  label: string;
  key: string;
}

/** Tracks a single HTTP request's key usage through its lifecycle. */
export interface RequestContext {
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
 * - KeyFault: the API key should be penalised (invalid, revoked, rate-limited, server fault)
 * - RequestFault: the request itself is bad — no key penalisation
 * - ServerFault: transient server issue — key penalised (normal circuit-breaker)
 */
export type ErrorType = 'KeyFault' | 'RequestFault' | 'ServerFault';

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
    })),
    currentIndex: 0,
    circuitBreakerThreshold: options?.circuitBreakerThreshold ?? 3,
    circuitBreakerCooldownMs: options?.circuitBreakerCooldownMs ?? 60_000,
    activeRequests: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Internal: return a read-only snapshot of the key already selected.
 * (Keeps mutation paths through markKeyFailed / markKeySucceeded / reenableKey.)
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
 * Internal: return the set of key labels that are currently booked
 * (present in *any* active request's triedKeys — C4 double-booking avoidance).
 */
function buildBookedLabels(state: ProxyState): Set<string> {
  const booked = new Set<string>();
  for (const [, ctx] of state.activeRequests) {
    for (const label of ctx.triedKeys) {
      booked.add(label);
    }
  }
  return booked;
}

/**
 * Internal: find the next available key, skipping:
 *  - disabled / under-cooldown keys
 *  - labels in `excludeLabels`
 * Advances the round-robin index and returns a read-only snapshot.
 */
function findNextKey(
  state: ProxyState,
  excludeLabels: Set<string>,
): KeySnapshot | null {
  const n = state.keys.length;
  if (n === 0) return null;

  for (let i = 0; i < n; i++) {
    const idx = (state.currentIndex + i) % n;
    const key = state.keys[idx];

    if (excludeLabels.has(key.label)) continue;
    if (!isKeyAvailable(state, key)) continue;

    // Advance past the selected key
    state.currentIndex = (idx + 1) % n;
    key.lastUsed = Date.now();
    return toSnapshot(key);
  }

  return null;
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

  const excludeLabels = new Set(ctx.triedKeys);
  // Avoid double-booking: don't assign a key that another request already tried
  const booked = buildBookedLabels(state);
  for (const label of booked) {
    excludeLabels.add(label);
  }

  const snapshot = findNextKey(state, excludeLabels);
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

  // Pick next excluding tried keys + double-booking guard
  const excludeLabels = new Set(ctx.triedKeys);
  const booked = buildBookedLabels(state);
  for (const label of booked) {
    excludeLabels.add(label);
  }

  const snapshot = findNextKey(state, excludeLabels);
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
 * - RequestFault: no penalisation (bad request, not bad key)
 */
export function markKeyFailed(
  state: ProxyState,
  keyLabel: string,
  errorType: ErrorType,
): void {
  if (errorType === 'RequestFault') return;

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

/**
 * Manually re-enable a previously disabled key.
 */
export function reenableKey(state: ProxyState, keyLabel: string): void {
  const key = state.keys.find((k) => k.label === keyLabel);
  if (!key) return;
  key.enabled = true;
  key.consecutiveFailures = 0;
  key.disabledAt = null; // C1: clear cooldown
}

// ---------------------------------------------------------------------------
// Status Queries
// ---------------------------------------------------------------------------

/**
 * Check whether a key is currently disabled.
 * A key that has passed its cooldown window is considered no longer disabled
 * (lazy re-enable happens on next selection, but this query reflects that).
 */
export function isKeyDisabled(state: ProxyState, keyLabel: string): boolean {
  const key = state.keys.find((k) => k.label === keyLabel);
  if (!key) return true;

  if (!key.enabled) {
    // C1: past cooldown → effectively not disabled anymore
    if (
      key.disabledAt !== null &&
      Date.now() - key.disabledAt >= state.circuitBreakerCooldownMs
    ) {
      return false;
    }
    return true;
  }

  return key.consecutiveFailures >= state.circuitBreakerThreshold;
}

// ---------------------------------------------------------------------------
// Error Classification (C2)
// ---------------------------------------------------------------------------

/**
 * Classify an HTTP error status + optional response body into an ErrorType.
 *
 * Rules:
 *  401               → KeyFault  (invalid/revoked key — immediate disable)
 *  429               → KeyFault  (rate-limited)
 *  500 / 502 / 503   → KeyFault if body mentions quota/balance, else ServerFault
 *  400 / 404 / 422   → RequestFault (bad request — don't penalise the key)
 *  everything else   → ServerFault
 */
export function classifyHttpError(status: number, _body?: string): ErrorType {
  if (status === 401) return 'KeyFault';
  if (status === 429) return 'KeyFault';
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

// ---------------------------------------------------------------------------
// Legacy (deprecated — prefer request-scoped API above)
// ---------------------------------------------------------------------------

/**
 * Legacy round-robin key selection.
 *
 * Picks the next enabled key that is under the circuit-breaker threshold
 * (or past its cooldown window).  Returns null when all keys are unavailable.
 *
 * @deprecated Use selectKeyForRequest / failoverRequest instead.
 */
export function selectNextKey(state: ProxyState): KeySnapshot | null {
  return findNextKey(state, new Set());
}
