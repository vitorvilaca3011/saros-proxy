/**
 * model-e2e.test.ts — Full-binary E2E with models running.
 *
 * Unlike e2e.test.ts (in-process createProxyApp), this suite spawns the real
 * compiled binary (`dist/index.js serve`) against a local HTTPS mock that
 * behaves like a real model API:
 *
 *   - Bearer-key auth with per-key failure injection
 *   - OpenAI-shaped completions incl. reasoning_content (thinking models)
 *   - SSE streaming deltas ending in [DONE]
 *   - Per-key quota usage endpoint feeding weighted rotation
 *
 * Verified end-to-end through the proxy's HTTP surface:
 *   health, completion round-trip, streaming, failover + circuit breaker,
 *   usage-weighted key rotation.
 *
 * Not part of the default unit suite (spawns processes, several seconds).
 * Run: npm run test:model-e2e
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TLS_KEY = join(REPO_ROOT, 'test', 'fixtures', 'tls', 'localhost-key.pem');
const TLS_CERT = join(REPO_ROOT, 'test', 'fixtures', 'tls', 'localhost-cert.pem');

const KEY_A = 'sk-model-e2e-key-aaaaaaaaaaaaaa';
const KEY_B = 'sk-model-e2e-key-bbbbbbbbbbbbbb';

interface MockRequest {
  bearer: string;
  path: string;
  method: string;
  body: Record<string, unknown>;
}

class MockModelUpstream {
  /** bearer -> remaining forced failures; each request with that key 500s */
  readonly failKeys = new Map<string, number>();
  /** bearer -> used percent reported by /usage */
  readonly usagePercent = new Map<string, number>([[KEY_A, 10], [KEY_B, 10]]);
  readonly requests: MockRequest[] = [];
  /** bearers that fetched /usage — lets tests await the lazy refresh */
  readonly usageRequests: string[] = [];
  private server: ReturnType<typeof createHttpsServer> | null = null;
  port = 0;

  async start(): Promise<void> {
    this.server = createHttpsServer(
      { key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) },
      (req, res) => this.handle(req, res),
    );
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        this.port = (this.server!.address() as { port: number }).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    srv.closeAllConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  reset(): void {
    this.failKeys.clear();
    this.usagePercent.set(KEY_A, 10);
    this.usagePercent.set(KEY_B, 10);
    this.requests.length = 0;
    this.usageRequests.length = 0;
  }

  private label(bearer: string): string | null {
    if (bearer === KEY_A) return 'key-a';
    if (bearer === KEY_B) return 'key-b';
    return null;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c; });
    req.on('end', () => {
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const url = req.url ?? '';
      const method = req.method ?? '';
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* not json */ }

      // --- Usage endpoint (feeds weighted rotation) ---
      if (url === '/zen/go/v1/usage' && method === 'GET') {
        if (this.label(bearer)) this.usageRequests.push(bearer);
        const pct = this.usagePercent.get(bearer);
        if (pct === undefined || !this.label(bearer)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid API key.' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          usage: {
            rolling: { percent: pct, resetsAt: '2026-08-22T23:00:00Z' },
            weekly: { percent: pct, resetsAt: '2026-08-29T00:00:00Z' },
            monthly: { percent: pct, resetsAt: '2026-09-01T00:00:00Z' },
          },
        }));
        return;
      }

      // --- Chat completions ---
      if (url === '/zen/go/v1/chat/completions' && method === 'POST') {
        if (!this.label(bearer)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'AuthError', message: 'Invalid API key.' },
          }));
          return;
        }
        this.requests.push({ bearer, path: url, method, body });

        const remaining = this.failKeys.get(bearer) ?? 0;
        if (remaining > 0) {
          this.failKeys.set(bearer, remaining - 1);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'simulated upstream 500' } }));
          return;
        }

        const model = (body.model as string) ?? 'mock-model';
        if (body.stream === true) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', reasoning_content: 'thinking...' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ' from mock-model' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-model-e2e',
          object: 'chat.completion',
          created: 1787428000,
          model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello from mock-model',
              reasoning_content: 'The user greeted me; reply briefly.',
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
        }));
        return;
      }

      if (url === '/zen/go/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'ox-alpha-free', object: 'model', owned_by: 'mock' }],
        }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  }
}

// ---------------------------------------------------------------------------
// Proxy process helpers
// ---------------------------------------------------------------------------

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: 'ignore', windowsHide: true });
    } catch {
      // already gone
    }
  } else {
    child.kill('SIGKILL');
  }
}

async function pollHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const data = (await res.json()) as { status?: string };
        if (data.status === 'ok') return true;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function removeTempDir(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

interface ProxyHandle {
  child: ChildProcess;
  port: number;
  workDir: string;
  logPath: string;
}

/** Spawn a fresh real binary against the mock upstream on its own port. */
async function spawnProxy(upstreamPort: number): Promise<ProxyHandle> {
  const workDir = mkdtempSync(join(tmpdir(), 'saros-model-e2e-'));
  mkdirSync(join(workDir, 'home', '.config'), { recursive: true });
  mkdirSync(join(workDir, 'home', 'AppData', 'Local'), { recursive: true });
  const logPath = join(workDir, 'proxy.log');

  const port = await getRandomPort();
  const cfgPath = join(workDir, 'config.yaml');
  writeFileSync(cfgPath, stringifyYaml({
    port,
    host: '127.0.0.1',
    upstreamBaseUrl: `https://127.0.0.1:${upstreamPort}`,
    circuitBreakerThreshold: 2,
    circuitBreakerCooldownMs: 3_000,
    requestTimeoutMs: 5_000,
    allowedOrigins: ['http://localhost:*'],
    keys: [
      { label: 'key-a', key: KEY_A },
      { label: 'key-b', key: KEY_B },
    ],
  }), 'utf-8');

  const out = openSync(logPath, 'a');
  const child = spawn(process.execPath, [
    join(REPO_ROOT, 'dist', 'index.js'), 'serve', '--config', cfgPath,
  ], {
    cwd: REPO_ROOT,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(workDir, 'home', '.config'),
      LOCALAPPDATA: join(workDir, 'home', 'AppData', 'Local'),
      HOME: join(workDir, 'home'),
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
    windowsHide: true,
  });
  child.once('spawn', () => { try { closeSync(out); } catch { /* closed */ } });

  if (!(await pollHealth(port, 15_000))) {
    killProcessTree(child);
    await removeTempDir(workDir);
    throw new Error(`proxy not healthy; log:\n${readFileSync(logPath, 'utf-8')}`);
  }
  return { child, port, workDir, logPath };
}

function stopProxy(handle: ProxyHandle | undefined): Promise<void> {
  if (!handle) return Promise.resolve();
  killProcessTree(handle.child);
  return removeTempDir(handle.workDir);
}

describe('model e2e (real binary, models running)', () => {
  let mainProxy: ProxyHandle;
  let port: number;
  let logPath: string;
  const upstream = new MockModelUpstream();

  beforeAll(async () => {
    if (!existsSync(join(REPO_ROOT, 'dist', 'index.js'))) {
      throw new Error('dist/index.js missing — run via `npm run test:model-e2e`');
    }
    await upstream.start();
    mainProxy = await spawnProxy(upstream.port);
    port = mainProxy.port;
    logPath = mainProxy.logPath;
  }, 60_000);

  afterAll(async () => {
    await stopProxy(mainProxy);
    await upstream.stop();
  });

  function proxyLog(): string {
    try { return readFileSync(logPath, 'utf-8'); } catch { return '<no log>'; }
  }

  async function complete(body: Record<string, unknown>): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'ox-alpha-free',
        messages: [{ role: 'user', content: 'hi' }],
        ...body,
      }),
    });
  }

  it('health reports both model keys enabled', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      status?: string; keyCount?: number; enabledCount?: number; disabledCount?: number;
    };
    expect(data.status).toBe('ok');
    expect(data.keyCount).toBe(2);
    expect(data.enabledCount).toBe(2);
    expect(data.disabledCount).toBe(0);
  });

  it('completion round-trips content and thinking through the binary', async () => {
    const res = await complete({});
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
    };
    expect(data.model).toBe('ox-alpha-free');
    expect(data.choices?.[0]?.message?.content).toBe('Hello from mock-model');
    expect(data.choices?.[0]?.message?.reasoning_content).toBe('The user greeted me; reply briefly.');
    expect(data.choices?.[0]?.finish_reason).toBe('stop');

    expect(upstream.requests.length).toBeGreaterThan(0);
    expect(upstream.requests[upstream.requests.length - 1].body.model).toBe('ox-alpha-free');
  }, 30_000);

  it('streaming completion concatenates deltas and ends with [DONE]', async () => {
    const res = await complete({ stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    expect(text).toContain('[DONE]');
    const contents = [...text.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join('');
    expect(contents).toBe('Hello from mock-model');
  }, 30_000);

  it('fails over to the healthy key when one key errors', async () => {
    upstream.reset();
    upstream.failKeys.set(KEY_A, 1); // next request carrying key-a gets a 500

    const res = await complete({});
    if (res.status !== 200) {
      throw new Error(`status ${res.status}; proxy log:\n${proxyLog()}`);
    }
    expect(res.headers.get('x-proxy-key-label')).toBe('key-b');

    // Both keys were attempted inside the single client request: first key-a
    // (500), then key-b (success).
    const attempted = upstream.requests.slice(-2).map((r) => r.bearer);
    expect(attempted).toEqual([KEY_A, KEY_B]);
  }, 30_000);

  it('circuit breaker stops retrying an unhealthy key during cooldown', async () => {
    upstream.reset();
    upstream.failKeys.set(KEY_A, 4); // enough consecutive failures to trip

    // Two client requests: each fails over to key-b, recording 2 failures for
    // key-a (threshold: 2) -> breaker opens for key-a.
    for (let i = 0; i < 2; i++) {
      const res = await complete({});
      if (res.status !== 200) {
        throw new Error(`status ${res.status}; proxy log:\n${proxyLog()}`);
      }
      expect(res.headers.get('x-proxy-key-label')).toBe('key-b');
    }

    // While key-a cools down, new requests must go straight to key-b without
    // touching key-a again.
    upstream.requests.length = 0;
    const res = await complete({});
    if (res.status !== 200) {
      throw new Error(`status ${res.status}; proxy log:\n${proxyLog()}`);
    }
    expect(res.headers.get('x-proxy-key-label')).toBe('key-b');
    expect(upstream.requests.map((r) => r.bearer)).toEqual([KEY_B]);
  }, 30_000);

  it('rotates traffic toward the key with more remaining quota', async () => {
    // Fresh instance: clean circuit-breaker state (a previous test opens
    // key-a for 3s) and a fresh 60s usage TTL so the warm-up below really
    // triggers a /usage refresh.
    upstream.reset();
    // Weights after refresh: key-a 20 (80% used), key-b 40 (60% used) -> a
    // deterministic 1:2 distribution over sequential requests (key-b has more
    // remaining quota). Equal-weight round-robin would yield 6/6; a disabled
    // key-a would yield 12/0 — both fail the bounds below.
    upstream.usagePercent.set(KEY_A, 80);
    upstream.usagePercent.set(KEY_B, 60);

    const rotationProxy = await spawnProxy(upstream.port);
    try {
      const p = rotationProxy.port;
      const completeOn = (body: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'ox-alpha-free',
            messages: [{ role: 'user', content: 'hi' }],
            ...body,
          }),
        });

      // Warm-up fires the lazy /usage refresh; wait until BOTH keys' usage
      // was actually fetched instead of sleeping a fixed amount.
      await completeOn({ messages: [{ role: 'user', content: 'warmup' }] });
      const refreshDeadline = Date.now() + 5_000;
      while (Date.now() < refreshDeadline) {
        const seen = new Set(upstream.usageRequests);
        if (seen.has(KEY_A) && seen.has(KEY_B)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(new Set(upstream.usageRequests)).toEqual(new Set([KEY_A, KEY_B]));
      upstream.requests.length = 0;

      const N = 12;
      const counts = new Map<string, number>();
      for (let i = 0; i < N; i++) {
        const res = await completeOn({});
        expect(res.status).toBe(200);
        const label = res.headers.get('x-proxy-key-label') ?? '?';
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }

      const toB = counts.get('key-b') ?? 0;
      const toA = counts.get('key-a') ?? 0;
      expect(toA + toB).toBe(N);
      // key-b has more remaining quota (40 vs 20) -> ~8 B and ~4 A. Both
      // bounds together prove weighted selection: plain RR gives 6/6, a dead
      // key-a gives 12 B / 0 A.
      expect(toB).toBeGreaterThanOrEqual(7);
      expect(toA).toBeGreaterThanOrEqual(3);
      if (process.env.SAROS_DEBUG_ROTATION) {
        console.log('rotation distribution:', Object.fromEntries(counts));
      }
    } finally {
      await stopProxy(rotationProxy);
    }
  }, 90_000);
});
