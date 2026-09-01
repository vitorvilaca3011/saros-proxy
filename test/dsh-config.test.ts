/**
 * dsh-config.test.ts — Tests for the DeepSeek Harness (dsh) config sync
 * (syncModelsToDshConfig / toDshModel / getDefaultDshConfigPath).
 *
 * Mirrors the harness-config.test.ts mocking pattern: homedir() is stubbed
 * to a mutable ref and node:fs read/write/copy are spied so error paths and
 * backup behaviour can be simulated deterministically.
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
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// os.homedir() caches its result, so a process.env.HOME override is ignored.
// Mock homedir() to a mutable ref so getDefaultDshConfigPath stays testable.
const mockHomeRef = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockHomeRef.current };
});

// Wrap fs read/write/copy in spies (defaulting to the real implementations)
// so error paths like write failures can be simulated per-call.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    writeFileSync: vi.fn(real.writeFileSync),
    readFileSync: vi.fn(real.readFileSync),
    copyFileSync: vi.fn(real.copyFileSync),
  };
});

import {
  getDefaultDshConfigPath,
  toDshModel,
  syncModelsToDshConfig,
} from '../src/cli/dsh-config.js';

const mockedFs = vi.mocked(fs);

function createTempDir(): string {
  return mkdtempSync(`${tmpdir()}${sep}dsh-config-test-`);
}

function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows file-lock races — non-fatal in tests
  }
}

/**
 * dsh patch layer fixture: top-level ARRAY of rows (the patch document
 * shape), with the saros-provider row at id llm-pi-ai.
 */
function dshFixture(): unknown {
  return [
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          'saros-proxy': {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:3000/zen/go/v1',
            apiKey: 'not-used',
            models: [{ id: 'stale-model', name: 'Stale', input: ['text'], contextWindow: 1, maxTokens: 1 }],
          },
          commandcode: { baseUrl: 'https://api.commandcode.ai', api: 'openai-completions' },
        },
        extra: { a: 1 },
      },
    },
    { id: 'some-other-row', config: { whatever: true } },
  ];
}

/** Two-entry canonical model map (opencode-shaped) with/without reasoning. */
const DSH_MODELS_MAP: Record<string, unknown> = {
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    reasoning: true,
    limit: { context: 1000000, output: 384000 },
    modalities: { input: ['text'], output: ['text'] },
    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
  },
  'kimi-k2.5': {
    id: 'kimi-k2.5',
    name: 'Kimi K2.5',
    reasoning: false,
    limit: { context: 262144, output: 65536 },
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
  },
};

describe('getDefaultDshConfigPath', () => {
  it('points at the web profile patch layer under ~/.dsh', () => {
    mockHomeRef.current = '/home/user';
    expect(getDefaultDshConfigPath()).toBe(
      join('/home/user', '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
    );
  });
});

describe('toDshModel', () => {
  it('maps thinking efforts to a reasoningEfforts map with its off sentinel and keeps cost', () => {
    const model = {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      reasoning: true,
      input: ['text'],
      contextWindow: 1000000,
      maxTokens: 384000,
      thinking: { mode: 'effort' as const, efforts: ['low', 'medium', 'high'] },
      cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0.08 },
    };
    expect(toDshModel(model)).toEqual({
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      input: ['text'],
      contextWindow: 1000000,
      maxTokens: 384000,
      reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
      cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0.08 },
    });
  });

  it('omits reasoningEfforts and cost when absent', () => {
    expect(
      toDshModel({
        id: 'kimi-k2.5',
        name: 'Kimi K2.5',
        reasoning: false,
        input: ['text', 'image'],
        contextWindow: 262144,
        maxTokens: 65536,
      }),
    ).toEqual({
      id: 'kimi-k2.5',
      name: 'Kimi K2.5',
      input: ['text', 'image'],
      contextWindow: 262144,
      maxTokens: 65536,
    });
  });
});

describe('syncModelsToDshConfig', () => {
  let tmpDir: string;
  let cfgPath: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    cfgPath = join(tmpDir, 'cordis.patch.yml');
  });

  afterEach(async () => {
    removeTempDir(tmpDir);
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    mockedFs.writeFileSync.mockReset();
    mockedFs.writeFileSync.mockImplementation(realFs.writeFileSync);
    mockedFs.readFileSync.mockReset();
    mockedFs.readFileSync.mockImplementation(realFs.readFileSync);
    mockedFs.copyFileSync.mockReset();
    mockedFs.copyFileSync.mockImplementation(realFs.copyFileSync);
  });

  it('replaces only saros-proxy.models, preserving comments, rows and backup', () => {
    const raw =
      '# saros model list — dsh rewrites cordis.yml at boot\n' +
      '# second comment\n\n' +
      stringifyYaml(dshFixture());
    writeFileSync(cfgPath, raw, 'utf-8');

    const result = syncModelsToDshConfig(DSH_MODELS_MAP, 3000, { configPath: cfgPath });
    expect(result.success).toBe(true);
    expect(result.path).toBe(cfgPath);
    expect(existsSync(cfgPath + '.backup')).toBe(true);

    const text = readFileSync(cfgPath, 'utf-8');
    expect(text.startsWith('# saros model list')).toBe(true);

    const doc = parseYaml(text) as Array<Record<string, unknown>>;
    const row = doc.find((r) => r.id === 'llm-pi-ai') as Record<string, unknown>;
    const providers = (row.config as Record<string, unknown>).providers as Record<string, unknown>;
    const saros = providers['saros-proxy'] as Record<string, unknown>;

    expect((saros.models as Array<{ id: string }>).map((m) => m.id)).toEqual([
      'deepseek-v4-flash',
      'kimi-k2.5',
    ]);
    const flash = (saros.models as Array<Record<string, unknown>>).find(
      (m) => m.id === 'deepseek-v4-flash',
    );
    expect(flash?.reasoningEfforts).toEqual({ off: null, low: 'low', medium: 'medium', high: 'high' });
    const kimi = (saros.models as Array<Record<string, unknown>>).find((m) => m.id === 'kimi-k2.5');
    expect(kimi?.reasoningEfforts).toBeUndefined();

    // Untouched: other providers, other rows, and the stale model is gone.
    expect(providers.commandcode).toBeDefined();
    expect((row.config as Record<string, unknown>).extra).toEqual({ a: 1 });
    expect(doc.some((r) => r.id === 'some-other-row')).toBe(true);
    expect((saros.models as Array<Record<string, unknown>>).some((m) => m.id === 'stale-model')).toBe(false);
  });

  it('writes a .backup snapshot of the pre-sync file', () => {
    writeFileSync(cfgPath, stringifyYaml(dshFixture()), 'utf-8');
    syncModelsToDshConfig(DSH_MODELS_MAP, 3000, { configPath: cfgPath });

    const backup = parseYaml(readFileSync(cfgPath + '.backup', 'utf-8')) as Array<Record<string, unknown>>;
    const row = backup.find((r) => r.id === 'llm-pi-ai') as Record<string, unknown>;
    const saros = ((row.config as Record<string, unknown>).providers as Record<string, unknown>)[
      'saros-proxy'
    ] as Record<string, unknown>;
    expect((saros.models as Array<{ id: string }>).map((m) => m.id)).toEqual(['stale-model']);
  });

  it('writes an empty models array for an empty model map', () => {
    writeFileSync(cfgPath, stringifyYaml(dshFixture()), 'utf-8');
    const result = syncModelsToDshConfig({}, 3000, { configPath: cfgPath });
    expect(result.success).toBe(true);
    const doc = parseYaml(readFileSync(cfgPath, 'utf-8')) as Array<Record<string, unknown>>;
    const row = doc.find((r) => r.id === 'llm-pi-ai') as Record<string, unknown>;
    const saros = ((row.config as Record<string, unknown>).providers as Record<string, unknown>)[
      'saros-proxy'
    ] as Record<string, unknown>;
    expect(saros.models).toEqual([]);
  });

  it('reports a missing config file', () => {
    const missingPath = join(tmpDir, 'nope.yml');
    const result = syncModelsToDshConfig(DSH_MODELS_MAP, 3000, { configPath: missingPath });
    expect(result.success).toBe(false);
    expect(result.error).toContain('config not found at');
  });

  it('reports invalid YAML in the patch file', () => {
    writeFileSync(cfgPath, 'providers: [unclosed', 'utf-8');
    const result = syncModelsToDshConfig(DSH_MODELS_MAP, 3000, { configPath: cfgPath });
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid YAML');
  });

  it('rejects a patch document that is not a top-level array', () => {
    writeFileSync(cfgPath, 'just a scalar\n', 'utf-8');
    const result = syncModelsToDshConfig(DSH_MODELS_MAP, 3000, { configPath: cfgPath });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not a top-level array');
  });

  it('reports a missing llm-pi-ai row', () => {
    writeFileSync(cfgPath, stringifyYaml([{ id: 'other-row', config: {} }]), 'utf-8');
    const result = syncModelsToDshConfig(DSH_MODELS_MAP, 3000, { configPath: cfgPath });
    expect(result.success).toBe(false);
    expect(result.error).toContain('no llm-pi-ai row');
  });

  it('reports a missing saros-proxy provider on the row', () => {
    writeFileSync(
      cfgPath,
      stringifyYaml([{ id: 'llm-pi-ai', config: { providers: {} } }]),
      'utf-8',
    );
    const result = syncModelsToDshConfig(DSH_MODELS_MAP, 3000, { configPath: cfgPath });
    expect(result.success).toBe(false);
    expect(result.error).toContain('no saros-proxy provider');
  });

  it('returns the underlying error when the write fails', () => {
    writeFileSync(cfgPath, stringifyYaml(dshFixture()), 'utf-8');

    mockedFs.writeFileSync.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied, open');
    });

    const result = syncModelsToDshConfig(DSH_MODELS_MAP, 3000, { configPath: cfgPath });
    expect(result.success).toBe(false);
    expect(result.path).toBe(cfgPath);
    expect(result.error).toContain('EACCES');
  });

  it('uses the default path (homedir) when no configPath is given', () => {
    mockHomeRef.current = tmpDir;
    const dshDefault = getDefaultDshConfigPath();
    mkdirSync(join(tmpDir, '.dsh', 'profiles', 'web'), { recursive: true });
    writeFileSync(dshDefault, stringifyYaml(dshFixture()), 'utf-8');
    const result = syncModelsToDshConfig(DSH_MODELS_MAP, 3000);
    expect(result.success).toBe(true);
    expect(result.path).toBe(dshDefault);
  });
});
