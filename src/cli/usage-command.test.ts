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

function makeConfig(keys: Array<{ label: string; key: string; provider?: string }>): ProxyConfig {
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

function usageBody(percent: number, resetsAt?: string | null): Response {
  const windows: Record<string, unknown> = { rolling: { percent }, weekly: { percent }, monthly: { percent } };
  if (resetsAt !== undefined) {
    for (const k of ['rolling', 'weekly', 'monthly']) {
      (windows[k] as Record<string, unknown>).resetsAt = resetsAt;
    }
  }
  return new Response(JSON.stringify({ usage: windows }), { status: 200 });
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

  it('colors window tiers and renders every reset-time format', async () => {
    mockConfigRef.config = makeConfig([{ label: 'hot', key: 'sk-hot' }]);
    // >=90 -> red tier; resets in 30 minutes
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      usageBody(95, new Date(Date.now() + 30 * 60_000).toISOString()),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUsageCommand();
    let out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('95%');
    expect(out).toContain('tightest resets in 3');

    // 70..89 -> yellow tier; resets in hours
    mockConfigRef.config = makeConfig([{ label: 'warm', key: 'sk-warm' }]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValue(
      usageBody(75, new Date(Date.now() + 5 * 3_600_000).toISOString()),
    );
    log.mockClear();
    await runUsageCommand();
    out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('75%');
    expect(out).toContain('in 5h');

    // <70 -> green tier; resets in days
    mockConfigRef.config = makeConfig([{ label: 'cool', key: 'sk-cool' }]);
    fetchSpy.mockResolvedValue(
      usageBody(10, new Date(Date.now() + 72 * 3_600_000).toISOString()),
    );
    log.mockClear();
    await runUsageCommand();
    out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('10%');
    expect(out).toContain('in 3d');

    // Missing resetsAt -> '-'; invalid date string -> '-' too
    mockConfigRef.config = makeConfig([{ label: 'odd', key: 'sk-odd' }]);
    fetchSpy.mockResolvedValue(usageBody(50, 'not-a-date'));
    log.mockClear();
    await runUsageCommand();
    out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('(tightest resets -)');

    fetchSpy.mockRestore();
  });

  it('skips the models section silently when the stats file is corrupt or empty', async () => {
    mockConfigRef.config = makeConfig([{ label: 'alpha', key: 'sk-alpha' }]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(usageBody(42));
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'model-stats.json'), '{broken json', 'utf-8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runUsageCommand();
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Key usage'));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Most used models'));

    // Valid JSON but zero/absent counts -> section skipped as well
    writeFileSync(join(tmpDir, 'model-stats.json'), JSON.stringify({ since: 1, counts: { gone: 0 } }), 'utf-8');
    log.mockClear();
    await runUsageCommand();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Most used models'));
  });

  it('returns 1 only when every key fails to fetch usage', async () => {
    mockConfigRef.config = makeConfig([
      { label: 'alpha', key: 'sk-alpha' },
      { label: 'beta', key: 'sk-beta' },
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 500 }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runUsageCommand();
    expect(code).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed to fetch'));
  });

  it('reports n/a for providers without a queryable usage API', async () => {
    // commandcode has no usage endpoint; the command must not call fetch.
    mockConfigRef.config = makeConfig([
      { label: 'cc', key: 'user_cc-key-abcdefghijklmnop', provider: 'commandcode' },
      { label: 'oc', key: 'sk-oc-key-abcdefghijklmnop', provider: 'opencode-go' },
    ]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(usageBody(25));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runUsageCommand();
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('(commandcode)'));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('usage: n/a — provider has no queryable usage API'),
    );
    // opencode-go key still fetched its usage.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
  it('renders the models section when counts exist but since is absent', async () => {
    mockConfigRef.config = makeConfig([{ label: 'alpha', key: 'sk-alpha' }]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(usageBody(42));
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'model-stats.json'),
      JSON.stringify({ counts: { 'glm-5': 7 } }),
      'utf-8',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runUsageCommand();
    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('Most used models');
    expect(out).toContain('glm-5');
    expect(out).not.toContain('since 202');
  });
  it('skips the models section when counts are absent entirely', async () => {
    mockConfigRef.config = makeConfig([{ label: 'alpha', key: 'sk-alpha' }]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(usageBody(42));
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'model-stats.json'), JSON.stringify({ since: 1 }), 'utf-8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUsageCommand();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Most used models'));
  });

  it('renders a missing reset time as a dash', async () => {
    mockConfigRef.config = makeConfig([{ label: 'odd', key: 'sk-odd' }]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(usageBody(50, undefined));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUsageCommand();
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('(tightest resets -)');
  });

  it('reports a non-Error config-load failure verbatim', async () => {
    mockConfigRef.config = makeConfig([{ label: 'alpha', key: 'sk-alpha' }]);
    vi.mocked(loadConfig).mockImplementation(() => {
      throw 'disk on fire';
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runUsageCommand()).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Failed to load config'), 'disk on fire');
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