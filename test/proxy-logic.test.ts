/**
 * proxy-logic.test.ts — Comprehensive unit tests for the proxy logic module.
 *
 * Vitest-based; run with: npx vitest run test/proxy-logic.test.ts
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
  describeKeys,
  keyRetryAfterMs,
  setKeyEntitlement,
  updateKeyUsage,
  type ProxyState,
  type ErrorType,
} from '../src/proxy-logic.js';
import { parseOpencodeUsage } from '../src/providers/opencode-go.js';
import { parseCommandcodeUsage } from '../src/providers/commandcode.js';

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

  it('re-enables a key that succeeded after being disabled', () => {
    const state = makeState(1);
    markKeyFailed(state, 'alpha', 'KeyFault');
    expect(state.keys[0].enabled).toBe(false);

    markKeySucceeded(state, 'alpha');

    expect(state.keys[0].enabled).toBe(true);
    expect(state.keys[0].disabledAt).toBeNull();
    expect(selectKeyForRequest(state, 'req-after-success')!.label).toBe('alpha');
  });

  it('does not strand a shared key when one request fails and another succeeds', () => {
    // Tier 2 shares the only key between concurrent requests; one 401s while
    // the other gets a 200. Before the fix the success left
    // enabled=false / disabledAt=null, so the key was never selectable again.
    const state = createProxyState([{ label: 'solo', key: 'sk-solo-000001' }], {
      circuitBreakerThreshold: 1,
      circuitBreakerCooldownMs: 60_000,
    });
    expect(selectKeyForRequest(state, 'stream-a')!.label).toBe('solo');
    expect(selectKeyForRequest(state, 'stream-b')!.label).toBe('solo');

    markKeyFailed(state, 'solo', 'KeyFault');
    markKeySucceeded(state, 'solo');

    expect(selectKeyForRequest(state, 'stream-c')?.label).toBe('solo');
  });
});

describe('key failure reporting', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records the upstream status and reason of the last failure', () => {
    const state = makeState(1);
    freezeTime(1_000_000_000_000);

    markKeyFailed(state, 'alpha', 'KeyFault', { status: 401, body: 'invalid key' });

    expect(state.keys[0].lastError).toMatchObject({
      status: 401,
      reason: 'auth',
      at: 1_000_000_000_000,
    });
  });

  it('classifies quota, rate-limit and server failures', () => {
    const state = makeState(1);

    markKeyFailed(state, 'alpha', 'KeyFault', { status: 502, body: 'insufficient balance' });
    markKeyFailed(state, 'beta', 'ServerFault', { status: 429 });
    markKeyFailed(state, 'gamma', 'ServerFault', { status: 503 });

    expect(state.keys[0].lastError?.reason).toBe('quota');
    expect(state.keys[1].lastError?.reason).toBe('rate_limit');
    expect(state.keys[2].lastError?.reason).toBe('server');
  });

  it('labels a rate-limited 5xx as rate_limit, not quota', () => {
    const state = makeState(1);
    // classifyHttpError sees "limit" in the body and calls it KeyFault; the
    // reason must still be the rate limit, not a quota wall.
    markKeyFailed(state, 'alpha', 'KeyFault', { status: 503, body: 'rate limit exceeded, retry later' });
    expect(state.keys[0].lastError?.reason).toBe('rate_limit');
  });

  it('still calls a quota wall a quota wall', () => {
    const state = makeState(1);
    markKeyFailed(state, 'alpha', 'KeyFault', { status: 503, body: 'insufficient balance' });
    expect(state.keys[0].lastError?.reason).toBe('quota');
  });

  it('redacts credentials that the upstream echoed back', () => {
    const state = makeState(1);
    markKeyFailed(state, 'alpha', 'KeyFault', {
      status: 401,
      body: '{"error":"Incorrect API key provided: sk-leaked-key-abcdef123456"}',
    });
    expect(state.keys[0].lastError?.detail).not.toContain('sk-leaked-key-abcdef123456');
    expect(state.keys[0].lastError?.detail).toContain('[redacted-key]');
  });

  it('keeps the last error after a success but clears the disable', () => {
    const state = makeState(1);
    markKeyFailed(state, 'alpha', 'KeyFault', { status: 401 });

    markKeySucceeded(state, 'alpha');

    expect(state.keys[0].enabled).toBe(true);
    expect(state.keys[0].lastError?.reason).toBe('auth');
  });

  it('reports retryAfterMs only while the key is cooling down', () => {
    const state = makeState(1, 60_000);
    freezeTime(1_000_000_000_000);
    markKeyFailed(state, 'alpha', 'KeyFault', { status: 401 });

    expect(keyRetryAfterMs(state, state.keys[0])).toBe(60_000);
    advanceTime(45_000);
    expect(keyRetryAfterMs(state, state.keys[0])).toBe(15_000);
    advanceTime(15_000);
    expect(keyRetryAfterMs(state, state.keys[0])).toBe(0);
  });

  it('returns null for a key that is enabled but over the failure threshold', () => {
    const state = makeState(2);
    expect(
      keyRetryAfterMs(state, { enabled: true, consecutiveFailures: 2, disabledAt: null }),
    ).toBeNull();
  });

  it('describes keys without exposing the credential', () => {
    const state = makeState(1);
    markKeyFailed(state, 'alpha', 'KeyFault', { status: 401 });

    const [alpha] = describeKeys(state);

    expect(alpha).toMatchObject({
      label: 'alpha',
      provider: 'opencode-go',
      enabled: false,
      entitled: true,
    });
    expect(alpha.lastError?.reason).toBe('auth');
    expect(JSON.stringify(describeKeys(state))).not.toContain('sk-a1');
  });
});

describe('config-disabled keys', () => {
  it('never selects a key marked enabled: false', () => {
    const state = createProxyState([
      { label: 'retired', key: 'sk-retired-000001', enabled: false },
      { label: 'live', key: 'sk-live-00000001' },
    ]);

    expect(state.keys[0].enabled).toBe(false);
    expect(state.keys[0].disabledByConfig).toBe(true);

    const picked = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const snap = selectKeyForRequest(state, `cfg-${i}`);
      if (snap) picked.add(snap.label);
    }
    expect([...picked]).toEqual(['live']);
  });

  it('returns no key when the only key is disabled by config', () => {
    const state = createProxyState([
      { label: 'retired', key: 'sk-retired-000001', enabled: false },
    ]);
    expect(selectKeyForRequest(state, 'cfg-only')).toBeNull();
    // Never selected means never penalised.
    expect(state.keys[0].consecutiveFailures).toBe(0);
    expect(state.keys[0].lastError).toBeNull();
  });

  it('is not revived by a success and reports where the disable came from', () => {
    const state = createProxyState([
      { label: 'retired', key: 'sk-retired-000001', enabled: false },
    ]);

    markKeySucceeded(state, 'retired');

    expect(state.keys[0].enabled).toBe(false);
    expect(describeKeys(state)[0]).toMatchObject({
      enabled: false,
      disabledByConfig: true,
    });
  });
});

describe('C2 – Error Classification', () => {
  it('classifyHttpError returns KeyFault for 401', () => {
    expect(classifyHttpError(401)).toBe('KeyFault');
    expect(classifyHttpError(401, 'invalid key')).toBe('KeyFault');
  });

  it('classifyHttpError returns RequestFault for 401 model-unknown errors', () => {
    // opencode-go returns 401 with ModelError for models it does not serve;
    // punishing that as a key fault would disable the whole pool on rotation.
    expect(
      classifyHttpError(401, '{"error":{"type":"ModelError","message":"Model gpt-5.5 is not supported"}}'),
    ).toBe('RequestFault');
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
    // 403 = permission denial (e.g. MODEL_NOT_IN_PLAN) — the key is fine
    expect(classifyHttpError(403)).toBe('RequestFault');
    expect(classifyHttpError(404)).toBe('RequestFault');
    expect(classifyHttpError(422)).toBe('RequestFault');
  });

  it('classifyHttpError returns ServerFault for other codes', () => {
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
    expect(snap).toEqual({ label: 'alpha', key: 'sk-a1', provider: 'opencode-go' });
    expect(Object.keys(snap!).sort()).toEqual(['key', 'label', 'provider']);
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
    expect(Object.keys(failSnap!).sort()).toEqual(['key', 'label', 'provider']);
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
    expect(snap).toEqual({ label: 'alpha', key: 'sk-a1', provider: 'opencode-go' });

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

// ---------------------------------------------------------------------------
// Usage-Weighted Rotation
// ---------------------------------------------------------------------------

describe('updateKeyUsage + weighted selection', () => {
  it('distributes requests proportionally to remaining monthly quota (30/70 → 7/3)', () => {
    const state = makeState();
    // alpha: 30% of the month used, beta: 70%; gamma: no usage data
    updateKeyUsage(state, new Map([
      ['alpha', { usedPercent: 30, exhausted: false }],
      ['beta', { usedPercent: 70, exhausted: false }],
    ]));

    const counts: Record<string, number> = { alpha: 0, beta: 0, gamma: 0 };
    for (let i = 0; i < 10; i++) {
      const key = selectKeyForRequest(state, `req-${i}`)!;
      completeRequest(state, `req-${i}`, true);
      counts[key.label]++;
    }
    // gamma has no usage data → neutral median weight, still weighted overall
    expect(counts).toEqual({ alpha: 4, beta: 2, gamma: 4 });
  });

  it('distributes exactly 7/3 when only two keys exist', () => {
    const state = createProxyState(
      [{ label: 'x', key: 'sk-x' }, { label: 'y', key: 'sk-y' }],
    );
    updateKeyUsage(state, new Map([
      ['x', { usedPercent: 30, exhausted: false }],
      ['y', { usedPercent: 70, exhausted: false }],
    ]));

    const counts: Record<string, number> = { x: 0, y: 0 };
    for (let i = 0; i < 10; i++) {
      const key = selectKeyForRequest(state, `req-${i}`)!;
      completeRequest(state, `req-${i}`, true);
      counts[key.label]++;
    }
    expect(counts).toEqual({ x: 7, y: 3 });
  });

  it('falls back to even round-robin without usage data', () => {
    const state = createProxyState(
      [{ label: 'x', key: 'sk-x' }, { label: 'y', key: 'sk-y' }],
    );
    const counts: Record<string, number> = { x: 0, y: 0 };
    for (let i = 0; i < 10; i++) {
      const key = selectKeyForRequest(state, `req-${i}`)!;
      completeRequest(state, `req-${i}`, true);
      counts[key.label]++;
    }
    expect(counts).toEqual({ x: 5, y: 5 });
  });

  it('falls back to even round-robin when every key is exhausted', () => {
    const state = createProxyState(
      [{ label: 'x', key: 'sk-x' }, { label: 'y', key: 'sk-y' }],
    );
    updateKeyUsage(state, new Map([
      ['x', { usedPercent: 100, exhausted: true }],
      ['y', { usedPercent: 100, exhausted: true }],
    ]));
    const counts: Record<string, number> = { x: 0, y: 0 };
    for (let i = 0; i < 10; i++) {
      const key = selectKeyForRequest(state, `req-${i}`)!;
      completeRequest(state, `req-${i}`, true);
      counts[key.label]++;
    }
    expect(counts).toEqual({ x: 5, y: 5 });
  });

  it('adapts when usage changes between selections', () => {
    const state = createProxyState(
      [{ label: 'x', key: 'sk-x' }, { label: 'y', key: 'sk-y' }],
    );
    updateKeyUsage(state, new Map([
      ['x', { usedPercent: 10, exhausted: false }],
      ['y', { usedPercent: 90, exhausted: false }],
    ]));
    const first = selectKeyForRequest(state, 'a')!;
    completeRequest(state, 'a', true);
    expect(first.label).toBe('x');

    // y frees up, x fills up — next pick flips
    updateKeyUsage(state, new Map([
      ['x', { usedPercent: 95, exhausted: false }],
      ['y', { usedPercent: 10, exhausted: false }],
    ]));
    const second = selectKeyForRequest(state, 'b')!;
    completeRequest(state, 'b', true);
    expect(second.label).toBe('y');
  });

  it('never selects a key with a spent window over one with room', () => {
    const state = createProxyState(
      [{ label: 'x', key: 'sk-x' }, { label: 'y', key: 'sk-y' }],
    );
    updateKeyUsage(state, new Map([
      ['x', { usedPercent: 100, exhausted: true }],
      ['y', { usedPercent: 20, exhausted: false }],
    ]));
    for (let i = 0; i < 6; i++) {
      const key = selectKeyForRequest(state, `req-${i}`)!;
      completeRequest(state, `req-${i}`, true);
      expect(key.label).toBe('y');
    }
  });
});

// Real payload shapes: the numbers below come out of the provider parsers,
// not hand-written percentages, so a unit change in a parser breaks rotation.
const OPENCODE_NORMAL_BODY = JSON.stringify({
  usage: { rolling: { percent: 5 }, weekly: { percent: 10 }, monthly: { percent: 20 } },
});
const OPENCODE_SPENT_WEEKLY_BODY = JSON.stringify({
  usage: { rolling: { percent: 0 }, weekly: { percent: 100 }, monthly: { percent: 50 } },
});
// Monthly cap = 2 × weekly.cap = 70; monthlyCredits 21 → 49/70 = 70% used.
const COMMANDCODE_70_BODY = JSON.stringify({
  credits: { monthlyCredits: 21 },
  windowLimits: { fiveHour: { used: 1, cap: 14 }, weekly: { used: 2, cap: 35 } },
});

/** Run `rounds` picks, completing each, and count selections per label. */
function countSelections(state: ProxyState, rounds: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of state.keys) counts[key.label] = 0;
  for (let i = 0; i < rounds; i++) {
    const picked = selectKeyForRequest(state, `req-${i}`);
    expect(picked).not.toBeNull();
    completeRequest(state, `req-${i}`, true);
    counts[picked!.label]++;
  }
  return counts;
}

describe('weighted selection fed by the provider usage parsers', () => {
  it('rotates by the monthly parser outputs, not by other windows', () => {
    const opencode = parseOpencodeUsage(OPENCODE_NORMAL_BODY);
    const commandcode = parseCommandcodeUsage(COMMANDCODE_70_BODY);
    // opencode-go monthly: 20%. commandcode monthly: (70 − 21)/70 = 70%.
    expect(opencode).not.toBeNull();
    expect(opencode!.usedPercent).toBe(20);
    expect(opencode!.exhausted).toBe(false);
    expect(commandcode).not.toBeNull();
    expect(commandcode!.usedPercent).toBeCloseTo(70, 10);
    expect(commandcode!.exhausted).toBe(false);

    const state = createProxyState([
      { label: 'oc', key: 'oc_sk_' + 'a'.repeat(40) },
      { label: 'cc', key: 'user_' + 'a'.repeat(40) },
    ]);
    updateKeyUsage(state, new Map([
      ['oc', { usedPercent: opencode!.usedPercent, exhausted: opencode!.exhausted }],
      ['cc', { usedPercent: commandcode!.usedPercent, exhausted: commandcode!.exhausted }],
    ]));

    // Remaining monthly weights are 80 and 30 → 7.27/2.73 over 10 picks.
    expect(countSelections(state, 10)).toEqual({ oc: 7, cc: 3 });
  });

  it('gives a key without usage the median weight when the others come from parsers', () => {
    const opencode = parseOpencodeUsage(OPENCODE_NORMAL_BODY)!;
    const commandcode = parseCommandcodeUsage(COMMANDCODE_70_BODY)!;
    const state = createProxyState([
      { label: 'oc', key: 'oc_sk_' + 'a'.repeat(40) },
      { label: 'cc', key: 'user_' + 'a'.repeat(40) },
      { label: 'spare', key: 'sk-spare' },
    ]);
    updateKeyUsage(state, new Map([
      ['oc', { usedPercent: opencode.usedPercent, exhausted: opencode.exhausted }],
      ['cc', { usedPercent: commandcode.usedPercent, exhausted: commandcode.exhausted }],
    ]));

    // Remaining weights: oc 80, cc 30 → median 80 for the key with no data.
    expect(countSelections(state, 10)).toEqual({ oc: 4, cc: 2, spare: 4 });
  });

  it('never selects a key whose weekly window is spent, even with 50% of the month left', () => {
    const spent = parseOpencodeUsage(OPENCODE_SPENT_WEEKLY_BODY)!;
    const opencode = parseOpencodeUsage(OPENCODE_NORMAL_BODY)!;
    expect(spent.usedPercent).toBe(50);
    expect(spent.exhausted).toBe(true);

    const state = createProxyState([
      { label: 'spent', key: 'oc_sk_' + 'a'.repeat(40) },
      { label: 'oc', key: 'oc_sk_' + 'b'.repeat(40) },
    ]);
    updateKeyUsage(state, new Map([
      ['spent', { usedPercent: spent.usedPercent, exhausted: spent.exhausted }],
      ['oc', { usedPercent: opencode.usedPercent, exhausted: opencode.exhausted }],
    ]));

    const counts = countSelections(state, 10);
    expect(counts.spent).toBe(0);
    expect(counts.oc).toBe(10);
  });

  it('clamps window and monthly ratios to 100, never above', () => {
    const windowOverCap = parseCommandcodeUsage(JSON.stringify({
      windowLimits: { fiveHour: { used: 20, cap: 14 } },
    }));
    expect(windowOverCap?.rollingPercent).toBe(100);
    expect(windowOverCap?.rollingPercent).toBeLessThanOrEqual(100);
    expect(windowOverCap?.exhausted).toBe(true);

    const creditsOverdrawn = parseCommandcodeUsage(
      '{"credits":{"monthlyCredits":-10},"windowLimits":{"weekly":{"cap":35}}}',
    );
    expect(creditsOverdrawn?.monthlyPercent).toBe(100);
    expect(creditsOverdrawn?.usedPercent).toBe(100);
    expect(creditsOverdrawn?.exhausted).toBe(true);
  });
});

describe('weighted selection with exhausted keys and missing usage data', () => {
  function pool(labels: string[]): ProxyState {
    return createProxyState(labels.map((label) => ({ label, key: `sk-${label}` })));
  }

  it('never routes to an exhausted key beside a key without usage data (2-key pool)', () => {
    const state = pool(['exh', 'new']);
    updateKeyUsage(state, new Map([
      ['exh', { usedPercent: 50, exhausted: true }],
    ]));

    expect(countSelections(state, 10)).toEqual({ exh: 0, new: 10 });
  });

  it('never routes to two exhausted keys beside a key without usage data (3-key pool)', () => {
    const state = pool(['exh1', 'exh2', 'new']);
    updateKeyUsage(state, new Map([
      ['exh1', { usedPercent: 90, exhausted: true }],
      ['exh2', { usedPercent: 10, exhausted: true }],
    ]));

    expect(countSelections(state, 10)).toEqual({ exh1: 0, exh2: 0, new: 10 });
  });

  it('does not let exhausted zeros drag the neutral weight to zero', () => {
    const state = pool(['exh1', 'exh2', 'near', 'new']);
    updateKeyUsage(state, new Map([
      ['exh1', { usedPercent: 100, exhausted: true }],
      ['exh2', { usedPercent: 100, exhausted: true }],
      ['near', { usedPercent: 95, exhausted: false }],
    ]));

    // Without the fix the median of [0, 0, 5] was 0 and 'new' starved.
    expect(countSelections(state, 10)).toEqual({ exh1: 0, exh2: 0, near: 5, new: 5 });
  });

  it('clears residual weight when a key becomes exhausted', () => {
    const state = pool(['x', 'y']);
    updateKeyUsage(state, new Map([
      ['x', { usedPercent: 50, exhausted: false }],
      ['y', { usedPercent: 50, exhausted: false }],
    ]));

    // Equal weights: x wins the first pick, leaving y with +50 momentum.
    const first = selectKeyForRequest(state, 'warmup')!;
    completeRequest(state, 'warmup', true);
    expect(first.label).toBe('x');
    const y = state.keys.find((k) => k.label === 'y')!;
    expect(y.currentWeight).toBeGreaterThan(0);

    updateKeyUsage(state, new Map([
      ['y', { usedPercent: 50, exhausted: true }],
    ]));
    expect(countSelections(state, 10)).toEqual({ x: 10, y: 0 });
    expect(y.currentWeight).toBe(0);
  });

  it('defers an exhausted key to Tier 2 when the healthy key is booked', () => {
    const state = pool(['H', 'E']);
    updateKeyUsage(state, new Map([
      ['H', { usedPercent: 10, exhausted: false }],
      ['E', { usedPercent: 50, exhausted: true }],
    ]));

    expect(selectKeyForRequest(state, 'r1')?.label).toBe('H');
    // r1 never completed, so H is booked. Tier 1 must not hand out E just
    // because it is the only unbooked candidate.
    expect(selectKeyForRequest(state, 'r2')?.label).toBe('H');
  });

  it('failover does not hand out an exhausted key when a booked key is healthy', () => {
    const state = pool(['H', 'G', 'E']);
    updateKeyUsage(state, new Map([
      ['H', { usedPercent: 10, exhausted: false }],
      ['G', { usedPercent: 10, exhausted: false }],
      ['E', { usedPercent: 50, exhausted: true }],
    ]));

    expect(selectKeyForRequest(state, 'r1')?.label).toBe('H');
    expect(selectKeyForRequest(state, 'r2')?.label).toBe('G');
    // H failed on r1 and G is booked by r2, so Tier 1 sees only E.
    expect(failoverRequest(state, 'r1')?.label).toBe('G');
  });

  it('keeps the previous monthly percent when a snapshot has no monthly metric', () => {
    const state = pool(['x']);
    updateKeyUsage(state, new Map([['x', { usedPercent: 80, exhausted: false }]]));

    updateKeyUsage(state, new Map([['x', { usedPercent: null, exhausted: true }]]));

    const x = state.keys[0];
    expect(x.usagePercent).toBe(80);
    expect(x.exhausted).toBe(true);
  });
});

describe('setKeyEntitlement (no plan for the provider)', () => {
  it('keeps an unentitled key out of rotation without tripping the breaker', () => {
    const state = createProxyState(
      [{ label: 'x', key: 'sk-x' }, { label: 'y', key: 'sk-y' }],
    );
    setKeyEntitlement(state, 'x', false);

    for (let i = 0; i < 4; i++) {
      const key = selectKeyForRequest(state, `req-${i}`)!;
      completeRequest(state, `req-${i}`, true);
      expect(key.label).toBe('y');
    }
    // The excluded key is untouched by the circuit breaker.
    const x = state.keys.find((k) => k.label === 'x')!;
    expect(x.enabled).toBe(true);
    expect(x.consecutiveFailures).toBe(0);
  });

  it('serves nothing when every key lacks a plan, and recovers when one returns', () => {
    const state = createProxyState([{ label: 'x', key: 'sk-x' }]);
    setKeyEntitlement(state, 'x', false);
    expect(selectKeyForRequest(state, 'req-0')).toBeNull();

    setKeyEntitlement(state, 'x', true);
    expect(selectKeyForRequest(state, 'req-1')?.label).toBe('x');
  });
});

describe('NetworkFault handling', () => {
  it('does not disable keys or increment failures', () => {
    const state = makeState(1, 60_000);
    markKeyFailed(state, 'alpha', 'NetworkFault');
    markKeyFailed(state, 'alpha', 'NetworkFault');
    markKeyFailed(state, 'alpha', 'NetworkFault');

    const alpha = state.keys.find((k) => k.label === 'alpha')!;
    expect(alpha.enabled).toBe(true);
    expect(alpha.consecutiveFailures).toBe(0);
    expect(selectKeyForRequest(state, 'req-net')!.label).toBe('alpha');
  });

  it('keeps rotating after repeated timeout storms on every key', () => {
    const state = makeState(1, 60_000);
    for (let i = 0; i < 20; i++) {
      const key = selectKeyForRequest(state, `req-${i}`)!;
      markKeyFailed(state, key.label, 'NetworkFault');
      failoverRequest(state, `req-${i}`);
      completeRequest(state, `req-${i}`, false);
    }
    for (const k of state.keys) {
      expect(k.enabled).toBe(true);
      expect(k.consecutiveFailures).toBe(0);
    }
    // Selection still works — no blackout
    expect(selectKeyForRequest(state, 'after-storm')).not.toBeNull();
  });
});
