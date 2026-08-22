/**
 * proxy-logic.test.ts — Comprehensive unit tests for the proxy logic module.
 *
 * Vitest-based; run with: npx vitest run src/proxy-logic.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createProxyState,
  selectKeyForRequest,
  failoverRequest,
  completeRequest,
  markKeyFailed,
  markKeySucceeded,
  classifyHttpError,
  type ProxyState,
  type ErrorType,
} from './proxy-logic.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a simple 3-key state for most tests. */
function makeState(
  threshold = 3,
  cooldownMs = 60_000,
): ProxyState {
  return createProxyState(
    [
      { label: 'alpha', key: 'sk-a1' },
      { label: 'beta', key: 'sk-b2' },
      { label: 'gamma', key: 'sk-c3' },
    ],
    { circuitBreakerThreshold: threshold, circuitBreakerCooldownMs: cooldownMs },
  );
}

/** Freeze time at a fixed point so cooldown tests are deterministic. */
function freezeTime(now: number): void {
  vi.useFakeTimers({ now, shouldAdvanceTime: false });
}

/** Advance time by ms and run pending timers. */
function advanceTime(ms: number): void {
  vi.advanceTimersByTime(ms);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createProxyState', () => {
  it('creates state with default options', () => {
    const state = makeState();
    expect(state.keys).toHaveLength(3);
    expect(state.currentIndex).toBe(0);
    expect(state.circuitBreakerThreshold).toBe(3);
    expect(state.circuitBreakerCooldownMs).toBe(60_000);
    expect(state.activeRequests).toBeInstanceOf(Map);
    for (const key of state.keys) {
      expect(key.enabled).toBe(true);
      expect(key.consecutiveFailures).toBe(0);
      expect(key.lastUsed).toBeNull();
      expect(key.disabledAt).toBeNull();
    }
  });

  it('creates state with custom options', () => {
    const state = createProxyState(
      [{ label: 'x', key: 'sk-x' }],
      { circuitBreakerThreshold: 5, circuitBreakerCooldownMs: 10_000 },
    );
    expect(state.circuitBreakerThreshold).toBe(5);
    expect(state.circuitBreakerCooldownMs).toBe(10_000);
  });

  it('creates empty state when no keys provided', () => {
    const state = createProxyState([]);
    expect(state.keys).toHaveLength(0);
    expect(selectKeyForRequest(state, 'test')).toBeNull();
  });
});

describe('C1 – Circuit Breaker Cooldown', () => {
  beforeEach(() => {
    freezeTime(1_000_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('disables key and sets disabledAt when threshold reached', () => {
    const state = makeState(2); // threshold = 2
    // 1 failure
    markKeyFailed(state, 'alpha', 'ServerFault');
    expect(state.keys[0].enabled).toBe(true);
    expect(state.keys[0].disabledAt).toBeNull();

    // 2nd failure → threshold hit
    markKeyFailed(state, 'alpha', 'ServerFault');
    expect(state.keys[0].enabled).toBe(false);
    expect(state.keys[0].disabledAt).toBe(1_000_000_000_000);
  });

  it('lazily re-enables disabled key after cooldown expires', () => {
    const state = makeState(1, 60_000);
    freezeTime(1_000_000_000_000);

    // Disable alpha
    markKeyFailed(state, 'alpha', 'ServerFault');
    expect(state.keys[0].enabled).toBe(false);
    expect(state.keys[0].disabledAt).toBe(1_000_000_000_000);

    // Before cooldown — selectKeyForRequest should skip alpha (picks beta, index advances)
    const key1 = selectKeyForRequest(state, 'req-cd1');
    expect(key1).not.toBeNull();
    expect(key1!.label).not.toBe('alpha');

    // Advance past cooldown
    advanceTime(60_001);

    // Run selectKeyForRequest through the full cycle until alpha comes around
    // (gamma was next at index 2, then wraps to alpha at index 0)
    const key2 = selectKeyForRequest(state, 'req-cd2');
    expect(key2!.label).toBe('gamma');
    const key3 = selectKeyForRequest(state, 'req-cd3');
    expect(key3!.label).toBe('alpha');
    expect(state.keys[0].enabled).toBe(true);
    expect(state.keys[0].consecutiveFailures).toBe(0);
    expect(state.keys[0].disabledAt).toBeNull();
  });

  it('cooldown works with selectKeyForRequest as well', () => {
    const state = makeState(1, 60_000);
    freezeTime(1_000_000_000_000);

    markKeyFailed(state, 'alpha', 'ServerFault');

    // Before cooldown — selectKeyForRequest picks beta (index advances)
    const snap1 = selectKeyForRequest(state, 'req-cd4');
    expect(snap1).not.toBeNull();
    expect(snap1!.label).not.toBe('alpha');

    // After cooldown — alpha is past cooldown
    advanceTime(60_001);

    // Next request wraps through gamma then hits alpha
    const snap2 = selectKeyForRequest(state, 'req-cd5');
    expect(snap2!.label).toBe('gamma');
    const snap3 = selectKeyForRequest(state, 'req-cd6');
    expect(snap3!.label).toBe('alpha');
  });

  it('clear disabledAt on markKeySucceeded', () => {
    const state = makeState(1);
    markKeyFailed(state, 'alpha', 'ServerFault');
    expect(state.keys[0].disabledAt).not.toBeNull();

    markKeySucceeded(state, 'alpha');
    expect(state.keys[0].disabledAt).toBeNull();
    expect(state.keys[0].consecutiveFailures).toBe(0);
  });
});

describe('C2 – Error Classification', () => {
  it('classifyHttpError returns KeyFault for 401', () => {
    expect(classifyHttpError(401)).toBe('KeyFault');
    expect(classifyHttpError(401, 'invalid key')).toBe('KeyFault');
  });

  it('classifyHttpError returns ServerFault for 429 (transient rate-limit)', () => {
    expect(classifyHttpError(429)).toBe('ServerFault');
    expect(classifyHttpError(429, 'rate limited')).toBe('ServerFault');
  });

  it('classifyHttpError returns KeyFault for 5xx with quota/balance body', () => {
    expect(classifyHttpError(500, 'quota exceeded')).toBe('KeyFault');
    expect(classifyHttpError(502, 'insufficient balance')).toBe('KeyFault');
    expect(classifyHttpError(503, 'limit reached')).toBe('KeyFault');
  });

  it('classifyHttpError returns ServerFault for 5xx without quota body', () => {
    expect(classifyHttpError(500)).toBe('ServerFault');
    expect(classifyHttpError(502, 'internal error')).toBe('ServerFault');
    expect(classifyHttpError(503, 'service unavailable')).toBe('ServerFault');
  });

  it('classifyHttpError returns RequestFault for 400/404/422', () => {
    expect(classifyHttpError(400)).toBe('RequestFault');
    expect(classifyHttpError(404)).toBe('RequestFault');
    expect(classifyHttpError(422)).toBe('RequestFault');
  });

  it('classifyHttpError returns ServerFault for other codes', () => {
    expect(classifyHttpError(403)).toBe('ServerFault');
    expect(classifyHttpError(408)).toBe('ServerFault');
    expect(classifyHttpError(999)).toBe('ServerFault');
  });

  it('markKeyFailed does nothing for RequestFault', () => {
    const state = makeState();
    markKeyFailed(state, 'alpha', 'RequestFault');
    expect(state.keys[0].consecutiveFailures).toBe(0);
    expect(state.keys[0].enabled).toBe(true);
  });

  it('markKeyFailed with ServerFault uses normal circuit-breaker', () => {
    const state = makeState(2);
    markKeyFailed(state, 'alpha', 'ServerFault');
    expect(state.keys[0].consecutiveFailures).toBe(1);
    expect(state.keys[0].enabled).toBe(true);

    markKeyFailed(state, 'alpha', 'ServerFault');
    expect(state.keys[0].consecutiveFailures).toBe(2);
    expect(state.keys[0].enabled).toBe(false);
  });

  it('markKeyFailed with KeyFault disables immediately', () => {
    const state = makeState(5); // high threshold
    markKeyFailed(state, 'alpha', 'KeyFault');
    // Even with threshold=5, KeyFault bumps failures to threshold so it's disabled
    expect(state.keys[0].enabled).toBe(false);
    expect(state.keys[0].disabledAt).not.toBeNull();
  });

  it('429 uses incremental circuit breaker (not instant disable)', () => {
    const state = makeState(3);
    // First 429 → ServerFault → 1/3 failures, still enabled
    markKeyFailed(state, 'alpha', classifyHttpError(429));
    expect(state.keys[0].consecutiveFailures).toBe(1);
    expect(state.keys[0].enabled).toBe(true);

    // Second 429 → 2/3, still enabled
    markKeyFailed(state, 'alpha', classifyHttpError(429));
    expect(state.keys[0].consecutiveFailures).toBe(2);
    expect(state.keys[0].enabled).toBe(true);

    // Third 429 → 3/3, now disabled
    markKeyFailed(state, 'alpha', classifyHttpError(429));
    expect(state.keys[0].enabled).toBe(false);
  });
});

describe('C3 – Read-only Snapshots', () => {
  it('selectKeyForRequest returns KeySnapshot not ApiKey', () => {
    const state = makeState();
    const snap = selectKeyForRequest(state, 'req-snap');
    expect(snap).toEqual({ label: 'alpha', key: 'sk-a1' });
    expect(Object.keys(snap!).sort()).toEqual(['key', 'label']);
  });

  it('mutating returned snapshot does not affect internal state', () => {
    const state = makeState();
    const snap = selectKeyForRequest(state, 'req-snap2')!;
    // Attempt to mutate the snapshot
    (snap as any).key = 'hacked';
    (snap as any).label = 'hacked';
    // Internal state must be unchanged
    expect(state.keys[0].label).toBe('alpha');
    expect(state.keys[0].key).toBe('sk-a1');
  });

  it('failoverRequest returns KeySnapshot', () => {
    const state = makeState();
    const snap = selectKeyForRequest(state, 'req-1');
    expect(snap).not.toBeNull();

    const failSnap = failoverRequest(state, 'req-1');
    expect(failSnap).not.toBeNull();
    expect(Object.keys(failSnap!).sort()).toEqual(['key', 'label']);
  });
});

describe('C4 – Request-Scoped Key Tracking', () => {
  beforeEach(() => {
    freezeTime(1_000_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('selectKeyForRequest creates context and picks first key', () => {
    const state = makeState();
    const snap = selectKeyForRequest(state, 'req-1');
    expect(snap).toEqual({ label: 'alpha', key: 'sk-a1' });

    const ctx = state.activeRequests.get('req-1');
    expect(ctx).toBeDefined();
    expect(ctx!.requestId).toBe('req-1');
    expect(ctx!.triedKeys).toEqual([]);
    expect(ctx!.currentKey).toEqual(snap);
  });

  it('selectKeyForRequest reuses existing context for same requestId', () => {
    const state = makeState();
    const snap1 = selectKeyForRequest(state, 'req-1');
    expect(snap1!.label).toBe('alpha');

    // Second call with same requestId should return the same (already tracked) key
    const snap2 = selectKeyForRequest(state, 'req-1');
    expect(snap2).toEqual(snap1);
  });

  it('failoverRequest adds current key to triedKeys and picks next', () => {
    const state = makeState();
    selectKeyForRequest(state, 'req-1'); // picks alpha
    const next = failoverRequest(state, 'req-1');

    const ctx = state.activeRequests.get('req-1')!;
    expect(ctx.triedKeys).toEqual(['alpha']);
    expect(next).not.toBeNull();
    expect(next!.label).not.toBe('alpha');
    expect(ctx.currentKey!.label).toBe(next!.label);
  });

  it('failoverRequest exhausts all keys and returns null', () => {
    const state = makeState(1, 60_000); // 3 keys, threshold=1

    // Disable all keys by marking each as failed
    markKeyFailed(state, 'alpha', 'ServerFault');
    markKeyFailed(state, 'beta', 'ServerFault');
    markKeyFailed(state, 'gamma', 'ServerFault');

    const snap = selectKeyForRequest(state, 'req-exhaust');
    expect(snap).toBeNull();
  });

  it('completeRequest cleans up context', () => {
    const state = makeState();
    selectKeyForRequest(state, 'req-clean');
    expect(state.activeRequests.has('req-clean')).toBe(true);

    completeRequest(state, 'req-clean', true);
    expect(state.activeRequests.has('req-clean')).toBe(false);
  });

  it('completeRequest with success calls markKeySucceeded', () => {
    const state = makeState();
    selectKeyForRequest(state, 'req-ok');
    expect(state.keys[0].consecutiveFailures).toBe(0);

    // Pre-fail the key, then succeed
    markKeyFailed(state, 'alpha', 'ServerFault');
    expect(state.keys[0].consecutiveFailures).toBe(1);

    completeRequest(state, 'req-ok', true);
    // Context cleaned up
    expect(state.activeRequests.has('req-ok')).toBe(false);
    // Key was succeeded
    expect(state.keys[0].consecutiveFailures).toBe(0);
  });

  it('completeRequest without success does not call markKeySucceeded', () => {
    const state = makeState();
    selectKeyForRequest(state, 'req-fail');
    markKeyFailed(state, 'alpha', 'ServerFault');
    const failuresBefore = state.keys[0].consecutiveFailures;

    completeRequest(state, 'req-fail', false);
    expect(state.activeRequests.has('req-fail')).toBe(false);
    expect(state.keys[0].consecutiveFailures).toBe(failuresBefore);
  });

  it('abandoned keys become available to other requests after failover', () => {
    const state = makeState();
    // Disable gamma so round-robin wraps back to alpha
    markKeyFailed(state, 'gamma', 'KeyFault');

    // Request A starts with alpha, fails over to beta
    selectKeyForRequest(state, 'req-A');
    failoverRequest(state, 'req-A'); // alpha → triedKeys, picks beta

    // Request B CAN get alpha — it's no longer in use by A
    const snapB = selectKeyForRequest(state, 'req-B');
    expect(snapB).not.toBeNull();
    expect(snapB!.label).toBe('alpha');
  });

  it('concurrent requests get different keys', () => {
    const state = makeState();

    const a = selectKeyForRequest(state, 'req-A');
    const b = selectKeyForRequest(state, 'req-B');
    const c = selectKeyForRequest(state, 'req-C');

    // All three should get different keys
    const labels = [a!.label, b!.label, c!.label];
    expect(new Set(labels).size).toBe(3);
  });

  it('failoverRequest returns null when all remaining keys are tried', () => {
    const state = makeState();

    selectKeyForRequest(state, 'req-failover');
    // alpha (current) → tried
    const second = failoverRequest(state, 'req-failover'); // beta is picked
    expect(second!.label).toBe('beta');
    // beta (current) → tried
    const third = failoverRequest(state, 'req-failover'); // gamma is picked
    expect(third!.label).toBe('gamma');
    // gamma (current) → tried — no more keys
    const fourth = failoverRequest(state, 'req-failover');
    expect(fourth).toBeNull();

    const ctx = state.activeRequests.get('req-failover')!;
    expect(ctx.triedKeys).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('Round-robin rotation', () => {
  it('selectKeyForRequest with unique requestIds rotates evenly through keys', () => {
    const state = makeState();
    expect(selectKeyForRequest(state, 'rr-1')!.label).toBe('alpha');
    expect(selectKeyForRequest(state, 'rr-2')!.label).toBe('beta');
    expect(selectKeyForRequest(state, 'rr-3')!.label).toBe('gamma');

    // Complete all so rr-4 can reuse keys
    completeRequest(state, 'rr-1', true);
    completeRequest(state, 'rr-2', true);
    completeRequest(state, 'rr-3', true);

    expect(selectKeyForRequest(state, 'rr-4')!.label).toBe('alpha'); // wraps around
    expect(selectKeyForRequest(state, 'rr-5')!.label).toBe('beta');
    expect(selectKeyForRequest(state, 'rr-6')!.label).toBe('gamma');
  });

  it('skips disabled keys during round-robin', () => {
    const state = makeState();
    markKeyFailed(state, 'beta', 'ServerFault');
    markKeyFailed(state, 'beta', 'ServerFault');
    markKeyFailed(state, 'beta', 'ServerFault'); // disabled

    const keys: string[] = [];
    for (let i = 0; i < 2; i++) {
      keys.push(selectKeyForRequest(state, `rr-${i}`)!.label);
    }
    // Complete all to free keys for next round
    completeRequest(state, 'rr-0', true);
    completeRequest(state, 'rr-1', true);
    for (let i = 2; i < 4; i++) {
      keys.push(selectKeyForRequest(state, `rr-${i}`)!.label);
    }
    // beta should never appear
    expect(keys.every((k) => k !== 'beta')).toBe(true);
    expect(keys).toEqual(['alpha', 'gamma', 'alpha', 'gamma']);
  });
});

describe('Key sharing when all keys are booked', () => {
  it('falls back to round-robin when all healthy keys are booked', () => {
    const state = makeState();

    // Book all 3 keys with concurrent requests
    const a = selectKeyForRequest(state, 'req-A'); // alpha
    const b = selectKeyForRequest(state, 'req-B'); // beta
    const c = selectKeyForRequest(state, 'req-C'); // gamma
    expect([a!.label, b!.label, c!.label].sort()).toEqual(['alpha', 'beta', 'gamma']);

    // 4th concurrent request should SHARE a key, not get null
    const d = selectKeyForRequest(state, 'req-D');
    expect(d).not.toBeNull();
    // Must be one of the healthy keys
    expect(['alpha', 'beta', 'gamma']).toContain(d!.label);
  });

  it('returns null when all keys are booked AND circuit-breaker disabled', () => {
    const state = makeState(1, 60_000);
    // Disable all keys
    markKeyFailed(state, 'alpha', 'ServerFault');
    markKeyFailed(state, 'beta', 'ServerFault');
    markKeyFailed(state, 'gamma', 'ServerFault');

    expect(selectKeyForRequest(state, 'req')).toBeNull();
  });

  it('failoverRequest shares a booked key when all remaining are booked', () => {
    const state = makeState();

    // req-A picks alpha, failovers to beta (alpha in triedKeys)
    selectKeyForRequest(state, 'req-A'); // alpha
    failoverRequest(state, 'req-A');     // → beta

    // req-B and req-C book the remaining keys
    selectKeyForRequest(state, 'req-B'); // picks gamma (beta booked by A)
    selectKeyForRequest(state, 'req-C'); // alpha is free now (A moved off it)
    // Now req-A fails beta → triedKeys = [alpha, beta]
    // gamma is booked by B, alpha is booked by C → tier 1 fails
    // Tier 2: only triedKeys excluded → gamma available (shared with B)
    const next = failoverRequest(state, 'req-A');
    expect(next).not.toBeNull();
    expect(['alpha', 'beta', 'gamma']).toContain(next!.label);
    // Must not be a key already tried by this request
    expect(next!.label).not.toBe('alpha');
    expect(next!.label).not.toBe('beta');
  });

  it('key sharing still respects per-request triedKeys', () => {
    const state = makeState();

    // req-A tries all 3 keys via failover
    selectKeyForRequest(state, 'req-A');   // alpha
    failoverRequest(state, 'req-A');       // → beta
    failoverRequest(state, 'req-A');       // → gamma

    // All keys tried — failover must return null even with sharing
    const exhausted = failoverRequest(state, 'req-A');
    expect(exhausted).toBeNull();
  });
});

describe('markKeySucceeded', () => {
  it('resets consecutive failures to 0', () => {
    const state = makeState();
    markKeyFailed(state, 'alpha', 'ServerFault');
    markKeyFailed(state, 'alpha', 'ServerFault');
    expect(state.keys[0].consecutiveFailures).toBe(2);

    markKeySucceeded(state, 'alpha');
    expect(state.keys[0].consecutiveFailures).toBe(0);
    // disabledAt cleared
    expect(state.keys[0].disabledAt).toBeNull();
  });

  it('no-op for unknown key', () => {
    const state = makeState();
    // Should not throw
    markKeySucceeded(state, 'nonexistent');
  });
});

describe('Edge cases', () => {
  it('all keys disabled returns null', () => {
    const state = makeState(1);
    markKeyFailed(state, 'alpha', 'ServerFault');
    markKeyFailed(state, 'beta', 'ServerFault');
    markKeyFailed(state, 'gamma', 'ServerFault');

    expect(selectKeyForRequest(state, 'req-empty')).toBeNull();
  });

  it('failoverRequest returns null for unknown request ID', () => {
    const state = makeState();
    expect(failoverRequest(state, 'unknown')).toBeNull();
  });

  it('completeRequest no-ops for unknown request ID', () => {
    const state = makeState();
    // Should not throw
    completeRequest(state, 'unknown', true);
    completeRequest(state, 'unknown', false);
  });

  it('markKeyFailed no-op for unknown key label', () => {
    const state = makeState();
    markKeyFailed(state, 'unknown', 'KeyFault');
    // No throw, state unchanged
    expect(state.keys).toHaveLength(3);
  });

  it('handles single key state', () => {
    const state = createProxyState([{ label: 'only', key: 'sk-only' }]);
    expect(selectKeyForRequest(state, 'req-only')!.label).toBe('only');

    markKeyFailed(state, 'only', 'KeyFault');
    expect(selectKeyForRequest(state, 'req-only2')).toBeNull();
  });

  it('duplicate request IDs reuse the same context', () => {
    const state = makeState();
    const a = selectKeyForRequest(state, 'dup');
    const b = selectKeyForRequest(state, 'dup');
    expect(a).toEqual(b);
  });

  it('per-request triedKeys still prevents re-selecting the same key within one request', () => {
    const state = makeState();

    // Request A fails through all keys — triedKeys per-request grows
    selectKeyForRequest(state, 'req-A');
    failoverRequest(state, 'req-A'); // alpha tried, picks beta
    failoverRequest(state, 'req-A'); // beta tried, picks gamma

    // Request B can still get alpha (not excluded globally anymore)
    const snapB = selectKeyForRequest(state, 'req-B');
    expect(snapB).not.toBeNull();
    expect(snapB!.label).toBe('alpha');

    // Request A's own failover still correctly excludes alpha and beta
    const snapA = failoverRequest(state, 'req-A'); // gamma tried
    expect(snapA).toBeNull(); // all three keys tried by A
  });

  it('does not lazily re-enable a disabled key whose disabledAt was cleared', () => {
    const state = makeState(1, 60_000);
    markKeyFailed(state, 'alpha', 'ServerFault'); // disabled + disabledAt set
    // Simulate a defensive edge: disabled key with no cooldown timestamp
    state.keys[0].disabledAt = null;

    // isKeyAvailable: enabled=false, disabledAt===null → NOT re-enabled
    const snap = selectKeyForRequest(state, 'req-cd-edge');
    expect(snap).not.toBeNull();
    expect(snap!.label).not.toBe('alpha');
    expect(state.keys[0].enabled).toBe(false);
  });
});

describe('Failover edge cases', () => {
  it('failoverRequest handles a request whose context has no current key', () => {
    const state = makeState(1, 60_000);
    markKeyFailed(state, 'alpha', 'ServerFault');
    markKeyFailed(state, 'beta', 'ServerFault');
    markKeyFailed(state, 'gamma', 'ServerFault');

    // All keys disabled → selectKeyForRequest creates the context but returns null
    expect(selectKeyForRequest(state, 'req-nokey')).toBeNull();
    // ctx exists with currentKey null → failover must not throw and returns null
    expect(failoverRequest(state, 'req-nokey')).toBeNull();
    expect(state.activeRequests.get('req-nokey')!.triedKeys).toEqual([]);
  });

  it('failoverRequest keeps a null current key when no keys are available', () => {
    const state = makeState(1, 60_000);
    markKeyFailed(state, 'alpha', 'KeyFault');

    selectKeyForRequest(state, 'req-nokey2'); // picks beta (alpha disabled)
    markKeyFailed(state, 'beta', 'KeyFault');
    const next = failoverRequest(state, 'req-nokey2');
    // gamma is still healthy → picked
    expect(next!.label).toBe('gamma');
  });
});
