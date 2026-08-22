/**
 * model-stats.test.ts — Tests for persisted per-model request counters.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getModelStats,
  getModelStatsPath,
  recordModelRequest,
  resetModelStats,
} from './model-stats.js';

const savedConfigHome = process.env.XDG_CONFIG_HOME;
let tmpDir = '';

beforeEach(() => {
  tmpDir = mkdtempSync(`${tmpdir()}${sep}model-stats-test-`);
  process.env.XDG_CONFIG_HOME = tmpDir;
  resetModelStats();
});

afterEach(() => {
  // Flush any pending debounced write before restoring the environment
  resetModelStats();
  process.env.XDG_CONFIG_HOME = savedConfigHome;
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

  it('ignores corrupt or missing files', () => {
    mkdirSync(join(tmpDir, 'saros'), { recursive: true });
    writeFileSync(join(tmpDir, 'saros', 'model-stats.json'), '{broken', 'utf-8');
    expect(getModelStats()).toEqual([]);
  });

});
