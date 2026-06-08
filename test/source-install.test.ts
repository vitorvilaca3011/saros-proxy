/**
 * source-install.test.ts — Smoke test for the "from source" install path.
 *
 * Validates the documented install flow:
 *   1. Copy project to a temp directory (simulates `git clone`)
 *   2. Run `npm ci` (simulates `npm install`)
 *   3. Run `npm run build` (compiles TypeScript to dist/)
 *   4. Start the proxy with `node dist/index.js` (the actual built artifact)
 *   5. Verify /health responds
 *
 * Gated behind RUN_SOURCE_SMOKE=1 because it does a real `npm ci` (slow).
 *
 * Run: RUN_SOURCE_SMOKE=1 npx vitest run test/source-install.test.ts
 *      (On Windows PowerShell: $env:RUN_SOURCE_SMOKE="1"; npx vitest run test/source-install.test.ts)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Skip logic — opt-in via environment variable
// ---------------------------------------------------------------------------

const SKIP_SOURCE_SMOKE = process.env.RUN_SOURCE_SMOKE !== '1';
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function copyProjectToTemp(dest: string): Promise<void> {
  await cp(process.cwd(), dest, {
    recursive: true,
    filter: (src) => {
      const name = basename(src);
      if (name === 'node_modules') return false;
      if (name === 'dist') return false;
      if (name === '.git') return false;
      if (name === 'coverage') return false;
      return true;
    },
  });
}

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 300_000,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, npm_config_progress: 'false' },
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

function startProxyFromDist(
  port: number,
  configPath: string,
  cwd: string,
): ChildProcess {
  const entryPoint = join(cwd, 'dist', 'index.js');
  return spawn(
    `node "${entryPoint}" --port ${port} --config "${configPath}"`,
    [],
    {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LOG_LEVEL: 'silent', NODE_ENV: 'production' },
      detached: false,
    },
  );
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    execFile(
      'taskkill',
      ['/T', '/F', '/PID', String(child.pid)],
      { windowsHide: true },
      () => {},
    );
  } else {
    child.kill('SIGKILL');
  }
}

async function pollHealth(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const data = (await res.json()) as { status?: string };
        if (data.status === 'ok') return true;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

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

async function removeTempDir(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  const maxRetries = 5;
  const retryDelay = 500;
  for (let i = 0; i < maxRetries; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay });
      return;
    } catch {
      if (i === maxRetries - 1) return;
      await new Promise((r) => setTimeout(r, retryDelay));
    }
  }
}

// ---------------------------------------------------------------------------
// Tests — all gated by SKIP_SOURCE_SMOKE
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_SOURCE_SMOKE)('Source Install Smoke Test', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tempDir && existsSync(tempDir)) {
      await removeTempDir(tempDir);
    }
  });

  it(
    'clones project, builds, and runs the compiled proxy',
    async () => {
      tempDir = mkdtempSync(`${tmpdir()}${sep}source-smoke-`);
      const port = await getRandomPort();
      const configPath = join(tempDir, 'config.yaml');

      // 1. Write a valid config.yaml
      const cfg = {
        port,
        host: '127.0.0.1',
        upstreamBaseUrl: 'https://opencode.ai',
        circuitBreakerThreshold: 3,
        circuitBreakerCooldownMs: 60_000,
        requestTimeoutMs: 30_000,
        allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],
        keys: [
          { label: 'source-smoke', key: 'sk-source-smoke-key-1234567890' },
        ],
      };
      writeFileSync(configPath, stringifyYaml(cfg), 'utf-8');

      // 2. Copy project to temp (simulates git clone)
      await copyProjectToTemp(tempDir);

      // 3. npm ci — install dependencies
      const ciResult = await run('npm', ['ci', '--no-audit', '--no-fund'], tempDir, 300_000);
      expect(ciResult.stderr).not.toMatch(/npm ERR!/);

      // 4. npm run build — compile TypeScript
      const buildResult = await run('npm', ['run', 'build'], tempDir, 120_000);
      expect(buildResult.stderr).not.toMatch(/error TS/);

      // 5. Verify dist/ output exists
      const distIndex = join(tempDir, 'dist', 'index.js');
      expect(existsSync(distIndex)).toBe(true);

      // 6. Start proxy from compiled output
      const child = startProxyFromDist(port, configPath, tempDir);

      // 7. Verify /health responds
      const ok = await pollHealth(port, 60_000);
      killProcessTree(child);
      await new Promise((r) => {
        child.once('exit', () => r(undefined));
        setTimeout(r, 2000);
      });

      expect(ok).toBe(true);
    },
    600_000, // 10 min total
  );

  it(
    'produces a working dist/cli/setup.js (setup wizard compiles)',
    async () => {
      tempDir = mkdtempSync(`${tmpdir()}${sep}source-smoke-setup-`);

      await copyProjectToTemp(tempDir);
      await run('npm', ['ci', '--no-audit', '--no-fund'], tempDir, 300_000);
      await run('npm', ['run', 'build'], tempDir, 120_000);

      const setupEntry = join(tempDir, 'dist', 'cli', 'setup.js');
      expect(existsSync(setupEntry)).toBe(true);
    },
    600_000,
  );
});
