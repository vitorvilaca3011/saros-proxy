/**
 * lifecycle.e2e.test.ts — Full-binary E2E for the daemon lifecycle.
 *
 * Drives the compiled CLI (`dist/index.js start|status|stop|restart`) as real
 * child processes against a local HTTPS mock upstream. Each case gets its own
 * temp HOME and state dir, so one failure cannot cascade and no two cases
 * share a PID file or a daemon.
 *
 * What this pins that unit tests cannot: a detached daemon really survives the
 * `start` parent, the PID file names that process, traffic crosses it, `stop`
 * kills it, and `restart` swaps it for a new one.
 *
 * Not part of the default suite: every case spawns processes.
 * Run: npm run test:lifecycle
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BINARY = join(REPO_ROOT, 'dist', 'index.js');
const TLS_KEY = join(REPO_ROOT, 'test', 'fixtures', 'tls', 'localhost-key.pem');
const TLS_CERT = join(REPO_ROOT, 'test', 'fixtures', 'tls', 'localhost-cert.pem');
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string }
).version;

const KEY_LABEL = 'life-a';
const API_KEY = 'oc_sk_lifecycle_e2e_key_0001';
const MOCK_REPLY = 'hello from the lifecycle mock upstream';

// ---------------------------------------------------------------------------
// Mock upstream (HTTPS, same TLS fixtures as model-e2e.test.ts)
// ---------------------------------------------------------------------------

class MockLifecycleUpstream {
  port = 0;
  private server: HttpsServer | null = null;

  async start(): Promise<void> {
    this.server = createHttpsServer(
      { key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) },
      (req, res) => this.handle(req, res),
    );
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk; });
    req.on('end', () => {
      const url = req.url ?? '';
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (url === '/zen/go/v1/usage' && req.method === 'GET') {
        this.replyUsage(bearer, res);
        return;
      }
      if (url === '/zen/go/v1/chat/completions' && req.method === 'POST') {
        this.replyCompletion(bearer, raw, res);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  }

  private replyUsage(bearer: string, res: ServerResponse): void {
    if (bearer !== API_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid API key.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      usage: {
        rolling: { percent: 10, resetsAt: '2030-01-01T00:00:00Z' },
        weekly: { percent: 10, resetsAt: '2030-01-01T00:00:00Z' },
        monthly: { percent: 10, resetsAt: '2030-01-01T00:00:00Z' },
      },
    }));
  }

  private replyCompletion(bearer: string, raw: string, res: ServerResponse): void {
    if (bearer !== API_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key.' } }));
      return;
    }
    let model = 'mock-model';
    try {
      model = ((JSON.parse(raw) as { model?: string }).model) ?? model;
    } catch {
      // keep the default
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-lifecycle',
      object: 'chat.completion',
      created: 1787428000,
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: MOCK_REPLY },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }));
  }
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface LifecycleCase {
  home: string;
  stateDir: string;
  pidFile: string;
  logPath: string;
  port: number;
  /** Upstream the case config points at; reused when the port is rewritten. */
  upstreamPort: number;
  /** Last PID `start` reported: cleanup fallback when the PID file is gone. */
  lastPid?: number;
  env: NodeJS.ProcessEnv;
}

const activeCases = new Set<LifecycleCase>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll with a deadline; never a fixed sleep for boot or shutdown. */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(100);
  }
  return false;
}

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

function killPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
}

/** Portable liveness probe (EPERM means the PID exists, it is just not ours). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EACCES';
  }
}

async function removeTempDir(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      return;
    } catch {
      await delay(500);
    }
  }
}

function readLog(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '<no log>';
  }
}

function diagnostics(c: LifecycleCase, result?: CliResult): string {
  const sections = [`stateDir: ${c.stateDir}`];
  if (result) {
    sections.push(
      `exit=${result.code} timedOut=${result.timedOut}`,
      `--- stdout ---\n${result.stdout}`,
      `--- stderr ---\n${result.stderr}`,
    );
  }
  sections.push(`--- daemon.log ---\n${readLog(c.logPath)}`);
  return sections.join('\n');
}

/** Run the compiled CLI; never uses a shell, so paths may contain spaces. */
function runCli(
  c: LifecycleCase,
  args: string[],
  timeoutMs = 90_000,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BINARY, ...args], {
      cwd: REPO_ROOT,
      env: c.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function fetchHealth(port: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function pollHealth(
  port: number,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  let health: Record<string, unknown> | null = null;
  const up = await waitFor(async () => {
    health = await fetchHealth(port);
    return health?.status === 'ok';
  }, timeoutMs);
  return up ? health : null;
}

async function pollHealthDown(port: number, timeoutMs: number): Promise<boolean> {
  return waitFor(async () => (await fetchHealth(port)) === null, timeoutMs);
}

// ---------------------------------------------------------------------------
// Case setup and teardown
// ---------------------------------------------------------------------------

function stateDirFor(home: string): string {
  return process.platform === 'win32'
    ? join(home, 'AppData', 'Local', 'saros')
    : join(home, '.config', 'saros');
}

function writeCaseConfig(stateDir: string, port: number, upstreamPort: number): void {
  writeFileSync(join(stateDir, 'config.yaml'), stringifyYaml({
    port,
    host: '127.0.0.1',
    upstreamBaseUrl: `https://127.0.0.1:${upstreamPort}`,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 5_000,
    requestTimeoutMs: 10_000,
    allowedOrigins: ['http://127.0.0.1:*'],
    keys: [{ label: KEY_LABEL, key: API_KEY }],
  }), 'utf-8');
}

/**
 * One isolated installation per case: HOME/USERPROFILE, XDG_CONFIG_HOME and
 * LOCALAPPDATA all point at the temp dir, so config, pid, log and models.json
 * resolve inside it on every platform.
 */
async function createCase(upstreamPort: number): Promise<LifecycleCase> {
  const home = mkdtempSync(join(tmpdir(), 'saros-lifecycle-e2e-'));
  const xdg = join(home, '.config');
  const localAppData = join(home, 'AppData', 'Local');
  const stateDir = stateDirFor(home);
  mkdirSync(stateDir, { recursive: true });

  const port = await getRandomPort();
  writeCaseConfig(stateDir, port, upstreamPort);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    LOCALAPPDATA: localAppData,
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    LOG_LEVEL: 'info',
  };
  // The test runner's own env must not steer the CLI (or the daemon it spawns).
  for (const name of [
    'VITEST', 'NODE_ENV', 'SAROS_DAEMON', 'SAROS_LOG_JSON', 'SAROS_ALLOW_LEGACY_PID',
    'SAROS_PASSPHRASE', 'OPENCODE_GO_ENCRYPTION_KEY',
    'PROXY_PORT', 'PROXY_HOST', 'UPSTREAM_BASE_URL', 'OPENCODE_GO_KEYS',
  ]) {
    delete env[name];
  }

  const lifecycleCase: LifecycleCase = {
    home,
    stateDir,
    pidFile: join(stateDir, 'daemon.pid'),
    logPath: join(stateDir, 'daemon.log'),
    port,
    upstreamPort,
    env,
  };
  activeCases.add(lifecycleCase);
  return lifecycleCase;
}

function readPidFileValue(c: LifecycleCase): number | null {
  try {
    const pid = Number(readFileSync(c.pidFile, 'utf-8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * A `stop` that removes the PID file without killing the process is the
 * regression this suite exists for. Fall back to the last PID `start`
 * reported, but only while something still serves this case's port: a PID
 * recycled by the OS must never be signalled.
 */
async function pidFromLiveFallback(c: LifecycleCase): Promise<number | null> {
  if (c.lastPid === undefined) return null;
  return (await fetchHealth(c.port)) === null ? null : c.lastPid;
}

/**
 * Kill the daemon this case started, even when an assertion failed midway.
 * Returns false when the process survived the kill deadline: the PID file is
 * kept and the case stays registered so `afterAll` can retry.
 */
async function killDaemonFromPidFile(c: LifecycleCase): Promise<boolean> {
  const pid = readPidFileValue(c) ?? await pidFromLiveFallback(c);
  if (pid === null) return true;
  killPid(pid);
  if (!(await waitFor(() => !isProcessAlive(pid), 10_000))) return false;
  try {
    rmSync(c.pidFile, { force: true });
  } catch {
    // best effort: the temp dir goes away anyway
  }
  return true;
}

async function cleanupCase(c: LifecycleCase): Promise<void> {
  if (!(await killDaemonFromPidFile(c))) return;
  activeCases.delete(c);
  await removeTempDir(c.home);
}

// ---------------------------------------------------------------------------
// Start and log helpers
// ---------------------------------------------------------------------------

interface StartedDaemon {
  pid: number;
  port: number;
  health: Record<string, unknown>;
  result: CliResult;
}

/**
 * Start the case's daemon and wait for `/health`. Only for cases that expect a
 * healthy daemon: the squatter case runs `runCli` directly, so the port
 * retry below cannot mask the conflict path.
 */
async function startDaemon(c: LifecycleCase): Promise<StartedDaemon> {
  let result = await runCli(c, ['start']);
  if (
    result.code !== 0 &&
    `${result.stdout}\n${result.stderr}`.includes('Choose a different port')
  ) {
    // getRandomPort released the port before the daemon bound it; retry once.
    const port = await getRandomPort();
    writeCaseConfig(c.stateDir, port, c.upstreamPort);
    c.port = port;
    result = await runCli(c, ['start']);
  }
  expect(result.code, diagnostics(c, result)).toBe(0);
  const match = result.stdout.match(/Proxy started \(PID (\d+)\) on port (\d+)/);
  expect(match, diagnostics(c, result)).not.toBeNull();
  const pid = Number(match![1]);
  const port = Number(match![2]);
  c.lastPid = pid;
  expect(port).toBe(c.port);
  const health = await pollHealth(port, 15_000);
  expect(health, `daemon did not answer /health\n${diagnostics(c, result)}`).not.toBeNull();
  expect(isProcessAlive(pid), `daemon.pid names PID ${pid}, which is not alive\n${diagnostics(c, result)}`)
    .toBe(true);
  return { pid, port, health: health!, result };
}

function parseLogLines(path: string): Array<Record<string, unknown>> {
  return readLog(path)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

async function pollRequestComplete(
  c: LifecycleCase,
  path: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  let entry: Record<string, unknown> | null = null;
  const found = await waitFor(() => {
    entry = parseLogLines(c.logPath)
      .find((line) => line.evt === 'request.complete' && line.path === path) ?? null;
    return entry !== null;
  }, timeoutMs);
  return found ? entry : null;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('daemon lifecycle e2e (real binary)', () => {
  const upstream = new MockLifecycleUpstream();

  beforeAll(async () => {
    if (!existsSync(BINARY)) {
      throw new Error('dist/index.js missing — run via `npm run test:lifecycle`');
    }
    await upstream.start();
  });

  afterAll(async () => {
    for (const c of activeCases) {
      await cleanupCase(c);
    }
    await upstream.stop();
    if (activeCases.size > 0) {
      const dirs = [...activeCases].map((c) => c.stateDir).join(', ');
      throw new Error(`daemon cleanup failed for ${activeCases.size} case(s): ${dirs}`);
    }
  });

  it('start spawns a detached daemon and writes its PID', async () => {
    const c = await createCase(upstream.port);
    try {
      const started = await startDaemon(c);
      expect(readFileSync(c.pidFile, 'utf-8').trim()).toBe(String(started.pid));
      expect(started.health.status).toBe('ok');
      expect(started.health.version).toBe(PACKAGE_VERSION);
      expect(started.health.keyCount).toBe(1);
    } finally {
      await cleanupCase(c);
    }
  });

  it('status reports the live instance, its port and its key', async () => {
    const c = await createCase(upstream.port);
    try {
      const started = await startDaemon(c);
      const status = await runCli(c, ['status']);
      expect(status.code, diagnostics(c, status)).toBe(0);
      expect(status.stdout).toContain(`PID ${started.pid}`);
      expect(status.stdout).toContain(`port ${started.port}`);
      expect(status.stdout).toContain('1/1 enabled');
      expect(status.stdout).toContain(KEY_LABEL);
    } finally {
      await cleanupCase(c);
    }
  });

  it('carries real traffic and logs boot plus the completed request', async () => {
    const c = await createCase(upstream.port);
    try {
      const started = await startDaemon(c);
      const res = await fetch(`http://127.0.0.1:${started.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'ox-alpha-free',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-proxy-key-label')).toBe(KEY_LABEL);
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      expect(body.choices?.[0]?.message?.content).toBe(MOCK_REPLY);

      // The access log records the canonical route path (`/zen/go/v1/...`),
      // not the client's `/v1/...`; it is not remapped to the provider's
      // upstream prefix.
      const entry = await pollRequestComplete(c, '/zen/go/v1/chat/completions', 10_000);
      expect(entry, diagnostics(c)).not.toBeNull();
      expect(entry!.status).toBe(200);
      expect(entry!.keyLabel).toBe(KEY_LABEL);
      expect(parseLogLines(c.logPath).some((line) => line.evt === 'boot')).toBe(true);
    } finally {
      await cleanupCase(c);
    }
  });

  it('stop kills the daemon, removes the PID file and frees the port', async () => {
    const c = await createCase(upstream.port);
    try {
      const started = await startDaemon(c);
      const stop = await runCli(c, ['stop']);
      expect(stop.code, diagnostics(c, stop)).toBe(0);
      expect(stop.stdout).toContain(`PID ${started.pid}`);
      expect(stop.stdout).toMatch(/stopped/i);

      expect(await waitFor(() => !existsSync(c.pidFile), 10_000)).toBe(true);
      expect(await pollHealthDown(started.port, 10_000)).toBe(true);
      expect(await waitFor(() => !isProcessAlive(started.pid), 10_000)).toBe(true);
    } finally {
      await cleanupCase(c);
    }
  });

  it('stop without a daemon exits 0 and does not create a PID file', async () => {
    const c = await createCase(upstream.port);
    try {
      const stop = await runCli(c, ['stop']);
      expect(stop.code, diagnostics(c, stop)).toBe(0);
      expect(stop.stdout).toContain('No running proxy daemon found');
      expect(existsSync(c.pidFile)).toBe(false);
    } finally {
      await cleanupCase(c);
    }
  });

  it('start fails and names the port when a strange listener owns it', async () => {
    const c = await createCase(upstream.port);
    const squatter = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'not-saros' }));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        squatter.once('error', reject);
        squatter.listen(c.port, '127.0.0.1', () => resolve());
      });
      const start = await runCli(c, ['start']);
      const output = `${start.stdout}\n${start.stderr}`;
      expect(start.code, diagnostics(c, start)).not.toBe(0);
      expect(output).toContain('Choose a different port');
      expect(output).not.toContain('appears to be running');
      expect(existsSync(c.pidFile)).toBe(false);
    } finally {
      await closeServer(squatter);
      await cleanupCase(c);
    }
  });

  it('restart replaces the daemon with a new PID and serves again', async () => {
    const c = await createCase(upstream.port);
    try {
      const started = await startDaemon(c);
      const restart = await runCli(c, ['restart'], 120_000);
      expect(restart.code, diagnostics(c, restart)).toBe(0);
      expect(restart.stdout).toContain(`PID ${started.pid}`);

      const match = restart.stdout.match(/Proxy started \(PID (\d+)\) on port (\d+)/);
      expect(match, diagnostics(c, restart)).not.toBeNull();
      const newPid = Number(match![1]);
      const newPort = Number(match![2]);
      expect(newPid).not.toBe(started.pid);
      expect(newPort).toBe(c.port);
      expect(readFileSync(c.pidFile, 'utf-8').trim()).toBe(String(newPid));

      const health = await pollHealth(c.port, 15_000);
      expect(health, diagnostics(c, restart)).not.toBeNull();
      expect(await waitFor(() => !isProcessAlive(started.pid), 10_000)).toBe(true);
    } finally {
      await cleanupCase(c);
    }
  });
});

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
