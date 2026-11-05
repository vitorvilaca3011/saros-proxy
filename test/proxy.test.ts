import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildUpstreamUrl,
  buildUpstreamHeaders,
  isStreamingRequest,
  prepareOutboundRequest,
  createProxyApp,
  buildNoKeysBody,
  type UnavailableKey,
} from '../src/proxy.js';
import { opencodeGoProvider } from '../src/providers/opencode-go.js';
import { commandcodeProvider } from '../src/providers/commandcode.js';
import type { KeyProvider } from '../src/providers/index.js';
import { resetModelsFetcherState } from '../src/models-fetcher.js';
import { getKeyTokenUsage, resetTokenUsage } from '../src/token-usage.js';
import { loadModelsCatalog } from '../src/models-catalog.js';
import { getSarosDir, type ProxyConfig } from '../src/config.js';
import { MAX_BODY_SIZE } from '../src/constants.js';

describe('buildUpstreamUrl', () => {
  it('combines base URL and path', () => {
    expect(buildUpstreamUrl('https://api.example.com', '/v1/chat')).toBe('https://api.example.com/v1/chat');
  });

  it('strips trailing slash from base', () => {
    expect(buildUpstreamUrl('https://api.example.com/', '/v1/chat')).toBe('https://api.example.com/v1/chat');
    expect(buildUpstreamUrl('https://api.example.com///', '/v1/chat')).toBe('https://api.example.com/v1/chat');
  });

  it('adds leading slash to path if missing', () => {
    expect(buildUpstreamUrl('https://api.example.com', 'v1/chat')).toBe('https://api.example.com/v1/chat');
  });

  it('handles path with query parameters', () => {
    expect(buildUpstreamUrl('https://api.example.com', '/v1/chat?stream=true')).toBe('https://api.example.com/v1/chat?stream=true');
  });

  it('handles empty path', () => {
    expect(buildUpstreamUrl('https://api.example.com', '')).toBe('https://api.example.com/');
  });

  it('handles root path', () => {
    expect(buildUpstreamUrl('https://api.example.com', '/')).toBe('https://api.example.com/');
  });

  it('rejects path traversal attempts', () => {
    expect(() => buildUpstreamUrl('https://api.example.com', '/../../../etc/passwd')).toThrow('Path traversal detected');
    expect(() => buildUpstreamUrl('https://api.example.com', '/v1/../../internal')).toThrow('Path traversal detected');
  });
});

describe('buildUpstreamHeaders', () => {
  it('removes hop-by-hop headers', () => {
    const incoming = new Headers({
      'host': 'localhost:3000',
      'connection': 'keep-alive',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      'authorization': 'Bearer old-token',
      'content-type': 'application/json',
      'x-custom': 'value',
    });

    const result = buildUpstreamHeaders(incoming, 'new-token');

    expect(result.get('host')).toBeNull();
    expect(result.get('connection')).toBeNull();
    expect(result.get('keep-alive')).toBeNull();
    expect(result.get('transfer-encoding')).toBeNull();
    expect(result.get('content-type')).toBe('application/json');
    expect(result.get('x-custom')).toBe('value');
  });

  it('replaces Authorization header with new bearer token', () => {
    const incoming = new Headers({
      'authorization': 'Bearer old-token',
    });

    const result = buildUpstreamHeaders(incoming, 'new-token');

    expect(result.get('authorization')).toBe('Bearer new-token');
  });

  it('adds Authorization header even if not present', () => {
    const incoming = new Headers({
      'content-type': 'application/json',
    });

    const result = buildUpstreamHeaders(incoming, 'new-token');

    expect(result.get('authorization')).toBe('Bearer new-token');
  });

  it('preserves case-insensitive header matching', () => {
    const incoming = new Headers({
      'Host': 'localhost:3000',
      'CONNECTION': 'close',
      'Authorization': 'Bearer old',
    });

    const result = buildUpstreamHeaders(incoming, 'new-token');

    expect(result.get('host')).toBeNull();
    expect(result.get('connection')).toBeNull();
    expect(result.get('authorization')).toBe('Bearer new-token');
  });
});

describe('buildUpstreamHeaders — ZDR opt-in', () => {
  it('forwards x-cmd-zdr untouched so zero-data-retention is preserved', () => {
    const headers = buildUpstreamHeaders(new Headers({ 'x-cmd-zdr': '1' }), 'token');
    expect(headers.get('x-cmd-zdr')).toBe('1');
  });
});

describe('isStreamingRequest', () => {
  it('returns true when stream is true', () => {
    expect(isStreamingRequest('{"stream": true}')).toBe(true);
    expect(isStreamingRequest('{"model": "gpt-4", "stream": true}')).toBe(true);
  });

  it('returns false when stream is false', () => {
    expect(isStreamingRequest('{"stream": false}')).toBe(false);
  });

  it('returns false when stream field is missing', () => {
    expect(isStreamingRequest('{"model": "gpt-4"}')).toBe(false);
  });

  it('returns false for invalid JSON', () => {
    expect(isStreamingRequest('not json')).toBe(false);
    expect(isStreamingRequest('')).toBe(false);
    expect(isStreamingRequest('{')).toBe(false);
  });

  it('returns false when stream is not boolean', () => {
    expect(isStreamingRequest('{"stream": "true"}')).toBe(false);
    expect(isStreamingRequest('{"stream": 1}')).toBe(false);
    expect(isStreamingRequest('{"stream": null}')).toBe(false);
  });
});

describe('prepareOutboundRequest', () => {
  /** Provider stub that supports neither streamed usage nor sessions. */
  const plainProvider: KeyProvider = {
    ...opencodeGoProvider,
    supportsStreamUsage: undefined,
    sessionHeader: undefined,
  };

  function parse(body: string): Record<string, unknown> {
    return JSON.parse(body) as Record<string, unknown>;
  }

  function prepare(body: string, modelId?: string, wantsStreamUsage = false, clientSessionId?: string) {
    return prepareOutboundRequest(body, modelId, opencodeGoProvider, {
      wantsStreamUsage,
      clientSessionId,
    });
  }

  it('asks for streamed usage on streaming requests', () => {
    const { bodyText } = prepare(
      '{"model":"m","stream":true,"messages":[]}',
      'm',
      true,
    );
    expect(parse(bodyText)).toEqual({
      model: 'm',
      stream: true,
      messages: [],
      stream_options: { include_usage: true },
    });
  });

  it('leaves providers without stream-usage support alone', () => {
    const input = '{"model":"m","stream":true}';
    const prepared = prepareOutboundRequest(input, 'm', plainProvider, { wantsStreamUsage: true });
    expect(prepared.bodyText).toBe(input);
    expect(prepared.sessionId).toBeUndefined();
  });

  it('leaves non-streaming requests alone', () => {
    const input = '{"model":"m","stream":false,"messages":[]}';
    expect(prepare(input, 'm', false).bodyText).toBe(input);
  });

  it('honours an explicit client choice and merges otherwise', () => {
    expect(parse(prepare(
      '{"stream":true,"stream_options":{"include_usage":false}}', undefined, true,
    ).bodyText).stream_options).toEqual({ include_usage: false });

    expect(parse(prepare(
      '{"stream":true,"stream_options":{"include_usage":true,"foo":1}}', undefined, true,
    ).bodyText).stream_options).toEqual({ include_usage: true, foo: 1 });

    expect(parse(prepare(
      '{"stream":true,"stream_options":{"foo":1}}', undefined, true,
    ).bodyText).stream_options).toEqual({ foo: 1, include_usage: true });

    // Non-object stream_options is replaced, not merged.
    expect(parse(prepare(
      '{"stream":true,"stream_options":null}', undefined, true,
    ).bodyText).stream_options).toEqual({ include_usage: true });
  });

  it('strips the provider routing suffix and injects usage in one pass', () => {
    const { bodyText } = prepare(
      '{"model":"deepseek-v4-flash@commandcode","stream":true}',
      'deepseek-v4-flash@commandcode',
      true,
    );
    expect(parse(bodyText)).toEqual({
      model: 'deepseek-v4-flash',
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('returns bodies it cannot improve byte-identical', () => {
    for (const input of ['', 'not json', '[1,2,3]', '{"stream":true}']) {
      // No model to rewrite, nothing to inject, and no conversation to derive.
      const prepared = prepareOutboundRequest(input, undefined, plainProvider, { wantsStreamUsage: false });
      expect(prepared.bodyText).toBe(input);
      expect(prepared.sessionId).toBeUndefined();
    }
  });

  it('derives a stable session id for the same conversation', () => {
    const turn1 = prepare('{"model":"m","messages":[{"role":"user","content":"hello"}]}', 'm');
    const turn2 = prepare(
      '{"model":"m","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"},{"role":"user","content":"again"}]}',
      'm',
    );
    expect(turn1.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(turn2.sessionId).toBe(turn1.sessionId);
  });

  it('keeps the session id stable when only the system prompt changes', () => {
    const first = prepare(
      '{"model":"m","messages":[{"role":"system","content":"now 12:00"},{"role":"user","content":"hello"}]}',
      'm',
    );
    const second = prepare(
      '{"model":"m","messages":[{"role":"system","content":"now 12:05"},{"role":"user","content":"hello"}]}',
      'm',
    );
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('derives different session ids for different conversations and models', () => {
    const a = prepare('{"model":"m","messages":[{"role":"user","content":"one"}]}', 'm');
    const b = prepare('{"model":"m","messages":[{"role":"user","content":"two"}]}', 'm');
    const c = prepare('{"model":"other","messages":[{"role":"user","content":"one"}]}', 'other');
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.sessionId).not.toBe(c.sessionId);
  });

  it('falls back to the message prefix when there is no user turn', () => {
    const prepared = prepare('{"model":"m","messages":[{"role":"system","content":"ctx"}]}', 'm');
    expect(prepared.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(prepare('{"model":"m","messages":[{"role":"system","content":"other"}]}', 'm').sessionId)
      .not.toBe(prepared.sessionId);
  });

  it('never overrides a session id the client supplied', () => {
    expect(prepare('{"model":"m","messages":[]}', 'm', false, 'client-session').sessionId).toBeUndefined();
  });
});

describe('createProxyApp — /v1/models routes', () => {
  let app: ReturnType<typeof createProxyApp>;

  const testConfig: ProxyConfig = {
    port: 0,
    host: '127.0.0.1',
    upstreamBaseUrl: 'https://example.com',
    requestTimeoutMs: 30000,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60000,
    allowedOrigins: ['*'],
    keys: [{ label: 'test', key: 'sk-test-key-12345' }],
  };

  beforeEach(() => {
    resetModelsFetcherState();
    // Prevent real network calls — upstreamBaseUrl is https://example.com
    // which would otherwise cause 5s AbortSignal.timeout waits.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
  });

  beforeAll(() => {
    app = createProxyApp(testConfig);
  });

  it('GET /v1/models returns 200 with object: list', async () => {
    const res = await app.request('/v1/models');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('GET /v1/models returns all models', async () => {
    const res = await app.request('/v1/models');
    const body = await res.json();
    expect(body.data).toHaveLength(Object.keys(loadModelsCatalog()).length);
  });

  it('GET /v1/models each model entry has minimal format (id, object, created, owned_by)', async () => {
    const res = await app.request('/v1/models');
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const entry of body.data) {
      expect(entry).toHaveProperty('id');
      expect(entry.object).toBe('model');
      expect(entry.owned_by).toBe('saros');
      expect(typeof entry.created).toBe('number');
    }
  });

  it('GET /zen/go/v1/models returns 200 with object: list', async () => {
    const res = await app.request('/zen/go/v1/models');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(Object.keys(loadModelsCatalog()).length);
  });

  it('POST /v1/* paths are proxied to upstream (no longer 404)', async () => {
    const res1 = await app.request('/v1/models', { method: 'POST' });
    expect(res1.status).not.toBe(404);

    const res2 = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res2.status).not.toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Upstream proxy pipeline — standard (non-streaming) requests
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    upstreamBaseUrl: 'https://example.com',
    requestTimeoutMs: 30_000,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
    allowedOrigins: ['*'],
    keys: [
      { label: 'alpha', key: 'sk-alpha-key-0001' },
      { label: 'beta', key: 'sk-beta-key-0002' },
    ],
    ...overrides,
  };
}

function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Minimal structural view of the Hono app used by request helpers. */
interface AppLike {
  request(input: string | Request, requestInit?: RequestInit): Promise<Response>;
}

describe('createProxyApp — standard proxy pipeline', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetModelsFetcherState();
  });

  it('forwards a decision-model body untouched and books its usage', async () => {
    resetTokenUsage();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ probabilities: { yes: 0.7 }, usage: { input_tokens: 3, output_tokens: 0, total_tokens: 3 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const payload = { model: 'typesafe/jev', state: 'payments failing', questions: [{ text: 'will it recover' }] };
    const app = createProxyApp(makeConfig());
    const res = await app.request('/v1/systemone', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    await res.text();

    // /systemone is not a chat message: no stream_options injection, no body rewrite.
    const sent = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
    expect(sent).toEqual(payload);
    const recorded = Object.values(getKeyTokenUsage().keys);
    expect(recorded[0]).toMatchObject({ requests: 1, promptTokens: 3, totalTokens: 3 });
  });

  it('forwards successful requests and sanitizes downstream headers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=abc',
          'x-request-id': 'upstream-123',
          'connection': 'keep-alive',
          'transfer-encoding': 'chunked',
          'keep-alive': 'timeout=5',
          'proxy-authenticate': 'Basic',
          'proxy-authorization': 'secret',
          'te': 'trailers',
          'trailer': 'x-checksum',
          'upgrade': 'h2c',
        },
      }),
    );

    const app = createProxyApp(makeConfig());
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [] }),
      headers: { 'content-type': 'application/json', authorization: 'Bearer old-token' },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    // Hop-by-hop / sensitive / internal headers must be stripped downstream
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-request-id')).toBeNull();
    expect(res.headers.get('connection')).toBeNull();
    expect(res.headers.get('transfer-encoding')).toBeNull();
    expect(res.headers.get('keep-alive')).toBeNull();
    expect(res.headers.get('proxy-authenticate')).toBeNull();
    expect(res.headers.get('proxy-authorization')).toBeNull();
    expect(res.headers.get('te')).toBeNull();
    expect(res.headers.get('trailer')).toBeNull();
    expect(res.headers.get('upgrade')).toBeNull();
    // Proxy annotations are added
    expect(res.headers.get('X-Proxy-Key-Label')).toBe('alpha');
    expect(res.headers.get('X-Proxy-Request-Id')).toBeTruthy();

    // Upstream call: path rewritten to /zen/go/v1/, auth replaced by key
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://example.com/zen/go/v1/chat/completions');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer sk-alpha-key-0001');
  });

  it('replaces a client browser User-Agent with the opencode-go CLI identity', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"ok":true}', { status: 200 }),
    );
    const app = createProxyApp(makeConfig({
      keys: [{ label: 'oc', key: 'oc_sk_' + 'a'.repeat(40), provider: 'opencode-go' }],
    }));

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [] }),
      headers: { 'content-type': 'application/json', 'user-agent': 'Python-urllib/3.14' },
    });
    await res.text();

    const chatCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/chat/completions'));
    expect(chatCall).toBeDefined();
    const headers = (chatCall![1] as RequestInit).headers as Headers;
    // Cloudflare answers `403 error code: 1010` for forwarded browser UAs.
    expect(headers.get('user-agent')).toBe('cli');
  });

  it('leaves non-streaming bodies byte-identical (no usage option injected)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200 }),
    );
    const app = createProxyApp(makeConfig());
    const payload = JSON.stringify({ model: 'm', messages: [], stream: false });

    await (await app.request('/v1/chat/completions', {
      method: 'POST',
      body: payload,
      headers: { 'content-type': 'application/json' },
    })).text();

    // Exact equality: the body was neither re-serialized nor extended.
    expect(String((fetchMock.mock.calls[0][1] as RequestInit).body)).toBe(payload);
  });

  it('returns sanitized client errors for 400 without penalising keys', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'bad input' } }), { status: 400 }),
    );
    const app = createProxyApp(makeConfig());
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('bad input');
    expect(body.requestId).toBeTruthy();
    // RequestFault does not penalise the key
    const health = await app.request('/health');
    const h = await health.json();
    expect(h.enabledCount).toBe(2);
    expect(h.disabledCount).toBe(0);
  });

  it('falls back to the raw error string when the upstream error body has one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error": "plain string"}', { status: 400 }),
    );
    const app = createProxyApp(makeConfig());
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    const body = await res.json();
    expect(body.error).toBe('plain string');
  });

  it('uses a generic message when the upstream error body has no error field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 400 }));
    const app = createProxyApp(makeConfig());
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    const body = await res.json();
    expect(body.error).toBe('Bad Request');
  });

  it('uses a generic message when the upstream error body is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('oops not json', { status: 400 }));
    const app = createProxyApp(makeConfig());
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    const body = await res.json();
    expect(body.error).toBe('Bad Request');
  });

  it('fails over on 401 and returns 502 after retries are exhausted', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('invalid api key', { status: 401 })),
    );
    const app = createProxyApp(makeConfig());
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('Bad Gateway');
    expect(body.message).toBe('Upstream service unavailable after multiple attempts');
    // The 502 still names the keys and the causes: a caller must be able to
    // tell a revoked key from a rate limit.
    expect(body.keys).toHaveLength(2);
    expect(body.keys[0]).toMatchObject({ reason: 'auth', lastStatus: 401 });
    expect(body.causes.join(' ')).toMatch(/revoked|rotated/i);
    expect(body.retryAfterMs).toBeGreaterThan(0);
    // KeyFault disables keys immediately → both keys disabled
    const health = await app.request('/health');
    const h = await health.json();
    expect(h.enabledCount).toBe(0);
    expect(h.disabledCount).toBe(2);

    // Once the pool is empty, the next request gets the 503 diagnosis instead
    // of burning another upstream attempt.
    const again = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(again.status).toBe(503);
    const againBody = await again.json();
    expect(againBody.error).toBe('All API keys are temporarily unavailable');
    expect(againBody.keys).toHaveLength(2);
  });

  it('classifies 5xx quota/balance bodies as KeyFault and fails over', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('quota exceeded', { status: 500 })),
    );
    const app = createProxyApp(makeConfig());
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(502);
    const health = await app.request('/health');
    const h = await health.json();
    expect(h.enabledCount).toBe(0);
  });

  it('handles non-Error fetch rejections', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue('network glitch');
    const app = createProxyApp(makeConfig());
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(502);
  });

  it('treats aborted upstream requests as timeouts and fails over', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        (init as RequestInit & { signal?: AbortSignal }).signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
        return promise;
      });
      const app = createProxyApp(makeConfig({ requestTimeoutMs: 1000 }));
      const pending = app.request('/v1/chat/completions', {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      expect(res.status).toBe(502);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns 503 when failover exhausts the key pool', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const app = createProxyApp(makeConfig({ keys: [{ label: 'only', key: 'sk-only-key-0001' }] }));
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('All API keys are temporarily unavailable');
  });

  it('explains why every key is unavailable in the 503 body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"invalid key"}', { status: 401 }),
    );
    const app = createProxyApp(makeConfig({
      keys: [{ label: 'cc', key: 'user_cc-key-0001', provider: 'commandcode' }],
    }));

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-5@commandcode', messages: [] }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(503);
    const body = await res.json() as {
      error: string;
      retryAfterMs: number;
      causes: string[];
      keys: Array<{ label: string; provider: string; reason: string; lastStatus: number }>;
    };
    // Legacy field stays for clients that match on it.
    expect(body.error).toBe('All API keys are temporarily unavailable');
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({
      label: 'cc',
      provider: 'commandcode',
      reason: 'auth',
      lastStatus: 401,
    });
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(body.causes.join(' ')).toMatch(/revoked|rotated/i);
    // Never leak the credential, not even a prefix.
    expect(JSON.stringify(body)).not.toContain('user_cc-key-0001');
  });

  it('reports a key retired in config as disabled_by_config', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"invalid key"}', { status: 401 }),
    );
    const app = createProxyApp(makeConfig({
      keys: [
        { label: 'live', key: 'user_live_key_00001', provider: 'commandcode' },
        { label: 'retired', key: 'user_retired_key_001', provider: 'commandcode', enabled: false },
      ],
    }));

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [] }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(503);
    const body = await res.json() as {
      keys: Array<{ label: string; state: string; reason: string | null }>;
      causes: string[];
    };
    const retired = body.keys.find((key) => key.label === 'retired');
    expect(retired).toMatchObject({ state: 'disabled_by_config', reason: null });
    expect(body.causes.join(' ')).toMatch(/disabled in config/i);

    const health = await (await app.request('/health')).json() as {
      keys: Array<{ label: string; disabledByConfig: boolean }>;
    };
    expect(health.keys.find((key) => key.label === 'retired')?.disabledByConfig).toBe(true);
  });
  it('forwards GET requests without a body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const app = createProxyApp(makeConfig());
    const res = await app.request('/zen/go/v1/chat/completions');
    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://example.com/zen/go/v1/chat/completions');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
  });
});

describe('createProxyApp — SAROS_CAPTURE_4XX diagnostics', () => {
  // Resolve through the same helper the proxy uses: on win32 the config dir
  // comes from LOCALAPPDATA, not XDG_CONFIG_HOME.
  const captureDir = (): string => join(getSarosDir(), 'captures');

  const postChat = (app: AppLike, body: string): Promise<Response> =>
    app.request('/v1/chat/completions', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    });

  beforeEach(() => {
    rmSync(captureDir(), { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env.SAROS_CAPTURE_4XX;
    rmSync(captureDir(), { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes one 0600 capture per 4xx under the config dir with data-free names', async () => {
    process.env.SAROS_CAPTURE_4XX = '1';
    const upstreamError = JSON.stringify({ error: { message: 'bad role ../../etc/passwd' } });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(upstreamError, { status: 400 })),
    );
    const app = createProxyApp(makeConfig());
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'payload-marker' }] });

    expect((await postChat(app, body)).status).toBe(400);
    expect((await postChat(app, body)).status).toBe(400);

    const files = readdirSync(captureDir());
    expect(files).toHaveLength(2);
    for (const name of files) {
      // timestamp + monotonic sequence only: no request id, no separators
      // outside '-', no JSON punctuation, no '..'.
      expect(name).toMatch(/^\d+-\d+\.json$/);
      expect(name).not.toContain('..');
      const filePath = join(captureDir(), name);
      if (process.platform !== 'win32') {
        expect(statSync(filePath).mode & 0o777).toBe(0o600);
      }
    }
    expect(new Set(files).size).toBe(2);

    const capture = JSON.parse(readFileSync(join(captureDir(), files[0]), 'utf-8')) as Record<string, unknown>;
    expect(capture).toMatchObject({
      status: 400,
      method: 'POST',
      path: '/zen/go/v1/chat/completions',
      requestBody: body,
      upstreamError,
    });
    expect(capture.requestId).toBeTruthy();
    expect(capture.ts).toBeTruthy();
  });

  it('refuses to overwrite a pre-existing file at the capture path (wx)', async () => {
    process.env.SAROS_CAPTURE_4XX = '1';
    // Freeze the clock so the only unknown in the filename is the module-level
    // sequence, which the first capture reveals.
    const fixedNow = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('{"error":"first"}', { status: 400 })),
    );
    const app = createProxyApp(makeConfig());

    expect((await postChat(app, '{}')).status).toBe(400);
    const [firstName] = readdirSync(captureDir());
    const sequence = Number(firstName.replace(/\.json$/, '').split('-')[1]);
    const colliding = `${fixedNow}-${sequence + 1}.json`;
    const collidingPath = join(captureDir(), colliding);
    writeFileSync(collidingPath, 'do-not-touch');

    // 'wx' fails with EEXIST instead of overwriting; the proxy swallows the
    // diagnostic failure and still answers the client.
    expect((await postChat(app, '{}')).status).toBe(400);

    expect(readdirSync(captureDir()).sort()).toEqual([firstName, colliding].sort());
    expect(readFileSync(collidingPath, 'utf-8')).toBe('do-not-touch');
  });

  it('truncates the captured upstream error and request body', async () => {
    process.env.SAROS_CAPTURE_4XX = '1';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('e'.repeat(3_000), { status: 400 }));
    const app = createProxyApp(makeConfig());
    const body = JSON.stringify({ model: 'm', messages: [], filler: 'x'.repeat(120_000) });

    await (await postChat(app, body)).text();

    const [name] = readdirSync(captureDir());
    const capture = JSON.parse(readFileSync(join(captureDir(), name), 'utf-8')) as Record<string, unknown>;
    expect((capture.upstreamError as string)).toHaveLength(2_000);
    expect((capture.requestBody as string)).toHaveLength(100_000);
  });

  it('writes nothing when the flag is off', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"nope"}', { status: 400 }));
    const app = createProxyApp(makeConfig());

    await (await postChat(app, '{}')).text();

    expect(existsSync(captureDir())).toBe(false);
  });

  it('only captures 4xx, never 5xx', async () => {
    process.env.SAROS_CAPTURE_4XX = '1';
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('upstream down', { status: 503 })),
    );
    const app = createProxyApp(makeConfig());

    expect((await postChat(app, '{}')).status).toBe(502);

    expect(existsSync(captureDir())).toBe(false);
  });
});

describe('buildNoKeysBody', () => {
  const unavailable = (over: Partial<UnavailableKey> = {}): UnavailableKey => ({
    label: 'cc',
    provider: 'commandcode',
    state: 'disabled',
    reason: 'auth',
    lastStatus: 401,
    disabledAt: '2026-10-28T19:00:00.000Z',
    retryAfterMs: 1_000,
    detail: null,
    ...over,
  });

  it('reports each key with its reason and the soonest retry', () => {
    const body = buildNoKeysBody(
      [
        unavailable({ retryAfterMs: 5_000 }),
        unavailable({
          label: 'oc',
          provider: 'opencode-go',
          reason: 'rate_limit',
          lastStatus: 429,
          retryAfterMs: 0,
        }),
      ],
      'req-1',
    );

    expect(body.retryAfterMs).toBe(5_000);
    expect(body.keys).toHaveLength(2);
    expect(body.causes.some((cause) => /revoked|rotated/.test(cause))).toBe(true);
    expect(body.causes.some((cause) => /429/.test(cause))).toBe(true);
    expect(body.message).toContain('retry in 5s');
    expect(body.error).toBe('All API keys are temporarily unavailable');
  });

  it('explains an empty pool when every usable key was already tried', () => {
    const body = buildNoKeysBody([], 'req-3', 'claude-opus-5', ['alpha']);

    expect(body.keys).toHaveLength(0);
    expect(body.causes.join(' ')).toMatch(/keys tried for this request/i);
    expect(body.causes.join(' ')).toContain('alpha');
  });

  it('keeps the per-key reasons when some keys are also listed as tried', () => {
    const body = buildNoKeysBody([unavailable()], 'req-4', undefined, ['other']);
    // Both the per-key reason and the tried-key context are reported.
    expect(body.causes.some((cause) => /keys tried for this request/i.test(cause))).toBe(true);
    expect(body.causes.some((cause) => /revoked|rotated/i.test(cause))).toBe(true);
  });

  it('explains an account without plan and a pinned provider', () => {
    const body = buildNoKeysBody(
      [unavailable({ state: 'not_entitled', reason: null, lastStatus: null, retryAfterMs: null })],
      'req-2',
      'claude-opus-5@opencode-go',
    );

    expect(body.causes.join(' ')).toMatch(/no plan/);
    expect(body.causes.join(' ')).toMatch(/@opencode-go/);
    expect(body.message).toContain('opencode-go');
    expect(body.message).not.toContain('retry in');
    expect(body.retryAfterMs).toBeNull();
  });
});

describe('createProxyApp — streaming pipeline', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetModelsFetcherState();
  });

  function streamRequest(app: AppLike): Promise<Response> {
    return app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', stream: true }),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('streams SSE chunks and sets streaming headers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(sseStream('data: {"type":"chat","content":"hi"}\n\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const app = createProxyApp(makeConfig());
    const res = await streamRequest(app);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('connection')).toBe('keep-alive');
    expect(res.headers.get('X-Proxy-Key-Label')).toBe('alpha');
    const text = await res.text();
    expect(text).toContain('"content":"hi"');
  });

  it('detects SSE error markers and emits proxy_error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(sseStream('data: {"error":"boom"}\n\n'), { status: 200 }),
    );
    const app = createProxyApp(makeConfig({ circuitBreakerThreshold: 1 }));
    const res = await streamRequest(app);
    const text = await res.text();
    expect(text).toContain('proxy_error');
    expect(text).toContain('Upstream stream error');
    // error marker penalised the key (threshold 1 → disabled)
    const health = await app.request('/health');
    const h = await health.json();
    expect(h.enabledCount).toBe(1);
    expect(h.disabledCount).toBe(1);
  });

  it('passes through comment events, benign data, and invalid JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        sseStream(
          ': keep-alive\n\n',
          'data: {"type":"chat","content":"ok"}\n\n',
          'data: not-json\n\n',
          'data: null\n\n',
        ),
        { status: 200 },
      ),
    );
    const app = createProxyApp(makeConfig());
    const res = await streamRequest(app);
    const text = await res.text();
    expect(text).toContain(': keep-alive');
    expect(text).toContain('"content":"ok"');
    expect(text).not.toContain('proxy_error');
  });

  it('buffers partial SSE events split across chunks', async () => {
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('')); // empty chunk
        controller.enqueue(encoder.encode('data: {"type":"ch'));
        controller.enqueue(encoder.encode('at","content":"partial"}\n\n'));
        controller.close();
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(upstream, { status: 200 }));
    const app = createProxyApp(makeConfig());
    const res = await streamRequest(app);
    const text = await res.text();
    expect(text).toContain('"content":"partial"');
  });

  it('returns 502 when the streaming response has no body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const app = createProxyApp(makeConfig());
    const res = await streamRequest(app);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.message).toBe('Upstream response missing body');
  });

  it('reports stream read errors with proxy_error', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('connection reset');
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(upstream, { status: 200 }));
    const app = createProxyApp(makeConfig());
    const res = await streamRequest(app);
    const text = await res.text();
    expect(text).toContain('proxy_error');
    expect(text).toContain('Stream interrupted');
  });

  it('fails over streaming requests on network errors and returns 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const app = createProxyApp(makeConfig());
    const res = await streamRequest(app);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.message).toBe('Streaming service unavailable after multiple attempts');
  });

  it('fails over streaming requests on upstream error responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('oops', { status: 500 }));
    const app = createProxyApp(makeConfig());
    const res = await streamRequest(app);
    expect(res.status).toBe(502);
  });

  it('returns 503 for streaming when no keys remain', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const app = createProxyApp(makeConfig({ keys: [{ label: 'only', key: 'sk-only-key-0001' }] }));
    const res = await streamRequest(app);
    expect(res.status).toBe(503);
  });

  it('cancels the upstream stream when the client disconnects', async () => {
    let upstreamCancelled = false;
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"chat","content":"hi"}\n\n'));
        // deliberately keep the stream open
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(upstream, { status: 200 }));
    const app = createProxyApp(makeConfig());
    const res = await streamRequest(app);
    const reader = res.body!.getReader();
    await reader.read(); // pull the first chunk
    await reader.cancel(); // client disconnect → wrapped stream cancel → upstream cancel
    expect(upstreamCancelled).toBe(true);
  });

  it('asks the upstream for streamed token usage', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        sseStream(
          'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}\n\n',
          'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
        ),
        { status: 200 },
      ),
    );
    const app = createProxyApp(makeConfig());
    const res = await streamRequest(app);
    const text = await res.text();

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as {
      stream_options?: unknown;
    };
    expect(body.stream_options).toEqual({ include_usage: true });
    // The client stream is untouched by the injected option.
    expect(text).toContain('"content":"hi"');
  });

  it('books streamed usage once when the upstream repeats it', async () => {
    resetTokenUsage();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        sseStream(
          'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
          'data: [DONE]\n\n',
        ),
        { status: 200 },
      ),
    );
    const app = createProxyApp(makeConfig());
    await (await streamRequest(app)).text();

    // CommandCode repeats the same counts on the finish chunk and the
    // usage-only chunk; the key must be charged one request, not two.
    const recorded = Object.values(getKeyTokenUsage().keys);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      requests: 1,
      promptTokens: 5,
      completionTokens: 2,
      totalTokens: 7,
    });
  });

  it('books usage nested under response.usage (OpenAI Responses schema)', async () => {
    resetTokenUsage();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        sseStream(
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":11,"output_tokens":4,"total_tokens":15}}}\n\n',
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const app = createProxyApp(makeConfig());
    const res = await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', stream: true, input: 'hi' }),
      headers: { 'content-type': 'application/json' },
    });
    await res.text();

    // Responses streams the counts inside response.usage, not at the top level:
    // without this the request would spend credits unrecorded.
    const recorded = Object.values(getKeyTokenUsage().keys);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      requests: 1,
      promptTokens: 11,
      completionTokens: 4,
      totalTokens: 15,
    });
  });

  it('books usage split across Anthropic message_start and message_delta', async () => {
    resetTokenUsage();
    // Fresh Response per call: the usage-refresh probe also calls fetch, and a
    // shared instance would arrive with its body already consumed.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        sseStream(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":25,"output_tokens":1}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":5,"output_tokens":15}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const app = createProxyApp(makeConfig());
    const res = await app.request('/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 64, stream: true, messages: [] }),
      headers: { 'content-type': 'application/json' },
    });
    await res.text();

    // Anthropic reports the prompt count once (message_start) and the
    // cumulative output count later (message_delta): a last-one-wins reader
    // books 0 prompt tokens for every Messages stream. The delta repeats
    // input_tokens lower than the start event, so a per-field overwrite would
    // book 5; the largest cumulative value must win.
    const recorded = Object.values(getKeyTokenUsage().keys);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      requests: 1,
      promptTokens: 25,
      completionTokens: 15,
      totalTokens: 40,
    });
  });

  it('ignores message.usage on events that are not message_start', async () => {
    resetTokenUsage();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        sseStream(
          // A decision stream may carry a business `message` object; only
          // Anthropic's message_start owns token usage under that key.
          'data: {"type":"decision","message":{"usage":{"input_tokens":999,"output_tokens":999}}}\n\n',
          'data: {"type":"decision.completed","usage":{"input_tokens":3,"output_tokens":0,"total_tokens":3}}\n\n',
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const app = createProxyApp(makeConfig());
    const res = await app.request('/v1/systemone', {
      method: 'POST',
      body: JSON.stringify({ model: 'typesafe/jev', state: 'payments failing', questions: {}, stream: true }),
      headers: { 'content-type': 'application/json' },
    });
    await res.text();

    const recorded = Object.values(getKeyTokenUsage().keys);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      requests: 1,
      promptTokens: 3,
      completionTokens: 0,
      totalTokens: 3,
    });
  });

  it('books a total that never undercuts the merged prompt and completion', async () => {
    resetTokenUsage();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        sseStream(
          // The finish chunk carries the full triple; a later usage-only chunk
          // raises completion without repeating the total.
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105}}\n\n',
          'data: {"choices":[],"usage":{"completion_tokens":20}}\n\n',
          'data: [DONE]\n\n',
        ),
        { status: 200 },
      ),
    );
    const app = createProxyApp(makeConfig());
    await (await streamRequest(app)).text();

    const recorded = Object.values(getKeyTokenUsage().keys);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      requests: 1,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    });
  });

  it('respects the client decision about streamed usage', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(sseStream('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'), { status: 200 }),
    );
    const app = createProxyApp(makeConfig());

    // Explicit false → forwarded untouched.
    await (await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', stream: true, stream_options: { include_usage: false } }),
      headers: { 'content-type': 'application/json' },
    })).text();
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).stream_options)
      .toEqual({ include_usage: false });

    // Explicit true plus an extra option → both preserved, nothing re-injected.
    await (await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', stream: true, stream_options: { include_usage: true, foo: 1 } }),
      headers: { 'content-type': 'application/json' },
    })).text();
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)).stream_options)
      .toEqual({ include_usage: true, foo: 1 });
  });

  it('merges the usage option into client-supplied stream_options', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(sseStream('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'), { status: 200 }),
    );
    const app = createProxyApp(makeConfig());
    await (await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', stream: true, stream_options: { foo: 1 } }),
      headers: { 'content-type': 'application/json' },
    })).text();
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).stream_options)
      .toEqual({ foo: 1, include_usage: true });
  });

  it('does not inject stream usage into non-chat streaming routes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(sseStream('data: {"type":"x"}\n\n'), { status: 200 }),
    );
    const app = createProxyApp(makeConfig());

    await (await app.request('/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', stream: true }),
      headers: { 'content-type': 'application/json' },
    })).text();

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://example.com/zen/go/v1/responses');
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as {
      stream_options?: unknown;
    };
    expect(body.stream_options).toBeUndefined();
  });

  it('treats aborted streaming requests as timeouts', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        (init as RequestInit & { signal?: AbortSignal }).signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
        return promise;
      });
      const app = createProxyApp(makeConfig({ requestTimeoutMs: 1000 }));
      const pending = streamRequest(app);
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      expect(res.status).toBe(502);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createProxyApp — request limits, health, CORS, rate limit keys', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetModelsFetcherState();
  });

  it('rejects oversized requests via Content-Length header', async () => {
    const app = createProxyApp(makeConfig());
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      headers: {
        'content-type': 'application/json',
        'content-length': String(MAX_BODY_SIZE + 1),
      },
    });
    expect(res.status).toBe(413);
  });

  it('rejects oversized request bodies', async () => {
    const app = createProxyApp(makeConfig());
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: 'a'.repeat(MAX_BODY_SIZE + 1),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(413);
  });

  it('reports key and request state on /health', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const app = createProxyApp(
      makeConfig({ circuitBreakerThreshold: 1, keys: [{ label: 'only', key: 'sk-only-key-0001' }] }),
    );
    await app.request('/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    const res = await app.request('/health');
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.keyCount).toBe(1);
    // Network errors (fetch failed) are shared-upstream faults, not key
    // faults — the key must stay available so the proxy recovers instantly.
    expect(body.enabledCount).toBe(1);
    expect(body.disabledCount).toBe(0);
    expect(body.activeRequests).toBe(0);
  });

  it('exposes per-key state and the last upstream error on /health', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"invalid key"}', { status: 401 }),
    );
    const app = createProxyApp(makeConfig({
      keys: [{ label: 'cc', key: 'user_cc-key-0001', provider: 'commandcode' }],
    }));
    await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-5@commandcode', messages: [] }),
      headers: { 'content-type': 'application/json' },
    });

    const body = await (await app.request('/health')).json() as {
      keys: Array<{
        label: string;
        provider: string;
        enabled: boolean;
        retryAfterMs: number | null;
        lastError: { status: number; reason: string; at: string } | null;
      }>;
    };

    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({
      label: 'cc',
      provider: 'commandcode',
      enabled: false,
      lastError: { status: 401, reason: 'auth' },
    });
    expect(body.keys[0].retryAfterMs).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain('user_cc-key-0001');
  });

  it('reflects allowed origins via CORS', async () => {
    const app = createProxyApp(makeConfig({ allowedOrigins: ['https://*.example.com'] }));
    const res = await app.request('/health', { headers: { origin: 'https://app.example.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    // Browser JS can only read these annotations if they are exposed. Exact
    // value: an accidental extra header would widen the browser-visible
    // surface without a test noticing.
    expect(res.headers.get('access-control-expose-headers')).toBe(
      'X-Proxy-Key-Label,X-Proxy-Request-Id,X-Proxy-Provider',
    );
  });

  it('does not send CORS headers for disallowed origins', async () => {
    const app = createProxyApp(makeConfig({ allowedOrigins: ['https://*.example.com'] }));
    const res = await app.request('/health', { headers: { origin: 'https://evil.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('skips CORS for non-browser requests', async () => {
    const app = createProxyApp(makeConfig({ allowedOrigins: ['https://*.example.com'] }));
    const res = await app.request('/health');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('uses x-forwarded-for and x-real-ip for rate limit keys', async () => {
    const app = createProxyApp(makeConfig());
    const res1 = await app.request('/health', { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } });
    expect(res1.status).toBe(200);
    const res2 = await app.request('/health', { headers: { 'x-real-ip': '203.0.113.10' } });
    expect(res2.status).toBe(200);
  });
});

describe('network-fault resilience (no blackout lockup)', () => {
  it('keeps both keys enabled after repeated upstream timeouts', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        (init as RequestInit & { signal?: AbortSignal }).signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
        return promise;
      });
      const app = createProxyApp(makeConfig({ requestTimeoutMs: 1000 }));

      // Simulate a hung upstream across many consecutive requests
      for (let i = 0; i < 5; i++) {
        const pending = app.request('/v1/chat/completions', {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json', 'x-real-ip': `10.0.0.${i}` },
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await pending; // 502 — but keys must stay healthy
      }

      const health = await app.request('/health');
      const body = (await health.json()) as { enabledCount: number; disabledCount: number };
      expect(body.enabledCount).toBe(2);
      expect(body.disabledCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers immediately on the next request after timeouts stop', async () => {
    let shouldHang = true;
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        if (!shouldHang) {
          return Promise.resolve(new Response('{}', { status: 200 }));
        }
        const { promise, reject } = Promise.withResolvers<Response>();
        (init as RequestInit & { signal?: AbortSignal }).signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
        return promise;
      });
      const app = createProxyApp(makeConfig({ requestTimeoutMs: 1000 }));

      // Hung phase
      for (let i = 0; i < 3; i++) {
        const pending = app.request('/v1/chat/completions', {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json', 'x-real-ip': `10.0.1.${i}` },
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await pending;
      }

      // Upstream recovers — no cooldown to wait for, next request succeeds
      shouldHang = false;
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json', 'x-real-ip': '10.0.2.1' },
      });
      expect(res.status).toBe(200);

      const health = await app.request('/health');
      const body = (await health.json()) as { enabledCount: number };
      expect(body.enabledCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still disables a key on hard auth failures (401)', async () => {
    // Fresh Response per call: a shared instance would fail body re-reads and
    // get misclassified as a network fault.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'invalid api key' }), { status: 401 }),
    );
    const app = createProxyApp(makeConfig({ circuitBreakerThreshold: 1 }));
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json', 'x-real-ip': '10.0.3.1' },
    });
    expect(res.status).toBe(502);

    const health = await app.request('/health');
    const body = (await health.json()) as { enabledCount: number };
    // Both keys saw a 401 → both correctly cooling down (genuine key fault)
    expect(body.enabledCount).toBe(0);
  });
});

describe('createProxyApp — provider mapping & extra headers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetModelsFetcherState();
  });

  it('pins a commandcode key for @commandcode models and injects CLI headers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200 }),
    );
    const app = createProxyApp(makeConfig({
      keys: [{ label: 'cc', key: 'user_cc-key-0001', provider: 'commandcode' }],
    }));
    const res = await app.request('/zen/go/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-5@commandcode', messages: [] }),
      headers: { 'content-type': 'application/json', authorization: 'Bearer old-token' },
    });

    expect(res.status).toBe(200);
    // Upstream: commandcode base + remapped provider path.
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.commandcode.ai/provider/v1/chat/completions',
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer user_cc-key-0001');
    // Provider-specific CLI identity headers are injected upstream.
    expect(headers.get('x-commandcode-client')).toBe('cli');
    expect(headers.get('x-command-code-version')).toBeTruthy();
    // Session header is opencode-go only.
    expect(headers.get('x-opencode-session')).toBeNull();
    // The @commandcode routing suffix is stripped before upstream.
    const body = JSON.parse(String(init.body)) as { model: string };
    expect(body.model).toBe('claude-opus-5');
  });

  it.each([
    [
      '/v1/responses',
      { model: 'deepseek/deepseek-v4-flash', input: 'hi', stream: false },
    ],
    [
      '/v1/messages',
      { model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }], stream: false },
    ],
    [
      '/v1/systemone',
      {
        model: 'typesafe/jev',
        state: 'payments failing',
        questions: { is_urgent: { type: 'noul', instructions: 'Is this urgent?' } },
      },
    ],
  ])('relays %s to CommandCode /provider/v1 with the body and ZDR header intact', async (route, payload) => {
    // Fresh Response per call: a shared instance arrives with its body already
    // consumed if any other path (catalog warm-up, usage probe) fetches first.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    // The background catalog warm-up fetches `/provider/v1/models` on this
    // same client; seed it explicitly so the call list really contains a URL
    // that a `/provider/v1/` prefix filter would match first. Without this the
    // catalog never fires here (`modelAffinity` answers directly for these
    // models) and the route assertion below proves nothing.
    await commandcodeProvider.fetchCatalog?.();
    const app = createProxyApp(makeConfig({
      keys: [{ label: 'cc', key: 'user_cc-key-0001', provider: 'commandcode' }],
    }));

    const res = await app.request(route, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', 'x-cmd-zdr': '1' },
    });

    expect(res.status).toBe(200);
    // Match the full route: `/provider/v1/` alone also matches the public
    // models catalog (`/provider/v1/models`).
    const expectedUrl = `https://api.commandcode.ai/provider/v1${route.slice('/v1'.length)}`;
    const call = fetchMock.mock.calls.find(([url]) => String(url) === expectedUrl);
    expect(call).toBeDefined();
    const init = call?.[1] as RequestInit;
    // Byte-identical: no re-serialization, no chat-specific rewriting.
    expect(String(init.body)).toBe(JSON.stringify(payload));
    // Zero-data-retention opt-in is a client header: the proxy forwards it.
    expect((init.headers as Headers).get('x-cmd-zdr')).toBe('1');
  });

  it('never sends a key from another provider when a pin names the provider', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200 }),
    );
    const app = createProxyApp(makeConfig({
      keys: [
        { label: 'cc', key: 'user_cc-key-0001', provider: 'commandcode' },
        { label: 'oc', key: 'sk-oc-key-0002', provider: 'opencode-go' },
      ],
    }));

    const res = await app.request('/zen/go/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'glm-5@opencode-go', messages: [] }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const chatCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/zen/go/v1/chat/completions'),
    );
    const init = chatCall?.[1] as RequestInit | undefined;
    const headers = init?.headers as Headers;
    // The bearer must belong to the pinned provider — the opencode-go URL with
    // a commandcode key is a 401 that disables a healthy key.
    expect(headers.get('authorization')).toBe('Bearer sk-oc-key-0002');
    const body = JSON.parse(String(init?.body)) as { model: string };
    expect(body.model).toBe('glm-5');
  });

  it('strips the provider suffix and asks for usage in one pass', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(sseStream('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'), { status: 200 }),
    );
    const app = createProxyApp(makeConfig({
      keys: [{ label: 'cc', key: 'user_cc-key-0001', provider: 'commandcode' }],
    }));

    const res = await app.request('/zen/go/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek-v4-flash@commandcode', messages: [], stream: true }),
      headers: { 'content-type': 'application/json' },
    });
    await res.text();

    // The provider catalog warm-up also hits fetch (no body) — pick the
    // actual chat completion call.
    const chatCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/provider/v1/chat/completions'),
    );
    const body = JSON.parse(String((chatCall?.[1] as RequestInit | undefined)?.body)) as {
      model: string;
      stream_options?: unknown;
    };
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('forwards an unparseable body untouched', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(sseStream('data: [DONE]\n\n'), { status: 200 }),
    );
    const app = createProxyApp(makeConfig());

    await (await app.request('/v1/chat/completions', {
      method: 'POST',
      body: 'not json at all',
      headers: { 'content-type': 'application/json' },
    })).text();

    expect(String((fetchMock.mock.calls[0][1] as RequestInit).body)).toBe('not json at all');
  });

  it('handles a non-object JSON request body (JSON array)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    const app = createProxyApp(makeConfig());
    const res = await app.request('/zen/go/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify([1, 2, 3]),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://example.com/zen/go/v1/chat/completions',
    );
  });
});

describe('createProxyApp — session header', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetModelsFetcherState();
  });

  function upstreamHeaders(call: unknown[]): Headers {
    return (call[1] as RequestInit).headers as Headers;
  }

  it('derives a stable session id when the client sends none', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200 }),
    );
    const app = createProxyApp(makeConfig());
    const payload = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

    for (let i = 0; i < 2; i++) {
      await (await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      })).text();
    }

    const first = upstreamHeaders(fetchMock.mock.calls[0]).get('x-opencode-session');
    const second = upstreamHeaders(fetchMock.mock.calls[1]).get('x-opencode-session');
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toBe(first);
  });

  it('forwards a client-supplied session id untouched', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200 }),
    );
    const app = createProxyApp(makeConfig());

    await (await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      headers: { 'content-type': 'application/json', 'x-opencode-session': 'client-session-1' },
    })).text();

    expect(upstreamHeaders(fetchMock.mock.calls[0]).get('x-opencode-session')).toBe('client-session-1');
  });

  it('adds no session header for providers that do not use one', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200 }),
    );
    const app = createProxyApp(makeConfig({
      keys: [{ label: 'cc', key: 'user_cc-key-0001', provider: 'commandcode' }],
    }));

    await (await app.request('/zen/go/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      headers: { 'content-type': 'application/json' },
    })).text();

    const chatCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/provider/v1/chat/completions'),
    );
    expect(upstreamHeaders(chatCall as unknown[]).get('x-opencode-session')).toBeNull();
  });
});


describe('createProxyApp — X-Proxy-Provider header', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetModelsFetcherState();
  });

  // Mixed pool: one key per provider. The model suffix pins the provider, so
  // the response header can be checked against a known serving key.
  function mixedPool(): ProxyConfig {
    return makeConfig({
      keys: [
        { label: 'oc', key: 'oc_sk_oc-key-0000000001', provider: 'opencode-go' },
        { label: 'cc', key: 'user_cc-key-0000000001', provider: 'commandcode' },
      ],
    });
  }

  // This test pins the provider via the model suffix, so suffix and serving
  // key agree by construction — it would pass even if the header merely
  // re-parsed the model id. Provenance is proven by the unpinned test below
  // (its key prefixes contradict the configured providers, so prefix inference
  // would report the opposite provider) and by the prefix-contradiction test.
  it('reports the provider of the key that served the request', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"ok":true}', { status: 200 }),
    );
    const app = createProxyApp(mixedPool());

    const oc = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'model-x@opencode-go', messages: [] }),
      headers: { 'content-type': 'application/json' },
    });
    await oc.text();
    expect(oc.headers.get('X-Proxy-Provider')).toBe('opencode-go');
    expect(oc.headers.get('X-Proxy-Key-Label')).toBe('oc');

    const cc = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'model-x@commandcode', messages: [] }),
      headers: { 'content-type': 'application/json' },
    });
    await cc.text();
    expect(cc.headers.get('X-Proxy-Provider')).toBe('commandcode');
    expect(cc.headers.get('X-Proxy-Key-Label')).toBe('cc');
  });

  it('sets the provider header on streaming responses too', async () => {
    // One Response per fetch: the usage/models warm-up consumes bodies, and a
    // shared instance would be drained before the chat call in a clean process.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(sseStream('data: {"choices":[]}\n\n'), { status: 200 }),
    );
    const app = createProxyApp(mixedPool());

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'model-x@commandcode', stream: true, messages: [] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Proxy-Provider')).toBe('commandcode');
    expect(res.headers.get('X-Proxy-Key-Label')).toBe('cc');
    await res.text();
  });

  it('derives the header from the serving key when no suffix pins the model', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"ok":true}', { status: 200 }),
    );
    // Prefixes deliberately contradict the configured providers: a header
    // built by re-inferring from the credential would report opencode-go for
    // the sk-… key and commandcode for the user_… key — the opposite values.
    const app = createProxyApp(makeConfig({
      keys: [
        { label: 'sk-cc', key: 'sk-commandcode-key-000001', provider: 'commandcode' },
        { label: 'user-oc', key: 'user_opencode-key-000001', provider: 'opencode-go' },
      ],
    }));

    // Round-robin: sk-cc then user-oc. The model carries no @provider hint, so
    // the only source of truth is the selected key's configured provider.
    for (const expected of [
      { keyLabel: 'sk-cc', provider: 'commandcode' },
      { keyLabel: 'user-oc', provider: 'opencode-go' },
    ]) {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'model-x', messages: [] }),
        headers: { 'content-type': 'application/json' },
      });
      await res.text();
      expect(res.headers.get('X-Proxy-Key-Label')).toBe(expected.keyLabel);
      expect(res.headers.get('X-Proxy-Provider')).toBe(expected.provider);
    }
  });

  it('routes by the configured provider even when it contradicts the key prefix', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"ok":true}', { status: 200 }),
    );
    const app = createProxyApp(makeConfig({
      keys: [{ label: 'cc-sk', key: 'sk-commandcode-key-0001', provider: 'commandcode' }],
    }));

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'model-x', messages: [] }),
      headers: { 'content-type': 'application/json' },
    });
    await res.text();

    expect(res.headers.get('X-Proxy-Key-Label')).toBe('cc-sk');
    expect(res.headers.get('X-Proxy-Provider')).toBe('commandcode');
    // The URL proves the route itself: re-inferring from the sk- prefix used to
    // send this key to opencode-go's upstream.
    const chatUrls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.endsWith('/chat/completions'));
    expect(chatUrls).toEqual(['https://api.commandcode.ai/provider/v1/chat/completions']);
  });

  it('follows the serving key across a cross-provider failover', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (!url.endsWith('/chat/completions')) return new Response('{}', { status: 200 });
      return url.includes('commandcode')
        ? new Response('{"ok":true}', { status: 200 })
        : new Response('{"error":"boom"}', { status: 500 });
    });
    const app = createProxyApp(mixedPool());

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'model-x', messages: [] }),
      headers: { 'content-type': 'application/json' },
    });
    await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Proxy-Key-Label')).toBe('cc');
    expect(res.headers.get('X-Proxy-Provider')).toBe('commandcode');
  });
});

describe('createProxyApp — GET /debug/recent', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetModelsFetcherState();
    // A shell that exports SAROS_DEBUG_BUFFER must not flip this suite.
    delete process.env.SAROS_DEBUG_BUFFER;
  });

  afterEach(() => {
    delete process.env.SAROS_DEBUG_BUFFER;
  });

  /** One fresh Response per fetch; chat calls answer through `chat`. */
  function mockUpstream(chat: (url: string) => Response) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (!url.endsWith('/chat/completions')) return new Response('{}', { status: 200 });
      return chat(url);
    });
  }

  function postChat(app: AppLike, payload: Record<string, unknown>): Promise<Response> {
    return app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
    });
  }

  async function recent(app: AppLike): Promise<{
    count: number;
    entries: Array<Record<string, unknown>>;
  }> {
    return (await (await app.request('/debug/recent')).json()) as {
      count: number;
      entries: Array<Record<string, unknown>>;
    };
  }

  it('mirrors request.complete entries in order, without credential material', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"choices":[]}', { status: 200 }),
    );
    const secret = 'sk-alpha-secret-000000000001';
    const app = createProxyApp(makeConfig({ keys: [{ label: 'alpha', key: secret }] }));

    const first = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'model-one', messages: [] }),
      headers: { 'content-type': 'application/json' },
    });
    const firstId = first.headers.get('X-Proxy-Request-Id');
    await first.text();

    const second = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'model-two', stream: true, messages: [] }),
      headers: { 'content-type': 'application/json' },
    });
    await second.text();

    const res = await app.request('/debug/recent');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      capacity: number;
      count: number;
      entries: Array<Record<string, unknown>>;
    };

    expect(body.capacity).toBe(200);
    expect(body.count).toBe(2);
    expect(body.entries[0]).toMatchObject({
      requestId: firstId,
      method: 'POST',
      path: '/zen/go/v1/chat/completions',
      model: 'model-one',
      provider: 'opencode-go',
      keyLabel: 'alpha',
      status: 200,
      stream: false,
      attempt: 1,
    });
    expect(body.entries[1]).toMatchObject({
      model: 'model-two',
      provider: 'opencode-go',
      keyLabel: 'alpha',
      status: 200,
      stream: true,
      attempt: 1,
    });
    expect(typeof body.entries[0].at).toBe('string');
    expect(Date.parse(body.entries[0].at as string)).not.toBeNaN();
    expect(body.entries[0].durationMs).toBeTypeOf('number');

    // Only the public label travels: neither the credential nor a header dump.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('authorization');
  });

  it('records a request that never reached a key (503) with a null provider', async () => {
    mockUpstream(() => new Response('{}', { status: 200 }));
    const app = createProxyApp(makeConfig({
      keys: [{ label: 'retired', key: 'sk-retired-key-000000001', enabled: false }],
    }));

    const proxied = await postChat(app, { model: 'model-one', messages: [] });
    expect(proxied.status).toBe(503);
    expect(proxied.headers.get('X-Proxy-Key-Label')).toBeNull();
    expect(proxied.headers.get('X-Proxy-Provider')).toBeNull();
    await proxied.text();

    const body = await recent(app);
    expect(body.count).toBe(1);
    expect(body.entries[0]).toMatchObject({
      provider: null,
      keyLabel: null,
      status: 503,
    });
  });

  it('records the last key tried on a 503 raised after a failed attempt', async () => {
    mockUpstream(() => new Response('{"error":"boom"}', { status: 500 }));
    const app = createProxyApp(makeConfig({
      keys: [{ label: 'only', key: 'sk-only-key-0000000000001' }],
    }));

    const res = await postChat(app, { model: 'model-one', messages: [] });
    const failure = await res.json() as { causes: string[] };
    expect(res.status).toBe(503);
    // The proxy's own 503 advertises no key headers; the entry carries the label.
    expect(res.headers.get('X-Proxy-Key-Label')).toBeNull();
    expect(res.headers.get('X-Proxy-Provider')).toBeNull();
    // The body names the key it tried — the entry must not contradict it.
    expect(failure.causes.join(' ')).toContain('only');

    const body = await recent(app);
    expect(body.count).toBe(1);
    expect(body.entries[0]).toMatchObject({
      status: 503,
      provider: 'opencode-go',
      keyLabel: 'only',
      attempt: 2,
    });
  });

  it('keeps the second key as the last tried when a two-key pool fails both attempts', async () => {
    mockUpstream(() => new Response('{"error":"boom"}', { status: 500 }));
    const app = createProxyApp(makeConfig());

    const res = await postChat(app, { model: 'model-one', messages: [] });
    await res.text();
    // Both attempts consumed a key, so the loop is exhausted before another
    // selection: the terminal answer is 502, attributed to the second key.
    expect(res.status).toBe(502);

    const body = await recent(app);
    expect(body.count).toBe(1);
    expect(body.entries[0]).toMatchObject({
      status: 502,
      provider: 'opencode-go',
      keyLabel: 'beta',
      attempt: 2,
    });
  });

  it('returns 404 and records nothing when SAROS_DEBUG_BUFFER=0', async () => {
    process.env.SAROS_DEBUG_BUFFER = '0';
    // One Response per fetch: the warm-up calls would drain a shared instance.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"choices":[]}', { status: 200 }),
    );
    const app = createProxyApp(makeConfig());

    const proxied = await postChat(app, { model: 'model-one', messages: [] });
    expect(proxied.status).toBe(200);
    await proxied.text();
    // Scoped to the chat URL: usage/models warm-up fetches share globalThis.fetch.
    const chatCalls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.endsWith('/chat/completions'));
    expect(chatCalls).toHaveLength(1);

    const res = await app.request('/debug/recent');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not Found' });
  });

  it('records a forwarded 4xx once, with its key label and no debug headers', async () => {
    mockUpstream(() => new Response('{"error":{"message":"bad model"}}', { status: 400 }));
    const app = createProxyApp(makeConfig());

    const res = await postChat(app, { model: 'model-one', messages: [] });
    await res.text();
    expect(res.status).toBe(400);
    expect(res.headers.get('X-Proxy-Key-Label')).toBeNull();
    expect(res.headers.get('X-Proxy-Provider')).toBeNull();

    const body = await recent(app);
    expect(body.count).toBe(1);
    expect(body.entries[0]).toMatchObject({
      status: 400,
      provider: 'opencode-go',
      keyLabel: 'alpha',
      attempt: 1,
    });
  });

  it('records a retries-exhausted 502 once, with the last key tried', async () => {
    mockUpstream(() => new Response('{"error":"boom"}', { status: 500 }));
    const app = createProxyApp(makeConfig());

    const res = await postChat(app, { model: 'model-one', messages: [] });
    await res.text();
    expect(res.status).toBe(502);
    expect(res.headers.get('X-Proxy-Key-Label')).toBeNull();
    expect(res.headers.get('X-Proxy-Provider')).toBeNull();

    const body = await recent(app);
    expect(body.count).toBe(1);
    expect(body.entries[0]).toMatchObject({
      status: 502,
      provider: 'opencode-go',
      keyLabel: 'beta',
      attempt: 2,
    });
  });

  it('records the bodyless-stream 502 once, after the upstream 2xx', async () => {
    mockUpstream(() => new Response(null, { status: 200 }));
    const app = createProxyApp(makeConfig());

    const res = await postChat(app, { model: 'model-one', stream: true, messages: [] });
    await res.text();
    expect(res.status).toBe(502);
    expect(res.headers.get('X-Proxy-Key-Label')).toBeNull();
    expect(res.headers.get('X-Proxy-Provider')).toBeNull();

    const body = await recent(app);
    expect(body.count).toBe(1);
    expect(body.entries[0]).toMatchObject({
      status: 502,
      provider: 'opencode-go',
      keyLabel: 'alpha',
      stream: true,
    });
  });

  it('records one entry across a retry, on the attempt that succeeded', async () => {
    let chatCalls = 0;
    mockUpstream(() => {
      chatCalls++;
      return chatCalls === 1
        ? new Response('{"error":"boom"}', { status: 500 })
        : new Response('{"choices":[]}', { status: 200 });
    });
    const app = createProxyApp(makeConfig());

    const res = await postChat(app, { model: 'model-one', messages: [] });
    await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Proxy-Key-Label')).toBe('beta');
    expect(res.headers.get('X-Proxy-Provider')).toBe('opencode-go');

    // The failed attempt logs no access entry: one request, one entry.
    const body = await recent(app);
    expect(body.count).toBe(1);
    expect(body.entries[0]).toMatchObject({
      status: 200,
      attempt: 2,
      keyLabel: 'beta',
    });
  });
});
