/**
 * logging.test.ts — Event contracts for the request lifecycle (#86).
 *
 * The logger is mocked so the assertions read the structured fields rather than
 * a pretty-printed line. Everything else runs through the real Hono app.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const logCalls = vi.hoisted(() => ({
  info: [] as Array<Record<string, unknown>>,
  warn: [] as Array<Record<string, unknown>>,
  error: [] as Array<Record<string, unknown>>,
  debug: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/logger.js')>();
  const record = (bucket: Array<Record<string, unknown>>) =>
    (first: unknown) => {
      if (first && typeof first === 'object') bucket.push(first as Record<string, unknown>);
    };
  return {
    ...actual,
    logger: {
      info: vi.fn(record(logCalls.info)),
      warn: vi.fn(record(logCalls.warn)),
      error: vi.fn(record(logCalls.error)),
      debug: vi.fn(record(logCalls.debug)),
      level: 'info',
    },
  };
});

import { createProxyApp } from '../src/proxy.js';
import type { ProxyConfig } from '../src/config.js';

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    upstreamBaseUrl: 'https://example.com',
    requestTimeoutMs: 30_000,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
    allowedOrigins: ['*'],
    keys: [{ label: 'alpha', key: 'sk-alpha-key-0001' }],
    ...overrides,
  };
}

function post(app: ReturnType<typeof createProxyApp>, body: unknown) {
  return app.request('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function completions() {
  return logCalls.info.filter((entry) => entry.evt === 'request.complete');
}

describe('request lifecycle logging', () => {
  beforeEach(() => {
    logCalls.info.length = 0;
    logCalls.warn.length = 0;
    logCalls.error.length = 0;
    logCalls.debug.length = 0;
  });

  it('emits one request.complete line per successful request', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"choices":[]}', { status: 200 }),
    );
    const app = createProxyApp(makeConfig());

    // No model id on purpose: the provider catalog is not loaded in this test,
    // so any affinity lookup would consult an empty cache and exclude the pool.
    const res = await post(app, { messages: [] });
    expect(res.status).toBe(200);

    const lines = completions();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      evt: 'request.complete',
      method: 'POST',
      path: '/zen/go/v1/chat/completions',
      model: null,
      provider: 'opencode-go',
      keyLabel: 'alpha',
      status: 200,
      stream: false,
      attempt: 1,
    });
    expect(typeof lines[0].durationMs).toBe('number');
    expect(lines[0].requestId).toEqual(expect.any(String));
  });

  it('marks streaming requests as such', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', { status: 200 }),
    );
    const app = createProxyApp(makeConfig());

    const res = await post(app, { messages: [], stream: true });
    await res.text();

    expect(completions()[0]).toMatchObject({ status: 200, stream: true });
  });

  it('records the upstream error with its body prefix and duration', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"error":"rate limited, slow down"}', { status: 429 }),
    );
    const app = createProxyApp(makeConfig());

    await post(app, { messages: [] });

    const errorLine = logCalls.warn.find((entry) => entry.evt === 'upstream.error');
    expect(errorLine).toMatchObject({ status: 429, kind: 'standard' });
    expect(typeof errorLine?.durationMs).toBe('number');
    expect(String(errorLine?.bodyPrefix)).toContain('rate limited');
  });

  it('still emits exactly one complete line when every key fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"error":"invalid key"}', { status: 401 }),
    );
    const app = createProxyApp(makeConfig({
      keys: [
        { label: 'alpha', key: 'sk-alpha-key-0001' },
        { label: 'beta', key: 'sk-beta-key-00002' },
      ],
    }));

    const first = await post(app, { messages: [] });
    expect(first.status).toBe(502);
    const linesAfterFirst = completions();
    expect(linesAfterFirst).toHaveLength(1);
    expect(linesAfterFirst[0]).toMatchObject({ status: 502 });
    expect(logCalls.error.some((entry) => entry.evt === 'request.retries_exhausted')).toBe(true);

    // Pool is empty now: the next request never reaches upstream.
    const second = await post(app, { messages: [] });
    expect(second.status).toBe(503);
    const lines = completions();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ status: 503, keyLabel: null });
  });

  it('logs the selected key at debug with its provider and pin state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const app = createProxyApp(makeConfig({
      keys: [{ label: 'cc', key: 'user_cc-key-0000000000001', provider: 'commandcode' }],
    }));

    await post(app, { model: 'claude-opus-5@commandcode', messages: [] });

    const selected = logCalls.debug.find((entry) => entry.evt === 'key.selected');
    expect(selected).toMatchObject({ keyLabel: 'cc', provider: 'commandcode', pinned: true });
  });

  it('never writes key material into a log line, even when the upstream echoes it', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"error":"Incorrect API key provided: sk-leaked-key-abcdef123456"}', {
        status: 401,
      }),
    );
    const app = createProxyApp(makeConfig());

    await post(app, { messages: [] });

    const dump = JSON.stringify([logCalls.info, logCalls.warn, logCalls.error, logCalls.debug]);
    expect(dump).not.toContain('sk-leaked-key-abcdef123456');
    expect(dump).toContain('[redacted-key]');

    // The retries-exhausted error carries the body in err.message.
    const exhausted = logCalls.error.find((entry) => entry.evt === 'request.retries_exhausted');
    expect(String((exhausted?.err as Error | undefined)?.message)).not.toContain(
      'sk-leaked-key-abcdef123456',
    );
  });

  it('reports the downstream status when the success handler synthesizes an error', async () => {
    // Upstream 2xx without a body: the streaming handler answers 502.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 200 }));
    const app = createProxyApp(makeConfig());

    const res = await post(app, { messages: [], stream: true });
    await res.text();
    expect(res.status).toBe(502);

    expect(completions()[0]).toMatchObject({ status: 502, stream: true });
  });
});
