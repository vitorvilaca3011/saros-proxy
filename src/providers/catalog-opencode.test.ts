/**
 * catalog-opencode.test.ts — Tests for opencode-go provider catalog fetching,
 * model affinity / by-name resolution, smoke-test status branches, and
 * usage-percent edge cases not covered by the mock-server suite.
 *
 * Module-level catalog state (catalogCache / refreshStarted) is per-file under
 * vitest isolation, so test ordering is meaningful: "uncached" assertions
 * run before fetchCatalog populates the module state.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { opencodeGoProvider, parseOpencodeUsage } from './opencode-go.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('opencode-go catalog & affinity', () => {
  const CATALOG = [
    { id: 'deepseek-v4-flash' },
    { id: 'glm-5' },
    { id: 'deepseek/deepseek-v4-flash' },
    { id: 'trailing/' }, // split().pop() === '' -> falls back to the raw id
    { id: '' }, // empty id -> skipped by the indexer
    { id: 12345 }, // non-string id -> skipped
    null, // non-object entry -> skipped
  ];

  it('parsePercent treats non-numeric percents as 0', () => {
    const usage = parseOpencodeUsage(
      '{"usage":{"rolling":{"percent":"high"},"weekly":{},"monthly":{}}}',
    );
    expect(usage?.rollingPercent).toBe(0);
    expect(usage?.weeklyPercent).toBe(0);
    expect(usage?.monthlyPercent).toBe(0);
  });

  it('modelAffinity / modelAffinityByName stay non-committal before the catalog loads', async () => {
    // Must run before fetchCatalog populates the module cache (order matters).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(opencodeGoProvider.modelAffinity('glm-5')).toBe('maybe');
    expect(opencodeGoProvider.modelAffinityByName('glm-5')).toBe('maybe');
    // Let the background refresh settle (rejected) before later tests run.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('resolveNativeId returns null before the catalog loads', () => {
    expect(opencodeGoProvider.resolveNativeId('glm-5')).toBeNull();
  });

  it('fetchCatalog returns the raw list and indexes bare names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: CATALOG }), { status: 200 })),
    );
    const list = await opencodeGoProvider.fetchCatalog();
    expect(list).toHaveLength(7); // edge entries are returned raw by the second fetch
  });

  it('after catalog load, affinity and native ids resolve from the index', () => {
    expect(opencodeGoProvider.modelAffinity('glm-5')).toBe('yes');
    expect(opencodeGoProvider.modelAffinity('claude-opus-5')).toBe('no');
    expect(opencodeGoProvider.modelAffinityByName('glm-5')).toBe('yes');
    expect(opencodeGoProvider.resolveNativeId('glm-5')).toBe('glm-5');
    expect(opencodeGoProvider.resolveNativeId('claude-opus-5')).toBeNull();
  });

  it('fetchCatalog returns null on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 500 })),
    );
    expect(await opencodeGoProvider.fetchCatalog()).toBeNull();
  });

  it('fetchCatalog returns null when the body has no data array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: null }), { status: 200 })),
    );
    expect(await opencodeGoProvider.fetchCatalog()).toBeNull();
  });

  it('keeps string resetsAt values for windows that have them', () => {
    const usage = parseOpencodeUsage(
      JSON.stringify({
        usage: {
          rolling: { percent: 10, resetsAt: '2026-08-29T00:00:00Z' },
          weekly: { percent: 20, resetsAt: '2026-09-01T00:00:00Z' },
          monthly: { percent: 30 }, // no resetsAt
        },
      }),
    );
    expect(usage?.rollingResetsAt).toBe('2026-08-29T00:00:00Z');
    expect(usage?.weeklyResetsAt).toBe('2026-09-01T00:00:00Z');
    expect(usage?.monthlyResetsAt).toBeUndefined();
  });

  it('fetchCatalog returns null when the raw re-fetch fails', async () => {
    // First (index) call valid, second (raw list) call non-2xx.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'glm-5' }] }), { status: 200 }))
      .mockResolvedValue(new Response('down', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await opencodeGoProvider.fetchCatalog()).toBeNull();
  });

  it('fetchCatalog returns null when the raw re-fetch has no data array', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'glm-5' }] }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({ data: { not: 'array' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await opencodeGoProvider.fetchCatalog()).toBeNull();
  });
  it('fetchCatalog returns null when the raw re-fetch body is malformed', async () => {
    // First (index) call valid, second (raw list) call malformed JSON.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'glm-5' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('garbage', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await opencodeGoProvider.fetchCatalog()).toBeNull();
  });

  it('fetchCatalog returns null when the network fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      }),
    );
    expect(await opencodeGoProvider.fetchCatalog()).toBeNull();
  });

  it('smokeTest reports String(err) when the network rejects with a non-Error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw 'raw rejection';
      }),
    );
    const result = await opencodeGoProvider.smokeTest('sk-testkeyabcdefghijklmnop');
    expect(result.status).toBe('error');
    expect(result.detail).toBe('raw rejection');
  });
  it('smokeTest reports error when the network throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ENOTFOUND');
      }),
    );
    const result = await opencodeGoProvider.smokeTest('sk-testkeyabcdefghijklmnop');
    expect(result.status).toBe('error');
    expect(result.detail).toContain('ENOTFOUND');
  });

  it('smokeTest classifies 403 as invalid (definitive rejection)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 403 })),
    );
    const result = await opencodeGoProvider.smokeTest('sk-testkeyabcdefghijklmnop');
    expect(result.status).toBe('invalid');
    expect(result.httpStatus).toBe(403);
  });

  it('smokeTest classifies 429 as error (inconclusive)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('slow down', { status: 429 })),
    );
    const result = await opencodeGoProvider.smokeTest('sk-testkeyabcdefghijklmnop');
    expect(result.status).toBe('error');
    expect(result.httpStatus).toBe(429);
  });
});
