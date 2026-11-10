/**
 * usage-client.test.ts — Tests for the per-key usage API client and the
 * stale-while-revalidate coordinator.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  effectiveMonthlyPercent,
  fetchKeyUsage,
  maybeRefreshUsage,
  resetUsageRefreshState,
} from '../src/usage-client.js';
import { commandcodeProvider, opencodeGoProvider } from '../src/providers/index.js';
import {
  completeRequest,
  createProxyState,
  rotationWeight,
  selectKeyForRequest,
  type ProxyState,
} from '../src/proxy-logic.js';
import type { ProxyConfig } from '../src/config.js';

const VALID_BODY = JSON.stringify({
  usage: {
    rolling: { status: 'ok', percent: 12, resetsAt: '2026-08-22T19:00:00Z' },
    weekly: { status: 'ok', percent: 44, resetsAt: '2026-08-24T00:00:00Z' },
    monthly: { status: 'ok', percent: 92, resetsAt: '2026-08-27T00:00:00Z' },
  },
});

/** Real /alpha/billing/credits payload, measured 2026-11-05. */
const CREDITS_BODY = JSON.stringify({
  credits: { monthlyCredits: 62.1003565047, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    fiveHour: { used: 0.3212, cap: 14, exceeded: false, resetAt: 1793914043720 },
    weekly: { used: 4.2736, cap: 35, exceeded: false, resetAt: 1794307589031 },
  },
});

/** Deterministic macrotask boundary so fire-and-forget refreshes settle. */
function settleMacrotasks(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/** Deterministic weighted-selection counts over `rounds` requests. */
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

function makeConfig(): ProxyConfig {
  return {
    port: 3000,
    host: '127.0.0.1',
    keys: [{ label: 'k1', key: 'sk-test' }],
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
    upstreamBaseUrl: 'https://example.com',
    requestTimeoutMs: 5_000,
    allowedOrigins: [],
  };
}

describe('effectiveMonthlyPercent', () => {
  it('takes the tightest window after scaling it to the monthly allowance', () => {
    // The bug: monthly says 10%, but the weekly window (50% of the month) is
    // at 99% of its own allowance → 49.5% of the month is effectively gone.
    expect(effectiveMonthlyPercent(0, 99, 10)).toBe(49.5);
    // Monthly dominates when the shorter windows are quiet.
    expect(effectiveMonthlyPercent(0, 2, 28)).toBe(28);
    // The 5-hour window (20% of the month) at 100% is 20% of the month.
    expect(effectiveMonthlyPercent(100, 0, 10)).toBe(20);
  });
});

describe('fetchKeyUsage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns parsed usage on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(VALID_BODY, { status: 200 }));
    const result = await fetchKeyUsage('https://example.com', 'sk-test');
    expect(result.usage?.usedPercent).toBe(92);
    expect(result.usage?.exhausted).toBe(false);
    expect(result.noEntitlement).toBe(false);
  });

  it('returns no usage on non-200, network error, or contract violation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(fetchKeyUsage('https://example.com', 'sk')).resolves.toEqual({ usage: null, noEntitlement: false });

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await expect(fetchKeyUsage('https://example.com', 'sk')).resolves.toEqual({ usage: null, noEntitlement: false });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(fetchKeyUsage('https://example.com', 'sk')).resolves.toEqual({ usage: null, noEntitlement: false });
  });

  it('flags a 403 entitlement rejection but not a plan-gated model', async () => {
    // opencode-go: account without a Go subscription
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ type: 'error', error: { type: 'EntitlementError', message: 'OpenCode Go subscription required.' } }),
      { status: 403 },
    ));
    await expect(fetchKeyUsage('https://example.com', 'sk')).resolves.toEqual({
      usage: null,
      noEntitlement: true,
    });

    // commandcode: Go plan has no API access
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":{"code":"upgrade_required"}}', { status: 403 }),
    );
    await expect(fetchKeyUsage('https://example.com', 'sk')).resolves.toMatchObject({ noEntitlement: true });

    // A model gated by the plan is a request problem, not an account one.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":{"code":"MODEL_NOT_IN_PLAN"}}', { status: 403 }),
    );
    await expect(fetchKeyUsage('https://example.com', 'sk')).resolves.toEqual({ usage: null, noEntitlement: false });
  });

  it('sends the key as Bearer and hits the usage path', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(VALID_BODY, { status: 200 }));
    await fetchKeyUsage('https://example.com', 'sk-abc');
    expect(String(spy.mock.calls[0][0])).toBe('https://example.com/zen/go/v1/usage');
    expect((spy.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer sk-abc',
    });
  });

  it('sends the provider identity headers to the CommandCode credits endpoint', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(CREDITS_BODY, { status: 200 }));

    const result = await fetchKeyUsage(
      'https://api.commandcode.ai',
      'user_abc',
      commandcodeProvider,
    );

    expect(String(spy.mock.calls[0][0])).toBe('https://api.commandcode.ai/alpha/billing/credits');
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    // Without the CLI identity Cloudflare answers 403 on this route.
    expect(headers['User-Agent']).toMatch(/^CommandCodeCLI\/\d+\.\d+\.\d+$/);
    expect(headers['X-CommandCode-Client']).toBe('cli');
    expect(headers.Authorization).toBe('Bearer user_abc');
    expect(headers.Accept).toBe('application/json');
    expect(result.usage?.weeklyPercent).toBeCloseTo(12.210285714, 6);
    // Monthly is derived: (2 × 35 − 62.1003565047) / 70.
    expect(result.usage?.monthlyPercent).toBeCloseTo(11.285204993, 6);
    expect(result.usage?.usedPercent).toBe(result.usage?.monthlyPercent);
  });

  it('sends the opencode-go CLI User-Agent so Cloudflare does not reject the probe', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(VALID_BODY, { status: 200 }));

    await fetchKeyUsage('https://opencode.ai', 'oc_sk_test', opencodeGoProvider);

    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('cli');
  });

  it('skips providers with no usage endpoint without calling fetch', async () => {
    const noUsage = { ...opencodeGoProvider, usagePath: () => '' };
    const spy = vi.spyOn(globalThis, 'fetch');

    await expect(fetchKeyUsage('https://example.com', 'sk', noUsage)).resolves.toEqual({
      usage: null,
      noEntitlement: false,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('treats a throwing provider parser as a failed parse', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const broken = {
      ...opencodeGoProvider,
      parseUsageResponse: () => {
        throw new Error('bad contract');
      },
    };

    await expect(fetchKeyUsage('https://example.com', 'sk', broken)).resolves.toEqual({
      usage: null,
      noEntitlement: false,
    });
  });
});

describe('maybeRefreshUsage', () => {
  beforeEach(() => resetUsageRefreshState());
  afterEach(() => {
    resetUsageRefreshState();
    vi.restoreAllMocks();
  });

  function makeState(): ProxyState {
    return createProxyState([
      { label: 'a', key: 'sk-a' },
      { label: 'b', key: 'sk-b' },
    ]);
  }

  function mockPerKeyFetch() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const auth = (init as RequestInit).headers as Record<string, string>;
      const percent = auth.Authorization.includes('sk-a') ? 30 : 70;
      return new Response(
        JSON.stringify({ usage: { rolling: {}, weekly: {}, monthly: { percent } } }),
        { status: 200 },
      );
    });
  }

  it('updates state usage from a successful refresh', async () => {
    mockPerKeyFetch();
    const state = makeState();

    maybeRefreshUsage(state, makeConfig());
    await settleMacrotasks();
    await settleMacrotasks();

    expect(state.keys.find((k) => k.label === 'a')?.usagePercent).toBe(30);
    expect(state.keys.find((k) => k.label === 'b')?.usagePercent).toBe(70);
    expect(state.keys.every((k) => k.exhausted === false)).toBe(true);
  });

  it('weighs the tightest window from real payloads and rotates away from the tight key', async () => {
    // 'a': monthly 10% but weekly 99% (1% of the weekly allowance left).
    // 'b': monthly 20%, weekly 10% (the healthy one).
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const auth = (init as RequestInit).headers as Record<string, string>;
      const isA = auth.Authorization.includes('sk-a');
      return new Response(
        JSON.stringify({
          usage: {
            rolling: { percent: 0 },
            weekly: { percent: isA ? 99 : 10 },
            monthly: { percent: isA ? 10 : 20 },
          },
        }),
        { status: 200 },
      );
    });
    const state = makeState();

    maybeRefreshUsage(state, makeConfig());
    await settleMacrotasks();
    await settleMacrotasks();

    const a = state.keys.find((k) => k.label === 'a')!;
    const b = state.keys.find((k) => k.label === 'b')!;
    // Display keeps the monthly number; only the rotation weight changes.
    expect(a.usagePercent).toBe(10);
    expect(a.effectivePercent).toBeCloseTo(49.5, 10);
    expect(b.effectivePercent).toBe(20);

    const counts: Record<string, number> = { a: 0, b: 0 };
    for (let i = 0; i < 40; i++) {
      const key = selectKeyForRequest(state, `req-${i}`)!;
      completeRequest(state, `req-${i}`, true);
      counts[key.label]++;
    }
    expect(counts.a).toBeLessThan(counts.b);
  });

  it('keeps the previous usage when a 200 carries no numeric window', async () => {
    const state = makeState();
    const config = makeConfig();

    // Seed: 'a' has a spent weekly window, 'b' a normal month.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const auth = (init as RequestInit).headers as Record<string, string>;
      const isA = auth.Authorization.includes('sk-a');
      return new Response(
        JSON.stringify({
          usage: {
            rolling: { percent: isA ? 100 : 0 },
            weekly: {},
            monthly: { percent: isA ? 50 : 10 },
          },
        }),
        { status: 200 },
      );
    });
    maybeRefreshUsage(state, config);
    await settleMacrotasks();
    await settleMacrotasks();

    const a = state.keys.find((k) => k.label === 'a')!;
    expect(a.usagePercent).toBe(50);
    expect(a.exhausted).toBe(true);

    // Empty usage shape must not reset the key to 0% / non-exhausted.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"usage":{}}', { status: 200 }));
    resetUsageRefreshState();
    maybeRefreshUsage(state, config);
    await settleMacrotasks();
    await settleMacrotasks();

    expect(a.usagePercent).toBe(50);
    expect(a.exhausted).toBe(true);
  });

  it('keeps the previous monthly percent when a 200 omits only the monthly window', async () => {
    const state = makeState();
    const config = makeConfig();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ usage: { rolling: {}, weekly: {}, monthly: { percent: 70 } } }),
      { status: 200 },
    ));
    maybeRefreshUsage(state, config);
    await settleMacrotasks();
    await settleMacrotasks();
    expect(state.keys.find((k) => k.label === 'a')?.usagePercent).toBe(70);

    // Windows are present, but the monthly metric is missing: the previous
    // monthly value must survive rather than become 0% (maximum weight).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ usage: { rolling: { percent: 10 }, weekly: { percent: 20 }, monthly: {} } }),
      { status: 200 },
    ));
    resetUsageRefreshState();
    maybeRefreshUsage(state, config);
    await settleMacrotasks();
    await settleMacrotasks();

    const a = state.keys.find((k) => k.label === 'a')!;
    expect(a.usagePercent).toBe(70);
    expect(a.exhausted).toBe(false);
  });

  it('never increases slack from a partial payload on an anchored key', async () => {
    const state = makeState();
    const config = makeConfig();

    // Seed: 'a' anchored at 10, 'b' anchored at 80.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const auth = (init as RequestInit).headers as Record<string, string>;
      const isA = auth.Authorization.includes('sk-a');
      return new Response(
        JSON.stringify({
          usage: { rolling: {}, weekly: {}, monthly: { percent: isA ? 10 : 80 } },
        }),
        { status: 200 },
      );
    });
    maybeRefreshUsage(state, config);
    await settleMacrotasks();
    await settleMacrotasks();

    const a = state.keys.find((k) => k.label === 'a')!;
    const b = state.keys.find((k) => k.label === 'b')!;
    expect(a.effectivePercent).toBe(10);
    expect(b.effectivePercent).toBe(80);

    // Partial payload: 'a' weekly 99 implies 49.5% of the month; 'b' weekly 0
    // implies 0. No monthly window, so the previous values are the floor.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const auth = (init as RequestInit).headers as Record<string, string>;
      const isA = auth.Authorization.includes('sk-a');
      return new Response(
        JSON.stringify({
          usage: { rolling: {}, weekly: { percent: isA ? 99 : 0 }, monthly: {} },
        }),
        { status: 200 },
      );
    });
    resetUsageRefreshState();
    maybeRefreshUsage(state, config);
    await settleMacrotasks();
    await settleMacrotasks();

    // (c) anchored at 10 + weekly 99 → 49.5 / weight 50.5.
    expect(a.usagePercent).toBe(10);
    expect(a.effectivePercent).toBeCloseTo(49.5, 10);
    expect(rotationWeight(a)).toBeCloseTo(50.5, 10);
    // (d) anchored at 80 + weekly 0 → stays 80 / weight 20.
    expect(b.usagePercent).toBe(80);
    expect(b.effectivePercent).toBe(80);
    expect(rotationWeight(b)).toBe(20);
  });

  it('keeps a new key unanchored when a partial payload has no monthly window', async () => {
    const state = createProxyState([
      { label: 'known', key: 'sk-known' },
      { label: 'new', key: 'sk-new' },
    ]);
    const config = makeConfig();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const auth = (init as RequestInit).headers as Record<string, string>;
      const isKnown = auth.Authorization.includes('sk-known');
      return new Response(
        JSON.stringify(
          isKnown
            ? { usage: { rolling: {}, weekly: {}, monthly: { percent: 50 } } }
            : { usage: { rolling: { percent: 0 }, weekly: { percent: 0 }, monthly: {} } },
        ),
        { status: 200 },
      );
    });
    maybeRefreshUsage(state, config);
    await settleMacrotasks();
    await settleMacrotasks();

    const known = state.keys.find((k) => k.label === 'known')!;
    const fresh = state.keys.find((k) => k.label === 'new')!;
    expect(known.effectivePercent).toBe(50);
    // (a) A partial payload alone must not anchor the key: 0% of the short
    // windows is not enough to claim the monthly budget is untouched.
    expect(fresh.effectivePercent).toBeNull();
    expect(rotationWeight(fresh)).toBeNull();
    // Median of the known weight (50) — not the 100 maximum-weight fallback.
    expect(countSelections(state, 10)).toEqual({ known: 5, new: 5 });
  });

  it('keeps a new key unanchored from a tight partial window, but exhausted still weighs 0', async () => {
    const state = createProxyState([
      { label: 'known', key: 'sk-known' },
      { label: 'new', key: 'sk-new' },
    ]);
    const config = makeConfig();

    // (b) First refresh: weekly 99, no monthly → partial, still unanchored.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const auth = (init as RequestInit).headers as Record<string, string>;
      const isKnown = auth.Authorization.includes('sk-known');
      return new Response(
        JSON.stringify(
          isKnown
            ? { usage: { rolling: {}, weekly: {}, monthly: { percent: 50 } } }
            : { usage: { rolling: {}, weekly: { percent: 99 }, monthly: {} } },
        ),
        { status: 200 },
      );
    });
    maybeRefreshUsage(state, config);
    await settleMacrotasks();
    await settleMacrotasks();

    const known = state.keys.find((k) => k.label === 'known')!;
    const fresh = state.keys.find((k) => k.label === 'new')!;
    expect(fresh.effectivePercent).toBeNull();
    expect(rotationWeight(fresh)).toBeNull();
    // The tight partial window does not anchor the key; it keeps the median.
    expect(countSelections(state, 10)).toEqual({ known: 5, new: 5 });

    // Second refresh: weekly 100 → exhausted, even without a monthly anchor.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const auth = (init as RequestInit).headers as Record<string, string>;
      const isKnown = auth.Authorization.includes('sk-known');
      return new Response(
        JSON.stringify(
          isKnown
            ? { usage: { rolling: {}, weekly: {}, monthly: { percent: 50 } } }
            : { usage: { rolling: {}, weekly: { percent: 100 }, monthly: {} } },
        ),
        { status: 200 },
      );
    });
    resetUsageRefreshState();
    maybeRefreshUsage(state, config);
    await settleMacrotasks();
    await settleMacrotasks();

    expect(fresh.effectivePercent).toBeNull();
    expect(fresh.exhausted).toBe(true);
    expect(rotationWeight(fresh)).toBe(0);
    expect(countSelections(state, 10)).toEqual({ known: 10, new: 0 });
  });

  it('propagates a spent window into state even when the month has room', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const auth = (init as RequestInit).headers as Record<string, string>;
      const isA = auth.Authorization.includes('sk-a');
      return new Response(
        JSON.stringify({
          usage: {
            rolling: { percent: isA ? 100 : 0 },
            weekly: {},
            monthly: { percent: isA ? 20 : 10 },
          },
        }),
        { status: 200 },
      );
    });
    const state = makeState();

    maybeRefreshUsage(state, makeConfig());
    await settleMacrotasks();
    await settleMacrotasks();

    const a = state.keys.find((k) => k.label === 'a')!;
    const b = state.keys.find((k) => k.label === 'b')!;
    expect(a.usagePercent).toBe(20);
    expect(a.exhausted).toBe(true);
    expect(b.usagePercent).toBe(10);
    expect(b.exhausted).toBe(false);
  });

  it('deduplicates concurrent calls within the TTL window', async () => {
    const spy = mockPerKeyFetch();
    const state = makeState();
    const config = makeConfig();

    maybeRefreshUsage(state, config);
    maybeRefreshUsage(state, config);
    maybeRefreshUsage(state, config);
    await settleMacrotasks();
    await settleMacrotasks();

    // 2 keys fetched exactly once each
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('keeps previous usage data when the refresh fails', async () => {
    const state = makeState();
    const config = makeConfig();

    // Seed known-good data
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ usage: { rolling: {}, weekly: {}, monthly: { percent: 42 } } }),
        { status: 200 },
      ),
    );
    maybeRefreshUsage(state, config);
    await settleMacrotasks();
    await settleMacrotasks();

    // Now upstream breaks
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 503 }));
    resetUsageRefreshState();
    maybeRefreshUsage(state, config);
    await settleMacrotasks();
    await settleMacrotasks();

    expect(state.keys[0].usagePercent).toBe(42);
    // A transient failure must not change entitlement either.
    expect(state.keys[0].entitled).toBe(true);
  });

  it('drops a key without a subscription and restores it when it works again', async () => {
    const state = makeState();
    const config = makeConfig();

    // 'a' has no plan, 'b' is fine.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const auth = (init as RequestInit).headers as Record<string, string>;
      if (auth.Authorization.includes('sk-a')) {
        return new Response(
          JSON.stringify({ type: 'error', error: { type: 'EntitlementError', message: 'subscription required' } }),
          { status: 403 },
        );
      }
      return new Response(
        JSON.stringify({ usage: { rolling: {}, weekly: {}, monthly: { percent: 20 } } }),
        { status: 200 },
      );
    });

    maybeRefreshUsage(state, config);
    await settleMacrotasks();
    await settleMacrotasks();

    expect(state.keys.find((k) => k.label === 'a')?.entitled).toBe(false);
    expect(state.keys.find((k) => k.label === 'b')?.entitled).toBe(true);

    // Later the account is fixed → the next refresh puts it back in rotation.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ usage: { rolling: {}, weekly: {}, monthly: { percent: 5 } } }),
        { status: 200 },
      ),
    );
    resetUsageRefreshState();
    maybeRefreshUsage(state, config);
    await settleMacrotasks();
    await settleMacrotasks();

    expect(state.keys.find((k) => k.label === 'a')?.entitled).toBe(true);
  });
});
