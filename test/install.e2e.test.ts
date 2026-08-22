/**
 * install.e2e.test.ts — Full installation smoke test.
 *
 * Simulates exactly what a user does:
 *   1. `npm pack` the repository into a tarball
 *   2. `npm install <tarball>` into an isolated prefix
 *   3. Run the installed CLI (`--version`, `--help`)
 *   4. Start the installed proxy against a local mock upstream and push a
 *      real chat completion through it
 *
 * Fully offline (no npm registry access), hermetic (isolated XDG_CONFIG_HOME),
 * cross-platform (no shell shims — everything spawns through node directly).
 *   Run: npm run test:install
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawn, execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  openSync,
} from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify as stringifyYaml } from 'yaml';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Run npm cross-platform. On Windows npm ships only as npm.cmd, which Node
 * refuses to spawn without a shell (CVE-2024-27980 mitigation); shell mode
 * concatenates args unquoted, so path arguments get quoted explicitly.
 */
async function npmAsync(args: string[], cwd: string): Promise<{ stdout: string }> {
  const win = process.platform === 'win32';
  const cmd = win ? 'npm.cmd' : 'npm';
  const finalArgs = win ? args.map((a) => (/[/\\]/.test(a) ? `"${a}"` : a)) : args;
  return execFileAsync(cmd, finalArgs, { cwd, shell: win, windowsHide: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // child.kill() on Windows only kills cmd.exe, not the node grandchild.
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
    await new Promise((r) => setTimeout(r, 300));
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
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_REPLY = 'install smoke ok';

/**
 * Minimal OpenAI-compatible upstream serving one canned completion.
 *
 * HTTPS with the committed self-signed localhost cert: config validation
 * rejects plain-HTTP upstreams by design (keys must never leave loopback in
 * clear text), so the full-binary test must speak TLS. The spawned proxy
 * runs with NODE_TLS_REJECT_UNAUTHORIZED=0 to trust this fixture.
 */
function startMockUpstream(): Promise<{ server: ReturnType<typeof createHttpsServer>; port: number }> {
  const tlsOptions = {
    key: readFileSync(join(REPO_ROOT, 'test', 'fixtures', 'tls', 'localhost-key.pem')),
    cert: readFileSync(join(REPO_ROOT, 'test', 'fixtures', 'tls', 'localhost-cert.pem')),
  };
  const server = createHttpsServer(tlsOptions, (req: IncomingMessage, res) => {
    const url = req.url ?? '';
    // Startup probe hits /models; 404s here would open the circuit breaker
    // before any client request arrives.
    if (url === '/zen/go/v1/models' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'ox-alpha-free', object: 'model', owned_by: 'mock' }],
      }));
      return;
    }
    if (url === '/zen/go/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c; });
      req.on('end', () => {
        let model = 'unknown';
        try { model = (JSON.parse(body) as { model?: string }).model ?? 'unknown'; } catch { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-install-smoke',
          object: 'chat.completion',
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: MOCK_REPLY },
            finish_reason: 'stop',
          }],
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end('{"error":"not found"}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('install e2e (npm pack -> install -> run)', () => {
  let workDir: string;
  let prefixDir: string;
  let homeDir: string;
  let installedIndexJs: string;

  beforeAll(async () => {
    const distEntry = join(REPO_ROOT, 'dist', 'index.js');
    if (!existsSync(distEntry)) {
      throw new Error(
        'dist/index.js missing — build first (npm run build) or run via `npm run test:install`',
      );
    }

    workDir = mkdtempSync(join(tmpdir(), 'saros-install-'));
    prefixDir = join(workDir, 'prefix');
    homeDir = join(workDir, 'home');
    // Isolated XDG home: the CLI must never touch the developer's real config.
    mkdirHome(homeDir);

    const { stdout } = await npmAsync(['pack', '--pack-destination', workDir], REPO_ROOT);
    // npm prints the tarball name relative to cwd, but the file lives in
    // --pack-destination: resolve to an absolute path before installing.
    const tarballName = stdout.trim().split('\n').pop() as string;
    const tarball = join(workDir, tarballName.replace(/^.*[/\\]/, ''));
    await npmAsync(
      ['install', tarball, '--prefix', prefixDir, '--no-audit', '--no-fund'],
      REPO_ROOT,
    );
    installedIndexJs = join(prefixDir, 'node_modules', 'saros-proxy', 'dist', 'index.js');
  }, 180_000);

  afterAll(async () => {
    await removeTempDir(workDir);
  });

  it('installs the package payload (dist entrypoint + bin shim)', () => {
    expect(existsSync(installedIndexJs)).toBe(true);
    const pkg = JSON.parse(
      readFileSync(join(prefixDir, 'node_modules', 'saros-proxy', 'package.json'), 'utf-8'),
    ) as { bin: Record<string, string> };
    expect(pkg.bin['saros-proxy']).toBeTruthy();

    const binName = process.platform === 'win32' ? 'saros-proxy.cmd' : 'saros-proxy';
    expect(existsSync(join(prefixDir, 'node_modules', '.bin', binName))).toBe(true);
  });

  it('--version matches package.json', async () => {
    const pkgVersion = (JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'),
    ) as { version: string }).version;
    const { stdout } = await execFileAsync(process.execPath, [installedIndexJs, '--version']);
    expect(stdout.trim()).toBe(pkgVersion);
  });

  it('--help lists the main commands', async () => {
    const { stdout } = await execFileAsync(process.execPath, [installedIndexJs, '--help']);
    for (const cmd of ['serve', 'start', 'stop', 'status', 'probe', 'usage']) {
      expect(stdout).toContain(cmd);
    }
  });

  it('installed binary serves real traffic end-to-end', async () => {
    const upstream = await startMockUpstream();
    let child: ChildProcess | undefined;
    try {
      const port = await getRandomPort();
      const cfgPath = join(workDir, 'config.yaml');
      writeFileSync(cfgPath, stringifyYaml({
        port,
        host: '127.0.0.1',
        upstreamBaseUrl: `https://127.0.0.1:${upstream.port}`,
        circuitBreakerThreshold: 3,
        circuitBreakerCooldownMs: 1_000,
        requestTimeoutMs: 5000,
        allowedOrigins: ['http://localhost:*'],
        keys: [{ label: 'install-key', key: 'sk-install-smoke-1234567890abcdef' }],
      }), 'utf-8');

      const logPath = join(workDir, 'proxy.log');
      child = spawnDetached(process.execPath, [
        installedIndexJs, 'serve', '--config', cfgPath,
      ], homeDir, logPath);

      const healthy = await pollHealth(port, 15_000);
      if (!healthy) {
        throw new Error(`proxy did not become healthy; log:\n${readFileSync(logPath, 'utf-8')}`);
      }

      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'ox-alpha-free',
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (res.status !== 200) {
        throw new Error(
          `status ${res.status}; proxy log:\n${readFileSync(logPath, 'utf-8')}`,
        );
      }
      expect(res.headers.get('x-proxy-key-label')).toBe('install-key');
      const data = (await res.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
      };
      expect(data.model).toBe('ox-alpha-free');
      expect(data.choices?.[0]?.message?.content).toBe(MOCK_REPLY);
    } finally {
      if (child) killProcessTree(child);
      // Drop keep-alive sockets first so close() can't hang on idle undici
      // connections (masks assertion failures as timeouts otherwise).
      upstream.server.closeAllConnections();
      await new Promise<void>((r) => {
        if (!upstream.server) { r(); return; }
        upstream.server.close(() => r());
      });
    }
  }, 60_000);
});

// --- small utils kept at the bottom to keep fixtures readable ---------------

function mkdirHome(home: string): void {
  mkdirSync(join(home, '.config'), { recursive: true });
}

function spawnDetached(
  command: string,
  args: string[],
  home: string,
  logPath: string,
): ChildProcess {
  // Isolated XDG_CONFIG_HOME keeps the daemon out of the real user config.
  // Append-mode fd: lets tests dump the daemon log when assertions fail.
  const out = openSync(logPath, 'a');
  return spawn(command, args, {
    cwd: REPO_ROOT,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(home, '.config'),
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
    windowsHide: true,
  });
}
