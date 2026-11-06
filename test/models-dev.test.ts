/**
 * models-dev.test.ts — Per-provider models.dev metadata extraction and fetch.
 *
 * Fixtures mirror the real document shape: a flat dictionary keyed by
 * provider id, each provider carrying a `models` map keyed by model id.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MODELS_DEV_PROVIDER_ID } from '../src/constants.js';
import {
  MODELS_DEV_PROVIDER_IDS,
  MODELS_DEV_USER_AGENT,
  extractProviderModels,
  fetchModelsDevProvider,
  findProviderModel,
  resetModelsDevCache,
} from '../src/models-dev.js';

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

  it('lists opencode-go first, with commandcode also in scope', () => {
    expect(MODELS_DEV_PROVIDER_IDS[0]).toBe(MODELS_DEV_PROVIDER_ID);
    expect(MODELS_DEV_PROVIDER_IDS).toContain('commandcode');
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

  it('sends a User-Agent header (Cloudflare 403s without one)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FIXTURE));
    vi.stubGlobal('fetch', fetchMock);

    await fetchModelsDevProvider('commandcode');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(MODELS_DEV_USER_AGENT);
    expect(headers.Accept).toBe('application/json');
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
