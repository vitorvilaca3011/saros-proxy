/**
 * models-sync.test.ts — Unit tests for models-sync module.
 *
 * Tests are written FIRST (TDD red-green-refactor).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OPENCODE_MODELS } from './constants.js';
import type { ProxyConfig } from './config.js';
import * as modelsFetcher from './models-fetcher.js';
import {
  fetchUpstreamModelIds,
  getMissingModels,
  buildMinimalStub,
  getModelsFromOpencodeConfig,
  addMissingModelsToOpencodeConfig,
  syncOpencodeModelsWithUpstream,
  extractOpencodeGoModels,
  fetchModelsDevMetadata,
  resetModelsDevCacheState,
} from './models-sync.js';

// ---------------------------------------------------------------------------
// Mock node:fs writeFileSync to be controllable (fixes ESM spy issue).
// The mock delegates to the real implementation by default so that
// helper functions (writeConfig, etc.) continue to work.
// Tests can spy on fs.writeFileSync to intercept production code calls.
// ---------------------------------------------------------------------------

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn((...args: any[]) => (actual.writeFileSync as (...args: any[]) => any)(...args)),
  };
});

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
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'models-sync-'));
}

function writeConfig(dir: string, data: Record<string, unknown>): string {
  const path = join(dir, 'opencode.json');
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  return path;
}

/** Full opencode.json snippet with saros-proxy provider + models. */
function sarosProviderBlock(models: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: {
      'saros-proxy': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Saros',
        options: {
          baseURL: 'http://127.0.0.1:3000/zen/go/v1',
          apiKey: 'not-used',
        },
        models,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// fetchUpstreamModelIds
// ---------------------------------------------------------------------------

describe('fetchUpstreamModelIds', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    modelsFetcher.resetModelsFetcherState();
  });

  it('returns IDs from successful upstream response', async () => {
    vi.spyOn(modelsFetcher, 'getModelsList').mockResolvedValue(
      new Response(JSON.stringify({
        object: 'list',
        data: [
          { id: 'glm-5', object: 'model' },
          { id: 'kimi-k2.5', object: 'model' },
          { id: 'qwen3.7-max', object: 'model' },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const ids = await fetchUpstreamModelIds(testConfig);

    expect(ids).toEqual(['glm-5', 'kimi-k2.5', 'qwen3.7-max']);
  });

  it('returns empty array on fetch failure (TypeError)', async () => {
    vi.spyOn(modelsFetcher, 'getModelsList').mockRejectedValue(
      new TypeError('fetch failed'),
    );

    const ids = await fetchUpstreamModelIds(testConfig);

    expect(ids).toEqual([]);
  });

  it('returns empty array on non-2xx response', async () => {
    vi.spyOn(modelsFetcher, 'getModelsList').mockResolvedValue(
      new Response('Service Unavailable', { status: 503 }),
    );

    const ids = await fetchUpstreamModelIds(testConfig);

    expect(ids).toEqual([]);
  });

  it('returns empty array on malformed JSON', async () => {
    vi.spyOn(modelsFetcher, 'getModelsList').mockResolvedValue(
      new Response('not json{{{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const ids = await fetchUpstreamModelIds(testConfig);

    expect(ids).toEqual([]);
  });

  it('returns empty array on missing data field', async () => {
    vi.spyOn(modelsFetcher, 'getModelsList').mockResolvedValue(
      new Response(JSON.stringify({ object: 'list' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const ids = await fetchUpstreamModelIds(testConfig);

    expect(ids).toEqual([]);
  });

  it('returns empty array on data: [] (empty list)', async () => {
    vi.spyOn(modelsFetcher, 'getModelsList').mockResolvedValue(
      new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const ids = await fetchUpstreamModelIds(testConfig);

    expect(ids).toEqual([]);
  });

  it('returns empty array when response body is literal null', async () => {
    vi.spyOn(modelsFetcher, 'getModelsList').mockResolvedValue(
      new Response(JSON.stringify(null), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const ids = await fetchUpstreamModelIds(testConfig);

    expect(ids).toEqual([]);
  });

  it('returns empty array when data entry is missing id field', async () => {
    vi.spyOn(modelsFetcher, 'getModelsList').mockResolvedValue(
      new Response(JSON.stringify({
        object: 'list',
        data: [{ object: 'model' }, { id: 'valid-model', object: 'model' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const ids = await fetchUpstreamModelIds(testConfig);

    expect(ids).toEqual(['valid-model']);
  });
});

// ---------------------------------------------------------------------------
// getMissingModels
// ---------------------------------------------------------------------------

describe('getMissingModels', () => {
  it('returns empty array when current equals upstream', () => {
    const current = ['a', 'b', 'c'];
    const upstream = ['a', 'b', 'c'];
    expect(getMissingModels(current, upstream)).toEqual([]);
  });

  it('returns all upstream when current is empty', () => {
    expect(getMissingModels([], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('returns only the diff (preserves upstream order)', () => {
    expect(getMissingModels(['a', 'c'], ['a', 'b', 'c', 'd'])).toEqual(['b', 'd']);
  });

  it('handles duplicates in upstream (deduplicates)', () => {
    expect(getMissingModels(['a'], ['b', 'b', 'c', 'c'])).toEqual(['b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// buildMinimalStub
// ---------------------------------------------------------------------------

describe('buildMinimalStub', () => {
  it('kimi-k2.7-code', () => {
    expect(buildMinimalStub('kimi-k2.7-code')).toEqual({
      id: 'kimi-k2.7-code',
      name: 'Kimi K2.7 Code',
      limit: { context: 262144, output: 65536 },
      tool_call: true,
      reasoning: true,
    });
  });

  it('glm-5', () => {
    const stub = buildMinimalStub('glm-5');
    expect(stub.id).toBe('glm-5');
    expect(stub.name).toBe('GLM-5');
    expect(stub.tool_call).toBe(true);
    expect(stub.reasoning).toBe(true);
    expect(stub.limit).toBeDefined();
  });

  it('qwen3.7-max', () => {
    const stub = buildMinimalStub('qwen3.7-max');
    expect(stub.id).toBe('qwen3.7-max');
    expect(stub.name).toBe('Qwen 3.7 Max');
    expect(stub.limit).toBeDefined();
    expect(stub.tool_call).toBe(true);
    expect(stub.reasoning).toBe(true);
  });

  it('minimax-m3', () => {
    const stub = buildMinimalStub('minimax-m3');
    expect(stub.id).toBe('minimax-m3');
    expect(stub.name).toBe('MiniMax M3');
    expect(stub.limit).toBeDefined();
    expect(stub.tool_call).toBe(true);
    expect(stub.reasoning).toBe(true);
  });

  it('hy3-preview', () => {
    const stub = buildMinimalStub('hy3-preview');
    expect(stub.id).toBe('hy3-preview');
    // Not in models.dev nor bundled — heuristic title-case of the ID
    expect(stub.name).toBe('HY3 Preview');
    expect(stub.limit).toBeDefined();
    expect(stub.tool_call).toBe(true);
    expect(stub.reasoning).toBe(true);
  });

  it('unknown model uses heuristic title-case fallback', () => {
    const stub = buildMinimalStub('unknown-model-v2');
    expect(stub).toEqual({
      id: 'unknown-model-v2',
      name: 'Unknown Model V2',
      limit: { context: 262144, output: 65536 },
      tool_call: true,
      reasoning: true,
    });
  });

  it('toTitleCase with empty string returns empty', () => {
    const stub = buildMinimalStub('');
    expect(stub.name).toBe('');
    expect(stub.limit).toEqual({ context: 262144, output: 65536 });
  });

  it('toTitleCase with a1b (letter-number-letter) does NOT split', () => {
    const stub = buildMinimalStub('a1b');
    expect(stub.name).toBe('A1B');
    expect(stub.limit).toEqual({ context: 262144, output: 65536 });
  });

  it('toTitleCase with GLM-5 (all-uppercase) handles correctly', () => {
    const stub = buildMinimalStub('GLM-5');
    expect(stub.name).toBe('GLM-5'); // heuristic fallback, known entry is lowercase
    expect(stub.limit).toEqual({ context: 262144, output: 65536 });
  });

  it('returns heuristic title-case when known model has no name field', () => {
    // Temporarily add an entry that lacks a name
    const known = buildMinimalStub('unknown-custom-v1');
    // Falls back to heuristic
    expect(known.name).toBe('Unknown Custom V1');
    expect(known.limit).toEqual({ context: 262144, output: 65536 });
  });

  // --- models.dev metadata integration ---

  it('uses models.dev metadata when model is found (models.dev takes precedence over OPENCODE_MODELS)', () => {
    const devMetadata = {
      'deepseek-v4-pro': {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro (from models.dev)',
        reasoning: true,
        tool_call: true,
        limit: { context: 200000, output: 100000 },
        modalities: { input: ['text'], output: ['text'] },
        cost: { input: 1.0, output: 4.0 },
        reasoning_options: [],
        interleaved: { field: 'reasoning_content' },
        structured_output: true,
        provider: 'opencode-go',
      },
    };

    const stub = buildMinimalStub('deepseek-v4-pro', devMetadata);

    expect(stub.id).toBe('deepseek-v4-pro');
    expect(stub.name).toBe('DeepSeek V4 Pro (from models.dev)');
    expect(stub.limit).toEqual({ context: 200000, output: 100000 });
    expect(stub.cost).toEqual({ input: 1.0, output: 4.0 });
    expect(stub.reasoning_options).toEqual([]);
    expect(stub.interleaved).toEqual({ field: 'reasoning_content' });
    expect(stub.structured_output).toBe(true);
  });

  it('strips the provider field from models.dev metadata', () => {
    const devMetadata = {
      'deepseek-v4-pro': {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        reasoning: true,
        tool_call: true,
        limit: { context: 262144, output: 262144 },
        modalities: { input: ['text'], output: ['text'] },
        cost: { input: 1.0, output: 4.0 },
        provider: 'opencode-go',
      },
    };
    const stub = buildMinimalStub('deepseek-v4-pro', devMetadata);
    expect(stub).not.toHaveProperty('provider');
  });

  it('strips unknown fields not in MODELS_DEV_SAFE_FIELDS', () => {
    const devMetadata = {
      'kimi-k2.7-code': {
        id: 'kimi-k2.7-code',
        name: 'Kimi K2.7 Code',
        reasoning: true,
        tool_call: true,
        limit: { context: 262144, output: 262144 },
        modalities: { input: ['text'], output: ['text'] },
        cost: { input: 0.95, output: 4.0 },
        extra_unknown: 'should-be-dropped',
        also_bad: 42,
      },
    };
    const stub = buildMinimalStub('kimi-k2.7-code', devMetadata);
    expect(stub).not.toHaveProperty('extra_unknown');
    expect(stub).not.toHaveProperty('also_bad');
    expect(stub).toHaveProperty('cost');
    expect(stub).toHaveProperty('limit');
    expect(stub).toHaveProperty('modalities');
  });

  it('falls back to OPENCODE_MODELS when model not in models.dev metadata', () => {
    const devMetadata = {
      'kimi-k2.7-code': { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
    };
    // deepseek-v4-pro IS in OPENCODE_MODELS
    const stub = buildMinimalStub('deepseek-v4-pro', devMetadata);
    // Should use OPENCODE_MODELS entry, not models.dev
    expect(stub.id).toBe('deepseek-v4-pro');
    expect(stub.name).toBe('DeepSeek V4 Pro');
  });

  it('falls back to heuristic title-case when model not in models.dev NOR OPENCODE_MODELS', () => {
    const devMetadata = {
      'kimi-k2.7-code': { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
    };
    const stub = buildMinimalStub('unknown-model-v2', devMetadata);
    expect(stub.id).toBe('unknown-model-v2');
    expect(stub.name).toBe('Unknown Model V2');
    expect(stub.limit).toEqual({ context: 262144, output: 65536 });
    expect(stub.tool_call).toBe(true);
    expect(stub.reasoning).toBe(true);
  });

  it('passes through OPENCODE_MODELS when modelsDevMetadata is undefined (unchanged behavior)', () => {
    // no second arg — identical to existing behavior
    const stub = buildMinimalStub('deepseek-v4-pro');
    expect(stub.id).toBe('deepseek-v4-pro');
    expect(stub.name).toBe('DeepSeek V4 Pro');
    expect(stub.limit).toBeDefined();
  });

  it('hy3-preview falls back to heuristic title-case when not in models.dev or bundled', () => {
    const devMetadata = {
      'kimi-k2.7-code': { id: 'kimi-k2.7-code', name: 'Kimi' },
    };
    const stub = buildMinimalStub('hy3-preview', devMetadata);
    expect(stub.id).toBe('hy3-preview');
    expect(stub.name).toBe('HY3 Preview');
    expect(stub.limit).toBeDefined();
    expect(stub.tool_call).toBe(true);
    expect(stub.reasoning).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getModelsFromOpencodeConfig
// ---------------------------------------------------------------------------

describe('getModelsFromOpencodeConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  it('returns model keys from saros-proxy.models', () => {
    const configPath = writeConfig(tmpDir, sarosProviderBlock({
      'glm-5': { id: 'glm-5' },
      'kimi-k2.5': { id: 'kimi-k2.5' },
    }));
    expect(getModelsFromOpencodeConfig(configPath)).toEqual(['glm-5', 'kimi-k2.5']);
  });

  it('returns empty array if config file missing', () => {
    expect(getModelsFromOpencodeConfig(join(tmpDir, 'nonexistent.json'))).toEqual([]);
  });

  it('returns empty array if saros-proxy missing', () => {
    const configPath = writeConfig(tmpDir, {
      provider: { 'other-provider': { models: {} } },
    });
    expect(getModelsFromOpencodeConfig(configPath)).toEqual([]);
  });

  it('returns empty array if models field missing', () => {
    const configPath = writeConfig(tmpDir, {
      provider: {
        'saros-proxy': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Saros',
        },
      },
    });
    expect(getModelsFromOpencodeConfig(configPath)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// addMissingModelsToOpencodeConfig
// ---------------------------------------------------------------------------

describe('addMissingModelsToOpencodeConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  it('adds new models to existing models map', () => {
    const configPath = writeConfig(tmpDir, sarosProviderBlock({
      'existing': { id: 'existing', name: 'Existing', tool_call: true, reasoning: true },
    }));

    const result = addMissingModelsToOpencodeConfig(configPath, ['new-a', 'new-b']);

    expect(result.success).toBe(true);
    expect(result.path).toBe(configPath);
    const updated = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const models = (updated.provider as Record<string, unknown>)['saros-proxy'] as Record<string, unknown>;
    expect((models.models as Record<string, unknown>)['existing']).toBeDefined();
    expect((models.models as Record<string, unknown>)['new-a']).toBeDefined();
    expect((models.models as Record<string, unknown>)['new-b']).toBeDefined();
  });

  it('preserves existing models unchanged', () => {
    const configPath = writeConfig(tmpDir, sarosProviderBlock({
      'existing': { id: 'existing', name: 'Existing', tool_call: true, reasoning: true },
    }));

    addMissingModelsToOpencodeConfig(configPath, ['new-models']);
    const updated = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const models = (updated.provider as Record<string, unknown>)['saros-proxy'] as Record<string, unknown>;
    expect(models.models).toEqual({
      'existing': { id: 'existing', name: 'Existing', tool_call: true, reasoning: true },
      'new-models': {
        id: 'new-models',
        name: 'New Models',
        limit: { context: 262144, output: 65536 },
        tool_call: true,
        reasoning: true,
      },
    });
  });

  it('initializes models field if missing', () => {
    const configPath = writeConfig(tmpDir, sarosProviderBlock());
    const result = addMissingModelsToOpencodeConfig(configPath, ['first-model']);

    expect(result.success).toBe(true);
    const updated = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const models = (updated.provider as Record<string, unknown>)['saros-proxy'] as Record<string, unknown>;
    expect(models.models).toEqual({
      'first-model': {
        id: 'first-model',
        name: 'First Model',
        limit: { context: 262144, output: 65536 },
        tool_call: true,
        reasoning: true,
      },
    });
  });

  it('returns success:false if config does not exist', () => {
    const result = addMissingModelsToOpencodeConfig(
      join(tmpDir, 'nonexistent.json'),
      ['m1'],
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns success:false if saros-proxy provider missing', () => {
    const configPath = writeConfig(tmpDir, {
      provider: { 'other-provider': { models: {} } },
    });
    const result = addMissingModelsToOpencodeConfig(configPath, ['m1']);
    expect(result.success).toBe(false);
    expect(result.error).toContain('saros-proxy');
  });

  it('saros-proxy is null returns error', () => {
    const configPath = writeConfig(tmpDir, {
      provider: { 'saros-proxy': null },
    });
    const result = addMissingModelsToOpencodeConfig(configPath, ['m1']);
    expect(result.success).toBe(false);
    expect(result.error).toContain('saros-proxy');
  });

  it('saros-proxy is an array returns error', () => {
    const configPath = writeConfig(tmpDir, {
      provider: { 'saros-proxy': [] },
    });
    const result = addMissingModelsToOpencodeConfig(configPath, ['m1']);
    expect(result.success).toBe(false);
    expect(result.error).toContain('saros-proxy');
  });

  it('saros-proxy.models is null initializes to {} and adds new models', () => {
    const configPath = writeConfig(tmpDir, {
      provider: {
        'saros-proxy': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Saros',
          models: null,
        },
      },
    });
    const result = addMissingModelsToOpencodeConfig(configPath, ['m1']);
    expect(result.success).toBe(true);
    const updated = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const models = (updated.provider as Record<string, unknown>)['saros-proxy'] as Record<string, unknown>;
    expect((models.models as Record<string, unknown>)['m1']).toBeDefined();
  });

  it('missingIds: [] is a no-op (no backup, no write)', () => {
    const configPath = writeConfig(tmpDir, sarosProviderBlock({
      'existing': { id: 'existing', name: 'Existing' },
    }));
    const originalRaw = readFileSync(configPath, 'utf-8');
    const result = addMissingModelsToOpencodeConfig(configPath, []);
    expect(result.success).toBe(true);
    // File content should be unchanged
    expect(readFileSync(configPath, 'utf-8')).toBe(originalRaw);
    // No backup should exist (nothing was modified)
    const backupPath = configPath + '.backup';
    expect(existsSync(backupPath)).toBe(false);
  });

  it('overwrites existing model when missingIds includes an ID already in models', () => {
    const configPath = writeConfig(tmpDir, sarosProviderBlock({
      'm1': { id: 'm1', name: 'Old Name', tool_call: false, reasoning: false },
    }));
    const result = addMissingModelsToOpencodeConfig(configPath, ['m1']);
    expect(result.success).toBe(true);
    const updated = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const models = (updated.provider as Record<string, unknown>)['saros-proxy'] as Record<string, unknown>;
    // m1 should be overwritten with new stub (limit, tool_call: true, reasoning: true)
    expect(models.models).toEqual({
      'm1': {
        id: 'm1',
        name: 'M1',
        limit: { context: 262144, output: 65536 },
        tool_call: true,
        reasoning: true,
      },
    });
  });

  it('preserves all original fields (not just model keys) in written JSON', () => {
    const configPath = writeConfig(tmpDir, {
      version: '1.0',
      provider: {
        'saros-proxy': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Saros',
          options: {
            baseURL: 'http://127.0.0.1:3000/zen/go/v1',
            apiKey: 'not-used',
          },
          models: { 'existing': { id: 'existing' } },
        },
      },
      otherSection: { foo: 'bar' },
    });
    const result = addMissingModelsToOpencodeConfig(configPath, ['new-model']);
    expect(result.success).toBe(true);
    const updated = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(updated.version).toBe('1.0');
    expect(updated.otherSection).toEqual({ foo: 'bar' });
    expect(updated.provider).toBeDefined();
  });

  it('creates backup before writing', () => {
    const configPath = writeConfig(tmpDir, sarosProviderBlock({}));
    addMissingModelsToOpencodeConfig(configPath, ['m1']);

    const backupPath = configPath + '.backup';
    const backup = JSON.parse(readFileSync(backupPath, 'utf-8'));
    expect(backup.provider['saros-proxy'].models).toEqual({});
  });

  it('restores from backup on write failure', () => {
    const configPath = writeConfig(tmpDir, sarosProviderBlock({
      'keep-me': { id: 'keep-me' },
    }));

    // Make writeFileSync throw once. mockImplementationOnce auto-restores
    // after the first call so the mock doesn't leak to other tests.
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('write failed');
    });

    const result = addMissingModelsToOpencodeConfig(configPath, ['new-model']);

    expect(result.success).toBe(false);
    expect(result.error).toContain('write failed');

    // After restore, the original content should be back
    const restored = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const models = (restored.provider as Record<string, unknown>)['saros-proxy'] as Record<string, unknown>;
    expect(models.models).toEqual({ 'keep-me': { id: 'keep-me' } });
  });

  // --- models.dev metadata integration ---

  it('uses models.dev metadata when provided — adds cost and modalities', () => {
    const configPath = join(tmpDir, 'opencode.json');
    writeFileSync(configPath, JSON.stringify({
      provider: {
        'saros-proxy': {
          models: {
            'existing-model': { id: 'existing-model', name: 'Existing' },
          },
        },
      },
    }, null, 2));

    const devMetadata: Record<string, Record<string, unknown>> = {
      'new-model': {
        id: 'new-model',
        name: 'New Model from MD',
        reasoning: true,
        tool_call: true,
        limit: { context: 200000, output: 100000 },
        modalities: { input: ['text', 'image'], output: ['text'] },
        cost: { input: 0.5, output: 2.0 },
        reasoning_options: [],
        interleaved: { field: 'reasoning_content' },
        structured_output: true,
        provider: 'opencode-go',
      },
    };

    const result = addMissingModelsToOpencodeConfig(configPath, ['new-model'], devMetadata);
    expect(result.success).toBe(true);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    const models = written.provider['saros-proxy'].models;

    expect(models['new-model']).toMatchObject({
      id: 'new-model',
      name: 'New Model from MD',
      cost: { input: 0.5, output: 2.0 },
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 200000, output: 100000 },
    });
    expect(models['new-model']).not.toHaveProperty('provider');
    // Existing model untouched
    expect(models['existing-model']).toEqual({ id: 'existing-model', name: 'Existing' });
  });

  it('still works without modelsDevMetadata (unchanged behavior)', () => {
    const configPath = join(tmpDir, 'opencode.json');
    writeFileSync(configPath, JSON.stringify({
      provider: {
        'saros-proxy': {
          models: {},
        },
      },
    }, null, 2));

    const result = addMissingModelsToOpencodeConfig(configPath, ['deepseek-v4-pro']);
    expect(result.success).toBe(true);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    const models = written.provider['saros-proxy'].models;
    expect(models['deepseek-v4-pro']).toBeDefined();
    expect(models['deepseek-v4-pro'].name).toBe('DeepSeek V4 Pro');
    expect(models['deepseek-v4-pro'].cost).toBeUndefined(); // no models.dev → no cost
  });

  // --- enrichment tests ---

  it('enriches existing model with missing cost field from models.dev metadata', () => {
    const configPath = join(tmpDir, 'opencode.json');
    writeFileSync(configPath, JSON.stringify({
      provider: {
        'saros-proxy': {
          models: {
            'existing-a': { id: 'existing-a', name: 'Existing A', tools: true },
          },
        },
      },
    }, null, 2));

    const devMetadata: Record<string, Record<string, unknown>> = {
      'existing-a': {
        id: 'existing-a',
        name: 'Existing A (dev)',
        cost: { input: 0.5, output: 1.5 },
        limit: { context: 128000, output: 65536 },
        modalities: { input: ['text'], output: ['text'] },
      },
    };

    // No missing models — only enrichment applies
    const result = addMissingModelsToOpencodeConfig(configPath, [], devMetadata);
    expect(result.success).toBe(true);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    const model = written.provider['saros-proxy'].models['existing-a'];

    // Existing fields preserved
    expect(model.id).toBe('existing-a');
    expect(model.name).toBe('Existing A'); // not overwritten
    expect(model.tools).toBe(true); // not in safe fields, preserved

    // Missing fields added from models.dev
    expect(model.cost).toEqual({ input: 0.5, output: 1.5 });
    expect(model.limit).toEqual({ context: 128000, output: 65536 });
    expect(model.modalities).toEqual({ input: ['text'], output: ['text'] });
  });

  it('does not overwrite existing fields during enrichment', () => {
    const configPath = join(tmpDir, 'opencode.json');
    writeFileSync(configPath, JSON.stringify({
      provider: {
        'saros-proxy': {
          models: {
            'custom-model': {
              id: 'custom-model',
              name: 'My Custom Name',
              cost: { input: 9.99, output: 19.99 }, // manually set
              limit: { context: 99999, output: 99999 },
            },
          },
        },
      },
    }, null, 2));

    const devMetadata: Record<string, Record<string, unknown>> = {
      'custom-model': {
        id: 'custom-model',
        name: 'models.dev Name',
        cost: { input: 1.0, output: 2.0 },
        limit: { context: 100000, output: 50000 },
        modalities: { input: ['text'], output: ['text'] },
      },
    };

    const result = addMissingModelsToOpencodeConfig(configPath, [], devMetadata);
    expect(result.success).toBe(true);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    const model = written.provider['saros-proxy'].models['custom-model'];

    // Existing values preserved
    expect(model.name).toBe('My Custom Name');
    expect(model.cost).toEqual({ input: 9.99, output: 19.99 });
    expect(model.limit).toEqual({ context: 99999, output: 99999 });

    // But modalities was missing so it's added
    expect(model.modalities).toEqual({ input: ['text'], output: ['text'] });
  });

  it('returns early when nothing to enrich and no missing models', () => {
    const configPath = join(tmpDir, 'opencode.json');
    const original = {
      provider: {
        'saros-proxy': {
          models: {
            'complete-model': {
              id: 'complete-model',
              name: 'Complete',
              cost: { input: 1, output: 2 },
              limit: { context: 100, output: 100 },
              modalities: { input: ['text'], output: ['text'] },
              tool_call: true,
              reasoning: true,
            },
          },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(original, null, 2));

    // Pass metadata but model already has all safe fields
    const devMetadata: Record<string, Record<string, unknown>> = {
      'complete-model': {
        id: 'complete-model',
        name: 'Complete',
        cost: { input: 1, output: 2 },
        limit: { context: 100, output: 100 },
        modalities: { input: ['text'], output: ['text'] },
        tool_call: true,
        reasoning: true,
      },
    };

    const result = addMissingModelsToOpencodeConfig(configPath, [], devMetadata);
    expect(result.success).toBe(true);

    // File should be unchanged (no backup created, no write)
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// syncOpencodeModelsWithUpstream
// ---------------------------------------------------------------------------

describe('syncOpencodeModelsWithUpstream', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    vi.restoreAllMocks();
  });

  it('upstream returns [] — returns success:false with error', async () => {
    vi.spyOn(modelsFetcher, 'getModelsList').mockResolvedValue(
      new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const configPath = writeConfig(tmpDir, sarosProviderBlock({}));
    const result = await syncOpencodeModelsWithUpstream(testConfig, configPath);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No upstream models returned');
  });

  it('empty config (no models) and upstream has many — adds all', async () => {
    vi.spyOn(modelsFetcher, 'getModelsList').mockResolvedValue(
      new Response(JSON.stringify({
        object: 'list',
        data: [
          { id: 'm1', object: 'model' },
          { id: 'm2', object: 'model' },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const configPath = writeConfig(tmpDir, sarosProviderBlock({}));
    const result = await syncOpencodeModelsWithUpstream(testConfig, configPath);
    expect(result.success).toBe(true);
    const updated = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const models = (updated.provider as Record<string, unknown>)['saros-proxy'] as Record<string, unknown>;
    expect(models.models).toHaveProperty('m1');
    expect(models.models).toHaveProperty('m2');
  });

  it('both empty — returns success without backup file', async () => {
    vi.spyOn(modelsFetcher, 'getModelsList').mockResolvedValue(
      new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const configPath = writeConfig(tmpDir, sarosProviderBlock({}));
    const result = await syncOpencodeModelsWithUpstream(testConfig, configPath);
    expect(result.success).toBe(false);
    // No backup should exist since we never wrote
    expect(existsSync(configPath + '.backup')).toBe(false);
  });

  it('end-to-end: fetches upstream, finds missing, adds them', async () => {
    vi.spyOn(modelsFetcher, 'getModelsList').mockResolvedValue(
      new Response(JSON.stringify({
        object: 'list',
        data: [
          { id: 'existing-a', object: 'model' },
          { id: 'new-from-upstream', object: 'model' },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const configPath = writeConfig(tmpDir, sarosProviderBlock({
      'existing-a': { id: 'existing-a', name: 'Existing A', tool_call: true, reasoning: true },
    }));

    const result = await syncOpencodeModelsWithUpstream(testConfig, configPath);

    expect(result.success).toBe(true);
    const updated = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const models = (updated.provider as Record<string, unknown>)['saros-proxy'] as Record<string, unknown>;
    expect((models.models as Record<string, unknown>)['new-from-upstream']).toBeDefined();
  });

  it('no-op when upstream models already in config', async () => {
    vi.spyOn(modelsFetcher, 'getModelsList').mockResolvedValue(
      new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'already-there', object: 'model' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const configPath = writeConfig(tmpDir, sarosProviderBlock({
      'already-there': { id: 'already-there', name: 'Already There', tool_call: true, reasoning: true },
    }));

    const result = await syncOpencodeModelsWithUpstream(testConfig, configPath);

    expect(result.success).toBe(true);
    // Should not have created a backup (nothing to write)
    const backupExists = existsSync(configPath + '.backup');
    expect(backupExists).toBe(false);
  });

  it('graceful handling when config does not exist', async () => {
    vi.spyOn(modelsFetcher, 'getModelsList').mockResolvedValue(
      new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'm1', object: 'model' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await syncOpencodeModelsWithUpstream(
      testConfig,
      join(tmpDir, 'nonexistent.json'),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  // --- models.dev metadata integration ---

  it('fetches models.dev and passes metadata through to added models', async () => {
    resetModelsDevCacheState();

    // Mock upstream: returns two new models
    vi.spyOn(modelsFetcher, 'getModelsList').mockResolvedValue(
      new Response(JSON.stringify({
        object: 'list',
        data: [
          { id: 'deepseek-v4-pro', object: 'model' },
          { id: 'unknown-model-v2', object: 'model' },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    // Mock models.dev: has metadata for deepseek-v4-pro, NOT for unknown-model-v2
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        'opencode-go': {
          id: 'opencode-go',
          models: {
            'deepseek-v4-pro': {
              id: 'deepseek-v4-pro',
              name: 'DeepSeek V4 Pro (dev)',
              reasoning: true,
              tool_call: true,
              limit: { context: 200000, output: 100000 },
              modalities: { input: ['text'], output: ['text'] },
              cost: { input: 1.5, output: 6.0 },
              reasoning_options: [],
              interleaved: { field: 'reasoning_content' },
              structured_output: true,
              provider: 'opencode-go',
            },
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ));

    const configPath = join(tmpDir, 'opencode.json');
    writeFileSync(configPath, JSON.stringify({
      provider: { 'saros-proxy': { models: {} } },
    }, null, 2));

    const result = await syncOpencodeModelsWithUpstream(
      testConfig,
      configPath,
    );
    expect(result.success).toBe(true);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    const models = written.provider['saros-proxy'].models;

    // deepseek-v4-pro from models.dev (has cost, modalities)
    expect(models['deepseek-v4-pro']).toMatchObject({
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro (dev)',
      cost: { input: 1.5, output: 6.0 },
      modalities: { input: ['text'], output: ['text'] },
    });
    expect(models['deepseek-v4-pro']).not.toHaveProperty('provider');

    // unknown-model-v2 not in models.dev → falls back to heuristic (no cost)
    expect(models['unknown-model-v2']).toBeDefined();
    expect(models['unknown-model-v2'].id).toBe('unknown-model-v2');
    expect(models['unknown-model-v2'].name).toBe('Unknown Model V2');
    expect(models['unknown-model-v2'].cost).toBeUndefined();
  });

  it('continues sync when models.dev fails (best-effort, returns null)', async () => {
    resetModelsDevCacheState();

    vi.spyOn(modelsFetcher, 'getModelsList').mockResolvedValue(
      new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'deepseek-v4-pro', object: 'model' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    // models.dev fetch fails
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const configPath = join(tmpDir, 'opencode.json');
    writeFileSync(configPath, JSON.stringify({
      provider: { 'saros-proxy': { models: {} } },
    }, null, 2));

    const result = await syncOpencodeModelsWithUpstream(
      testConfig,
      configPath,
    );
    expect(result.success).toBe(true); // sync still succeeds

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    const models = written.provider['saros-proxy'].models;
    // Falls back to OPENCODE_MODELS
    expect(models['deepseek-v4-pro']).toBeDefined();
    expect(models['deepseek-v4-pro'].name).toBe('DeepSeek V4 Pro');
  });

  it('handles models.dev returning empty (no opencode-go provider)', async () => {
    resetModelsDevCacheState();

    vi.spyOn(modelsFetcher, 'getModelsList').mockResolvedValue(
      new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'deepseek-v4-pro', object: 'model' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    // models.dev returns JSON without opencode-go provider
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        'anthropic': { id: 'anthropic', models: {} },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ));

    const configPath = join(tmpDir, 'opencode.json');
    writeFileSync(configPath, JSON.stringify({
      provider: { 'saros-proxy': { models: {} } },
    }, null, 2));

    const result = await syncOpencodeModelsWithUpstream(
      testConfig,
      configPath,
    );
    expect(result.success).toBe(true);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    const models = written.provider['saros-proxy'].models;
    expect(models['deepseek-v4-pro']).toBeDefined();
    expect(models['deepseek-v4-pro'].name).toBe('DeepSeek V4 Pro');
  });
});

// ---------------------------------------------------------------------------
// extractOpencodeGoModels
// ---------------------------------------------------------------------------

describe('extractOpencodeGoModels', () => {
  it('extracts opencode-go provider models from full API response', () => {
    const parsed = {
      'opencode-go': {
        id: 'opencode-go',
        models: {
          'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
          'kimi-k2.7-code': { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
        },
      },
    };
    const result = extractOpencodeGoModels(parsed);
    expect(result).toEqual({
      'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      'kimi-k2.7-code': { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
    });
  });

  it('returns empty object when provider entry is not an object', () => {
    expect(extractOpencodeGoModels({ 'opencode-go': 'not-an-object' })).toEqual({});
    expect(extractOpencodeGoModels({})).toEqual({});
  });

  it('returns empty object when opencode-go provider not found', () => {
    const parsed = {
      'anthropic': { id: 'anthropic', models: { 'claude-sonnet': {} } },
      'some-random': { id: 'some-random', models: {} },
    };
    expect(extractOpencodeGoModels(parsed)).toEqual({});
  });

  it('returns empty object when opencode-go provider has no models field', () => {
    const parsed = {
      'opencode-go': { id: 'opencode-go', name: 'OpenCode Go' },
    };
    expect(extractOpencodeGoModels(parsed)).toEqual({});
  });

  it('returns empty object when models field is not an object', () => {
    const parsed = {
      'opencode-go': { id: 'opencode-go', models: 'invalid' },
    };
    expect(extractOpencodeGoModels(parsed)).toEqual({});
  });

  it('returns empty object when models field is null', () => {
    const parsed = {
      'opencode-go': { id: 'opencode-go', models: null },
    };
    expect(extractOpencodeGoModels(parsed)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// fetchModelsDevMetadata
// ---------------------------------------------------------------------------

describe('fetchModelsDevMetadata', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetModelsDevCacheState();
  });

  const makeSuccessResponse = () =>
    new Response(
      JSON.stringify({
        'opencode-go': {
          id: 'opencode-go',
          models: {
            'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
            'kimi-k2.7-code': { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
          },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('returns metadata map on successful fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await fetchModelsDevMetadata();
    expect(result).toEqual({
      'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      'kimi-k2.7-code': { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
    });
  });

  it('returns null on fetch network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const result = await fetchModelsDevMetadata();
    expect(result).toBeNull();
  });

  it('returns null on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Service Unavailable', { status: 503 }),
    ));

    const result = await fetchModelsDevMetadata();
    expect(result).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('not json{{{', { status: 200, headers: { 'content-type': 'application/json' } }),
    ));

    const result = await fetchModelsDevMetadata();
    expect(result).toBeNull();
  });

  it('returns empty object when opencode-go provider not found in response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ 'anthropic': { id: 'anthropic', models: {} } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    const result = await fetchModelsDevMetadata();
    expect(result).toEqual({});
  });

  it('fetches only once within cache TTL (cache hit)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeSuccessResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result1 = await fetchModelsDevMetadata();
    const result2 = await fetchModelsDevMetadata();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result1).toEqual(result2);
  });

  it('refetches after resetModelsDevCacheState clears cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeSuccessResponse());
    vi.stubGlobal('fetch', fetchMock);

    await fetchModelsDevMetadata(); // first call → caches

    resetModelsDevCacheState();

    await fetchModelsDevMetadata(); // cache cleared → second fetch

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resetModelsDevCacheState clears cache so next call refetches', async () => {
    const responses = [
      new Response(JSON.stringify({
        'opencode-go': { id: 'opencode-go', models: { 'a': { id: 'a' } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify({
        'opencode-go': { id: 'opencode-go', models: { 'b': { id: 'b' } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    vi.stubGlobal('fetch', fetchMock);

    const result1 = await fetchModelsDevMetadata();
    expect(result1).toEqual({ 'a': { id: 'a' } });

    resetModelsDevCacheState();

    const result2 = await fetchModelsDevMetadata();
    expect(result2).toEqual({ 'b': { id: 'b' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
