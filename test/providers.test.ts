/**
 * providers.test.ts — Unit tests for the multi-provider key abstraction.
 *
 * Network-dependent paths (smokeTest) are tested against a local HTTP mock
 * server; protocol-level helpers are tested purely.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import {
  opencodeGoProvider,
  parseOpencodeUsage,
} from '../src/providers/opencode-go.js';
import {
  commandcodeProvider,
  commandcodeClientHeaders,
  parseCommandcodeUsage,
  parsePlanId,
} from '../src/providers/commandcode.js';
import { identifyKey, extractKeys, isPlausibleKey, allProviders } from '../src/providers/index.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseOpencodeUsage', () => {
  it('parses a valid opencode-go usage body', () => {
    const body = JSON.stringify({
      usage: {
        rolling: { status: 'ok', percent: 12, resetsAt: '2026-08-29T00:00:00Z' },
        weekly: { status: 'ok', percent: 40 },
        monthly: { status: 'ok', percent: 5 },
      },
    });
    const usage = parseOpencodeUsage(body);
    expect(usage).not.toBeNull();
    expect(usage?.rollingPercent).toBe(12);
    expect(usage?.weeklyPercent).toBe(40);
    expect(usage?.monthlyPercent).toBe(5);
    // The rotation metric is the monthly window, not the worst window.
    expect(usage?.usedPercent).toBe(5);
    expect(usage?.exhausted).toBe(false);
    expect(usage?.monthlyAvailable).toBe(true);
    expect(usage?.rollingResetsAt).toBe('2026-08-29T00:00:00Z');
  });

  it('returns null on non-JSON and contract violations', () => {
    expect(parseOpencodeUsage('not json')).toBeNull();
    expect(parseOpencodeUsage('{}')).toBeNull();
    expect(parseOpencodeUsage('{"usage":"nope"}')).toBeNull();
  });

  it('returns null when usage exists but no window carries a number', () => {
    // A shape-less 200 must not overwrite the last good usage with zeros.
    expect(parseOpencodeUsage('{"usage":{}}')).toBeNull();
    expect(parseOpencodeUsage(
      '{"usage":{"rolling":{},"weekly":{"percent":"high"},"monthly":{}}}',
    )).toBeNull();
  });

  it('keeps usable windows when only the monthly percent is missing', () => {
    const usage = parseOpencodeUsage('{"usage":{"rolling":{"percent":12},"weekly":{"percent":40},"monthly":{}}}');
    expect(usage).not.toBeNull();
    expect(usage?.usedPercent).toBe(0);
    expect(usage?.monthlyAvailable).toBe(false);
    expect(usage?.exhausted).toBe(false);
  });

  it('clamps out-of-range percentages and flags an exhausted window', () => {
    const usage = parseOpencodeUsage('{"usage":{"rolling":{"percent":150},"weekly":{"percent":-3},"monthly":{"percent":0}}}');
    expect(usage?.rollingPercent).toBe(100);
    expect(usage?.weeklyPercent).toBe(0);
    expect(usage?.usedPercent).toBe(0);
    // The rolling window is at 100% even though the month is untouched.
    expect(usage?.exhausted).toBe(true);
  });
});

describe('parsePlanId', () => {
  it('extracts planId from a subscription body', () => {
    expect(parsePlanId('{"success":true,"data":{"planId":"individual-goat"}}')).toBe('individual-goat');
  });

  it('returns undefined for invalid bodies', () => {
    expect(parsePlanId('nope')).toBeUndefined();
    expect(parsePlanId('{"success":false}')).toBeUndefined();
    expect(parsePlanId('{"data":{}}')).toBeUndefined();
  });
});

// Real GET /alpha/billing/credits payload, measured 2026-11-05.
const CREDITS_BODY = JSON.stringify({
  credits: { monthlyCredits: 62.1003565047, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    fiveHour: { used: 0.3212, cap: 14, exceeded: false, resetAt: 1793914043720 },
    weekly: { used: 4.2736, cap: 35, exceeded: false, resetAt: 1794307589031 },
  },
});

describe('parseCommandcodeUsage', () => {
  it('derives the monthly rotation metric from the live credits payload', () => {
    const usage = parseCommandcodeUsage(CREDITS_BODY);
    expect(usage).not.toBeNull();
    expect(usage?.rollingPercent).toBeCloseTo(2.294285714, 6);
    expect(usage?.weeklyPercent).toBeCloseTo(12.210285714, 6);
    // Monthly cap = 2 × weekly.cap = 70; consumed = 70 − remaining credits.
    expect(usage?.monthlyPercent).toBeCloseTo(11.285204993, 6);
    expect(usage?.usedPercent).toBe(usage?.monthlyPercent);
    expect(usage?.exhausted).toBe(false);
    expect(usage?.monthlyAvailable).toBe(true);
    expect(usage?.rollingResetsAt).toBe('2026-11-05T21:27:23.720Z');
    expect(usage?.weeklyResetsAt).toBe('2026-11-10T10:46:29.031Z');
    expect(usage?.monthlyResetsAt).toBeUndefined();
  });

  it('falls back to 5 × fiveHour.cap when weekly.cap is absent', () => {
    const usage = parseCommandcodeUsage(JSON.stringify({
      credits: { monthlyCredits: 35 },
      windowLimits: { fiveHour: { used: 7, cap: 14 } },
    }));
    // Cap = 5 × 14 = 70; 35 credits remain → 50% consumed.
    expect(usage?.monthlyPercent).toBeCloseTo(50, 10);
    expect(usage?.usedPercent).toBeCloseTo(50, 10);
    expect(usage?.exhausted).toBe(false);
    expect(usage?.monthlyAvailable).toBe(true);
  });

  it('falls back to 5 × fiveHour.cap when the weekly-derived cap contradicts the used credits', () => {
    const usage = parseCommandcodeUsage(JSON.stringify({
      credits: { monthlyCredits: 68.5 },
      windowLimits: {
        fiveHour: { used: 0.5, cap: 20 },
        weekly: { used: 2, cap: 35 },
      },
    }));
    // 2 × 35 = 70, but consumed (70 − 68.5 = 1.5) < weekly.used (2) — impossible.
    // 5 × 20 = 100 validates: remaining 68.5 ≤ 100 and consumed 31.5 ≥ 2.
    expect(usage?.monthlyPercent).toBeCloseTo(31.5, 10);
    expect(usage?.monthlyAvailable).toBe(true);
  });

  it('returns null when monthlyCredits is numeric but no derived cap validates', () => {
    // remaining > cap means the inferred ladder is wrong; never clamp to 0%.
    expect(parseCommandcodeUsage(JSON.stringify({
      credits: { monthlyCredits: 100 },
      windowLimits: { fiveHour: { used: 1, cap: 14 }, weekly: { used: 2, cap: 35 } },
    }))).toBeNull();

    // Same with a single weekly cap and more remaining credits than the cap.
    expect(parseCommandcodeUsage(
      '{"credits":{"monthlyCredits":80},"windowLimits":{"weekly":{"used":0,"cap":35}}}',
    )).toBeNull();
  });

  it('leaves the monthly metric at 0 when monthlyCredits is absent but windows exist', () => {
    const withoutCredits = parseCommandcodeUsage(JSON.stringify({
      windowLimits: { fiveHour: { used: 7, cap: 14 }, weekly: { used: 7, cap: 35 } },
    }));
    expect(withoutCredits).not.toBeNull();
    expect(withoutCredits?.monthlyPercent).toBe(0);
    expect(withoutCredits?.usedPercent).toBe(0);
    expect(withoutCredits?.monthlyAvailable).toBe(false);
    expect(withoutCredits?.exhausted).toBe(false);
  });

  it('returns null when neither windows nor a monthly value produce data', () => {
    // No windowLimits, only credits: no cap to derive anything from.
    expect(parseCommandcodeUsage(
      '{"credits":{"monthlyCredits":62.29,"purchasedCredits":0,"freeCredits":0}}',
    )).toBeNull();

    // Non-numeric remaining value and no usable window.
    expect(parseCommandcodeUsage(
      '{"credits":{"monthlyCredits":"62"},"windowLimits":{"weekly":{"cap":35}}}',
    )).toBeNull();

    // Credits but no caps anywhere.
    expect(parseCommandcodeUsage('{"credits":{"monthlyCredits":62}}')).toBeNull();

    // Empty object.
    expect(parseCommandcodeUsage('{}')).toBeNull();
  });

  it('clamps ratios and flags exhaustion from any window', () => {
    const usage = parseCommandcodeUsage(JSON.stringify({
      windowLimits: {
        fiveHour: { used: 20, cap: 10, resetAt: 'not-a-number' },
        weekly: { used: 1, cap: 0 },
      },
    }));
    expect(usage?.rollingPercent).toBe(100);
    expect(usage?.weeklyPercent).toBe(0);
    expect(usage?.monthlyPercent).toBe(0);
    expect(usage?.usedPercent).toBe(0);
    expect(usage?.monthlyAvailable).toBe(false);
    expect(usage?.exhausted).toBe(true);
    expect(usage?.rollingResetsAt).toBeUndefined();
  });

  it('flags exhaustion when the monthly allowance is spent', () => {
    const usage = parseCommandcodeUsage(
      '{"credits":{"monthlyCredits":0},"windowLimits":{"weekly":{"used":0,"cap":35}}}',
    );
    expect(usage?.monthlyPercent).toBe(100);
    expect(usage?.usedPercent).toBe(100);
    expect(usage?.exhausted).toBe(true);
  });

  it('returns null for non-JSON and non-object bodies', () => {
    expect(parseCommandcodeUsage('nope')).toBeNull();
    expect(parseCommandcodeUsage('null')).toBeNull();
    expect(parseCommandcodeUsage('[]')).toBeNull();
  });
});

describe('quickMatch', () => {
  it('user_ prefix uniquely identifies commandcode', () => {
    expect(commandcodeProvider.quickMatch('user_' + 'a'.repeat(40))).toBe('yes');
    expect(opencodeGoProvider.quickMatch('user_' + 'a'.repeat(40))).toBe('no');
  });

  it('sk- is ambiguous between providers (maybe)', () => {
    const key = 'sk-' + 'a'.repeat(40);
    expect(opencodeGoProvider.quickMatch(key)).toBe('maybe');
    expect(commandcodeProvider.quickMatch(key)).toBe('maybe');
  });

  it('oc_sk_ prefix uniquely identifies opencode-go', () => {
    const key = 'oc_sk_' + 'a'.repeat(40);
    expect(opencodeGoProvider.quickMatch(key)).toBe('yes');
    expect(commandcodeProvider.quickMatch(key)).toBe('no');
  });

  it('rejects short or foreign keys', () => {
    expect(opencodeGoProvider.quickMatch('sk-short')).toBe('no');
    expect(commandcodeProvider.quickMatch('tok_' + 'a'.repeat(40))).toBe('no');
  });
});

describe('commandcodeClientHeaders', () => {
  it('includes all CLI-identity headers', () => {
    const h = commandcodeClientHeaders('1.38.2');
    expect(h['User-Agent']).toBe('CommandCodeCLI/1.38.2');
    expect(h['X-CommandCode-Client']).toBe('cli');
    expect(h['X-CLI-Environment']).toBe('production');
    expect(h.Authorization).toBeUndefined();
  });
});

describe('provider identity headers', () => {
  it('opencode-go overrides the User-Agent with the CLI identity Cloudflare accepts', () => {
    expect(opencodeGoProvider.extraUpstreamHeaders?.()).toEqual({ 'User-Agent': 'cli' });
  });

  it('opencode-go usage endpoint is unchanged', () => {
    expect(opencodeGoProvider.usagePath()).toBe('/zen/go/v1/usage');
  });
});

// ---------------------------------------------------------------------------
// Registry / identification (structural paths)
// ---------------------------------------------------------------------------

describe('registry', () => {
  it('registers both providers', () => {
    expect(allProviders().map((p) => p.id).sort()).toEqual(['commandcode', 'opencode-go']);
  });

  it('isPlausibleKey accepts both formats and rejects junk', () => {
    expect(isPlausibleKey('sk-' + 'a'.repeat(40))).toBe(true);
    expect(isPlausibleKey('user_' + 'a'.repeat(40))).toBe(true);
    expect(isPlausibleKey('oc_sk_' + 'a'.repeat(40))).toBe(true);
    expect(isPlausibleKey('garbage')).toBe(false);
    expect(isPlausibleKey('')).toBe(false);
  });
});

describe('extractKeys', () => {
  it('extracts keys from arbitrary pasted text', () => {
    const text = 'here are my keys:\nsk-abcdefghijklmnop1234567890 and user_abcdefghijklmnop1234567890!';
    const keys = extractKeys(text);
    expect(keys).toContain('sk-abcdefghijklmnop1234567890');
    expect(keys).toContain('user_abcdefghijklmnop1234567890');
  });

  it('extracts oc_sk_ opencode keys', () => {
    const text = 'OPENCODE_API_KEY=oc_sk_abcdefghijklmnop1234567890';
    expect(extractKeys(text)).toEqual(['oc_sk_abcdefghijklmnop1234567890']);
  });

  it('dedupes repeated keys', () => {
    const text = 'user_abcdefghijklmnop1234567890 user_abcdefghijklmnop1234567890';
    expect(extractKeys(text)).toHaveLength(1);
  });

  it('returns empty for text without keys', () => {
    expect(extractKeys('no keys here')).toEqual([]);
  });
});

describe('identifyKey (offline)', () => {
  it('routes user_ keys to commandcode unverified', async () => {
    const result = await identifyKey('user_' + 'a'.repeat(40), { verify: false });
    expect(result.provider).toBe('commandcode');
    expect(result.confidence).toBe('unverified');
  });

  it('routes oc_sk_ keys to opencode-go unverified', async () => {
    const result = await identifyKey('oc_sk_' + 'a'.repeat(40), { verify: false });
    expect(result.provider).toBe('opencode-go');
    expect(result.confidence).toBe('unverified');
  });

  it('returns unknown for unrecognized prefixes', async () => {
    const result = await identifyKey('totally-not-a-key', { verify: false });
    expect(result.provider).toBeNull();
    expect(result.confidence).toBe('unknown');
  });

  it('keeps an sk- key unverified when both providers could match it', async () => {
    const result = await identifyKey('sk-' + 'a'.repeat(40), { verify: false });
    expect(result.provider).toBeNull();
    expect(result.confidence).toBe('unverified');
  });
});

// ---------------------------------------------------------------------------
// Smoke tests against a local mock upstream
// ---------------------------------------------------------------------------

describe('smokeTest (mock upstream)', () => {
  let server: Server;
  let baseUrl: string;
  let lastHeaders: Record<string, string | string[] | undefined> = {};
  let mode: 'ok' | 'unauthorized' | 'boom';

  beforeAll(async () => {
    server = createServer((req, res) => {
      lastHeaders = req.headers;
      res.setHeader('content-type', 'application/json');
      if (mode === 'ok') {
        res.end(JSON.stringify({ success: true, data: { planId: 'individual-goat' } }));
      } else if (mode === 'unauthorized') {
        res.statusCode = 401;
        res.end(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', status: 401 } }));
      } else {
        res.statusCode = 500;
        res.end('boom');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('commandcode: 200 + planId → valid', async () => {
    // Point the provider at the mock by temporarily swapping its baseUrl
    const original = commandcodeProvider.baseUrl;
    (commandcodeProvider as { baseUrl: string }).baseUrl = baseUrl;
    Object.defineProperty(commandcodeProvider, 'baseUrl', { value: baseUrl, configurable: true });
    mode = 'ok';
    const result = await commandcodeProvider.smokeTest('user_testkeyabcdefghijklmnop');
    Object.defineProperty(commandcodeProvider, 'baseUrl', { value: original, configurable: true });
    expect(result.status).toBe('valid');
    expect(result.meta?.planId).toBe('individual-goat');
    expect(lastHeaders.authorization).toBe('Bearer user_testkeyabcdefghijklmnop');
    expect(lastHeaders['x-commandcode-client']).toBe('cli');
  });

  it('commandcode: 401 → invalid (definitive negative)', async () => {
    const original = commandcodeProvider.baseUrl;
    Object.defineProperty(commandcodeProvider, 'baseUrl', { value: baseUrl, configurable: true });
    mode = 'unauthorized';
    const result = await commandcodeProvider.smokeTest('user_testkeyabcdefghijklmnop');
    Object.defineProperty(commandcodeProvider, 'baseUrl', { value: original, configurable: true });
    expect(result.status).toBe('invalid');
    expect(result.httpStatus).toBe(401);
  });

  it('commandcode: 5xx → error (inconclusive)', async () => {
    const original = commandcodeProvider.baseUrl;
    Object.defineProperty(commandcodeProvider, 'baseUrl', { value: baseUrl, configurable: true });
    mode = 'boom';
    const result = await commandcodeProvider.smokeTest('user_testkeyabcdefghijklmnop');
    Object.defineProperty(commandcodeProvider, 'baseUrl', { value: original, configurable: true });
    expect(result.status).toBe('error');
  });

  it('opencode-go: 401 → invalid', async () => {
    const original = opencodeGoProvider.baseUrl;
    Object.defineProperty(opencodeGoProvider, 'baseUrl', { value: baseUrl, configurable: true });
    mode = 'unauthorized';
    const result = await opencodeGoProvider.smokeTest('sk-testkeyabcdefghijklmnop');
    Object.defineProperty(opencodeGoProvider, 'baseUrl', { value: original, configurable: true });
    expect(result.status).toBe('invalid');
  });

  it('opencode-go: 200 → valid', async () => {
    const original = opencodeGoProvider.baseUrl;
    Object.defineProperty(opencodeGoProvider, 'baseUrl', { value: baseUrl, configurable: true });
    mode = 'ok';
    const result = await opencodeGoProvider.smokeTest('sk-testkeyabcdefghijklmnop');
    Object.defineProperty(opencodeGoProvider, 'baseUrl', { value: original, configurable: true });
    expect(result.status).toBe('valid');
    // Cloudflare rejects browser-like signatures, so even the probe must
    // identify as the CLI.
    expect(lastHeaders['user-agent']).toBe('cli');
  });
});

describe('identifyKey (mock upstream, sk- collision)', () => {
  let server: Server;
  let baseUrl: string;
  let opencodeMode: 'ok' | 'unauthorized' | 'boom';

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      // The mock serves both providers' paths on one port:
      //   /zen/go/v1/usage            → opencode-go
      //   /alpha/billing/subscriptions → commandcode
      if (req.url?.startsWith('/zen/go/v1/usage')) {
        if (opencodeMode === 'boom') {
          res.statusCode = 500;
          res.end('server error');
          return;
        }
        res.statusCode = opencodeMode === 'ok' ? 200 : 401;
        res.end(opencodeMode === 'ok'
          ? JSON.stringify({ usage: { rolling: { percent: 10 } } })
          : JSON.stringify({ type: 'error', error: { type: 'AuthError' } }));
        return;
      }
      if (req.url?.startsWith('/alpha/billing/subscriptions')) {
        // commandcode always rejects in this scenario (the key is opencode-go's)
        res.statusCode = 401;
        res.end(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED' } }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('classifies an sk- key as opencode-go when commandcode rejects it', async () => {
    const ccOriginal = commandcodeProvider.baseUrl;
    const ogOriginal = opencodeGoProvider.baseUrl;
    Object.defineProperty(commandcodeProvider, 'baseUrl', { value: baseUrl, configurable: true });
    Object.defineProperty(opencodeGoProvider, 'baseUrl', { value: baseUrl, configurable: true });
    opencodeMode = 'ok';
    const result = await identifyKey('sk-testkeyabcdefghijklmnop');
    Object.defineProperty(commandcodeProvider, 'baseUrl', { value: ccOriginal, configurable: true });
    Object.defineProperty(opencodeGoProvider, 'baseUrl', { value: ogOriginal, configurable: true });
    expect(result.provider).toBe('opencode-go');
    expect(result.confidence).toBe('verified');
  });

  it('returns invalid when every candidate rejects the key', async () => {
    const ccOriginal = commandcodeProvider.baseUrl;
    const ogOriginal = opencodeGoProvider.baseUrl;
    Object.defineProperty(commandcodeProvider, 'baseUrl', { value: baseUrl, configurable: true });
    Object.defineProperty(opencodeGoProvider, 'baseUrl', { value: baseUrl, configurable: true });
    opencodeMode = 'unauthorized';
    const result = await identifyKey('sk-testkeyabcdefghijklmnop');
    Object.defineProperty(commandcodeProvider, 'baseUrl', { value: ccOriginal, configurable: true });
    Object.defineProperty(opencodeGoProvider, 'baseUrl', { value: ogOriginal, configurable: true });
    expect(result.provider).toBeNull();
    expect(result.confidence).toBe('invalid');
  });

  it('returns unknown when candidates give mixed verdicts (one invalid, one errored)', async () => {
    const ccOriginal = commandcodeProvider.baseUrl;
    const ogOriginal = opencodeGoProvider.baseUrl;
    Object.defineProperty(commandcodeProvider, 'baseUrl', { value: baseUrl, configurable: true });
    Object.defineProperty(opencodeGoProvider, 'baseUrl', { value: baseUrl, configurable: true });
    // commandcode rejects (401 invalid); opencode-go errors (500 inconclusive)
    opencodeMode = 'boom';
    const result = await identifyKey('sk-testkeyabcdefghijklmnop');
    Object.defineProperty(commandcodeProvider, 'baseUrl', { value: ccOriginal, configurable: true });
    Object.defineProperty(opencodeGoProvider, 'baseUrl', { value: ogOriginal, configurable: true });
    expect(result.provider).toBeNull();
    expect(result.confidence).toBe('unknown');
  });
});
