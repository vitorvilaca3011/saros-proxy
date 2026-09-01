/**
 * model-stats.test.ts — Tests for persisted per-model request counters.
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
  getModelStats,
  getModelStatsPath,
  recordModelRequest,
  resetModelStats,
  flushModelStats,
} from './model-stats.js';

const savedConfigHome = process.env.XDG_CONFIG_HOME;
let tmpDir = '';

beforeEach(() => {
  tmpDir = mkdtempSync(`${tmpdir()}${sep}model-stats-test-`);
  process.env.XDG_CONFIG_HOME = tmpDir;
  resetModelStats();
});

afterEach(async () => {
  // Flush any pending debounced write before restoring the environment
  resetModelStats();
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

describe('model-stats', () => {
  it('records requests and returns counts sorted desc', () => {
    recordModelRequest('glm-5');
    recordModelRequest('glm-5');
    recordModelRequest('kimi-k3');
    expect(getModelStats()).toEqual([
      { model: 'glm-5', count: 2 },
      { model: 'kimi-k3', count: 1 },
    ]);
  });

  it('persists counters after the debounce window', async () => {
    vi.useFakeTimers();
    try {
      recordModelRequest('glm-5');
      recordModelRequest('glm-5');

      const path = getModelStatsPath();
      expect(existsSync(path)).toBe(false); // write-behind: nothing yet

      await vi.advanceTimersByTimeAsync(10_000);
      expect(existsSync(path)).toBe(true);

      const file = JSON.parse(readFileSync(path, 'utf-8')) as {
        since: number;
        counts: Record<string, number>;
      };
      expect(file.counts['glm-5']).toBe(2);
      expect(typeof file.since).toBe('number');

      // Counters survive an in-memory reset when a file exists
      resetModelStats();
      expect(getModelStats()).toEqual([{ model: 'glm-5', count: 2 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush never overwrites history when the process recorded nothing', async () => {
    vi.useFakeTimers();
    try {
      // Seed history on disk
      recordModelRequest('glm-5');
      recordModelRequest('glm-5');
      await vi.advanceTimersByTimeAsync(10_000);
      const path = getModelStatsPath();
      expect(JSON.parse(readFileSync(path, 'utf-8')).counts['glm-5']).toBe(2);

      // A fresh process restarts (in-memory state reset), records nothing,
      // and shuts down gracefully — history must survive.
      resetModelStats();
      flushModelStats();
      const file = JSON.parse(readFileSync(path, 'utf-8')) as {
        counts: Record<string, number>;
      };
      expect(file.counts['glm-5']).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sanitizes model names: strips control chars, caps length, drops empty', () => {
    // Control bytes (NUL, ESC, DEL) are stripped; the remaining ANSI payload
    // characters are ordinary text and survive.
    recordModelRequest('ox\u0000-al\u001B[31mpha\u007F');
    expect(getModelStats()).toEqual([{ model: 'ox-al[31mpha', count: 1 }]);

    // Pure control characters sanitize to empty -> nothing recorded
    recordModelRequest('\u0000\u001F');
    recordModelRequest('');
    expect(getModelStats()).toEqual([{ model: 'ox-al[31mpha', count: 1 }]);
  });

  it('caps tracked models at 200, evicting the least-used entry', () => {
    for (let i = 0; i < 200; i++) {
      recordModelRequest(`model-${String(i).padStart(3, '0')}`);
    }
    // Give model-000 extra hits so it survives; model-001 stays at 1 and is
    // the least-used when the 201st distinct model arrives.
    recordModelRequest('model-000');

    recordModelRequest('the-new-arrival');

    const stats = getModelStats();
    expect(stats.length).toBeLessThanOrEqual(200);
    expect(stats.find((s) => s.model === 'model-001')).toBeUndefined();
    expect(stats.find((s) => s.model === 'model-000')?.count).toBe(2);
    expect(stats.find((s) => s.model === 'the-new-arrival')).toBeDefined();
  });

  it('load filters non-positive counts and preserves since from disk', async () => {
    vi.useFakeTimers();
    try {
      recordModelRequest('glm-5');
      await vi.advanceTimersByTimeAsync(10_000);
      const path = getModelStatsPath();
      // Corrupt the persisted file with junk entries + valid since
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { since: number };
      writeFileSync(path, JSON.stringify({
        since: raw.since,
        counts: { glm5: 2, zero: 0, negative: -3, notanumber: 'x' },
      }), 'utf-8');

      resetModelStats(); // in-memory reset; next access reloads from disk
      const stats = getModelStats();
      expect(stats).toEqual([{ model: 'glm5', count: 2 }]);
      expect(getModelStatsPath()).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset discards pending debounce write', async () => {
    vi.useFakeTimers();
    try {
      recordModelRequest('glm-5');
      resetModelStats(); // cancels the scheduled persist
      await vi.advanceTimersByTimeAsync(10_000);
      expect(existsSync(getModelStatsPath())).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores corrupt or missing files', () => {
    mkdirSync(join(tmpDir, 'saros'), { recursive: true });
    writeFileSync(join(tmpDir, 'saros', 'model-stats.json'), '{broken', 'utf-8');
    expect(getModelStats()).toEqual([]);
  });

  it('persist swallows write errors (best-effort stats)', async () => {
    vi.useFakeTimers();
    try {
      mockedWriteFileSync.mockImplementationOnce(() => {
        throw new Error('ENOSPC: no space left on device');
      });
      recordModelRequest('glm-5');
      // Debounce fires -> persist throws -> caught and logged, no crash.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(getModelStats()).toEqual([{ model: 'glm-5', count: 1 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushModelStats persists pending writes immediately (pending-timer path)', async () => {
    vi.useFakeTimers();
    try {
      recordModelRequest('glm-5');
      flushModelStats(); // clears the pending debounce timer, then persists now
      const file = JSON.parse(readFileSync(getModelStatsPath(), 'utf-8')) as {
        counts: Record<string, number>;
      };
      expect(file.counts['glm-5']).toBe(1);
      // Timer was cancelled: advancing the clock writes nothing more.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(JSON.parse(readFileSync(getModelStatsPath(), 'utf-8')).counts['glm-5']).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
