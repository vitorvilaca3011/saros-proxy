import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  buildUpstreamUrl,
  buildUpstreamHeaders,
  isStreamingRequest,
  createProxyApp,
} from './proxy.js';
import { resetModelsFetcherState } from './models-fetcher.js';
import { loadModelsFromJson } from './cli/opencode-config.js';
import type { ProxyConfig } from './config.js';
import { MAX_BODY_SIZE } from './constants.js';

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
    expect(body.data).toHaveLength(Object.keys(loadModelsFromJson()).length);
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
    expect(body.data).toHaveLength(Object.keys(loadModelsFromJson()).length);
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
    // KeyFault disables keys immediately → both keys disabled
    const health = await app.request('/health');
    const h = await health.json();
    expect(h.enabledCount).toBe(0);
    expect(h.disabledCount).toBe(2);
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

  it('reflects allowed origins via CORS', async () => {
    const app = createProxyApp(makeConfig({ allowedOrigins: ['https://*.example.com'] }));
    const res = await app.request('/health', { headers: { origin: 'https://app.example.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
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
