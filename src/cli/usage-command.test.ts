/**
 * usage-command.test.ts — Tests for the `saros-proxy usage` CLI command.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

// loadConfig reads the real config path; mock it to a fixed fixture.
const mockConfigRef = vi.hoisted(() => ({ config: null as unknown }));
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    loadConfig: vi.fn(() => mockConfigRef.config),
    getModelStatsPath: actual.getModelStatsPath,
  };
});

// model-stats reads XDG_CONFIG_HOME; steer it to a temp dir.
const tmpRef = vi.hoisted(() => ({ dir: '' }));
vi.mock('../model-stats.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../model-stats.js')>();
  return {
    ...actual,
    getModelStatsPath: () => join(tmpRef.dir, 'model-stats.json'),
  };
});

import { runUsageCommand } from './usage.js';
import { loadConfig } from '../config.js';
import type { ProxyConfig } from '../config.js';

function makeConfig(keys: Array<{ label: string; key: string }>): ProxyConfig {
  return {
    port: 3000,
    host: '127.0.0.1',
    keys,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
    upstreamBaseUrl: 'https://example.com',
    requestTimeoutMs: 5_000,
    allowedOrigins: [],
  };
}

function usageBody(percent: number): Response {
  return new Response(
    JSON.stringify({ usage: { rolling: { percent }, weekly: { percent }, monthly: { percent } } }),
    { status: 200 },
  );
}

describe('runUsageCommand', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(`${tmpdir()}${sep}usage-cmd-test-`);
    tmpRef.dir = tmpDir;
    vi.mocked(loadConfig).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows cleanup races — non-fatal
    }
  });

  it('prints per-key usage windows', async () => {
    mockConfigRef.config = makeConfig([{ label: 'alpha', key: 'sk-alpha' }]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(usageBody(42));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runUsageCommand();
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Key usage'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('alpha'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('42%'));
  });

  it('marks failed fetches and exits non-zero only when all fail', async () => {
    mockConfigRef.config = makeConfig([
      { label: 'alpha', key: 'sk-alpha' },
      { label: 'beta', key: 'sk-beta' },
    ]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const h = (init as RequestInit).headers as Record<string, string>;
      if (h.Authorization?.includes('sk-alpha')) return usageBody(10);
      return new Response('boom', { status: 503 });
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runUsageCommand();
    // One key fetched OK → command succeeds overall
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('beta'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed to fetch'));
  });

  it('lists most-used models from the stats file when present', async () => {
    mockConfigRef.config = makeConfig([{ label: 'alpha', key: 'sk-alpha' }]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(usageBody(1));

    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'model-stats.json'),
      JSON.stringify({ since: Date.parse('2026-08-01T00:00:00Z'), counts: { 'glm-5': 7, 'kimi-k3': 3 } }),
      'utf-8',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runUsageCommand();
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Most used models'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('glm-5'));
  });

  it('returns 1 when no keys or config load fails', async () => {
    mockConfigRef.config = makeConfig([]);
    const code = await runUsageCommand();
    expect(code).toBe(1);

    mockConfigRef.config = null;
    vi.mocked(loadConfig).mockImplementation(() => {
      throw new Error('nope');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runUsageCommand()).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Failed to load config'), 'nope');
  });
});