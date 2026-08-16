/**
 * probe-cache.test.ts — Unit tests for the probe cache module.
 *
 * Vitest-based; run with: npx vitest run src/probe-cache.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';
import { PROBE_CACHE_TTL_MS } from './constants.js';

// ---------------------------------------------------------------------------
// Mock getProbeCachePath to use a temporary directory
// ---------------------------------------------------------------------------

const mockCachePathRef = vi.hoisted(() => ({ current: '' }));

vi.mock('./probe-cache.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./probe-cache.js')>();
  return {
    ...mod,
    getProbeCachePath: vi.fn(() => mockCachePathRef.current),
  };
});

import {
  loadProbeCache,
  saveProbeCache,
  getCachedProbe,
  setCachedProbe,
  type ModelProbe,
  type ProbeCacheFile,
} from './probe-cache.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid probe for testing. */
function makeProbe(overrides: Partial<ModelProbe> = {}): ModelProbe {
  return {
    modelId: 'test-model',
    liveness: { status: 'ok', ts: Date.now() },
    reasoning: { status: 'ok', ts: Date.now() },
    toolCalling: { status: 'ok', ts: Date.now() },
    ...overrides,
  };
}

/** Create a temp directory and return its path. */
function createTempDir(): string {
  return mkdtempSync(join(os.tmpdir(), 'probe-cache-test-'));
}

/** Remove a temp directory. */
function removeTempDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getProbeCachePath', () => {
  it('returns path ending with saros/probe-cache.json', async () => {
    // Bypass the mock to test the real implementation
    const mod = await vi.importActual<typeof import('./probe-cache.js')>('./probe-cache.js');
    const result = mod.getProbeCachePath();
    expect(result).toMatch(/saros[/\\]probe-cache\.json$/);
  });
});

describe('loadProbeCache', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    mockCachePathRef.current = join(tempDir, 'probe-cache.json');
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('returns empty cache when file missing', () => {
    const result = loadProbeCache(mockCachePathRef.current);
    expect(result).toEqual({ version: 1, probes: {} });
  });

  it('returns empty cache when file is corrupt JSON', () => {
    writeFileSync(mockCachePathRef.current, '{invalid json}', 'utf-8');
    const result = loadProbeCache(mockCachePathRef.current);
    expect(result).toEqual({ version: 1, probes: {} });
  });

  it('returns parsed cache from valid file', () => {
    const cache: ProbeCacheFile = {
      version: 1,
      probes: {
        'model-a': makeProbe({ modelId: 'model-a' }),
      },
    };
    writeFileSync(mockCachePathRef.current, JSON.stringify(cache), 'utf-8');
    const result = loadProbeCache(mockCachePathRef.current);
    expect(result).toEqual(cache);
  });

  it('returns empty cache when version is 2 (version guard)', () => {
    const cache = { version: 2, probes: { 'm': makeProbe({ modelId: 'm' }) } };
    writeFileSync(mockCachePathRef.current, JSON.stringify(cache), 'utf-8');
    const result = loadProbeCache(mockCachePathRef.current);
    expect(result).toEqual({ version: 1, probes: {} });
  });

  it('returns empty cache when probes field is an array', () => {
    const cache = { version: 1, probes: [] };
    writeFileSync(mockCachePathRef.current, JSON.stringify(cache), 'utf-8');
    const result = loadProbeCache(mockCachePathRef.current);
    expect(result).toEqual({ version: 1, probes: {} });
  });

  it('returns empty cache on empty file (0 bytes)', () => {
    writeFileSync(mockCachePathRef.current, '', 'utf-8');
    const result = loadProbeCache(mockCachePathRef.current);
    expect(result).toEqual({ version: 1, probes: {} });
  });
});

describe('saveProbeCache', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    mockCachePathRef.current = join(tempDir, 'probe-cache.json');
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('writes JSON to disk', () => {
    const cache: ProbeCacheFile = {
      version: 1,
      probes: {
        'model-a': makeProbe({ modelId: 'model-a' }),
      },
    };
    saveProbeCache(cache, mockCachePathRef.current);
    expect(existsSync(mockCachePathRef.current)).toBe(true);
    const raw = JSON.parse(readFileSync(mockCachePathRef.current, 'utf-8'));
    expect(raw).toEqual(cache);
  });

  it('overwrites existing file with new content', () => {
    const oldCache: ProbeCacheFile = {
      version: 1,
      probes: { 'old': makeProbe({ modelId: 'old' }) },
    };
    saveProbeCache(oldCache, mockCachePathRef.current);
    const oldRaw = JSON.parse(readFileSync(mockCachePathRef.current, 'utf-8'));
    expect(oldRaw.probes).toHaveProperty('old');

    const newCache: ProbeCacheFile = {
      version: 1,
      probes: { 'new': makeProbe({ modelId: 'new' }) },
    };
    saveProbeCache(newCache, mockCachePathRef.current);
    const newRaw = JSON.parse(readFileSync(mockCachePathRef.current, 'utf-8'));
    expect(newRaw.probes).not.toHaveProperty('old');
    expect(newRaw.probes).toHaveProperty('new');
  });

  it('creates parent directory if missing', () => {
    // Remove the parent dir to simulate missing directory
    rmSync(tempDir, { recursive: true, force: true });
    const cache: ProbeCacheFile = { version: 1, probes: {} };
    // Should not throw
    expect(() => saveProbeCache(cache, mockCachePathRef.current)).not.toThrow();
    // Parent dir should be created
    expect(existsSync(tempDir)).toBe(true);
    expect(existsSync(mockCachePathRef.current)).toBe(true);
  });
});

describe('getCachedProbe', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    mockCachePathRef.current = join(tempDir, 'probe-cache.json');
  });

  afterEach(() => {
    removeTempDir(tempDir);
    vi.useRealTimers();
  });

  it('returns null when cache is empty', () => {
    const result = getCachedProbe('test-model', mockCachePathRef.current);
    expect(result).toBeNull();
  });

  it('returns null when model not in cache', () => {
    const cache: ProbeCacheFile = {
      version: 1,
      probes: { 'other-model': makeProbe({ modelId: 'other-model' }) },
    };
    saveProbeCache(cache, mockCachePathRef.current);
    const result = getCachedProbe('test-model', mockCachePathRef.current);
    expect(result).toBeNull();
  });

  it('returns probe when within TTL', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const probe = makeProbe({ modelId: 'test-model', liveness: { status: 'ok', ts: now } });
    const cache: ProbeCacheFile = { version: 1, probes: { 'test-model': probe } };
    saveProbeCache(cache, mockCachePathRef.current);

    // Advance time to just before TTL expiry
    vi.advanceTimersByTime(PROBE_CACHE_TTL_MS - 1);
    const result = getCachedProbe('test-model', mockCachePathRef.current);
    expect(result).not.toBeNull();
    expect(result!.modelId).toBe('test-model');
  });

  it('returns null when probe is older than TTL', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const probe = makeProbe({ modelId: 'test-model', liveness: { status: 'ok', ts: now } });
    const cache: ProbeCacheFile = { version: 1, probes: { 'test-model': probe } };
    saveProbeCache(cache, mockCachePathRef.current);

    // Advance past TTL
    vi.advanceTimersByTime(PROBE_CACHE_TTL_MS + 1);
    const result = getCachedProbe('test-model', mockCachePathRef.current);
    expect(result).toBeNull();
  });

  it('returns null exactly at TTL boundary (now - ts === TTL)', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const probe = makeProbe({ modelId: 'test-model', liveness: { status: 'ok', ts: now } });
    const cache: ProbeCacheFile = { version: 1, probes: { 'test-model': probe } };
    saveProbeCache(cache, mockCachePathRef.current);

    // Advance to exactly TTL — should be expired (strict inequality)
    vi.advanceTimersByTime(PROBE_CACHE_TTL_MS);
    const result = getCachedProbe('test-model', mockCachePathRef.current);
    expect(result).toBeNull();
  });

  it('returns probe when timestamp is in the future (clock skew)', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    // Probe with a future timestamp
    const probe = makeProbe({ modelId: 'test-model', liveness: { status: 'ok', ts: now + 3600_000 } });
    const cache: ProbeCacheFile = { version: 1, probes: { 'test-model': probe } };
    saveProbeCache(cache, mockCachePathRef.current);

    const result = getCachedProbe('test-model', mockCachePathRef.current);
    expect(result).not.toBeNull();
    expect(result!.modelId).toBe('test-model');
  });
});

describe('setCachedProbe', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    mockCachePathRef.current = join(tempDir, 'probe-cache.json');
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('adds probe to existing cache', () => {
    const probe = makeProbe({ modelId: 'test-model' });
    setCachedProbe('test-model', probe, mockCachePathRef.current);

    const cache = loadProbeCache(mockCachePathRef.current);
    expect(cache.probes['test-model']).toEqual(probe);
    expect(cache.version).toBe(1);
  });

  it('creates new cache file if none exists', () => {
    expect(existsSync(mockCachePathRef.current)).toBe(false);
    const probe = makeProbe({ modelId: 'new-model' });
    setCachedProbe('new-model', probe, mockCachePathRef.current);
    expect(existsSync(mockCachePathRef.current)).toBe(true);
  });

  it('overwrites an existing entry for the same modelId', () => {
    const original = makeProbe({ modelId: 'test-model', liveness: { status: 'ok', ts: 1000 } });
    setCachedProbe('test-model', original, mockCachePathRef.current);

    const updated = makeProbe({ modelId: 'test-model', liveness: { status: 'error', ts: 2000 } });
    setCachedProbe('test-model', updated, mockCachePathRef.current);

    const cache = loadProbeCache(mockCachePathRef.current);
    expect(cache.probes['test-model'].liveness.status).toBe('error');
    expect(cache.probes['test-model'].liveness.ts).toBe(2000);
  });

  it('preserves other model probes when updating one', () => {
    const probeA = makeProbe({ modelId: 'model-a' });
    const probeB = makeProbe({ modelId: 'model-b' });
    const probeC = makeProbe({ modelId: 'model-c' });

    setCachedProbe('model-a', probeA, mockCachePathRef.current);
    setCachedProbe('model-b', probeB, mockCachePathRef.current);
    setCachedProbe('model-c', probeC, mockCachePathRef.current);

    const cache = loadProbeCache(mockCachePathRef.current);
    expect(Object.keys(cache.probes)).toHaveLength(3);
    expect(cache.probes['model-a']).toEqual(probeA);
    expect(cache.probes['model-b']).toEqual(probeB);
    expect(cache.probes['model-c']).toEqual(probeC);
  });
});
