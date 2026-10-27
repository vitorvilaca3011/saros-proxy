/**
 * token-usage.test.ts — Tests for persisted per-key token counters.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

// Wrap writeFileSync in a spy (defaulting to the real implementation) so the
// best-effort persist error path can be simulated per-call.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, writeFileSync: vi.fn(real.writeFileSync) };
});

const mockedWriteFileSync = vi.mocked(fs.writeFileSync);
import {
  flushTokenUsage,
  getKeyTokenUsage,
  getTokenUsagePath,
  parseTokenCounts,
  recordKeyTokens,
  resetTokenUsage,
} from '../src/token-usage.js';

const savedConfigHome = process.env.XDG_CONFIG_HOME;
let tmpDir = '';

/** Upstream usage object shape (OpenAI Chat Completions). */
function usage(prompt: number, completion: number, total = prompt + completion) {
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

beforeEach(() => {
  tmpDir = mkdtempSync(`${tmpdir()}${sep}token-usage-test-`);
  process.env.XDG_CONFIG_HOME = tmpDir;
  resetTokenUsage();
});

afterEach(async () => {
  resetTokenUsage();
  process.env.XDG_CONFIG_HOME = savedConfigHome;
  const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  mockedWriteFileSync.mockReset();
  mockedWriteFileSync.mockImplementation(realFs.writeFileSync);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows file-lock races — non-fatal in tests
  }
});

describe('parseTokenCounts', () => {
  it('reads the three OpenAI token fields', () => {
    expect(parseTokenCounts(usage(10, 3))).toEqual({
      promptTokens: 10,
      completionTokens: 3,
      totalTokens: 13,
    });
  });

  it('reads the input/output shape used by OpenAI Responses and Anthropic', () => {
    expect(parseTokenCounts({ input_tokens: 11, output_tokens: 4, total_tokens: 15 })).toEqual({
      promptTokens: 11,
      completionTokens: 4,
      totalTokens: 15,
    });
    expect(parseTokenCounts({ input_tokens: 6, output_tokens: 1 })).toEqual({
      promptTokens: 6,
      completionTokens: 1,
      totalTokens: 7,
    });
  });

  it('ignores objects that report no recognizable token field', () => {
    expect(parseTokenCounts({ foo: 1 })).toBeNull();
    expect(parseTokenCounts('nope')).toBeNull();
  });

  it('derives the total when the upstream omits it', () => {
    expect(parseTokenCounts({ prompt_tokens: 7, completion_tokens: 2 })).toEqual({
      promptTokens: 7,
      completionTokens: 2,
      totalTokens: 9,
    });
  });

  it('ignores non-numeric, negative, and fractional values', () => {
    expect(parseTokenCounts({ prompt_tokens: '10', completion_tokens: -4, total_tokens: 12.7 })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 12,
    });
  });

  it('returns null for values without token counts', () => {
    // Intermediate streaming chunks send `usage: null`.
    expect(parseTokenCounts(null)).toBeNull();
    expect(parseTokenCounts(undefined)).toBeNull();
    expect(parseTokenCounts({})).toBeNull();
    expect(parseTokenCounts([{ prompt_tokens: 1 }])).toBeNull();
    // A proxied quota-API response has an unrelated `usage` object.
    expect(parseTokenCounts({ rolling: { percent: 12 } })).toBeNull();
  });

  it('records an explicit zero-token response as a request', () => {
    expect(parseTokenCounts({ prompt_tokens: 0, completion_tokens: 0 })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });
});

describe('token-usage', () => {
  it('accumulates per-key totals', () => {
    recordKeyTokens('alpha', usage(10, 5));
    recordKeyTokens('alpha', usage(20, 1, 21));
    recordKeyTokens('beta', usage(1, 1, 2));

    const { keys } = getKeyTokenUsage();
    expect(keys.alpha).toMatchObject({
      requests: 2,
      promptTokens: 30,
      completionTokens: 6,
      totalTokens: 36,
    });
    expect(keys.alpha.lastAt).toBeGreaterThan(0);
    expect(keys.beta).toMatchObject({ requests: 1, totalTokens: 2 });
  });

  it('ignores responses without token counts', () => {
    recordKeyTokens('alpha', null);
    recordKeyTokens('alpha', { rolling: { percent: 5 } });
    expect(getKeyTokenUsage().keys).toEqual({});
  });

  it('persists counters after the debounce window', async () => {
    vi.useFakeTimers();
    try {
      recordKeyTokens('alpha', usage(10, 5));
      const path = getTokenUsagePath();
      expect(existsSync(path)).toBe(false); // write-behind: nothing yet

      await vi.advanceTimersByTimeAsync(10_000);
      expect(existsSync(path)).toBe(true);

      const file = JSON.parse(readFileSync(path, 'utf-8')) as {
        since: number;
        keys: Record<string, { requests: number; totalTokens: number }>;
      };
      expect(file.keys.alpha.totalTokens).toBe(15);
      expect(typeof file.since).toBe('number');

      // Counters survive an in-memory reset when a file exists.
      resetTokenUsage();
      expect(getKeyTokenUsage().keys.alpha.totalTokens).toBe(15);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush never overwrites history when the process recorded nothing', async () => {
    vi.useFakeTimers();
    try {
      recordKeyTokens('alpha', usage(10, 5));
      await vi.advanceTimersByTimeAsync(10_000);
      const path = getTokenUsagePath();

      // A fresh process restarts (in-memory state reset), records nothing,
      // and shuts down gracefully — history must survive.
      resetTokenUsage();
      flushTokenUsage();
      const file = JSON.parse(readFileSync(path, 'utf-8')) as {
        keys: Record<string, { totalTokens: number }>;
      };
      expect(file.keys.alpha.totalTokens).toBe(15);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush persists pending writes immediately and cancels the timer', async () => {
    vi.useFakeTimers();
    try {
      recordKeyTokens('alpha', usage(4, 6));
      flushTokenUsage();
      const path = getTokenUsagePath();
      expect(JSON.parse(readFileSync(path, 'utf-8')).keys.alpha.totalTokens).toBe(10);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(JSON.parse(readFileSync(path, 'utf-8')).keys.alpha.totalTokens).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset discards the pending debounce write', async () => {
    vi.useFakeTimers();
    try {
      recordKeyTokens('alpha', usage(1, 1, 2));
      resetTokenUsage();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(existsSync(getTokenUsagePath())).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sanitizes key labels: strips control chars, caps length, drops empty', () => {
    recordKeyTokens('ox\u0000-al\u001B[31mpha\u007F', usage(1, 1, 2));
    expect(Object.keys(getKeyTokenUsage().keys)).toEqual(['ox-al[31mpha']);

    recordKeyTokens('long-' + 'x'.repeat(200), usage(1, 1, 2));
    const labels = Object.keys(getKeyTokenUsage().keys);
    expect(labels[1].length).toBe(128);

    recordKeyTokens('\u0000\u001F', usage(1, 1, 2));
    expect(Object.keys(getKeyTokenUsage().keys)).toHaveLength(2);
  });

  it('caps tracked keys at 200, evicting the least-used entry', () => {
    for (let i = 0; i < 200; i++) {
      recordKeyTokens(`key-${String(i).padStart(3, '0')}`, usage(1, 1, 2));
    }
    // key-000 gets extra responses so it survives; key-001 stays at 1 and is
    // the least-used when the 201st label arrives.
    recordKeyTokens('key-000', usage(1, 1, 2));

    recordKeyTokens('the-new-arrival', usage(1, 1, 2));

    const { keys } = getKeyTokenUsage();
    expect(Object.keys(keys)).toHaveLength(200);
    expect(keys['key-001']).toBeUndefined();
    expect(keys['key-000'].requests).toBe(2);
    expect(keys['the-new-arrival']).toBeDefined();
  });

  it('never evicts the label it just recorded', () => {
    for (let i = 0; i < 200; i++) {
      recordKeyTokens(`key-${String(i).padStart(3, '0')}`, usage(1, 1, 2));
      recordKeyTokens(`key-${String(i).padStart(3, '0')}`, usage(1, 1, 2));
    }
    // Every existing label has 2 responses; the new one has 1 and is the
    // least-used — it must survive its own recording.
    recordKeyTokens('fresh', usage(1, 1, 2));
    const { keys } = getKeyTokenUsage();
    expect(keys.fresh.requests).toBe(1);
    expect(Object.keys(keys)).toHaveLength(201);
  });

  it('ignores corrupt files and filters unusable entries on load', () => {
    mkdirSync(join(tmpDir, 'saros'), { recursive: true });
    const path = join(tmpDir, 'saros', 'token-usage.json');
    writeFileSync(path, '{broken', 'utf-8');
    expect(getKeyTokenUsage()).toEqual({ since: 0, keys: {} });

    writeFileSync(
      path,
      JSON.stringify({
        since: 1_700_000_000_000,
        keys: {
          good: { requests: 2, promptTokens: 5, completionTokens: 5, totalTokens: 10, lastAt: 9 },
          never: { requests: 0, totalTokens: 999 },
          junk: 'not-an-object',
        },
      }),
      'utf-8',
    );
    resetTokenUsage(); // drop in-memory state so the file is reloaded
    expect(getKeyTokenUsage()).toEqual({
      since: 1_700_000_000_000,
      keys: {
        good: { requests: 2, promptTokens: 5, completionTokens: 5, totalTokens: 10, lastAt: 9 },
      },
    });
  });

  it('loads a file without since or with non-object keys', () => {
    mkdirSync(join(tmpDir, 'saros'), { recursive: true });
    const path = join(tmpDir, 'saros', 'token-usage.json');

    // Keys present, `since` absent → a fresh timestamp is stamped on write.
    writeFileSync(path, JSON.stringify({
      keys: { alpha: { requests: 1, promptTokens: 2, completionTokens: 3, totalTokens: 5, lastAt: 7 } },
    }), 'utf-8');
    resetTokenUsage();
    expect(getKeyTokenUsage().since).toBe(0);
    flushTokenUsage();
    const stamped = JSON.parse(readFileSync(path, 'utf-8')) as { since: number };
    expect(stamped.since).toBeGreaterThan(0);

    // `keys` is not an object → nothing loaded, no crash.
    writeFileSync(path, JSON.stringify({ since: 42, keys: 'nope' }), 'utf-8');
    resetTokenUsage();
    expect(getKeyTokenUsage()).toEqual({ since: 42, keys: {} });
  });

  it('flush is a no-op when nothing was recorded', () => {
    flushTokenUsage();
    expect(existsSync(getTokenUsagePath())).toBe(false);
  });

  it('flush after the debounce already fired re-persists without a timer', async () => {
    vi.useFakeTimers();
    try {
      recordKeyTokens('alpha', usage(1, 1, 2));
      await vi.advanceTimersByTimeAsync(10_000); // debounce fires, timer cleared
      recordKeyTokens('alpha', usage(1, 1, 2));
      await vi.advanceTimersByTimeAsync(10_000);
      flushTokenUsage(); // no pending timer left → straight to persist
      const file = JSON.parse(readFileSync(getTokenUsagePath(), 'utf-8')) as {
        keys: Record<string, { requests: number }>;
      };
      expect(file.keys.alpha.requests).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persist swallows write errors (best-effort counters)', async () => {
    vi.useFakeTimers();
    try {
      mockedWriteFileSync.mockImplementationOnce(() => {
        throw new Error('ENOSPC: no space left on device');
      });
      recordKeyTokens('alpha', usage(1, 2, 3));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(getKeyTokenUsage().keys.alpha.totalTokens).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
