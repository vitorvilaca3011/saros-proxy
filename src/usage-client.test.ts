/**
 * usage-client.test.ts — Tests for the per-key usage API client and the
 * stale-while-revalidate coordinator.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchKeyUsage,
  maybeRefreshUsage,
  parseUsageResponse,
  resetUsageRefreshState,
} from './usage-client.js';
import { createProxyState, type ProxyState } from './proxy-logic.js';
import { updateKeyUsage } from './proxy-logic.js';
import type { ProxyConfig } from './config.js';

const VALID_BODY = JSON.stringify({
  usage: {
    rolling: { status: 'ok', percent: 12, resetsAt: '2026-08-22T19:00:00Z' },
    weekly: { status: 'ok', percent: 44, resetsAt: '2026-08-24T00:00:00Z' },
    monthly: { status: 'ok', percent: 92, resetsAt: '2026-08-27T00:00:00Z' },
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

describe('parseUsageResponse', () => {
  it('parses windows and picks the worst one for usedPercent', () => {
    const usage = parseUsageResponse(VALID_BODY);
    expect(usage).toEqual({
      usedPercent: 92,
      rollingPercent: 12,
      weeklyPercent: 44,
      monthlyPercent: 92,
      rollingResetsAt: '2026-08-22T19:00:00Z',
      weeklyResetsAt: '2026-08-24T00:00:00Z',
      monthlyResetsAt: '2026-08-27T00:00:00Z',
    });
  });

  it('clamps out-of-range percents', () => {
    const body = JSON.stringify({
      usage: { rolling: { percent: 150 }, weekly: { percent: -5 }, monthly: {} },
    });
    const usage = parseUsageResponse(body);
    expect(usage.rollingPercent).toBe(100);
    expect(usage.weeklyPercent).toBe(0);
    expect(usage.monthlyPercent).toBe(0);
    expect(usage.usedPercent).toBe(100);
  });

  it('throws on invalid JSON and on missing usage object', () => {
    expect(() => parseUsageResponse('not json')).toThrow();
    expect(() => parseUsageResponse('{}')).toThrow(/missing "usage"/);
  });
});

describe('fetchKeyUsage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns parsed usage on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(VALID_BODY, { status: 200 }));
    const usage = await fetchKeyUsage('https://example.com', 'sk-test');
    expect(usage?.usedPercent).toBe(92);
  });

  it('returns null on non-200, network error, or contract violation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(fetchKeyUsage('https://example.com', 'sk')).resolves.toBeNull();

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await expect(fetchKeyUsage('https://example.com', 'sk')).resolves.toBeNull();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(fetchKeyUsage('https://example.com', 'sk')).resolves.toBeNull();
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

  function mockPerKeyFetch(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const auth = (init as RequestInit).headers as Record<string, string>;
      const percent = auth.Authorization.includes('sk-a') ? 30 : 70;
      return new Response(
        JSON.stringify({ usage: { rolling: { percent }, weekly: {}, monthly: {} } }),
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
        JSON.stringify({ usage: { rolling: { percent: 42 }, weekly: {}, monthly: {} } }),
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
  });
});
