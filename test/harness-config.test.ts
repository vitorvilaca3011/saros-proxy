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

import { toPiOmpModel, toPiOmpModelArray } from '../src/cli/harness-models.js';
import { syncModelsToPiConfig } from '../src/cli/pi-config.js';
import { syncModelsToOmpConfig } from '../src/cli/omp-config.js';
import {
  parseHarnessArgs,
  readHarnessSettings,
  writeHarnessSettings,
  syncModelsInAllHarnesses,
} from '../src/cli/harness-sync.js';

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
});
