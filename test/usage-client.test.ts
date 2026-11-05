/**
 * usage-client.test.ts — Tests for the per-key usage API client and the
 * stale-while-revalidate coordinator.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchKeyUsage,
  maybeRefreshUsage,
  resetUsageRefreshState,
} from '../src/usage-client.js';
import { commandcodeProvider, opencodeGoProvider } from '../src/providers/index.js';
import { createProxyState, type ProxyState } from '../src/proxy-logic.js';
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
