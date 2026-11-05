/**
 * usage-command.test.ts — Tests for the `saros-proxy usage` CLI command.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

// loadConfig reads the real config path; mock it to a fixed fixture.
const mockConfigRef = vi.hoisted(() => ({ config: null as unknown }));
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadConfig: vi.fn(() => mockConfigRef.config),
    getModelStatsPath: actual.getModelStatsPath,
  };
});

// model-stats reads XDG_CONFIG_HOME; steer it to a temp dir.
const tmpRef = vi.hoisted(() => ({ dir: '' }));
vi.mock('../src/model-stats.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/model-stats.js')>();
  return {
    ...actual,
    getModelStatsPath: () => join(tmpRef.dir, 'model-stats.json'),
  };
});

// token-usage also resolves through the real config dir — same treatment.
vi.mock('../src/token-usage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/token-usage.js')>();
  return {
    ...actual,
    getTokenUsagePath: () => join(tmpRef.dir, 'token-usage.json'),
  };
});

import { runUsageCommand } from '../src/cli/usage.js';
import { SecretSourceError } from '../src/secrets/source.js';
import { loadConfig } from '../src/config.js';
import type { ProxyConfig } from '../src/config.js';

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

/** Real /alpha/billing/credits payload shape (verified live 2026-11-05). */
function creditsBody(): Response {
  return new Response(JSON.stringify({
    credits: { monthlyCredits: 62.2914806211, purchasedCredits: 0, freeCredits: 0 },
    windowLimits: {
      limited: true,
      fiveHour: { used: 0.1300584138, cap: 14, exceeded: false, resetAt: 1793914043720 },
      weekly: { used: 4.0825104096, cap: 35, exceeded: false, resetAt: 1794307589031 },
    },
  }), { status: 200 });
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

  it('fetches commandcode credits with CLI identity alongside opencode-go usage', async () => {
    mockConfigRef.config = makeConfig([
      { label: 'cc', key: 'user_cc-key-abcdefghijklmnop', provider: 'commandcode' },
      { label: 'oc', key: 'sk-oc-key-abcdefghijklmnop', provider: 'opencode-go' },
    ]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/alpha/billing/credits') ? creditsBody() : usageBody(25),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runUsageCommand();
    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('(commandcode)');
    expect(out).toContain('(opencode-go)');
    // Credits → used/cap: 0.1301/14 = 0.93% (5h), 4.0825/35 = 11.66% (weekly).
    expect(out).toContain('5h: 1%  Weekly: 12%  Monthly: 0%');
    expect(out).toContain('25%');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const creditsCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).endsWith('/alpha/billing/credits'));
    // Cloudflare gates the route on the CLI identity headers.
    expect((creditsCall?.[1] as RequestInit).headers).toMatchObject({
      'User-Agent': expect.stringMatching(/^CommandCodeCLI\//),
    });
  });

  it('reports n/a for an unknown provider id', async () => {
    mockConfigRef.config = makeConfig([
      { label: 'ghost', key: 'sk-ghost', provider: 'unknown' as never },
    ]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runUsageCommand();
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('usage: n/a — provider has no queryable usage API'),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('appends token totals to the commandcode credits line', async () => {
    mockConfigRef.config = makeConfig([
      { label: 'cc', key: 'user_cc-key-abcdefghijklmnop', provider: 'commandcode' },
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(creditsBody());
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'token-usage.json'),
      JSON.stringify({
        since: Date.parse('2026-09-01T00:00:00Z'),
        keys: {
          cc: {
            requests: 12,
            promptTokens: 9_000,
            completionTokens: 3_300,
            totalTokens: 12_300,
            lastAt: Date.now(),
          },
        },
      }),
      'utf-8',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runUsageCommand();
    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('Weekly: 12%');
    expect(out).toContain('· tokens: 12.3k (9k in / 3.3k out, 12 requests)');
    expect(out).toContain('token totals since 2026-09-01');
  });

  it('appends token totals to quota lines and filters unusable entries', async () => {
    mockConfigRef.config = makeConfig([{ label: 'alpha', key: 'sk-alpha' }]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(usageBody(42));
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'token-usage.json'),
      JSON.stringify({
        since: 0,
        keys: {
          alpha: {
            requests: 3,
            promptTokens: 1_500,
            completionTokens: 100,
            totalTokens: 1_600,
            lastAt: Date.now(),
          },
          // Never reported a request → not rendered.
          ghost: { requests: 0, totalTokens: 9_999 },
        },
      }),
      'utf-8',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runUsageCommand();
    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('42%');
    expect(out).toContain('· tokens: 1.6k (1.5k in / 100 out, 3 requests)');
    // No `since` in the file → no accumulation-window header.
    expect(out).not.toContain('token totals since');
  });

  it('treats a corrupt token-usage file as empty without failing', async () => {
    mockConfigRef.config = makeConfig([
      { label: 'cc', key: 'user_cc-key-abcdefghijklmnop', provider: 'commandcode' },
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(creditsBody());
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'token-usage.json'), '{broken json', 'utf-8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runUsageCommand();
    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('(commandcode)');
    expect(out).toContain('Weekly: 12%');
    expect(out).not.toContain('failed to fetch');
  });

  it('formats large and partial token totals', async () => {
    mockConfigRef.config = {
      ...makeConfig([{ label: 'alpha', key: 'sk-alpha' }]),
      // Configured upstream override → quota fetch uses the mapped base URL.
      upstreams: { 'opencode-go': 'https://override.example.com' },
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(usageBody(20));
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'token-usage.json'),
      JSON.stringify({
        since: Date.parse('2026-09-02T00:00:00Z'),
        keys: {
          // Millions bucket, and token fields the file never wrote.
          alpha: { requests: 40, totalTokens: 2_450_000, promptTokens: 2_000_000, completionTokens: 450_000 },
          beta: { requests: 2 },
        },
      }),
      'utf-8',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runUsageCommand();
    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('tokens: 2.5M (2M in / 450k out, 40 requests)');
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://override.example.com/zen/go/v1/usage');
  });

  it('flags a key whose account has no plan for its provider', async () => {
    mockConfigRef.config = makeConfig([
      { label: 'gated', key: 'sk-gated' },
      { label: 'alpha', key: 'sk-alpha' },
    ]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const auth = (init as RequestInit).headers as Record<string, string>;
      if (auth.Authorization.includes('sk-gated')) {
        return new Response(
          JSON.stringify({ type: 'error', error: { type: 'EntitlementError', message: 'subscription required' } }),
          { status: 403 },
        );
      }
      return usageBody(30);
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runUsageCommand();
    // A definitive "no subscription" answer is not a fetch failure.
    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('no subscription for this provider — excluded from rotation');
    expect(out).toContain('30%');
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

  it('falls back to local totals when encrypted keys have no passphrase', async () => {
    vi.mocked(loadConfig).mockImplementation(() => {
      throw new SecretSourceError('Encrypted API keys found, but no passphrase source is available.');
    });
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'model-stats.json'),
      JSON.stringify({ since: Date.now(), counts: { 'gpt-test': 3 } }),
      'utf-8',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runUsageCommand()).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('local token totals only');
    expect(out).toContain('SAROS_PASSPHRASE');
    expect(out).toContain('Most used models');
  });
});