/**
 * account-switching.test.ts — E2E tests for API key rotation and failover
 * via X-Proxy-Key-Label and X-Proxy-Request-Id response headers.
 *
 * Run: npx vitest run test/account-switching.test.ts
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

    // Artificial delay
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    // --- Route handlers ---

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
            if ('closeAllConnections' in server) {
              server.closeAllConnections();
            }
            server.close(() => r());
          }),
        });
      },
    );
  });
}

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
    if ('closeAllConnections' in mockUpstream) {
      mockUpstream.closeAllConnections();
    }
    mockUpstream.close(() => resolve());
  });
});

beforeEach(() => {
  mockControl.reset();
});

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('Account Switching', () => {

  // -----------------------------------------------------------------------
  // Sequential rotation (2-key shared proxy)
  // Tests: sequentialNonStreamingRequestsRotateKeys,
  //        sequentialStreamingRequestsRotateKeys,
  //        requestIdHeaderMatchesResponse
  // -----------------------------------------------------------------------

  describe('sequential rotation (2 keys)', () => {
    let proxy: ProxyContext;

    beforeAll(async () => {
      proxy = await startProxy(baseConfig(upstreamPort));
    });
    afterAll(async () => { await proxy.close(); });

    // --- Test 1 ---

    it('sequential non-streaming requests rotate keys via X-Proxy-Key-Label', async () => {
      const expectedLabels = ['key-1', 'key-2', 'key-1', 'key-2'];

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
        expect(res.headers.get('X-Proxy-Key-Label')).toBe(expectedLabels[i]);
        expect(res.headers.get('X-Proxy-Request-Id')).toBeTruthy();
      }

      // Verify upstream request log shows alternating auth headers
      const log = mockControl.getRequestLog();
      expect(log.length).toBe(4);
      expect(log[0].auth).toBe('Bearer sk-e2e-test-1111111111111111');
      expect(log[1].auth).toBe('Bearer sk-e2e-test-2222222222222222');
      expect(log[2].auth).toBe('Bearer sk-e2e-test-1111111111111111');
      expect(log[3].auth).toBe('Bearer sk-e2e-test-2222222222222222');
    });

    // --- Test 2 ---

    it('sequential streaming requests rotate keys via X-Proxy-Key-Label', async () => {
      const expectedLabels = ['key-1', 'key-2', 'key-1', 'key-2'];

      for (let i = 0; i < 4; i++) {
        const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4',
            messages: [{ role: 'user', content: `msg-${i}` }],
            stream: true,
          }),
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/event-stream');
        expect(res.headers.get('X-Proxy-Key-Label')).toBe(expectedLabels[i]);

        // Consume each stream to verify it completes
        const data = await collectStream(res);
        expect(data).toContain('data: [DONE]');
      }
    }, 10000);

    // --- Test 5 ---

    it('X-Proxy-Request-Id header is present and unique per request', async () => {
      const requestIds: string[] = [];

      for (let i = 0; i < 2; i++) {
        const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4',
            messages: [{ role: 'user', content: `req-${i}` }],
            stream: false,
          }),
        });

        expect(res.status).toBe(200);
        const rid = res.headers.get('X-Proxy-Request-Id');
        expect(rid).toBeTruthy();
        requestIds.push(rid!);
      }

      // Two different requests should have different IDs
      expect(requestIds[0]).not.toBe(requestIds[1]);
      // Both should be non-empty strings
      expect(requestIds[0].length).toBeGreaterThan(0);
      expect(requestIds[1].length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent rotation (3-key shared proxy)
  // Test: concurrentNonStreamingRequestsUseDifferentKeys
  // -----------------------------------------------------------------------

  describe('concurrent rotation (3 keys)', () => {
    let proxy: ProxyContext;

    beforeAll(async () => {
      const cfg = {
        ...baseConfig(upstreamPort),
        keys: [
          { label: 'key-1', key: 'sk-e2e-test-1111111111111111' },
          { label: 'key-2', key: 'sk-e2e-test-2222222222222222' },
          { label: 'key-3', key: 'sk-e2e-test-3333333333333333' },
        ],
      };
      proxy = await startProxy(cfg);
    });
    afterAll(async () => { await proxy.close(); });

    // --- Test 4 ---

    it('concurrent non-streaming requests use different keys', async () => {
      const responses = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
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

      // All should succeed
      for (const res of responses) {
        expect(res.status).toBe(200);
      }

      // Collect all X-Proxy-Key-Label values
      const labels = responses.map((res) => res.headers.get('X-Proxy-Key-Label'));
      const uniqueLabels = new Set(labels);

      // With 3 concurrent requests and 3 keys, all should be different
      expect(uniqueLabels.size).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Failover (fresh proxy per test)
  // Tests: failoverChangesKeyLabel, streamingFailoverChangesKeyLabel
  // -----------------------------------------------------------------------

  describe('failover', () => {
    function cfg() {
      return { ...baseConfig(upstreamPort), circuitBreakerThreshold: 10 };
    }

    // --- Test 3 ---

    it('failover changes X-Proxy-Key-Label when first key fails', async () => {
      await withFreshProxy(cfg(), async (proxy) => {
        // Make key-1 return 500 (ServerFault — retriable)
        mockControl.setResponse(
          'Bearer sk-e2e-test-1111111111111111',
          500,
          JSON.stringify({ error: 'server error' }),
        );

        const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4',
            messages: [{ role: 'user', content: 'test failover' }],
            stream: false,
          }),
        });

        expect(res.status).toBe(200);
        // Failover should have switched to key-2
        expect(res.headers.get('X-Proxy-Key-Label')).toBe('key-2');
        expect(res.headers.get('X-Proxy-Request-Id')).toBeTruthy();

        // Verify upstream log shows 2 entries with different auth headers
        const log = mockControl.getRequestLog();
        expect(log.length).toBe(2);
        expect(log[0].auth).not.toBe(log[1].auth);
      });
    });

    // --- Test 6 ---

    it('streaming failover changes X-Proxy-Key-Label', async () => {
      await withFreshProxy(cfg(), async (proxy) => {
        // Make key-1 return 500
        mockControl.setResponse(
          'Bearer sk-e2e-test-1111111111111111',
          500,
          JSON.stringify({ error: 'server error' }),
        );

        const res = await pf(proxy.port, '/zen/go/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4',
            messages: [{ role: 'user', content: 'streaming failover' }],
            stream: true,
          }),
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/event-stream');
        // Failover should have switched to key-2
        expect(res.headers.get('X-Proxy-Key-Label')).toBe('key-2');
        expect(res.headers.get('X-Proxy-Request-Id')).toBeTruthy();

        // Consume stream to verify it has data
        const data = await collectStream(res);
        expect(data.length).toBeGreaterThan(0);
        expect(data).toContain('data: [DONE]');
      });
    }, 10000);
  });
});
