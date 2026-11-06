/**
 * models-refresh.test.ts — Unit tests for the deterministic catalog generator.
 *
 * The merge is pure: every source is built in the test, so no network and no
 * real catalog file is involved. Fetch-failure behaviour is pinned at the
 * orchestrator, where a rejected source must leave the file untouched.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  defaultRefreshFetchers,
  extractModelsDevProviderModels,
  fetchCommandcodeModels,
  fetchModelsDevCatalog,
  fetchOpencodeGoModels,
  formatCatalogDiff,
  mergeModelCatalog,
  parseCatalogContent,
  refreshModelCatalog,
  serializeModelCatalog,
} from '../src/models-refresh.js';
import type { ModelCatalogMergeInput, RefreshFetchers } from '../src/models-refresh.js';

const MODELS_DEV_SAMPLE = {
  'opencode-go': {
    models: {
      'glm-5.3': {
        id: 'glm-5.3',
        name: 'GLM 5.3',
        tool_call: true,
        reasoning: true,
        description: 'not part of the catalog schema',
        limit: { context: 1_000_000, output: 131_072 },
        cost: { input: 0.6, output: 2.2, cache_read: 0.11 },
      },
      retired: { id: 'retired', name: 'Retired' },
    },
  },
  commandcode: {
    models: {
      'zai-org/GLM-5.3': {
        id: 'zai-org/GLM-5.3',
        name: 'GLM 5.3 (CommandCode)',
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text'], output: ['text'] },
        cost: { input: 0.99 },
      },
      'vendor/new-model': {
        id: 'vendor/new-model',
        name: 'New Model',
        reasoning: false,
        cost: { input: 0.1, output: 0.2 },
      },
      'vendor/gone': { id: 'vendor/gone', name: 'Gone' },
    },
  },
  other: { models: { ignored: { id: 'ignored' } } },
};

function mergeSample(overrides: Partial<ModelCatalogMergeInput> = {}) {
  return mergeModelCatalog({
    modelsDev: MODELS_DEV_SAMPLE,
    opencodeModels: [{ id: 'glm-5.3' }],
    commandcodeModels: [{ id: 'zai-org/GLM-5.3' }, { id: 'vendor/new-model', name: 'New Model' }],
    current: {
      'glm-5.3': {
        id: 'glm-5.3',
        name: 'Old name',
        custom_field: 'keep me',
        limit: { context: 1_000_000, output: 65_536 },
      },
      ghost: { id: 'ghost', name: 'Ghost' },
    },
    ...overrides,
  });
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function ioWith(content: string | null) {
  return { read: vi.fn(() => content), write: vi.fn<(content: string) => void>() };
}

/** Defaults a live-only model gets (mirrors `providerCatalogToCanonical`). */
function liveStubDefaults(): Record<string, unknown> {
  return {
    tool_call: true,
    reasoning: true,
    limit: { context: 262_144, output: 65_536 },
    modalities: { input: ['text'], output: ['text'] },
    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
  };
}

function fetchers(
  overrides: Partial<RefreshFetchers> = {},
): RefreshFetchers {
  return {
    modelsDev: async () => MODELS_DEV_SAMPLE,
    opencodeModels: async () => [{ id: 'glm-5.3' }],
    commandcodeModels: async () => [
      { id: 'zai-org/GLM-5.3' },
      { id: 'vendor/new-model', name: 'New Model' },
    ],
    ...overrides,
  };
}

describe('extractModelsDevProviderModels', () => {
  it('returns one provider map', () => {
    expect(extractModelsDevProviderModels(MODELS_DEV_SAMPLE, 'commandcode')).toEqual(
      MODELS_DEV_SAMPLE.commandcode.models,
    );
  });

  it.each([
    ['missing provider', {}],
    ['provider is an array', { 'opencode-go': [] }],
    ['models is an array', { 'opencode-go': { models: [] } }],
    ['provider is null', { 'opencode-go': null }],
  ])('returns {} for %s', (_label, parsed) => {
    expect(extractModelsDevProviderModels(parsed as Record<string, unknown>, 'opencode-go')).toEqual({});
  });
});

describe('mergeModelCatalog', () => {
  it('keeps only ids present in the live catalogs and drops retired ones', () => {
    const result = mergeSample();

    expect(Object.keys(result.models)).toEqual(['glm-5.3', 'new-model']);
    expect(result.models.retired).toBeUndefined();
    expect(result.models.gone).toBeUndefined();
  });

  it('reports added, removed and changed keys', () => {
    const result = mergeSample();

    expect(result.added).toEqual(['new-model']);
    expect(result.removed).toEqual(['ghost']);
    expect(result.changed).toEqual(['glm-5.3']);
  });

  it('merges metadata fields and never copies non-schema fields', () => {
    const entry = mergeSample().models['glm-5.3'];

    expect(entry).toMatchObject({
      id: 'glm-5.3',
      name: 'GLM 5.3',
      tool_call: true,
      reasoning: true,
      limit: { context: 1_000_000, output: 131_072 },
      cost: { input: 0.6, output: 2.2, cache_read: 0.11 },
    });
    expect(entry.description).toBeUndefined();
  });

  it('preserves a field the current file has and models.dev omits', () => {
    expect(mergeSample().models['glm-5.3'].custom_field).toBe('keep me');
  });

  it('opencode-go wins over commandcode and commandcode fills the holes', () => {
    const entry = mergeSample().models['glm-5.3'];

    // Both providers expose the model; the primary provider owns the name...
    expect(entry.name).toBe('GLM 5.3');
    // ...but commandcode still contributes fields opencode-go lacks.
    expect(entry.modalities).toEqual({ input: ['text'], output: ['text'] });
  });

  it('normalizes vendor-prefixed keys to the bare model name', () => {
    const result = mergeSample();

    expect(result.models['new-model']?.id).toBe('new-model');
    expect(result.models['zai-org/glm-5.3']).toBeUndefined();
  });

  it('sorts top-level and nested keys deterministically', () => {
    const first = mergeSample();
    const second = mergeSample();

    expect(Object.keys(first.models)).toEqual(['glm-5.3', 'new-model']);
    expect(Object.keys(first.models['glm-5.3'])).toEqual(
      [...Object.keys(first.models['glm-5.3'])].sort(),
    );
    expect(Object.keys(first.models['glm-5.3'].cost as object)).toEqual(
      ['cache_read', 'input', 'output'],
    );
    expect(serializeModelCatalog(first.models)).toBe(serializeModelCatalog(second.models));
  });

  it('does not report a change when the catalog already matches', () => {
    const current = mergeSample().models;

    expect(mergeSample({ current }).changed).toEqual([]);
  });

  it('treats a non-object current entry as empty', () => {
    const result = mergeSample({ current: { 'glm-5.3': 'not an object' } });

    expect(result.models['glm-5.3']).toMatchObject({ id: 'glm-5.3', name: 'GLM 5.3' });
    expect(result.added).toEqual(['new-model']);
    expect(result.changed).toEqual(['glm-5.3']);
  });

  it('seeds a live-only model with the metadata the live payload carries', () => {
    const result = mergeModelCatalog({
      modelsDev: MODELS_DEV_SAMPLE,
      opencodeModels: [
        { id: 'glm-5.3' },
        { id: 'vendor/Brand-New', name: 'Brand New', context_length: 200_000 },
      ],
      commandcodeModels: [{ id: 'zai-org/GLM-5.3' }],
      current: {},
    });

    expect(result.models['brand-new']).toEqual({
      id: 'brand-new',
      ...liveStubDefaults(),
      limit: { context: 200_000, output: 65_536 },
      name: 'Brand New',
    });
    expect(result.added).toContain('brand-new');
  });

  it('gives a live-only model every field the catalog schema requires', () => {
    const result = mergeModelCatalog({
      modelsDev: MODELS_DEV_SAMPLE,
      opencodeModels: [{ id: 'vendor/only-live', name: 'Only Live' }],
      commandcodeModels: [{ id: 'zai-org/GLM-5.3' }],
      current: {},
    });

    const entry = result.models['only-live'];
    const limit = entry.limit as Record<string, unknown>;
    expect(typeof limit.context).toBe('number');
    expect(typeof limit.output).toBe('number');
    expect(limit.output).toBe(65_536);
    expect(entry.modalities).toEqual({ input: ['text'], output: ['text'] });
    expect(entry.tool_call).toBe(true);
    expect(entry.reasoning).toBe(true);
    expect(entry.reasoning_options).toEqual([
      { type: 'effort', values: ['low', 'medium', 'high'] },
    ]);
  });

  it('lets models.dev limit and modalities win over the live defaults', () => {
    const result = mergeModelCatalog({
      modelsDev: {
        'opencode-go': {
          models: {
            'glm-5.3': {
              id: 'glm-5.3',
              limit: { context: 900_000, output: 42 },
              modalities: { input: ['text', 'image'], output: ['text'] },
            },
          },
        },
        commandcode: { models: {} },
      },
      opencodeModels: [{ id: 'glm-5.3', context_length: 123 }],
      commandcodeModels: [],
      current: {},
    });

    expect(result.models['glm-5.3'].limit).toEqual({ context: 900_000, output: 42 });
    expect(result.models['glm-5.3'].modalities).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    });
  });

  it('keeps the current fields of a live-only model already in the file', () => {
    const current = {
      'brand-new': { id: 'brand-new', name: 'User Name', cost: { input: 1 } },
    };
    const result = mergeModelCatalog({
      modelsDev: MODELS_DEV_SAMPLE,
      opencodeModels: [{ id: 'glm-5.3' }, { id: 'vendor/brand-new', name: 'Live Name' }],
      commandcodeModels: [{ id: 'zai-org/GLM-5.3' }],
      current,
    });

    expect(result.models['brand-new']).toMatchObject({
      id: 'brand-new',
      name: 'User Name',
      cost: { input: 1 },
      limit: { context: 262_144, output: 65_536 },
    });
    // The stub fills the missing schema fields, so the entry does change.
    expect(result.changed).toEqual(['brand-new']);
  });

  it('does not remove a live model models.dev omits', () => {
    const result = mergeModelCatalog({
      modelsDev: MODELS_DEV_SAMPLE,
      opencodeModels: [{ id: 'glm-5.3' }],
      commandcodeModels: [{ id: 'zai-org/GLM-5.3' }, { id: 'vendor/glm-9' }],
      current: { 'glm-9': { id: 'glm-9', name: 'GLM 9' } },
    });

    expect(result.removed).toEqual([]);
    expect(result.models['glm-9']).toMatchObject({ id: 'glm-9', name: 'GLM 9' });
  });

  it('lets models.dev metadata win over the live stub', () => {
    const result = mergeModelCatalog({
      modelsDev: MODELS_DEV_SAMPLE,
      opencodeModels: [{ id: 'glm-5.3', name: 'Live Name', context_length: 123 }],
      commandcodeModels: [{ id: 'zai-org/GLM-5.3' }],
      current: {},
    });

    expect(result.models['glm-5.3']).toMatchObject({
      name: 'GLM 5.3',
      limit: { context: 1_000_000 },
    });
  });

  it('aborts when two live ids collapse to the same bare name', () => {
    expect(() =>
      mergeModelCatalog({
        modelsDev: MODELS_DEV_SAMPLE,
        opencodeModels: [{ id: 'glm-5.3' }],
        commandcodeModels: [{ id: 'vendorA/foo' }, { id: 'vendorB/foo' }],
        current: {},
      }),
    ).toThrow(/bare-name collision in commandcode.*vendorA\/foo.*vendorB\/foo.*"foo"/);
  });

  it('aborts when models.dev and the live catalog disagree on the raw id', () => {
    expect(() =>
      mergeModelCatalog({
        modelsDev: {
          'opencode-go': { models: { 'glm-5.3': { id: 'glm-5.3', name: 'GLM 5.3' } } },
          commandcode: { models: { 'vendorA/foo': { id: 'vendorA/foo', name: 'Foo' } } },
        },
        opencodeModels: [{ id: 'glm-5.3' }],
        commandcodeModels: [{ id: 'vendorB/foo' }],
        current: {},
      }),
    ).toThrow(/bare-name collision in commandcode.*vendorB\/foo.*vendorA\/foo.*"foo"/);
  });

  it('falls back to the live stub when models.dev has no known provider', () => {
    const result = mergeModelCatalog({
      modelsDev: {},
      opencodeModels: [{ id: 'glm-5.3', name: 'GLM 5.3' }],
      commandcodeModels: [{ id: 'vendor/new-model' }],
      current: { ghost: { id: 'ghost' } },
    });

    expect(result.models['glm-5.3']).toEqual({
      id: 'glm-5.3',
      ...liveStubDefaults(),
      name: 'GLM 5.3',
    });
    expect(result.models['new-model']).toEqual({ id: 'new-model', ...liveStubDefaults() });
    expect(result.removed).toEqual(['ghost']);
  });

  it('treats a missing current catalog as empty', () => {
    const result = mergeModelCatalog({
      modelsDev: MODELS_DEV_SAMPLE,
      opencodeModels: [{ id: 'glm-5.3' }],
      commandcodeModels: [{ id: 'zai-org/GLM-5.3' }],
    });

    expect(result.added).toEqual(['glm-5.3']);
    expect(result.removed).toEqual([]);
  });

  it('ignores live entries whose id normalizes to an empty key', () => {
    const result = mergeModelCatalog({
      modelsDev: MODELS_DEV_SAMPLE,
      opencodeModels: [{ id: '' }, { id: 'glm-5.3' }],
      commandcodeModels: [{ id: 'zai-org/GLM-5.3' }],
      current: {},
    });

    expect(Object.keys(result.models)).toEqual(['glm-5.3']);
  });

  it('ignores models.dev entries with no usable metadata', () => {
    const result = mergeModelCatalog({
      modelsDev: {
        'opencode-go': { models: { 'glm-5.3': {}, hy4: 'not an object' } },
        commandcode: { models: {} },
      },
      opencodeModels: [{ id: 'glm-5.3', name: 'Live GLM' }, { id: 'hy4', name: 'Live HY4' }],
      commandcodeModels: [],
      current: {},
    });

    expect(result.models['glm-5.3']).toEqual({
      id: 'glm-5.3',
      ...liveStubDefaults(),
      name: 'Live GLM',
    });
    expect(result.models.hy4).toEqual({ id: 'hy4', ...liveStubDefaults(), name: 'Live HY4' });
  });
});

describe('serializeModelCatalog', () => {
  it('writes 2-space JSON with a trailing newline', () => {
    expect(serializeModelCatalog({ a: { id: 'a' } })).toBe(
      '{\n  "a": {\n    "id": "a"\n  }\n}\n',
    );
  });

  it('sorts top-level and nested keys', () => {
    expect(serializeModelCatalog({ b: { z: 1, a: 2 }, a: { id: 'a' } })).toBe(
      '{\n  "a": {\n    "id": "a"\n  },\n  "b": {\n    "a": 2,\n    "z": 1\n  }\n}\n',
    );
  });
});

describe('parseCatalogContent', () => {
  it('treats null and blank content as an empty catalog', () => {
    expect(parseCatalogContent(null)).toEqual({});
    expect(parseCatalogContent('  \n')).toEqual({});
  });

  it('parses an object', () => {
    expect(parseCatalogContent('{"a":{"id":"a"}}')).toEqual({ a: { id: 'a' } });
  });

  it('rejects invalid JSON and non-object payloads', () => {
    expect(() => parseCatalogContent('{ not json')).toThrow();
    expect(() => parseCatalogContent('[1]')).toThrow(/not a JSON object/);
  });
});

describe('fetchModelsDevCatalog', () => {
  it('sends a User-Agent and returns the parsed catalog', async () => {
    const fetchMock = vi.fn(async () => okResponse(MODELS_DEV_SAMPLE));

    await expect(fetchModelsDevCatalog(fetchMock)).resolves.toEqual(MODELS_DEV_SAMPLE);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('models.dev');
    expect(init.headers).toMatchObject({ 'User-Agent': expect.any(String) });
  });

  it('throws on a non-2xx response', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));

    await expect(fetchModelsDevCatalog(fetchMock)).rejects.toThrow(/HTTP 403/);
  });

  it('throws when the payload is not an object', async () => {
    const fetchMock = vi.fn(async () => okResponse([1, 2]));

    await expect(fetchModelsDevCatalog(fetchMock)).rejects.toThrow(/non-object/);
  });
});

describe('live catalog fetchers', () => {
  it('reads opencode-go models and skips malformed entries', async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        data: [
          { id: 'glm-5.3', name: 'GLM 5.3', context_length: 1_000_000 },
          { id: '' },
          { id: 7 },
          null,
          { id: 'hy4' },
        ],
      }),
    );

    await expect(fetchOpencodeGoModels(fetchMock)).resolves.toEqual([
      { id: 'glm-5.3', name: 'GLM 5.3', context_length: 1_000_000 },
      { id: 'hy4' },
    ]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'User-Agent': 'cli' });
  });

  it('reads commandcode models that advertise /chat/completions', async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        data: [
          { id: 'claude-opus-5', supported_endpoints: ['/messages'] },
          { id: 'vendor/claude-impostor', supported_endpoints: ['/messages'] },
          { id: 'zai-org/GLM-5.3', name: 'GLM-5.3', context_length: 1_000_000, supported_endpoints: ['/chat/completions'] },
          { id: 'gpt-6-astra', supported_endpoints: ['/responses'] },
          { id: 'gpt-6-sol', supported_endpoints: ['/chat/completions', '/responses'] },
          { id: 'no-endpoints' },
        ],
      }),
    );

    await expect(fetchCommandcodeModels(fetchMock)).resolves.toEqual([
      { id: 'zai-org/GLM-5.3', name: 'GLM-5.3', context_length: 1_000_000 },
      { id: 'gpt-6-sol' },
    ]);
  });

  it.each([
    ['a non-2xx response', async () => new Response('down', { status: 500 })],
    ['a payload without a data array', async () => okResponse({ object: 'list' })],
  ])('throws on %s', async (_label, response) => {
    const fetchMock = vi.fn(response);

    await expect(fetchCommandcodeModels(fetchMock)).rejects.toThrow(/commandcode models/);
  });

  it('wires the default fetchers to the live endpoints', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('models.dev')) return okResponse(MODELS_DEV_SAMPLE);
      if (url.includes('commandcode')) {
        return okResponse({ data: [{ id: 'zai-org/GLM-5.3', supported_endpoints: ['/chat/completions'] }] });
      }
      return okResponse({ data: [{ id: 'glm-5.3' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const live = defaultRefreshFetchers();
      await expect(live.modelsDev()).resolves.toEqual(MODELS_DEV_SAMPLE);
      await expect(live.opencodeModels()).resolves.toEqual([{ id: 'glm-5.3' }]);
      await expect(live.commandcodeModels()).resolves.toEqual([{ id: 'zai-org/GLM-5.3' }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('refreshModelCatalog', () => {
  it('writes the merged catalog when it changed', async () => {
    const io = ioWith(JSON.stringify(mergeSample({ current: {} }).models));

    const result = await refreshModelCatalog(io, fetchers(), { dryRun: false });

    expect(result.written).toBe(true);
    expect(io.write).toHaveBeenCalledTimes(1);
    expect(io.write).toHaveBeenCalledWith(result.nextContent);
  });

  it('does not rewrite an identical file', async () => {
    const current = serializeModelCatalog(mergeSample().models);
    const io = ioWith(current);

    const result = await refreshModelCatalog(io, fetchers(), { dryRun: false });

    expect(result.written).toBe(false);
    expect(result.formattingOnly).toBe(false);
    expect(io.write).not.toHaveBeenCalled();
  });

  it('reports a formatting-only difference on a dry run', async () => {
    const models = mergeSample({ current: {} }).models;
    const io = ioWith(JSON.stringify(models));

    const result = await refreshModelCatalog(io, fetchers(), { dryRun: true });

    expect(result.formattingOnly).toBe(true);
    expect(result.written).toBe(false);
    expect(result.nextContent).not.toBe(result.previousContent);
    expect(io.write).not.toHaveBeenCalled();
  });

  it('leaves the file untouched on a dry run', async () => {
    const io = ioWith(null);

    const result = await refreshModelCatalog(io, fetchers(), { dryRun: true });

    expect(result.written).toBe(false);
    expect(result.previousContent).toBeNull();
    expect(io.write).not.toHaveBeenCalled();
    expect(result.nextContent.endsWith('\n')).toBe(true);
  });

  it('does not read or write when models.dev fails', async () => {
    const io = ioWith('{"keep":{"id":"keep"}}');
    const failing = fetchers({
      modelsDev: async () => {
        throw new Error('models.dev returned HTTP 403');
      },
    });

    await expect(refreshModelCatalog(io, failing)).rejects.toThrow(/HTTP 403/);
    expect(io.read).not.toHaveBeenCalled();
    expect(io.write).not.toHaveBeenCalled();
  });

  it('does not read or write when the opencode-go catalog fails', async () => {
    const io = ioWith('{"keep":{"id":"keep"}}');
    const failing = fetchers({
      opencodeModels: async () => {
        throw new Error('opencode-go models returned HTTP 503');
      },
    });

    await expect(refreshModelCatalog(io, failing)).rejects.toThrow(/HTTP 503/);
    expect(io.read).not.toHaveBeenCalled();
    expect(io.write).not.toHaveBeenCalled();
  });

  it('does not read or write when a live catalog fails', async () => {
    const io = ioWith('{"keep":{"id":"keep"}}');
    const failing = fetchers({
      commandcodeModels: async () => {
        throw new Error('commandcode models returned HTTP 500');
      },
    });

    await expect(refreshModelCatalog(io, failing)).rejects.toThrow(/HTTP 500/);
    expect(io.read).not.toHaveBeenCalled();
    expect(io.write).not.toHaveBeenCalled();
  });

  it.each([
    ['models.dev has no opencode-go models', { modelsDev: async () => ({ commandcode: { models: { x: { id: 'x' } } } }) }, /no opencode-go models/],
    ['models.dev has no commandcode models', { modelsDev: async () => ({ 'opencode-go': { models: { x: { id: 'x' } } } }) }, /no commandcode models/],
    ['models.dev has an empty opencode-go map', { modelsDev: async () => ({ 'opencode-go': { models: {} }, commandcode: { models: { x: { id: 'x' } } } }) }, /no opencode-go models/],
    ['the opencode-go list is empty', { opencodeModels: async () => [] }, /opencode-go returned no models/],
    ['the commandcode list is empty', { commandcodeModels: async () => [] }, /commandcode returned no models/],
  ])('rejects without reading or writing when %s', async (_label, overrides, message) => {
    const io = ioWith('{"keep":{"id":"keep"}}');

    await expect(refreshModelCatalog(io, fetchers(overrides))).rejects.toThrow(message);
    expect(io.read).not.toHaveBeenCalled();
    expect(io.write).not.toHaveBeenCalled();
  });

  it('refuses to remove more than half of the current models', async () => {
    const io = ioWith(
      JSON.stringify({ a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' }, d: { id: 'd' }, e: { id: 'e' } }),
    );
    const shrinking = fetchers({
      modelsDev: async () => ({
        'opencode-go': { models: { a: { id: 'a' } } },
        commandcode: { models: { b: { id: 'b' } } },
      }),
      opencodeModels: async () => [{ id: 'a' }],
      commandcodeModels: async () => [{ id: 'b' }],
    });

    await expect(refreshModelCatalog(io, shrinking)).rejects.toThrow(
      /remove 3 of 5 models \(60%\)/,
    );
    expect(io.write).not.toHaveBeenCalled();
  });

  it('allows the shrink when the caller opts in', async () => {
    const io = ioWith(
      JSON.stringify({ a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' }, d: { id: 'd' }, e: { id: 'e' } }),
    );
    const shrinking = fetchers({
      modelsDev: async () => ({
        'opencode-go': { models: { a: { id: 'a' } } },
        commandcode: { models: { b: { id: 'b' } } },
      }),
      opencodeModels: async () => [{ id: 'a' }],
      commandcodeModels: async () => [{ id: 'b' }],
    });

    const result = await refreshModelCatalog(io, shrinking, { allowShrink: true });

    expect(result.removed).toEqual(['c', 'd', 'e']);
    expect(io.write).toHaveBeenCalledTimes(1);
  });

  it('allows a shrink of exactly half', async () => {
    const io = ioWith(
      JSON.stringify({ a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' }, d: { id: 'd' } }),
    );
    const shrinking = fetchers({
      modelsDev: async () => ({
        'opencode-go': { models: { a: { id: 'a' } } },
        commandcode: { models: { b: { id: 'b' } } },
      }),
      opencodeModels: async () => [{ id: 'a' }],
      commandcodeModels: async () => [{ id: 'b' }],
    });

    const result = await refreshModelCatalog(io, shrinking);

    expect(result.removed).toEqual(['c', 'd']);
    expect(io.write).toHaveBeenCalledTimes(1);
  });

  it('refuses to overwrite a malformed current file', async () => {
    const io = ioWith('{ not json');

    await expect(refreshModelCatalog(io, fetchers(), { dryRun: false })).rejects.toThrow();
    expect(io.write).not.toHaveBeenCalled();
  });
});

describe('formatCatalogDiff', () => {
  it('renders an empty catalog as added entries', () => {
    const diff = formatCatalogDiff(null, { a: { id: 'a' } });

    expect(diff).toContain('+ "a": {');
  });

  it('renders removed entries and reports no changes', () => {
    expect(formatCatalogDiff({ ghost: { id: 'ghost' } }, {})).toContain('- "ghost": {');
    expect(formatCatalogDiff({ a: { id: 'a' } }, { a: { id: 'a' } })).toBe('no changes');
  });

  it('renders a field-level diff for changed entries', () => {
    const diff = formatCatalogDiff(
      { a: { id: 'a', name: 'Old' } },
      { a: { id: 'a', name: 'New' } },
    );

    expect(diff).toContain('~ a');
    expect(diff).toContain('-   "name": "Old"');
    expect(diff).toContain('+   "name": "New"');
  });

  it('renders lines appended to or removed from a changed entry', () => {
    const added = formatCatalogDiff(
      { a: { id: 'a', name: 'Same' } },
      { a: { id: 'a', name: 'Same', tool_call: true } },
    );
    const removed = formatCatalogDiff(
      { a: { id: 'a', name: 'Same', tool_call: true } },
      { a: { id: 'a', name: 'Same' } },
    );

    expect(added).toContain('+   "tool_call": true');
    expect(removed).toContain('-   "tool_call": true');
  });

  it('keeps unchanged lines inside a changed entry, and inserted ones before them', () => {
    const diff = formatCatalogDiff(
      { a: { first: 1, keep: 'same' } },
      { a: { first: 9, inserted: true, keep: 'same' } },
    );

    expect(diff).toContain('-   "first": 1,');
    expect(diff).toContain('+   "inserted": true,');
    expect(diff).toContain('    "keep": "same"');
  });

  it('walks an inserted line that precedes a common one', () => {
    const diff = formatCatalogDiff(
      { a: { id: 'a', name: 'Same', tail: 1 } },
      { a: { id: 'a', extra: true, name: 'Same', tail: 2 } },
    );

    expect(diff).toContain('+   "extra": true,');
    expect(diff).toContain('    "name": "Same",');
    expect(diff).toContain('-   "tail": 1');
  });
});
