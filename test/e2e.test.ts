/**
 * e2e.test.ts — Comprehensive E2E tests for OpenCode-Go Multi-Account Proxy.
 *
 * Starts a real mock upstream server and real proxy servers, then makes
 * real HTTP requests to verify the full request/response lifecycle.
 *
 * Run: npx vitest run test/e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';

import { createProxyApp } from '../src/proxy.js';
import { validateConfig } from '../src/config.js';
import type { ProxyConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

async function collectStream(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mock Upstream Server
// ---------------------------------------------------------------------------

interface LogEntry {
  method: string;
  url: string;
  auth: string;
  body: string;
}

interface UpstreamControl {
  setResponse(authHeader: string, status: number, body: string, headers?: Record<string, string>): void;
  setDefaultResponse(status: number, body: string, headers?: Record<string, string>): void;
  /** Make the first N requests fail with the given status (then fall through to normal routing). */
  setFailNextN(n: number, status: number, body?: string): void;
  setDelay(ms: number): void;
  setStreamError(v: boolean): void;
  setStreamChunks(chunks: string[]): void;
  getRequestLog(): LogEntry[];
  reset(): void;
}

function createMockUpstream(): { server: Server; control: UpstreamControl } {
  const customResponses = new Map<string, { status: number; headers: Record<string, string>; body: string }>();
  let defaultResponse: { status: number; headers: Record<string, string>; body: string } | null = null;
  let failRemaining = 0;
  let failStatus = 500;
  let failBody = '{"error":"simulated failure"}';
  let delayMs = 0;
  let streamError = false;
  let streamChunks: string[] = [];
  const requestLog: LogEntry[] = [];

  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url || '';
    const method = req.method || '';
    const auth = req.headers['authorization'] || '';

    requestLog.push({ method, url, auth, body });

    // Custom response by auth header (highest priority)
    if (customResponses.has(auth)) {
      const resp = customResponses.get(auth)!;
      res.writeHead(resp.status, resp.headers);
      res.end(resp.body);
      return;
    }

    // Default static response (ignores route)
    if (defaultResponse) {
      res.writeHead(defaultResponse.status, defaultResponse.headers);
      res.end(defaultResponse.body);
      return;
    }

    // Fail-first-N mode
    if (failRemaining > 0) {
      failRemaining--;
      res.writeHead(failStatus, { 'Content-Type': 'application/json' });
      res.end(failBody);
      return;
    }

    // Artificial delay (for timeout testing)
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    // --- Route handlers ---

    if (url === '/zen/go/v1/models' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Custom': 'models-header',
      });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'gpt-4', object: 'model', created: 1687882411, owned_by: 'openai' },
          { id: 'gpt-3.5-turbo', object: 'model', created: 1687882411, owned_by: 'openai' },
        ],
      }));
      return;
    }

    if (url === '/zen/go/v1/chat/completions' && method === 'POST') {
      let request: Record<string, unknown> = {};
      try {
        request = JSON.parse(body);
      } catch { /* empty */ }

      if (request.stream === true) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Custom': 'stream-header',
        });

        if (streamError) {
          res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
          res.write('data: {"error":{"message":"API error"}}\n\n');
        } else if (streamChunks.length > 0) {
          for (const chunk of streamChunks) {
            res.write(chunk);
          }
        } else {
          res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
          res.write('data: [DONE]\n\n');
        }
        res.end();
      } else {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Custom': 'chat-header',
        });
        res.end(JSON.stringify({
          id: 'chatcmpl-e2e-test',
          object: 'chat.completion',
          created: 1687882411,
          model: 'gpt-4',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hello world from mock' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const control: UpstreamControl = {
    setResponse(authHeader, status, body, headers = { 'Content-Type': 'application/json' }) {
      customResponses.set(authHeader, { status, headers, body });
    },
    setDefaultResponse(status, body, headers = { 'Content-Type': 'application/json' }) {
      defaultResponse = { status, headers, body };
    },
    setFailNextN(n, status, body) {
      failRemaining = n;
      failStatus = status;
      if (body !== undefined) failBody = body;
    },
    setDelay(ms) { delayMs = ms; },
    setStreamError(v) { streamError = v; },
    setStreamChunks(chunks) { streamChunks = chunks; },
    getRequestLog() { return requestLog; },
    reset() {
      customResponses.clear();
      defaultResponse = null;
      failRemaining = 0;
      failStatus = 500;
      failBody = '{"error":"simulated failure"}';
      delayMs = 0;
      streamError = false;
      streamChunks = [];
      requestLog.length = 0;
    },
  };

  return { server, control };
}

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function baseConfig(upstreamPort: number): ProxyConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    keys: [
      { label: 'key-1', key: 'sk-e2e-test-1111111111111111' },
      { label: 'key-2', key: 'sk-e2e-test-2222222222222222' },
    ],
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 500,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    requestTimeoutMs: 3000,
    allowedOrigins: ['http://localhost:*'],
  };
}

interface ProxyContext {
  port: number;
  server: ReturnType<typeof serve>;
  close(): Promise<void>;
}

async function startProxy(cfg: ProxyConfig): Promise<ProxyContext> {
  const app = createProxyApp(cfg);
  return new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, port: 0, hostname: '127.0.0.1' },
      (info: AddressInfo) => {
        resolve({
          port: info.port,
          server,
          close: () => new Promise<void>((r) => {
            // Close all keep-alive connections first (Node.js 18.2+)
            if ('closeAllConnections' in server) {
              (server as any).closeAllConnections();
            }
            server.close(() => r());
          }),
        });
      },
    );
  });
}

/** Helper to run a test against a dedicated (fresh) proxy instance. */
async function withFreshProxy(
  cfg: ProxyConfig,
  fn: (ctx: ProxyContext) => Promise<void>,
): Promise<void> {
  const ctx = await startProxy(cfg);
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

function pf(port: number, path: string, options?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, options);
}

// -----------------------------------------------------------------------
// Global — mock upstream runs once for the whole suite
// -----------------------------------------------------------------------

let mockUpstream: Server;
let mockControl: UpstreamControl;
let upstreamPort: number;

beforeAll(async () => {
  const mock = createMockUpstream();
  mockUpstream = mock.server;
  mockControl = mock.control;
  await new Promise<void>((resolve) => {
    mockUpstream.listen(0, '127.0.0.1', () => {
      upstreamPort = (mockUpstream.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    // Close all keep-alive connections first (Node.js 18.2+)
    if ('closeAllConnections' in mockUpstream) {
      (mockUpstream as any).closeAllConnections();
    }
    mockUpstream.close(() => resolve());
  });
});

beforeEach(() => {
  mockControl.reset();
});

// -----------------------------------------------------------------------
// 1. Health & Status
// -----------------------------------------------------------------------

describe('1. Health & Status', () => {
  let proxy: ProxyContext;

  beforeAll(async () => {
    proxy = await startProxy(baseConfig(upstreamPort));
  });
  afterAll(async () => { await proxy.close(); });

  it('GET /health returns correct status and configuration', async () => {
    const res = await pf(proxy.port, '/health');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    expect(body.status).toBe('ok');
    expect(body.keyCount).toBe(2);
    expect(body.enabledCount).toBe(2);
    expect(body.disabledCount).toBe(0);
    expect(body.activeRequests).toBe(0);
    expect(body.circuitBreakerThreshold).toBe(3);
    expect(body.circuitBreakerCooldownMs).toBe(500);
    expect(typeof body.uptime).toBe('number');
  });

  it('health reflects disabled keys', async () => {
    mockControl.setResponse(
      'Bearer sk-e2e-test-1111111111111111',
      401,
      JSON.stringify({ error: 'invalid key' }),
    );

    await pf(proxy.port, '/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });

    const health = await (await pf(proxy.port, '/health')).json() as Record<string, unknown>;
    expect(health.enabledCount).toBe(1);
    expect(health.disabledCount).toBe(1);
    expect(health.keyCount).toBe(2);
  });
});

// -----------------------------------------------------------------------
// 2. Models Endpoint
// -----------------------------------------------------------------------

describe('2. Models Endpoint', () => {
  let proxy: ProxyContext;

  beforeAll(async () => {
    proxy = await startProxy(baseConfig(upstreamPort));
  });
  afterAll(async () => { await proxy.close(); });

  it('GET /zen/go/v1/models proxies correctly', async () => {
    const res = await pf(proxy.port, '/zen/go/v1/models');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('X-Custom')).toBe('models-header');

    const body = await res.json() as Record<string, unknown>;
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as Array<{ id: string }>).length).toBe(2);

    const log = mockControl.getRequestLog();
    expect(log.length).toBe(1);
    expect(log[0].url).toBe('/zen/go/v1/models');
    expect(log[0].auth).toMatch(/^Bearer sk-e2e-test-/);
  });

  it('models response includes correct data', async () => {
    const res = await pf(proxy.port, '/zen/go/v1/models');
    const body = await res.json() as Record<string, unknown>;
    const models = body.data as Array<{ id: string }>;
    expect(models[0].id).toBe('gpt-4');
    expect(models[1].id).toBe('gpt-3.5-turbo');
  });
});

// -----------------------------------------------------------------------
// 3. Non-Streaming Requests
// -----------------------------------------------------------------------

describe('3. Non-Streaming Requests', () => {
  let proxy: ProxyContext;

  beforeAll(async () => {
    proxy = await startProxy(baseConfig(upstreamPort));
  });
  afterAll(async () => { await proxy.close(); });

  it('round-robin key rotation across multiple requests', async () => {
    const usedKeys: string[] = [];

    for (let i = 0; i < 4; i++) {
      const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: `msg-${i}` }],
          stream: false,
        }),
      });
      expect(res.status).toBe(200);
    }

    const log = mockControl.getRequestLog();
    expect(log.length).toBe(4);

    for (const entry of log) {
      usedKeys.push(entry.auth.replace('Bearer ', ''));
    }

    // Fresh proxy → rotation: key-1, key-2, key-1, key-2
    expect(usedKeys[0]).toBe('sk-e2e-test-1111111111111111');
    expect(usedKeys[1]).toBe('sk-e2e-test-2222222222222222');
    expect(usedKeys[2]).toBe('sk-e2e-test-1111111111111111');
    expect(usedKeys[3]).toBe('sk-e2e-test-2222222222222222');
  });

  it('POST with stream:false returns chat completion', async () => {
    const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('X-Custom')).toBe('chat-header');

    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBe('chatcmpl-e2e-test');
    expect(body.object).toBe('chat.completion');
    const choices = body.choices as Array<{ message: { content: string } }>;
    expect(choices[0].message.content).toBe('Hello world from mock');
  });

  it('forwards request headers correctly (Authorization replaced)', async () => {
    await pf(proxy.port, '/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Custom-Fwd': 'should-be-present',
        Authorization: 'Bearer bad-key-should-be-overridden',
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });

    const log = mockControl.getRequestLog();
    expect(log.length).toBe(1);
    expect(log[0].auth).not.toBe('Bearer bad-key-should-be-overridden');
    expect(log[0].auth).toMatch(/^Bearer sk-e2e-test-/);
  });
});

// -----------------------------------------------------------------------
// 4. Failover on Errors  — each test gets a fresh proxy
// -----------------------------------------------------------------------

describe('4. Failover on Errors', () => {
  function cfg() { return { ...baseConfig(upstreamPort), circuitBreakerThreshold: 10 }; }

  it('429 (KeyFault) triggers retry with next key', async () => {
    await withFreshProxy(cfg(), async (proxy) => {
      mockControl.setFailNextN(1, 429, JSON.stringify({ error: 'rate limited' }));

      const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
      });

      expect(res.status).toBe(200);

      const log = mockControl.getRequestLog();
      expect(log.length).toBe(2);
      // Two different keys were used
      expect(log[0].auth).not.toBe(log[1].auth);
    });
  });

  it('500 (ServerFault) triggers retry with next key', async () => {
    await withFreshProxy(cfg(), async (proxy) => {
      mockControl.setFailNextN(1, 500, JSON.stringify({ error: 'internal error' }));

      const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
      });

      expect(res.status).toBe(200);
      const log = mockControl.getRequestLog();
      expect(log.length).toBe(2);
      expect(log[0].auth).not.toBe(log[1].auth);
    });
  });

  it('all keys fail returns 502', async () => {
    await withFreshProxy(cfg(), async (proxy) => {
      mockControl.setDefaultResponse(500, JSON.stringify({ error: 'server error' }));

      const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
      });

      expect(res.status).toBe(502);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('Bad Gateway');
    });
  });

  it('400 (RequestFault) is not retried and key not penalised', async () => {
    await withFreshProxy(cfg(), async (proxy) => {
      mockControl.setDefaultResponse(400, JSON.stringify({ error: 'bad request' }));

      const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [],
          stream: false,
        }),
      });

      expect(res.status).toBe(400);
      // Only 1 request — RequestFault does NOT trigger retry
      expect(mockControl.getRequestLog().length).toBe(1);

      // Key should NOT be penalised
      const health = await (await pf(proxy.port, '/health')).json() as Record<string, unknown>;
      expect(health.enabledCount).toBe(2);
    });
  });

  it('404 (RequestFault) is not retried', async () => {
    await withFreshProxy(cfg(), async (proxy) => {
      mockControl.setDefaultResponse(404, JSON.stringify({ error: 'not found' }));

      const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
      });

      expect(res.status).toBe(404);
      expect(mockControl.getRequestLog().length).toBe(1);
    });
  });

  it('401 (KeyFault) disables the key immediately and retries', async () => {
    await withFreshProxy(cfg(), async (proxy) => {
      mockControl.setFailNextN(1, 401, JSON.stringify({ error: 'invalid key' }));

      const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
      });

      expect(res.status).toBe(200);

      // The key that got 401 should be disabled
      const health = await (await pf(proxy.port, '/health')).json() as Record<string, unknown>;
      expect(health.disabledCount).toBe(1);
      expect(health.enabledCount).toBe(1);
    });
  });
});

// -----------------------------------------------------------------------
// 5. Streaming Requests
// -----------------------------------------------------------------------

describe('5. Streaming Requests', () => {
  let proxy: ProxyContext;

  beforeAll(async () => {
    proxy = await startProxy(baseConfig(upstreamPort));
  });
  afterAll(async () => { await proxy.close(); });

  it('SSE chunks are passed through correctly', async () => {
    const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const data = await collectStream(res);
    expect(data).toContain('data: {"choices":[{"delta":{"content":"Hello"}}]}');
    expect(data).toContain('data: {"choices":[{"delta":{"content":" world"}}]}');
    expect(data).toContain('data: [DONE]');
  });

  it('stream completes normally with [DONE] marker', async () => {
    const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
    });

    const data = await collectStream(res);
    expect(data).toContain('[DONE]');
  });

  it('Content-Type is set to text/event-stream', async () => {
    const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
    });

    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('connection')).toBe('keep-alive');
  });
});

// -----------------------------------------------------------------------
// 6. Mid-Stream Error Detection
// -----------------------------------------------------------------------

describe('6. Mid-Stream Error Detection', () => {
  let proxy: ProxyContext;

  beforeAll(async () => {
    proxy = await startProxy(baseConfig(upstreamPort));
  });
  afterAll(async () => { await proxy.close(); });

  it('error marker in stream triggers proxy_error event', async () => {
    mockControl.setStreamError(true);

    const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const data = await collectStream(res);
    expect(data).toContain('proxy_error');
    expect(data).toContain('"type":"proxy_error"');
  });

  it('stream closes gracefully after mid-stream error', async () => {
    mockControl.setStreamError(true);

    const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
    });

    const data = await collectStream(res);
    expect(typeof data).toBe('string');
    expect(data.length).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------
// 7. Circuit Breaker — each test gets a fresh proxy
// -----------------------------------------------------------------------

describe('7. Circuit Breaker', () => {
  function cfg() { return baseConfig(upstreamPort); }

  it('after threshold consecutive failures, key is disabled', async () => {
    await withFreshProxy(cfg(), async (proxy) => {
      // Make key-1 always return 500, key-2 always succeeds
      mockControl.setResponse(
        'Bearer sk-e2e-test-1111111111111111',
        500,
        JSON.stringify({ error: 'server fault' }),
      );

      // Send enough requests so key-1 crosses threshold
      // With threshold=3 and round-robin, every other request hits key-1
      // So 6 requests → 3 failures on key-1 → disabled
      for (let i = 0; i < 6; i++) {
        const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4',
            messages: [{ role: 'user', content: `msg-${i}` }],
            stream: false,
          }),
        });
        expect(res.status).toBe(200);
      }

      const health = await (await pf(proxy.port, '/health')).json() as Record<string, unknown>;
      expect(health.disabledCount).toBe(1);
      expect(health.enabledCount).toBe(1);
    });
  });

  it('disabled key is skipped in round-robin', async () => {
    await withFreshProxy(cfg(), async (proxy) => {
      // First disable key-1
      mockControl.setResponse(
        'Bearer sk-e2e-test-1111111111111111',
        500,
        JSON.stringify({ error: 'server fault' }),
      );

      for (let i = 0; i < 6; i++) {
        await pf(proxy.port, '/zen/go/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4',
            messages: [{ role: 'user', content: `disable-${i}` }],
            stream: false,
          }),
        });
      }

      // Verify key-1 is disabled
      let health = await (await pf(proxy.port, '/health')).json() as Record<string, unknown>;
      expect(health.disabledCount).toBe(1);

      // Now make more requests — all should use key-2
      mockControl.reset();
      for (let i = 0; i < 3; i++) {
        await pf(proxy.port, '/zen/go/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4',
            messages: [{ role: 'user', content: `round-${i}` }],
            stream: false,
          }),
        });
      }

      const log = mockControl.getRequestLog();
      expect(log.length).toBe(3);
      for (const entry of log) {
        expect(entry.auth).toBe('Bearer sk-e2e-test-2222222222222222');
      }
    });
  });

  it('after cooldown period, key is re-enabled', async () => {
    await withFreshProxy(cfg(), async (proxy) => {
      // Disable key-1 via 401
      mockControl.setResponse(
        'Bearer sk-e2e-test-1111111111111111',
        401,
        JSON.stringify({ error: 'invalid' }),
      );

      await pf(proxy.port, '/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'disable' }],
          stream: false,
        }),
      });

      let health = await (await pf(proxy.port, '/health')).json() as Record<string, unknown>;
      expect(health.disabledCount).toBe(1);

      // Wait for cooldown (500ms)
      await new Promise((r) => setTimeout(r, 600));

      // Now both keys should be available
      mockControl.reset();
      const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'after cooldown' }],
          stream: false,
        }),
      });
      expect(res.status).toBe(200);

      health = await (await pf(proxy.port, '/health')).json() as Record<string, unknown>;
      expect(health.disabledCount).toBe(0);
      expect(health.enabledCount).toBe(2);
    });
  });

  it('manual re-enable mechanism works via lazy cooldown', async () => {
    await withFreshProxy(cfg(), async (proxy) => {
      // Disable key-1 via 401
      mockControl.setResponse(
        'Bearer sk-e2e-test-1111111111111111',
        401,
        JSON.stringify({ error: 'invalid' }),
      );

      await pf(proxy.port, '/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'disable' }],
          stream: false,
        }),
      });

      // Wait for cooldown
      await new Promise((r) => setTimeout(r, 600));

      // Manually re-enable via the re-enable mechanism
      // (In production this would be an API endpoint; here we rely on lazy cooldown)
      mockControl.reset();
      const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'reenable' }],
          stream: false,
        }),
      });
      expect(res.status).toBe(200);

      const health = await (await pf(proxy.port, '/health')).json() as Record<string, unknown>;
      expect(health.disabledCount).toBe(0);
      expect(health.enabledCount).toBe(2);
    });
  });
});

// -----------------------------------------------------------------------
// 8. Request Timeout
// -----------------------------------------------------------------------

describe('8. Request Timeout', () => {
  let proxy: ProxyContext;

  beforeAll(async () => {
    const cfg = { ...baseConfig(upstreamPort), requestTimeoutMs: 1000 };
    proxy = await startProxy(cfg);
  });
  afterAll(async () => { await proxy.close(); });

  it('when upstream exceeds requestTimeoutMs, proxy returns 504', async () => {
    mockControl.setDelay(3000);

    const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'timeout test' }],
        stream: false,
      }),
    });

    expect(res.status).toBe(504);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Gateway Timeout');
  }, 10000);

  it('timeout applies to streaming requests as well', async () => {
    mockControl.setDelay(3000);

    const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'timeout stream' }],
        stream: true,
      }),
    });

    expect(res.status).toBe(504);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Gateway Timeout');
  }, 10000);
});

// -----------------------------------------------------------------------
// 9. CORS
// -----------------------------------------------------------------------

describe('9. CORS', () => {
  let proxy: ProxyContext;

  beforeAll(async () => {
    proxy = await startProxy(baseConfig(upstreamPort));
  });
  afterAll(async () => { await proxy.close(); });

  it('requests from allowed origins succeed with CORS headers', async () => {
    const res = await pf(proxy.port, '/health', {
      headers: { Origin: 'http://localhost:3000' },
    });

    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('requests from allowed origins (different port) succeed', async () => {
    const res = await pf(proxy.port, '/health', {
      headers: { Origin: 'http://localhost:9999' },
    });

    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:9999');
  });

  it('requests from disallowed origins lack CORS headers', async () => {
    const res = await pf(proxy.port, '/health', {
      headers: { Origin: 'https://evil-site.com' },
    });

    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('preflight OPTIONS requests return proper CORS headers', async () => {
    const res = await pf(proxy.port, '/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('access-control-allow-methods')).toBeTruthy();
  });
});

// -----------------------------------------------------------------------
// 10. Config Validation
// -----------------------------------------------------------------------

describe('10. Config Validation', () => {
  it('invalid port falls back to default', () => {
    const cfg = validateConfig({
      port: -1,
      keys: [{ label: 't', key: 'sk-valid-key-1234567890123' }],
      upstreamBaseUrl: 'https://opencode.ai',
    });
    expect(cfg.port).toBe(3000);
  });

  it('invalid upstream URL falls back to default', () => {
    const cfg = validateConfig({
      upstreamBaseUrl: 'not-a-url',
      keys: [{ label: 't', key: 'sk-valid-key-1234567890123' }],
    });
    expect(cfg.upstreamBaseUrl).toBe('https://opencode.ai');
  });

  it('HTTP upstream URL falls back to default (HTTPS required)', () => {
    const cfg = validateConfig({
      upstreamBaseUrl: 'http://example.com',
      keys: [{ label: 't', key: 'sk-valid-key-1234567890123' }],
    });
    expect(cfg.upstreamBaseUrl).toBe('https://opencode.ai');
  });

  it('invalid API keys are filtered out', () => {
    const cfg = validateConfig({
      keys: [
        { label: 'valid', key: 'sk-valid-key-1234567890123456' },
        { label: 'short', key: 'sk-too-short' },
        { label: 'wrong-prefix', key: 'ak-invalid-prefix-1234567890' },
      ],
    });
    expect(cfg.keys).toHaveLength(1);
    expect(cfg.keys[0].label).toBe('valid');
  });

  it('missing keys throws error', () => {
    expect(() => validateConfig({ keys: [] })).toThrow('No valid API keys configured');
  });

  it('missing keys entirely throws error', () => {
    expect(() => validateConfig({})).toThrow('No valid API keys configured');
  });

  it('valid config passes through', () => {
    const cfg = validateConfig({
      port: 4000,
      host: '0.0.0.0',
      keys: [{ label: 'main', key: 'sk-valid-key-1234567890123456' }],
      circuitBreakerThreshold: 5,
      circuitBreakerCooldownMs: 10_000,
      upstreamBaseUrl: 'https://opencode.ai',
      requestTimeoutMs: 15_000,
      allowedOrigins: ['http://app.example.com'],
    });
    expect(cfg.port).toBe(4000);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.keys).toHaveLength(1);
    expect(cfg.circuitBreakerThreshold).toBe(5);
    expect(cfg.circuitBreakerCooldownMs).toBe(10_000);
    expect(cfg.requestTimeoutMs).toBe(15_000);
    expect(cfg.allowedOrigins).toEqual(['http://app.example.com']);
  });
});

// -----------------------------------------------------------------------
// 11. Concurrent Requests
// -----------------------------------------------------------------------

describe('11. Concurrent Requests', () => {
  let proxy: ProxyContext;

  beforeAll(async () => {
    proxy = await startProxy(baseConfig(upstreamPort));
  });
  afterAll(async () => { await proxy.close(); });

  it('concurrent requests use multiple keys in rotation', async () => {
    const count = 6;

    const responses = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        pf(proxy.port, '/zen/go/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4',
            messages: [{ role: 'user', content: `concurrent-msg-${i}` }],
            stream: false,
          }),
        }),
      ),
    );

    // All requests should succeed
    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    const log = mockControl.getRequestLog();
    expect(log.length).toBe(count);

    // Verify at least 2 different keys were used (rotation happened)
    const usedKeys = new Set(log.map((entry) => entry.auth));
    expect(usedKeys.size).toBeGreaterThan(1);

    // Verify no single key handled more than 4 of the 6 requests
    const keyCounts = new Map<string, number>();
    for (const entry of log) {
      keyCounts.set(entry.auth, (keyCounts.get(entry.auth) || 0) + 1);
    }
    for (const count of keyCounts.values()) {
      expect(count).toBeLessThanOrEqual(4);
    }
  });

  it('concurrent requests all return valid chat completions', async () => {
    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        pf(proxy.port, '/zen/go/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4',
            messages: [{ role: 'user', content: `msg-${i}` }],
            stream: false,
          }),
        }),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.id).toBe('chatcmpl-e2e-test');
      const choices = body.choices as Array<{ message: { content: string } }>;
      expect(choices[0].message.content).toBe('Hello world from mock');
    }
  });
});

// -----------------------------------------------------------------------
// 12. Request Body Limits
// -----------------------------------------------------------------------

describe('12. Request Body Limits', () => {
  let proxy: ProxyContext;

  beforeAll(async () => {
    proxy = await startProxy(baseConfig(upstreamPort));
  });
  afterAll(async () => { await proxy.close(); });

  it('rejects request body larger than 10MB with 413', async () => {
    const largeBody = 'x'.repeat(11 * 1024 * 1024); // ~11MB — exceeds 10MB limit

    const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: largeBody }],
        stream: false,
      }),
    });

    expect(res.status).toBe(413);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Request body too large');

    // Verify no request was forwarded to the upstream
    expect(mockControl.getRequestLog().length).toBe(0);
  });

  it('accepts request body near but under 10MB limit', async () => {
    const bodyContent = 'y'.repeat(9 * 1024 * 1024); // ~9MB — under 10MB limit

    const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: bodyContent }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);

    // Verify the request was forwarded
    const log = mockControl.getRequestLog();
    const matchingLogs = log.filter((entry) => entry.body.includes('yyyyy'));
    expect(matchingLogs.length).toBe(1);
  }, 30000);

});
