/**
 * harness-config.test.ts — Unit tests for pi/omp harness config sync,
 * harness-selection settings, and the multi-harness orchestrator.
 *
 * Fixtures are deliberately rich (extra providers, unrelated top-level
 * keys, nested settings) to prove saros only touches
 * `providers["saros-proxy"].models`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { join, sep, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// os.homedir() caches its result, so a process.env.HOME override is ignored.
// Mock homedir() to a mutable ref so settings-path tests stay in tmp dirs.
const mockHomeRef = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockHomeRef.current };
});

// Wrap fs read/write in spies (defaulting to the real implementations) so
// error paths like corrupt post-write validation and write failures can be
// simulated per-call.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    writeFileSync: vi.fn(real.writeFileSync),
    readFileSync: vi.fn(real.readFileSync),
  };
});

// Live (non-offline) model-sync paths hit the network; stub them so
// buildCanonicalModels/syncModelsInAllHarnesses tests stay deterministic.
vi.mock('../src/models-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/models-sync.js')>();
  return {
    ...actual,
    fetchUpstreamModelIds: vi.fn(),
    fetchModelsDevMetadata: vi.fn(),
    buildMinimalStub: vi.fn(),
    syncOpencodeModelsWithUpstream: vi.fn(),
  };
});

import {
  buildCanonicalModels,
  toPiOmpModel,
  toPiOmpModelArray,
} from '../src/cli/harness-models.js';
import { syncModelsToPiConfig } from '../src/cli/pi-config.js';
import { syncModelsToOmpConfig } from '../src/cli/omp-config.js';
import { loadModelsFromJson } from '../src/cli/opencode-config.js';
import {
  fetchUpstreamModelIds,
  fetchModelsDevMetadata,
  buildMinimalStub,
  syncOpencodeModelsWithUpstream,
} from '../src/models-sync.js';
import type { ProxyConfig } from '../src/config.js';
import {
  parseHarnessArgs,
  readHarnessSettings,
  writeHarnessSettings,
  syncModelsInAllHarnesses,
} from '../src/cli/harness-sync.js';

const mockedFs = vi.mocked(fs);
const mockedFetchUpstreamIds = vi.mocked(fetchUpstreamModelIds);
const mockedFetchModelsDevMetadata = vi.mocked(fetchModelsDevMetadata);
const mockedBuildMinimalStub = vi.mocked(buildMinimalStub);
const mockedSyncOpencodeUpstream = vi.mocked(syncOpencodeModelsWithUpstream);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
  return mkdtempSync(`${tmpdir()}${sep}harness-config-test-`);
}

async function removeTempDir(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  const maxRetries = 5;
  const retryDelay = 500;
  for (let i = 0; i < maxRetries; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay });
      return;
    } catch {
      if (i === maxRetries - 1) {
        console.warn(`Failed to remove temp dir ${dir}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}

/** Two-entry canonical model map (opencode-shaped). */
const TEST_MODELS_MAP: Record<string, unknown> = {
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    tool_call: true,
    reasoning: true,
    limit: { context: 1000000, output: 384000 },
    modalities: { input: ['text'], output: ['text'] },
  },
  'kimi-k2.5': {
    id: 'kimi-k2.5',
    name: 'Kimi K2.5',
    tool_call: true,
    reasoning: true,
    limit: { context: 262144, output: 65536 },
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
  },
};

const EXPECTED_PI_OMP_MODELS = [
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    reasoning: true,
    input: ['text'],
    contextWindow: 1000000,
    maxTokens: 384000,
  },
  {
    id: 'kimi-k2.5',
    name: 'Kimi K2.5',
    reasoning: true,
    input: ['text', 'image'], // 'video' filtered out
    contextWindow: 262144,
    maxTokens: 65536,
  },
];

function richPiFixture(): Record<string, unknown> {
  return {
    version: '1.0',
    settings: { theme: 'dark', nested: { a: 1 } },
    providers: {
      lmstudio: {
        baseUrl: 'http://127.0.0.1:1234/v1',
        api: 'openai-completions',
        apiKey: 'lm-studio',
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: 'max_tokens',
        },
        models: [
          { id: 'local-a', name: 'Local A', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 4096 },
          { id: 'local-b', name: 'Local B', reasoning: false, input: ['text'], contextWindow: 16384, maxTokens: 8192 },
        ],
      },
      'saros-proxy': {
        name: 'Saros',
        baseUrl: 'http://127.0.0.1:3000/zen/go/v1',
        api: 'openai-completions',
        apiKey: 'not-used',
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: 'max_tokens',
        },
        models: [{ id: 'stale-model', name: 'Stale', reasoning: true, input: ['text'], contextWindow: 1000, maxTokens: 500 }],
      },
    },
  };
}

function richOmpFixture(): Record<string, unknown> {
  const fixture = richPiFixture();
  (fixture.providers as Record<string, unknown>)['saros-proxy'] = {
    ...(fixture.providers as Record<string, unknown>)['saros-proxy'],
    auth: 'none',
    modelOverrides: { 'stale-model': { reasoning: true } },
  };
  return fixture;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('toPiOmpModel transform', () => {
  it('maps bundled-shaped entries to pi/omp shape, filtering input modalities', () => {
    const result = toPiOmpModel(TEST_MODELS_MAP['kimi-k2.5'] as Record<string, unknown>);
    expect(result).toEqual({
      id: 'kimi-k2.5',
      name: 'Kimi K2.5',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 262144,
      maxTokens: 65536,
    });
  });

  it('defaults contextWindow/maxTokens/input/reasoning when metadata is missing', () => {
    const result = toPiOmpModel({ id: 'bare-model' });
    expect(result).toEqual({
      id: 'bare-model',
      name: 'bare-model',
      reasoning: false,
      input: ['text'],
      contextWindow: 262144,
      maxTokens: 65536,
    });
  });

  it('maps models.dev snake_case cost to camelCase with zero defaults', () => {
    const result = toPiOmpModel({
      id: 'deepseek-v4-flash',
      cost: { input: 0.14, output: 0.28, cache_read: 0.0028, cache_write: 0 },
    });
    expect(result.cost).toEqual({ input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 });
  });

  it('accepts camelCase cost and omits cost when malformed', () => {
    const camel = toPiOmpModel({
      id: 'm',
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    });
    expect(camel.cost).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });

    const malformed = toPiOmpModel({ id: 'm', cost: { input: 'x' } });
    expect(malformed.cost).toBeUndefined();
  });

  it('toPiOmpModelArray maps every entry in order', () => {
    expect(toPiOmpModelArray(TEST_MODELS_MAP)).toEqual(EXPECTED_PI_OMP_MODELS);
  });

  it('defaults id and name to empty strings when id is not a string', () => {
    const result = toPiOmpModel({ id: 42 });
    expect(result.id).toBe('');
    expect(result.name).toBe('');
  });

  it('defaults cache costs to zero when neither camelCase nor snake_case is present', () => {
    const result = toPiOmpModel({ id: 'm', cost: { input: 1, output: 2 } });
    expect(result.cost).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  it('coerces non-numeric cache costs to zero', () => {
    const result = toPiOmpModel({
      id: 'm',
      cost: { input: 1, output: 2, cacheRead: 'x', cacheWrite: true },
    });
    expect(result.cost).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  });
});

describe('buildCanonicalModels', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    mockHomeRef.current = tmpDir;
    mockedFetchUpstreamIds.mockReset();
    mockedFetchModelsDevMetadata.mockReset();
    mockedBuildMinimalStub.mockReset();
    mockedSyncOpencodeUpstream.mockReset();
  });

  afterEach(async () => {
    mockHomeRef.current = '';
    await removeTempDir(tmpDir);
  });

  it('returns bundled models immediately when offline or without a config', async () => {
    const offline = await buildCanonicalModels({ port: 3000 } as ProxyConfig, {
      offline: true,
    });
    const noConfig = await buildCanonicalModels(undefined);

    expect(offline).toEqual(loadModelsFromJson());
    expect(noConfig).toEqual(loadModelsFromJson());
    expect(mockedFetchUpstreamIds).not.toHaveBeenCalled();
  });

  it('builds the map from upstream ids enriched with models.dev metadata', async () => {
    mockedFetchUpstreamIds.mockResolvedValue(['m1', 'm2']);
    mockedFetchModelsDevMetadata.mockResolvedValue({
      m1: { id: 'm1', name: 'M One' },
      m2: { id: 'm2', name: 'M Two' },
    });
    mockedBuildMinimalStub.mockImplementation((id, meta) => ({
      id,
      name: meta?.[id]?.name,
      stub: true,
    }));

    const result = await buildCanonicalModels({ port: 3000 } as ProxyConfig);

    expect(mockedFetchUpstreamIds).toHaveBeenCalledWith({ port: 3000 });
    expect(mockedBuildMinimalStub).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      m1: { id: 'm1', name: 'M One', stub: true },
      m2: { id: 'm2', name: 'M Two', stub: true },
    });
  });

  it('falls back to bundled models when the upstream fetch throws', async () => {
    mockedFetchUpstreamIds.mockRejectedValue(new Error('network down'));
    mockedFetchModelsDevMetadata.mockResolvedValue(null);

    const result = await buildCanonicalModels({ port: 3000 } as ProxyConfig);

    expect(result).toEqual(loadModelsFromJson());
    expect(mockedBuildMinimalStub).not.toHaveBeenCalled();
  });

  it('falls back to bundled models when upstream returns no ids', async () => {
    mockedFetchUpstreamIds.mockResolvedValue([]);
    mockedFetchModelsDevMetadata.mockResolvedValue(null);

    const result = await buildCanonicalModels({ port: 3000 } as ProxyConfig);

    expect(result).toEqual(loadModelsFromJson());
    expect(mockedBuildMinimalStub).not.toHaveBeenCalled();
  });

  it('passes undefined metadata to the stub builder when models.dev yields nothing', async () => {
    mockedFetchUpstreamIds.mockResolvedValue(['m1']);
    mockedFetchModelsDevMetadata.mockResolvedValue(null);
    mockedBuildMinimalStub.mockImplementation((id, meta) => ({ id, meta }));

    const result = await buildCanonicalModels({ port: 3000 } as ProxyConfig);

    expect(mockedBuildMinimalStub).toHaveBeenCalledWith('m1', undefined);
    expect(result).toEqual({ m1: { id: 'm1', meta: undefined } });
  });
});

describe('syncModelsToPiConfig (JSON)', () => {
  let tmpDir: string;
  let piPath: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    piPath = join(tmpDir, 'models.json');
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    mockedFs.writeFileSync.mockReset();
    mockedFs.writeFileSync.mockImplementation(realFs.writeFileSync);
    mockedFs.readFileSync.mockReset();
    mockedFs.readFileSync.mockImplementation(realFs.readFileSync);
  });

  it('preserves other providers and top-level keys; replaces only saros-proxy.models', () => {
    const fixture = richPiFixture();
    writeFileSync(piPath, JSON.stringify(fixture, null, 2), 'utf-8');

    const result = syncModelsToPiConfig(TEST_MODELS_MAP, 3000, { configPath: piPath });
    expect(result.success).toBe(true);
    expect(result.path).toBe(piPath);

    const updated = JSON.parse(readFileSync(piPath, 'utf-8')) as Record<string, unknown>;
    const providers = updated.providers as Record<string, unknown>;

    // Untouched
    expect(updated.version).toBe('1.0');
    expect(updated.settings).toEqual({ theme: 'dark', nested: { a: 1 } });
    expect(providers.lmstudio).toEqual(
      (fixture.providers as Record<string, unknown>).lmstudio,
    );

    // saros-proxy: non-models fields preserved, only models replaced
    const saros = providers['saros-proxy'] as Record<string, unknown>;
    const origSaros = ((fixture.providers as Record<string, unknown>)[
      'saros-proxy'
    ] as Record<string, unknown>);
    const { models: _origModels, ...origSarosRest } = origSaros;
    const { models: _newModels, ...sarosRest } = saros;
    expect(sarosRest).toEqual(origSarosRest);
    expect(saros.models).toEqual(EXPECTED_PI_OMP_MODELS);
  });

  it('preserves an existing baseUrl (port does not override it)', () => {
    const fixture = richPiFixture();
    writeFileSync(piPath, JSON.stringify(fixture, null, 2), 'utf-8');

    syncModelsToPiConfig(TEST_MODELS_MAP, 9999, { configPath: piPath });
    const updated = JSON.parse(readFileSync(piPath, 'utf-8')) as Record<string, unknown>;
    const saros = (updated.providers as Record<string, unknown>)[
      'saros-proxy'
    ] as Record<string, unknown>;
    expect(saros.baseUrl).toBe('http://127.0.0.1:3000/zen/go/v1');
  });

  it('preserves a custom existing api (only models are replaced)', () => {
    const fixture = richPiFixture();
    ((fixture.providers as Record<string, unknown>)['saros-proxy'] as Record<string, unknown>)
      .api = 'anthropic-messages';
    writeFileSync(piPath, JSON.stringify(fixture, null, 2), 'utf-8');

    syncModelsToPiConfig(TEST_MODELS_MAP, 3000, { configPath: piPath });
    const updated = JSON.parse(readFileSync(piPath, 'utf-8')) as Record<string, unknown>;
    const saros = (updated.providers as Record<string, unknown>)[
      'saros-proxy'
    ] as Record<string, unknown>;
    expect(saros.api).toBe('anthropic-messages');
    expect(saros.models).toEqual(EXPECTED_PI_OMP_MODELS);
  });

  it('sets baseUrl from the port when the provider has none', () => {
    writeFileSync(
      piPath,
      JSON.stringify({ providers: { 'saros-proxy': { api: 'openai-completions' } } }, null, 2),
      'utf-8',
    );

    syncModelsToPiConfig(TEST_MODELS_MAP, 4242, { configPath: piPath });
    const updated = JSON.parse(readFileSync(piPath, 'utf-8')) as Record<string, unknown>;
    const saros = (updated.providers as Record<string, unknown>)[
      'saros-proxy'
    ] as Record<string, unknown>;
    expect(saros.baseUrl).toBe('http://127.0.0.1:4242/zen/go/v1');
  });

  it('creates a full fresh provider stub when saros-proxy is absent', () => {
    writeFileSync(
      piPath,
      JSON.stringify({ providers: { lmstudio: { models: [] } } }, null, 2),
      'utf-8',
    );

    syncModelsToPiConfig(TEST_MODELS_MAP, 3000, { configPath: piPath });
    const updated = JSON.parse(readFileSync(piPath, 'utf-8')) as Record<string, unknown>;
    const saros = (updated.providers as Record<string, unknown>)[
      'saros-proxy'
    ] as Record<string, unknown>;
    expect(saros.name).toBe('Saros');
    expect(saros.apiKey).toBe('not-used');
    expect(saros.api).toBe('openai-completions');
    expect(saros.compat).toEqual({
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
    });
  });

  it('skips when the config file is missing and creates nothing', () => {
    const missingPath = join(tmpDir, 'nope.json');
    const result = syncModelsToPiConfig(TEST_MODELS_MAP, 3000, { configPath: missingPath });
    expect(result.success).toBe(false);
    expect(result.error).toContain('config not found at');
    expect(existsSync(missingPath)).toBe(false);
  });

  it('creates a .backup exactly once', () => {
    const fixture = richPiFixture();
    writeFileSync(piPath, JSON.stringify(fixture, null, 2), 'utf-8');
    const backupPath = `${piPath}.backup`;

    syncModelsToPiConfig(TEST_MODELS_MAP, 3000, { configPath: piPath });
    expect(existsSync(backupPath)).toBe(true);
    const backupBefore = readFileSync(backupPath, 'utf-8');

    syncModelsToPiConfig(TEST_MODELS_MAP, 3000, { configPath: piPath });
    expect(readFileSync(backupPath, 'utf-8')).toBe(backupBefore); // not overwritten
  });

  it('is idempotent (second run produces byte-identical output)', () => {
    writeFileSync(piPath, JSON.stringify(richPiFixture(), null, 2), 'utf-8');

    syncModelsToPiConfig(TEST_MODELS_MAP, 3000, { configPath: piPath });
    const first = readFileSync(piPath, 'utf-8');

    syncModelsToPiConfig(TEST_MODELS_MAP, 3000, { configPath: piPath });
    expect(readFileSync(piPath, 'utf-8')).toBe(first);
  });

  it('reports invalid JSON without corrupting the file', () => {
    writeFileSync(piPath, '{ this is not json', 'utf-8');
    const result = syncModelsToPiConfig(TEST_MODELS_MAP, 3000, { configPath: piPath });
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid');
  });

  it('restores from backup and reports failure when the written file fails validation', () => {
    writeFileSync(piPath, JSON.stringify(richPiFixture(), null, 2), 'utf-8');
    const original = readFileSync(piPath, 'utf-8');

    mockedFs.writeFileSync.mockImplementationOnce((path, data, options) => {
      // Simulate a write that produces corrupt output (e.g. encoding issue).
      return writeFileSync(piPath, '{ this is not json', options);
    });

    const result = syncModelsToPiConfig(TEST_MODELS_MAP, 3000, { configPath: piPath });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Restored from backup');
    expect(readFileSync(piPath, 'utf-8')).toBe(original);
  });

  it('returns the underlying error when writeFileSync throws', () => {
    writeFileSync(piPath, JSON.stringify(richPiFixture(), null, 2), 'utf-8');

    mockedFs.writeFileSync.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied, open');
    });

    const result = syncModelsToPiConfig(TEST_MODELS_MAP, 3000, { configPath: piPath });
    expect(result.success).toBe(false);
    expect(result.path).toBe(piPath);
    expect(result.error).toContain('EACCES');
  });

  it('reports non-Error throw values verbatim', () => {
    writeFileSync(piPath, JSON.stringify(richPiFixture(), null, 2), 'utf-8');

    mockedFs.writeFileSync.mockImplementationOnce(() => {
      throw 'disk on fire';
    });

    const result = syncModelsToPiConfig(TEST_MODELS_MAP, 3000, { configPath: piPath });
    expect(result.success).toBe(false);
    expect(result.error).toBe('disk on fire');
  });

  it('handles a config without a providers key', () => {
    writeFileSync(piPath, JSON.stringify({ version: '1.0' }), 'utf-8');
    const result = syncModelsToPiConfig(TEST_MODELS_MAP, 3000, { configPath: piPath });
    expect(result.success).toBe(true);
    const updated = JSON.parse(readFileSync(piPath, 'utf-8')) as Record<string, unknown>;
    expect((updated.providers as Record<string, unknown>)['saros-proxy']).toBeDefined();
  });
});

describe('syncModelsToOmpConfig (YAML)', () => {
  let tmpDir: string;
  let ompPath: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    ompPath = join(tmpDir, 'models.yml');
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    mockedFs.writeFileSync.mockReset();
    mockedFs.writeFileSync.mockImplementation(realFs.writeFileSync);
    mockedFs.readFileSync.mockReset();
    mockedFs.readFileSync.mockImplementation(realFs.readFileSync);
  });

  it('preserves other providers and top-level keys; replaces only saros-proxy.models', () => {
    const fixture = richOmpFixture();
    writeFileSync(ompPath, stringifyYaml(fixture), 'utf-8');

    const result = syncModelsToOmpConfig(TEST_MODELS_MAP, 3000, { configPath: ompPath });
    expect(result.success).toBe(true);

    const updated = parseYaml(readFileSync(ompPath, 'utf-8')) as Record<string, unknown>;
    const providers = updated.providers as Record<string, unknown>;

    expect(updated.version).toBe('1.0');
    expect(updated.settings).toEqual({ theme: 'dark', nested: { a: 1 } });
    expect(providers.lmstudio).toEqual(
      (fixture.providers as Record<string, unknown>).lmstudio,
    );

    const saros = providers['saros-proxy'] as Record<string, unknown>;
    const origSaros = ((fixture.providers as Record<string, unknown>)[
      'saros-proxy'
    ] as Record<string, unknown>);
    const { models: _origModels, ...origSarosRest } = origSaros;
    const { models: _newModels, ...sarosRest } = saros;
    expect(sarosRest).toEqual(origSarosRest);
    expect(saros.models).toEqual(EXPECTED_PI_OMP_MODELS);
  });

  it('keeps existing baseUrl and fresh-provider auth stub', () => {
    const fixture = richOmpFixture();
    writeFileSync(ompPath, stringifyYaml(fixture), 'utf-8');
    syncModelsToOmpConfig(TEST_MODELS_MAP, 9999, { configPath: ompPath });
    const updated = parseYaml(readFileSync(ompPath, 'utf-8')) as Record<string, unknown>;
    const saros = (updated.providers as Record<string, unknown>)[
      'saros-proxy'
    ] as Record<string, unknown>;
    expect(saros.baseUrl).toBe('http://127.0.0.1:3000/zen/go/v1');

    writeFileSync(ompPath, stringifyYaml({ providers: {} }), 'utf-8');
    syncModelsToOmpConfig(TEST_MODELS_MAP, 1234, { configPath: ompPath });
    const fresh = parseYaml(readFileSync(ompPath, 'utf-8')) as Record<string, unknown>;
    const freshSaros = (fresh.providers as Record<string, unknown>)[
      'saros-proxy'
    ] as Record<string, unknown>;
    expect(freshSaros.baseUrl).toBe('http://127.0.0.1:1234/zen/go/v1');
    expect(freshSaros.auth).toBe('none');
    expect(freshSaros.apiKey).toBe('not-used');
    expect(freshSaros.name).toBeUndefined(); // omp provider schema has no `name`
  });

  it('preserves a custom existing api (only models are replaced)', () => {
    const fixture = richOmpFixture();
    ((fixture.providers as Record<string, unknown>)['saros-proxy'] as Record<string, unknown>)
      .api = 'anthropic-messages';
    writeFileSync(ompPath, stringifyYaml(fixture), 'utf-8');

    syncModelsToOmpConfig(TEST_MODELS_MAP, 3000, { configPath: ompPath });
    const updated = parseYaml(readFileSync(ompPath, 'utf-8')) as Record<string, unknown>;
    const saros = (updated.providers as Record<string, unknown>)[
      'saros-proxy'
    ] as Record<string, unknown>;
    expect(saros.api).toBe('anthropic-messages');
    expect(saros.models).toEqual(EXPECTED_PI_OMP_MODELS);
  });

  it('skips when the config file is missing and creates nothing', () => {
    const missingPath = join(tmpDir, 'nope.yml');
    const result = syncModelsToOmpConfig(TEST_MODELS_MAP, 3000, { configPath: missingPath });
    expect(result.success).toBe(false);
    expect(result.error).toContain('config not found at');
    expect(existsSync(missingPath)).toBe(false);
  });

  it('is idempotent (second run produces byte-identical output)', () => {
    writeFileSync(ompPath, stringifyYaml(richOmpFixture()), 'utf-8');
    syncModelsToOmpConfig(TEST_MODELS_MAP, 3000, { configPath: ompPath });
    const first = readFileSync(ompPath, 'utf-8');
    syncModelsToOmpConfig(TEST_MODELS_MAP, 3000, { configPath: ompPath });
    expect(readFileSync(ompPath, 'utf-8')).toBe(first);
  });

  it('reports invalid YAML without corrupting the file', () => {
    writeFileSync(ompPath, 'providers: [unclosed', 'utf-8');
    const result = syncModelsToOmpConfig(TEST_MODELS_MAP, 3000, { configPath: ompPath });
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid');
  });

  it('rejects YAML that parses to a non-object (array or scalar)', () => {
    writeFileSync(ompPath, '- just\n- a list\n', 'utf-8');
    expect(syncModelsToOmpConfig(TEST_MODELS_MAP, 3000, { configPath: ompPath }).error).toContain(
      'invalid YAML',
    );

    writeFileSync(ompPath, 'just a scalar string\n', 'utf-8');
    expect(syncModelsToOmpConfig(TEST_MODELS_MAP, 3000, { configPath: ompPath }).error).toContain(
      'invalid YAML',
    );
  });

  it('treats a null document and a missing providers key as empty configs', () => {
    writeFileSync(ompPath, 'null\n', 'utf-8');
    const fromNull = syncModelsToOmpConfig(TEST_MODELS_MAP, 4242, { configPath: ompPath });
    expect(fromNull.success).toBe(true);
    const nullUpdated = parseYaml(readFileSync(ompPath, 'utf-8')) as Record<string, unknown>;
    expect(
      ((nullUpdated.providers as Record<string, unknown>)['saros-proxy'] as Record<string, unknown>)
        .baseUrl,
    ).toBe('http://127.0.0.1:4242/zen/go/v1');

    writeFileSync(ompPath, 'version: 1.0\n', 'utf-8');
    const noProviders = syncModelsToOmpConfig(TEST_MODELS_MAP, 4243, { configPath: ompPath });
    expect(noProviders.success).toBe(true);
    const updated = parseYaml(readFileSync(ompPath, 'utf-8')) as Record<string, unknown>;
    expect((updated.providers as Record<string, unknown>)['saros-proxy']).toBeDefined();
  });

  it('restores from backup and reports failure when the written YAML fails validation', () => {
    writeFileSync(ompPath, stringifyYaml(richOmpFixture()), 'utf-8');
    const original = readFileSync(ompPath, 'utf-8');

    mockedFs.writeFileSync.mockImplementationOnce((path, data, options) => {
      return writeFileSync(ompPath, 'providers: [unclosed', options);
    });

    const result = syncModelsToOmpConfig(TEST_MODELS_MAP, 3000, { configPath: ompPath });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Restored from backup');
    expect(readFileSync(ompPath, 'utf-8')).toBe(original);
  });

  it('returns the underlying error when writeFileSync throws', () => {
    writeFileSync(ompPath, stringifyYaml(richOmpFixture()), 'utf-8');

    mockedFs.writeFileSync.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied, open');
    });

    const result = syncModelsToOmpConfig(TEST_MODELS_MAP, 3000, { configPath: ompPath });
    expect(result.success).toBe(false);
    expect(result.error).toContain('EACCES');
  });

  it('reports non-Error throw values verbatim', () => {
    writeFileSync(ompPath, stringifyYaml(richOmpFixture()), 'utf-8');

    mockedFs.writeFileSync.mockImplementationOnce(() => {
      throw 'disk on fire';
    });

    const result = syncModelsToOmpConfig(TEST_MODELS_MAP, 3000, { configPath: ompPath });
    expect(result.success).toBe(false);
    expect(result.error).toBe('disk on fire');
  });
});

describe('harness selection settings', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    mockHomeRef.current = tmpDir;
  });

  afterEach(async () => {
    mockHomeRef.current = '';
    await removeTempDir(tmpDir);
  });

  it('writeHarnessSettings/readHarnessSettings round-trip', () => {
    writeHarnessSettings(['omp', 'pi', 'opencode']);
    expect(readHarnessSettings()).toEqual(['omp', 'pi', 'opencode']);
  });

  it('defaults to opencode when the file is missing (legacy behavior)', () => {
    expect(readHarnessSettings()).toEqual(['opencode']);
  });

  it('returns [] when the file is invalid or an explicit empty list', () => {
    const dir = join(tmpDir, '.config', 'saros');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'harnesses.json'), '{nope', 'utf-8');
    expect(readHarnessSettings()).toEqual([]);

    writeFileSync(join(dir, 'harnesses.json'), JSON.stringify({ harnesses: [] }), 'utf-8');
    expect(readHarnessSettings()).toEqual([]);
  });

  it('filters unknown ids out of the settings file', () => {
    const dir = join(tmpDir, '.config', 'saros');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'harnesses.json'), JSON.stringify({ harnesses: ['pi', 'bogus'] }), 'utf-8');
    expect(readHarnessSettings()).toEqual(['pi']);
  });

  it('returns [] when the file exists but has no harnesses array', () => {
    const dir = join(tmpDir, '.config', 'saros');
    mkdirSync(dir, { recursive: true });
    const settingsPath = join(dir, 'harnesses.json');

    writeFileSync(settingsPath, 'null', 'utf-8');
    expect(readHarnessSettings()).toEqual([]);

    writeFileSync(settingsPath, '"just a string"', 'utf-8');
    expect(readHarnessSettings()).toEqual([]);

    writeFileSync(settingsPath, JSON.stringify({ harnesses: 'pi' }), 'utf-8');
    expect(readHarnessSettings()).toEqual([]);
  });

  it('parseHarnessArgs maps aliases and reports unknown names', () => {
    expect(parseHarnessArgs(['omp', 'pi', 'oc'])).toEqual({
      ids: ['omp', 'pi', 'opencode'],
      errors: [],
    });
    expect(parseHarnessArgs(['ohmypi', 'opencode'])).toEqual({
      ids: ['omp', 'opencode'],
      errors: [],
    });
    expect(parseHarnessArgs(['omp', 'omp'])).toEqual({ ids: ['omp'], errors: [] }); // dedup
    expect(parseHarnessArgs(['bogus'])).toEqual({ ids: [], errors: ['bogus'] });
  });
});

describe('syncModelsInAllHarnesses', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    mockHomeRef.current = tmpDir;
  });

  afterEach(async () => {
    mockHomeRef.current = '';
    await removeTempDir(tmpDir);
  });

  it('returns [] when the settings file explicitly disables every harness', async () => {
    // Missing file defaults to ['opencode']; an explicit empty list is the opt-out.
    const dir = join(tmpDir, '.config', 'saros');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'harnesses.json'), JSON.stringify({ harnesses: [] }), 'utf-8');
    const results = await syncModelsInAllHarnesses(undefined, { offline: true });
    expect(results).toEqual([]);
  });

  it('defaults to opencode when the settings file is missing', async () => {
    const results = await syncModelsInAllHarnesses(undefined, { offline: true });
    expect(results.map((r) => r.harness)).toEqual(['opencode']);
    // offline opencode path: config file absent under the temp HOME
    expect(results[0].result.success).toBe(false);
    expect(results[0].result.error).toContain('config not found');
  });

  it('syncs only enabled harnesses', async () => {
    // Create config files for all three harnesses under the temp HOME.
    const piPath = join(tmpDir, '.pi', 'agent', 'models.json');
    const ompPath = join(tmpDir, '.omp', 'agent', 'models.yml');
    const ocPath = join(tmpDir, '.config', 'opencode', 'opencode.jsonc');
    for (const p of [piPath, ompPath, ocPath]) {
      mkdirSync(dirname(p), { recursive: true });
    }
    writeFileSync(piPath, JSON.stringify({ providers: { lmstudio: { models: [] } } }), 'utf-8');
    writeFileSync(ompPath, stringifyYaml({ providers: { lmstudio: { models: [] } } }), 'utf-8');
    writeFileSync(
      ocPath,
      JSON.stringify({ provider: { 'saros-proxy': { models: {} } } }),
      'utf-8',
    );

    // Enable only pi.
    writeHarnessSettings(['pi']);

    const results = await syncModelsInAllHarnesses(undefined, { offline: true });
    expect(results.map((r) => r.harness)).toEqual(['pi']);
    expect(results[0].result.success).toBe(true);

    // pi was updated with the bundled canonical list.
    const piContent = JSON.parse(readFileSync(piPath, 'utf-8')) as Record<string, unknown>;
    const piSaros = (piContent.providers as Record<string, unknown>)[
      'saros-proxy'
    ] as Record<string, unknown>;
    expect(Array.isArray(piSaros.models)).toBe(true);
    expect((piSaros.models as unknown[]).length).toBeGreaterThan(0);
    expect((piSaros.models as Array<{ id: string }>).some((m) => m.id === 'deepseek-v4-pro')).toBe(true);

    // omp and opencode untouched.
    const ompContent = parseYaml(readFileSync(ompPath, 'utf-8')) as Record<string, unknown>;
    expect((ompContent.providers as Record<string, unknown>)['saros-proxy']).toBeUndefined();
    const ocContent = JSON.parse(readFileSync(ocPath, 'utf-8')) as Record<string, unknown>;
    expect(
      ((ocContent.provider as Record<string, unknown>)['saros-proxy'] as Record<string, unknown>)
        .models,
    ).toEqual({});
  });

  it('syncs opencode via upstream when a config is provided (live path)', async () => {
    mockedSyncOpencodeUpstream.mockResolvedValue({ success: true, path: '/tmp/opencode.json' });

    const results = await syncModelsInAllHarnesses({ port: 3000 } as ProxyConfig);

    expect(results.map((r) => r.harness)).toEqual(['opencode']);
    expect(mockedSyncOpencodeUpstream).toHaveBeenCalledWith({ port: 3000 });
    expect(results[0].result.success).toBe(true);
  });

  it('syncs omp using the default config path when enabled', async () => {
    const ompPath = join(tmpDir, '.omp', 'agent', 'models.yml');
    mkdirSync(dirname(ompPath), { recursive: true });
    writeFileSync(ompPath, stringifyYaml({ providers: { lmstudio: { models: [] } } }), 'utf-8');

    writeHarnessSettings(['omp']);

    const results = await syncModelsInAllHarnesses(undefined, { offline: true });
    expect(results.map((r) => r.harness)).toEqual(['omp']);
    expect(results[0].result.success).toBe(true);

    const updated = parseYaml(readFileSync(ompPath, 'utf-8')) as Record<string, unknown>;
    const saros = (updated.providers as Record<string, unknown>)[
      'saros-proxy'
    ] as Record<string, unknown>;
    expect(Array.isArray(saros.models)).toBe(true);
    expect(
      (saros.models as Array<{ id: string }>).some((m) => m.id === 'deepseek-v4-pro'),
    ).toBe(true);
  });
});
