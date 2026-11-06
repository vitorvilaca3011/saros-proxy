/**
 * models-dev.test.ts — Per-provider models.dev metadata extraction and fetch.
 *
 * Fixtures mirror the real document shape: a flat dictionary keyed by
 * provider id, each provider carrying a `models` map keyed by model id.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../src/logger.js';
import {
  extractProviderModels,
  fetchModelsDevProvider,
  findProviderModel,
  resetModelsDevCache,
} from '../src/models-dev.js';

// Warnings are asserted, not printed; models-dev is the only consumer here.
vi.mock('../src/logger.js', () => ({ logger: { warn: vi.fn() } }));

/** Small fixture covering both providers saros consumes. */
const FIXTURE = {
  'opencode-go': {
    id: 'opencode-go',
    models: {
      'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      'glm-5': { id: 'glm-5', name: 'GLM 5' },
    },
  },
  commandcode: {
    id: 'commandcode',
    models: {
      'claude-opus-5': { id: 'claude-opus-5', name: 'Claude Opus 5' },
      'deepseek/deepseek-v4-flash': {
        id: 'deepseek/deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
      },
      'MoonshotAI/Kimi_K2.7_Code': {
        id: 'MoonshotAI/Kimi_K2.7_Code',
        name: 'Kimi K2.7 Code',
      },
      broken: 'not-an-entry',
    },
  },
  anthropic: { id: 'anthropic', models: { 'claude-sonnet-5': { id: 'claude-sonnet-5' } } },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// extractProviderModels
// ---------------------------------------------------------------------------

describe('extractProviderModels', () => {
  it('extracts the opencode-go slice', () => {
    expect(extractProviderModels(FIXTURE, 'opencode-go')).toEqual({
      'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      'glm-5': { id: 'glm-5', name: 'GLM 5' },
    });
  });

  it('extracts the commandcode slice without leaking other providers', () => {
    const result = extractProviderModels(FIXTURE, 'commandcode');
    expect(Object.keys(result)).toEqual([
      'claude-opus-5',
      'deepseek/deepseek-v4-flash',
      'MoonshotAI/Kimi_K2.7_Code',
      'broken',
    ]);
    expect(result['claude-opus-5']).toEqual({ id: 'claude-opus-5', name: 'Claude Opus 5' });
    expect(result['claude-sonnet-5']).toBeUndefined();
  });

  it('returns an empty map when the provider is absent', () => {
    expect(extractProviderModels(FIXTURE, 'nope')).toEqual({});
    expect(extractProviderModels({}, 'opencode-go')).toEqual({});
  });

  it('returns an empty map for malformed provider entries', () => {
    expect(extractProviderModels({ 'opencode-go': 'nope' }, 'opencode-go')).toEqual({});
    expect(extractProviderModels({ 'opencode-go': null }, 'opencode-go')).toEqual({});
    expect(extractProviderModels({ 'opencode-go': [] }, 'opencode-go')).toEqual({});
    expect(extractProviderModels({ 'opencode-go': {} }, 'opencode-go')).toEqual({});
    expect(extractProviderModels({ 'opencode-go': { models: 'nope' } }, 'opencode-go')).toEqual({});
    expect(extractProviderModels({ 'opencode-go': { models: null } }, 'opencode-go')).toEqual({});
    expect(extractProviderModels({ 'opencode-go': { models: [] } }, 'opencode-go')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// findProviderModel
// ---------------------------------------------------------------------------

describe('findProviderModel', () => {
  const commandcode = extractProviderModels(FIXTURE, 'commandcode');

  it('matches an exact model id', () => {
    expect(findProviderModel(commandcode, 'claude-opus-5')).toEqual({
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
    });
  });

  it('matches by bare name when the lookup id has no vendor prefix', () => {
    expect(findProviderModel(commandcode, 'deepseek-v4-flash')).toEqual({
      id: 'deepseek/deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
    });
  });

  it('matches by bare name when the lookup id carries a vendor prefix', () => {
    const bareKeyed = extractProviderModels(FIXTURE, 'opencode-go');
    expect(findProviderModel(bareKeyed, 'deepseek-v4-pro')).toBeDefined();
    expect(findProviderModel(bareKeyed, 'deepseek/glm-5')).toEqual({ id: 'glm-5', name: 'GLM 5' });
  });

  it('is case- and separator-insensitive on the bare name', () => {
    expect(findProviderModel(commandcode, 'moonshotai/kimi-k2.7-code')).toEqual({
      id: 'MoonshotAI/Kimi_K2.7_Code',
      name: 'Kimi K2.7 Code',
    });
    expect(findProviderModel(commandcode, 'KIMI_K2.7_CODE')).toEqual({
      id: 'MoonshotAI/Kimi_K2.7_Code',
      name: 'Kimi K2.7 Code',
    });
  });

  it('strips a provider routing suffix before matching', () => {
    expect(findProviderModel(commandcode, 'deepseek/deepseek-v4-flash@commandcode')).toEqual({
      id: 'deepseek/deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
    });
  });

  it('returns undefined for unknown ids and non-object entries', () => {
    expect(findProviderModel(commandcode, 'unknown-model')).toBeUndefined();
    expect(findProviderModel(commandcode, 'broken')).toBeUndefined();
    expect(findProviderModel({}, 'anything')).toBeUndefined();
  });

  it('refuses a bare-name match when two ids share that bare name', () => {
    const slice = {
      'vendorA/foo': { id: 'vendorA/foo', name: 'A Foo' },
      'vendorB/foo': { id: 'vendorB/foo', name: 'B Foo' },
      'vendorC/bar': { id: 'vendorC/bar', name: 'C Bar' },
    };

    // Exact ids still resolve; only the ambiguous bare name is refused.
    expect(findProviderModel(slice, 'vendorA/foo')).toEqual({ id: 'vendorA/foo', name: 'A Foo' });
    expect(findProviderModel(slice, 'vendorB/foo')).toEqual({ id: 'vendorB/foo', name: 'B Foo' });
    expect(findProviderModel(slice, 'foo')).toBeUndefined();

    // A bare name claimed once keeps matching.
    expect(findProviderModel(slice, 'bar')).toEqual({ id: 'vendorC/bar', name: 'C Bar' });
  });

  it('warns once per slice about colliding bare names', () => {
    const warn = vi.mocked(logger.warn);
    warn.mockClear();
    const slice = {
      'vendorA/foo': { id: 'vendorA/foo' },
      'vendorB/foo': { id: 'vendorB/foo' },
    };

    findProviderModel(slice, 'foo');
    findProviderModel(slice, 'foo');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { bareNames: ['foo'] },
      expect.stringContaining('bare-name collisions'),
    );
  });
});

// ---------------------------------------------------------------------------
// fetchModelsDevProvider
// ---------------------------------------------------------------------------

describe('fetchModelsDevProvider', () => {
  beforeEach(() => {
    resetModelsDevCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetModelsDevCache();
  });

  it('fetches with the CLI User-Agent models.dev accepts', async () => {
    // Measured 2026-11-06: models.dev answered 403 to a library-default UA
    // where `User-Agent: cli` got 200. The mock enforces that gate, so
    // dropping or renaming the header makes this test fail; the 403 → null
    // path itself is covered by 'returns null on non-2xx'.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      return headers['User-Agent'] === 'saros-proxy'
        ? jsonResponse(FIXTURE)
        : new Response('forbidden', { status: 403 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchModelsDevProvider('commandcode')).resolves.toMatchObject({
      'claude-opus-5': { id: 'claude-opus-5', name: 'Claude Opus 5' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns only the requested provider slice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(FIXTURE)));

    await expect(fetchModelsDevProvider('opencode-go')).resolves.toEqual({
      'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      'glm-5': { id: 'glm-5', name: 'GLM 5' },
    });
    const commandcode = await fetchModelsDevProvider('commandcode');
    expect(commandcode?.['claude-opus-5']).toEqual({
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
    });
    expect(commandcode?.['glm-5']).toBeUndefined();
  });

  it('fetches the document once for both providers (shared TTL cache)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FIXTURE));
    vi.stubGlobal('fetch', fetchMock);

    await fetchModelsDevProvider('opencode-go');
    await fetchModelsDevProvider('commandcode');
    await fetchModelsDevProvider('opencode-go');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight fetch between concurrent cold-cache callers', async () => {
    const { promise, resolve: resolveFetch } = Promise.withResolvers<Response>();
    const fetchMock = vi.fn(() => promise);
    vi.stubGlobal('fetch', fetchMock);

    // Both start on a cold cache, before the first response settles.
    const first = fetchModelsDevProvider('opencode-go');
    const second = fetchModelsDevProvider('commandcode');
    resolveFetch(jsonResponse(FIXTURE));

    await expect(first).resolves.toEqual({
      'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      'glm-5': { id: 'glm-5', name: 'GLM 5' },
    });
    await expect(second).resolves.toMatchObject({
      'claude-opus-5': { id: 'claude-opus-5', name: 'Claude Opus 5' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches after the cache is reset', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FIXTURE));
    vi.stubGlobal('fetch', fetchMock);

    await fetchModelsDevProvider('opencode-go');
    resetModelsDevCache();
    await fetchModelsDevProvider('opencode-go');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns an empty map when the provider is absent from the document', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(FIXTURE)));
    await expect(fetchModelsDevProvider('not-a-provider')).resolves.toEqual({});
  });

  it('returns null on non-2xx, malformed JSON, or a non-object root', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));
    await expect(fetchModelsDevProvider('opencode-go')).resolves.toBeNull();

    resetModelsDevCache();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json{{{')));
    await expect(fetchModelsDevProvider('opencode-go')).resolves.toBeNull();

    resetModelsDevCache();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([1, 2, 3])));
    await expect(fetchModelsDevProvider('opencode-go')).resolves.toBeNull();
  });

  it('returns null on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(fetchModelsDevProvider('commandcode')).resolves.toBeNull();
  });
});
