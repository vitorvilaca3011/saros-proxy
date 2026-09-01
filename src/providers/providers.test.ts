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
} from './opencode-go.js';
import {
  commandcodeProvider,
  commandcodeClientHeaders,
  parsePlanId,
} from './commandcode.js';
import { identifyKey, extractKeys, isPlausibleKey, allProviders } from './index.js';

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
    expect(usage?.usedPercent).toBe(40);
    expect(usage?.rollingResetsAt).toBe('2026-08-29T00:00:00Z');
  });

  it('returns null on non-JSON and contract violations', () => {
    expect(parseOpencodeUsage('not json')).toBeNull();
    expect(parseOpencodeUsage('{}')).toBeNull();
    expect(parseOpencodeUsage('{"usage":"nope"}')).toBeNull();
  });

  it('clamps out-of-range percentages', () => {
    const usage = parseOpencodeUsage('{"usage":{"rolling":{"percent":150},"weekly":{"percent":-3},"monthly":{"percent":0}}}');
    expect(usage?.rollingPercent).toBe(100);
    expect(usage?.weeklyPercent).toBe(0);
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
