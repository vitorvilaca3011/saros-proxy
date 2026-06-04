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
  reenableKey,
  isKeyDisabled,
  classifyHttpError,
  selectNextKey,
  type ProxyState,
  type ErrorType,
} from './proxy-logic';

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
    expect(selectNextKey(state)).toBeNull();
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

    // Before cooldown — selectNextKey should skip alpha (picks beta, index advances)
    const key1 = selectNextKey(state);
    expect(key1).not.toBeNull();
    expect(key1!.label).not.toBe('alpha');

    // Advance past cooldown
    advanceTime(60_001);

    // Alpha is past cooldown — isKeyDisabled should reflect that
    expect(isKeyDisabled(state, 'alpha')).toBe(false);

    // Run selectNextKey through the full cycle until alpha comes around
    // (gamma was next at index 2, then wraps to alpha at index 0)
    const key2 = selectNextKey(state);
    expect(key2!.label).toBe('gamma');
    const key3 = selectNextKey(state);
    expect(key3!.label).toBe('alpha');
    expect(state.keys[0].enabled).toBe(true);
    expect(state.keys[0].consecutiveFailures).toBe(0);
    expect(state.keys[0].disabledAt).toBeNull();
  });

  it('cooldown works with selectKeyForRequest as well', () => {
    const state = makeState(1, 60_000);
    freezeTime(1_000_000_000_000);

    markKeyFailed(state, 'alpha', 'ServerFault');
    expect(isKeyDisabled(state, 'alpha')).toBe(true);

    // Before cooldown — selectKeyForRequest picks beta (index advances)
    const snap1 = selectKeyForRequest(state, 'req-1');
    expect(snap1).not.toBeNull();
    expect(snap1!.label).not.toBe('alpha');

    // After cooldown — alpha is past cooldown
    advanceTime(60_001);
    expect(isKeyDisabled(state, 'alpha')).toBe(false);

    // Next request wraps through gamma then hits alpha
    const snap2 = selectKeyForRequest(state, 'req-2');
    expect(snap2!.label).toBe('gamma');
    const snap3 = selectKeyForRequest(state, 'req-3');
    expect(snap3!.label).toBe('alpha');
  });

  it('clear disabledAt on reenableKey', () => {
    const state = makeState(1);
    markKeyFailed(state, 'alpha', 'ServerFault');
    expect(state.keys[0].disabledAt).not.toBeNull();

    reenableKey(state, 'alpha');
    expect(state.keys[0].disabledAt).toBeNull();
    expect(state.keys[0].enabled).toBe(true);
    expect(state.keys[0].consecutiveFailures).toBe(0);
  });

  it('clears disabledAt on markKeySucceeded', () => {
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

  it('classifyHttpError returns KeyFault for 429', () => {
    expect(classifyHttpError(429)).toBe('KeyFault');
    expect(classifyHttpError(429, 'rate limited')).toBe('KeyFault');
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
});

describe('C3 – Read-only Snapshots', () => {
  it('selectNextKey returns KeySnapshot not ApiKey', () => {
    const state = makeState();
    const snap = selectNextKey(state);
    expect(snap).toEqual({ label: 'alpha', key: 'sk-a1' });
    // Verify it's a plain object, not the internal ApiKey
    expect(Object.keys(snap!).sort()).toEqual(['key', 'label']);
  });

  it('selectKeyForRequest returns KeySnapshot not ApiKey', () => {
    const state = makeState();
    const snap = selectKeyForRequest(state, 'req-1');
    expect(snap).toEqual({ label: 'alpha', key: 'sk-a1' });
    expect(Object.keys(snap!).sort()).toEqual(['key', 'label']);
  });

  it('mutating returned snapshot does not affect internal state', () => {
    const state = makeState();
    const snap = selectNextKey(state)!;
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

  it('selectKeyForRequest excludes keys tried by other active requests', () => {
    const state = makeState();

    // Request A starts with alpha, fails over to beta
    selectKeyForRequest(state, 'req-A');
    failoverRequest(state, 'req-A'); // alpha → triedKeys, picks beta

    // Request B should not get alpha (in req-A's triedKeys)
    const snapB = selectKeyForRequest(state, 'req-B');
    expect(snapB).not.toBeNull();
    expect(snapB!.label).not.toBe('alpha');
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
  it('selectNextKey rotates evenly through keys', () => {
    const state = makeState();
    expect(selectNextKey(state)!.label).toBe('alpha');
    expect(selectNextKey(state)!.label).toBe('beta');
    expect(selectNextKey(state)!.label).toBe('gamma');
    expect(selectNextKey(state)!.label).toBe('alpha'); // wraps around
    expect(selectNextKey(state)!.label).toBe('beta');
    expect(selectNextKey(state)!.label).toBe('gamma');
  });

  it('selectKeyForRequest rotates when called with different requestIds', () => {
    const state = makeState();
    expect(selectKeyForRequest(state, 'r1')!.label).toBe('alpha');
    expect(selectKeyForRequest(state, 'r2')!.label).toBe('beta');
    expect(selectKeyForRequest(state, 'r3')!.label).toBe('gamma');
    expect(selectKeyForRequest(state, 'r4')!.label).toBe('alpha');
  });

  it('skips disabled keys during round-robin', () => {
    const state = makeState();
    markKeyFailed(state, 'beta', 'ServerFault');
    markKeyFailed(state, 'beta', 'ServerFault');
    markKeyFailed(state, 'beta', 'ServerFault'); // disabled

    const keys: string[] = [];
    for (let i = 0; i < 4; i++) {
      keys.push(selectNextKey(state)!.label);
    }
    // beta should never appear
    expect(keys.every((k) => k !== 'beta')).toBe(true);
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

describe('reenableKey', () => {
  it('re-enables a disabled key', () => {
    const state = makeState(1);
    markKeyFailed(state, 'alpha', 'ServerFault');
    expect(state.keys[0].enabled).toBe(false);

    reenableKey(state, 'alpha');
    expect(state.keys[0].enabled).toBe(true);
    expect(state.keys[0].consecutiveFailures).toBe(0);
    expect(state.keys[0].disabledAt).toBeNull();
  });

  it('no-op for unknown key', () => {
    const state = makeState();
    reenableKey(state, 'unknown');
    // No throw
  });
});

describe('isKeyDisabled', () => {
  beforeEach(() => {
    freezeTime(1_000_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true for nonexistent key', () => {
    expect(isKeyDisabled(makeState(), 'nope')).toBe(true);
  });

  it('returns false initially', () => {
    const state = makeState();
    expect(isKeyDisabled(state, 'alpha')).toBe(false);
    expect(isKeyDisabled(state, 'beta')).toBe(false);
  });

  it('returns true when threshold reached', () => {
    const state = makeState(2);
    markKeyFailed(state, 'alpha', 'ServerFault');
    expect(isKeyDisabled(state, 'alpha')).toBe(false);
    markKeyFailed(state, 'alpha', 'ServerFault');
    expect(isKeyDisabled(state, 'alpha')).toBe(true);
  });

  it('returns false after cooldown has passed', () => {
    const state = makeState(1, 60_000);
    markKeyFailed(state, 'alpha', 'ServerFault');
    expect(isKeyDisabled(state, 'alpha')).toBe(true);

    advanceTime(60_001);
    expect(isKeyDisabled(state, 'alpha')).toBe(false);
  });
});

describe('Edge cases', () => {
  it('all keys disabled returns null', () => {
    const state = makeState(1);
    markKeyFailed(state, 'alpha', 'ServerFault');
    markKeyFailed(state, 'beta', 'ServerFault');
    markKeyFailed(state, 'gamma', 'ServerFault');

    expect(selectNextKey(state)).toBeNull();
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
    expect(selectNextKey(state)!.label).toBe('only');
    expect(selectNextKey(state)!.label).toBe('only'); // wraps back

    markKeyFailed(state, 'only', 'KeyFault');
    expect(selectNextKey(state)).toBeNull();
  });

  it('duplicate request IDs reuse the same context', () => {
    const state = makeState();
    const a = selectKeyForRequest(state, 'dup');
    const b = selectKeyForRequest(state, 'dup');
    expect(a).toEqual(b);
  });

  it('tried key exclusion works with duplicate keys across requests', () => {
    const state = makeState();

    // Request A fails alpha, so alpha is in A's triedKeys
    selectKeyForRequest(state, 'req-A');
    failoverRequest(state, 'req-A'); // alpha tried, picks beta

    // Request B should not get alpha (it's in req-A's triedKeys)
    selectKeyForRequest(state, 'req-B');
    const failB = failoverRequest(state, 'req-B'); // beta tried

    // After failover, req-B should still avoid alpha (in req-A's triedKeys)
    if (failB) {
      expect(failB.label).not.toBe('alpha');
    }
  });
});
