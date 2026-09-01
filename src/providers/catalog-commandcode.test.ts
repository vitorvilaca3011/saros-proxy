/**
 * catalog-commandcode.test.ts — Tests for commandcode provider catalog
 * fetching, model affinity / by-name resolution, client-version resolution,
 * and smoke-test error/status branches not covered by the mock-server suite.
 *
 * Module-level catalog state (catalogCache / warmupStarted) is per-file under
 * vitest isolation, so test ordering is meaningful: "uncached" assertions
 * run before fetchCatalog populates the module state.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { commandcodeProvider, resolveClientVersion } from './commandcode.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveClientVersion (fresh module per case)', () => {
  const cases: Array<{
    name: string;
    fetchImpl: () => Promise<unknown>;
    expected: string;
    fetches: number;
  }> = [
    {
      name: 'returns the registry version when fetch succeeds',
      fetchImpl: async () => new Response(JSON.stringify({ version: '1.38.2' }), { status: 200 }),
      expected: '1.38.2',
      fetches: 1,
    },
    {
      name: 'falls back when fetch fails to reach the registry',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
      expected: '0.18.10',
      fetches: 1,
    },
    {
      name: 'falls back on non-2xx registry responses',
      fetchImpl: async () => new Response('nope', { status: 503 }),
      expected: '0.18.10',
      fetches: 1,
    },
    {
      name: 'falls back when the registry body lacks a semver version',
      fetchImpl: async () => new Response(JSON.stringify({ version: 'banana-version' }), { status: 200 }),
      expected: '0.18.10',
      fetches: 1,
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      // Fresh module per case so the module-level version cache starts empty.
      vi.resetModules();
      const fetchMock = vi.fn(c.fetchImpl);
      vi.stubGlobal('fetch', fetchMock);
      const fresh = await import('./commandcode.js');
      expect(await fresh.resolveClientVersion()).toBe(c.expected);
      // Second call must be served from the cache (no extra fetch).
      expect(await fresh.resolveClientVersion()).toBe(c.expected);
      expect(fetchMock).toHaveBeenCalledTimes(c.fetches);
    });
  }
});

describe('commandcode model catalog & affinity', () => {
  const CATALOG = [
    { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'claude-opus-5', name: 'Claude Opus 5', context_length: 200_000 },
    { id: 'glm-5', name: 'GLM 5' },
    { id: 'trailing/' }, // split().pop() === '' -> native map keeps the raw id
    { id: '' }, // empty id -> skipped by the indexer
    { id: 12345 }, // non-string id -> skipped
    null, // non-object entry -> skipped by the filter
  ];

  it('modelAffinity is structural: vendor-prefixed and claude ids claim commandcode', () => {
    expect(commandcodeProvider.modelAffinity('deepseek/deepseek-v4-flash')).toBe('yes');
    expect(commandcodeProvider.modelAffinity('claude-opus-5')).toBe('yes');
    expect(commandcodeProvider.modelAffinity('glm-5')).toBe('maybe');
  });

  it('modelAffinityByName stays non-committal while the catalog is not loaded', async () => {
    // Must run before fetchCatalog populates the module cache (order matters).
    // The background warm-up must fail cleanly so the cache stays null.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(commandcodeProvider.modelAffinityByName('deepseek-v4-flash')).toBe('maybe');
    // Let the background warm-up settle (rejected) before later tests run.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('resolveNativeId returns null before the catalog is loaded', () => {
    expect(commandcodeProvider.resolveNativeId('deepseek-v4-flash')).toBeNull();
  });

  it('fetchCatalog filters claude-* (messages-only) and indexes the catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: CATALOG }), { status: 200 })),
    );
    const models = await commandcodeProvider.fetchCatalog();
    // claude-opus-5, null and non-objects are filtered out; trailing+empty stay.
    expect(models).toHaveLength(4);
    expect(models?.some((m) => m.id === 'claude-opus-5')).toBe(false);
    expect(models?.some((m) => m.id === 'trailing/')).toBe(true);
  });

  it('after catalog load, bare-name and native-id lookups resolve', () => {
    expect(commandcodeProvider.modelAffinityByName('deepseek-v4-flash')).toBe('yes');
    expect(commandcodeProvider.modelAffinityByName('claude-opus-5')).toBe('no');
    expect(commandcodeProvider.resolveNativeId('deepseek-v4-flash')).toBe(
      'deepseek/deepseek-v4-flash',
    );
    expect(commandcodeProvider.resolveNativeId('nope')).toBeNull();
    // A trailing-slash id indexes only the full id: affinity yes, no native mapping.
    expect(commandcodeProvider.modelAffinityByName('trailing/')).toBe('yes');
    expect(commandcodeProvider.resolveNativeId('trailing/')).toBeNull();
  });

  it('fetchCatalog returns null on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );
    expect(await commandcodeProvider.fetchCatalog()).toBeNull();
  });

  it('fetchCatalog returns null when the body has no data array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: 'nope' }), { status: 200 })),
    );
    expect(await commandcodeProvider.fetchCatalog()).toBeNull();
  });

  it('fetchCatalog returns null when the response is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json', { status: 200 })),
    );
    expect(await commandcodeProvider.fetchCatalog()).toBeNull();
  });

  it('fetchCatalog returns null when the network fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      }),
    );
    expect(await commandcodeProvider.fetchCatalog()).toBeNull();
  });

  it('usagePath is empty and parseUsageResponse always null (no usage API)', () => {
    expect(commandcodeProvider.usagePath()).toBe('');
    expect(commandcodeProvider.parseUsageResponse('{}')).toBeNull();
  });

  it('extraUpstreamHeaders carries CLI identity without authorization', () => {
    const headers = commandcodeProvider.extraUpstreamHeaders();
    expect(headers['X-CommandCode-Client']).toBe('cli');
    expect(headers.Authorization).toBeUndefined();
  });

  it('smokeTest reports error when the network throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ENOTFOUND');
      }),
    );
    const result = await commandcodeProvider.smokeTest('user_testkeyabcdefghijklmnop');
    expect(result.status).toBe('error');
    expect(result.detail).toContain('ENOTFOUND');
  });

  it('smokeTest reports String(err) when the network rejects with a non-Error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw 'raw rejection';
      }),
    );
    const result = await commandcodeProvider.smokeTest('user_testkeyabcdefghijklmnop');
    expect(result.status).toBe('error');
    expect(result.detail).toBe('raw rejection');
  });
  it('smokeTest classifies 403 as invalid (definitive rejection)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 403 })),
    );
    const result = await commandcodeProvider.smokeTest('user_testkeyabcdefghijklmnop');
    expect(result.status).toBe('invalid');
    expect(result.httpStatus).toBe(403);
  });

  it('smokeTest returns valid without meta when the body has no planId', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })),
    );
    const result = await commandcodeProvider.smokeTest('user_testkeyabcdefghijklmnop');
    expect(result.status).toBe('valid');
    expect(result.meta).toBeUndefined();
    expect(result.detail).toBeUndefined();
  });
});
