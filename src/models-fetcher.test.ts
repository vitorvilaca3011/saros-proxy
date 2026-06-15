/**
 * models-fetcher.test.ts — Unit tests for models-fetcher module.
 *
 * Covers:
 *   fetchModelsFromUpstream  — upstream fetch, validation, error handling
 *   getModelsList            — orchestrator: warm buffer, in-flight dedup, fallback
 *   buildFallbackResponse    — fallback structure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MODELS_FETCH_TIMEOUT_MS, MODELS_WARM_BUFFER_MS } from './constants.js';
import { loadModelsFromJson } from './cli/opencode-config.js';
import type { ProxyConfig } from './config.js';
import {
  fetchModelsFromUpstream,
  getModelsList,
  buildFallbackResponse,
  resetModelsFetcherState,
} from './models-fetcher.js';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const testConfig: ProxyConfig = {
  port: 0,
  host: '127.0.0.1',
  upstreamBaseUrl: 'https://example.com',
  requestTimeoutMs: 30000,
  circuitBreakerThreshold: 3,
  circuitBreakerCooldownMs: 60000,
  allowedOrigins: ['*'],
  keys: [],
};

// ---------------------------------------------------------------------------
// fetchModelsFromUpstream
// ---------------------------------------------------------------------------

describe('fetchModelsFromUpstream', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed data on successful upstream response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ object: 'list', data: [{ id: 'glm-5' }] })),
    } as unknown as Response);

    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    const result = await fetchModelsFromUpstream(testConfig);

    expect(result).toEqual({ object: 'list', data: [{ id: 'glm-5' }] });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/zen/go/v1/models',
      expect.objectContaining({
        method: 'GET',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(timeoutSpy).toHaveBeenCalledWith(MODELS_FETCH_TIMEOUT_MS);
  });

  it('returns null on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    const result = await fetchModelsFromUpstream(testConfig);

    expect(result).toBeNull();
  });

  it('returns null on AbortError (timeout)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation was aborted', 'AbortError'),
    );

    const result = await fetchModelsFromUpstream(testConfig);

    expect(result).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('not json{{{'),
    } as unknown as Response);

    const result = await fetchModelsFromUpstream(testConfig);

    expect(result).toBeNull();
  });

  it('returns null when data is null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ object: 'list', data: null })),
    } as unknown as Response);

    const result = await fetchModelsFromUpstream(testConfig);

    expect(result).toBeNull();
  });

  it('returns null when data field is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ object: 'list' })),
    } as unknown as Response);

    const result = await fetchModelsFromUpstream(testConfig);

    expect(result).toBeNull();
  });

  it('returns null on HTTP 503', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve('Service Unavailable'),
    } as unknown as Response);

    const result = await fetchModelsFromUpstream(testConfig);

    expect(result).toBeNull();
  });

  it('returns null on HTTP 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    } as unknown as Response);

    const result = await fetchModelsFromUpstream(testConfig);

    expect(result).toBeNull();
  });

  it('passes through empty data array (not null)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ object: 'list', data: [] })),
    } as unknown as Response);

    const result = await fetchModelsFromUpstream(testConfig);

    expect(result).toEqual({ object: 'list', data: [] });
  });

  it('returns null when object type is not "list"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ object: 'error', data: [] })),
    } as unknown as Response);

    const result = await fetchModelsFromUpstream(testConfig);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getModelsList — orchestrator: warm buffer, in-flight dedup, fallback
// ---------------------------------------------------------------------------

describe('getModelsList', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetModelsFetcherState();
  });

  it('returns upstream data on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ object: 'list', data: [{ id: 'm1' }] })),
    } as unknown as Response);

    const response = await getModelsList(testConfig);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(body).toEqual({ object: 'list', data: [{ id: 'm1' }] });
  });

  it('falls back on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    const response = await getModelsList(testConfig);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(Object.keys(loadModelsFromJson()).length);
  });

  it('fallback response entries have correct shape', async () => {
    const response = buildFallbackResponse();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(Object.keys(loadModelsFromJson()).length);

    for (const entry of body.data) {
      expect(entry).toHaveProperty('id');
      expect(entry.object).toBe('model');
      expect(entry.owned_by).toBe('saros');
      expect(typeof entry.created).toBe('number');
    }
  });

  it('deduplicates concurrent in-flight requests', async () => {
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ object: 'list', data: [{ id: `m${callCount}` }] })),
      } as unknown as Response;
    });

    const [r1, r2, r3] = await Promise.all([
      getModelsList(testConfig),
      getModelsList(testConfig),
      getModelsList(testConfig),
    ]);

    // Only one actual fetch should have happened
    expect(callCount).toBe(1);

    // All three responses should have identical data
    const b1 = await r1.json();
    const b2 = await r2.json();
    const b3 = await r3.json();
    expect(b1).toEqual(b2);
    expect(b2).toEqual(b3);
  });

  it('uses warm buffer on second call within 60s', async () => {
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ object: 'list', data: [{ id: `m${callCount}` }] })),
      } as unknown as Response;
    });

    const r1 = await getModelsList(testConfig);
    expect(callCount).toBe(1);
    const b1 = await r1.json();
    expect(b1).toEqual({ object: 'list', data: [{ id: 'm1' }] });

    // Second call immediately after — should use warm buffer, not fetch
    const r2 = await getModelsList(testConfig);
    expect(callCount).toBe(1);
    const b2 = await r2.json();
    expect(b2).toEqual(b1);
  });
});

// ---------------------------------------------------------------------------
// Warm buffer expiry
// ---------------------------------------------------------------------------

describe('getModelsList — warm buffer expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    resetModelsFetcherState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-fetches after warm buffer expires (past 60s)', async () => {
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ object: 'list', data: [{ id: `m${callCount}` }] })),
      } as unknown as Response;
    });

    // First call — should fetch
    await getModelsList(testConfig);
    expect(callCount).toBe(1);

    // Advance time past the warm buffer
    vi.advanceTimersByTime(MODELS_WARM_BUFFER_MS + 1_000);

    // Second call — should re-fetch since buffer expired
    await getModelsList(testConfig);
    expect(callCount).toBe(2);
  });
});
