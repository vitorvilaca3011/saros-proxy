/**
 * npm-package.test.ts — Smoke tests for the published saros-proxy npm package.
 *
 * Validates:
 *   1. Package metadata on the npm registry
 *   2. CLI binary works (`--version`, `--help`)
 *   3. Proxy can start via the npm-published binary
 *
 * These tests hit the npm registry, so they are gated behind RUN_NPM_SMOKE=1
 * to avoid breaking offline CI.
 *
 * Run: RUN_NPM_SMOKE=1 npx vitest run test/npm-package.test.ts
 *      (On Windows PowerShell: $env:RUN_NPM_SMOKE="1"; npx vitest run test/npm-package.test.ts)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exec, execSync, spawn } from 'node:child_process';
import { writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Skip logic — all tests in this file hit the npm registry
// ---------------------------------------------------------------------------

const SKIP_NPM_SMOKE = process.env.RUN_NPM_SMOKE !== '1';
const PACKAGE_VERSION = process.env.SAROS_PROXY_VERSION ?? '0.1.0';

const execAsync = promisify(exec);

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

async function removeTempDir(dir: string): Promise<void> {
  if (!existsSync(dir)) return;

  const maxRetries = 5;
  const retryDelay = 500;

  for (let i = 0; i < maxRetries; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay });
      return;
    } catch {
      if (i === maxRetries - 1) {
        console.warn(`Failed to remove temp dir ${dir}`);
        return;
      }
      await new Promise((r) => setTimeout(r, retryDelay));
    }
  }
}

function suppressConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

function restoreConsole(): void {
  vi.restoreAllMocks();
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    execSync(`taskkill /T /F /PID ${child.pid}`, {
      stdio: 'ignore',
      windowsHide: true,
    });
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

// ---------------------------------------------------------------------------
// Tests — all gated by SKIP_NPM_SMOKE
// ---------------------------------------------------------------------------

if (SKIP_NPM_SMOKE) {
  describe('npm-package (skipped)', () => {
    it.skip('set RUN_NPM_SMOKE=1 to enable npm smoke tests', () => {
      // This test provides a visible skip reason in the vitest output
    });
  });
}

// Test Group 1: Package Metadata (lightweight, no install)
describe.skipIf(SKIP_NPM_SMOKE)('NPM Package Metadata', () => {
  it.skipIf(SKIP_NPM_SMOKE)(
    'is published with name "saros-proxy"',
    () => {
      const result = execSync('npm view saros-proxy name', {
        encoding: 'utf-8',
      });
      expect(result.trim()).toBe('saros-proxy');
    },
    30_000,
  );

  it.skipIf(SKIP_NPM_SMOKE)(
    'exposes the saros-proxy and saros-proxy-setup bin entries',
    () => {
      const result = execSync('npm view saros-proxy bin --json', {
        encoding: 'utf-8',
      });
      const bin = JSON.parse(result) as Record<string, string>;
      expect(bin).toHaveProperty('saros-proxy');
      expect(bin).toHaveProperty('saros-proxy-setup');
      expect(bin['saros-proxy']).toBe('dist/index.js');
      expect(bin['saros-proxy-setup']).toBe('dist/cli/setup.js');
    },
    30_000,
  );

  it.skipIf(SKIP_NPM_SMOKE)(
    'requires Node >= 22',
    () => {
      const result = execSync('npm view saros-proxy engines --json', {
        encoding: 'utf-8',
      });
      const engines = JSON.parse(result) as { node?: string };
      expect(engines.node).toBe('>=22.0.0');
    },
    30_000,
  );
});

// Test Group 2: CLI Binary (via npx)
describe.skipIf(SKIP_NPM_SMOKE)('CLI Binary (via npx)', () => {
  it.skipIf(SKIP_NPM_SMOKE)(
    'responds to --version with a semver string',
    async () => {
      const { stdout } = await execAsync(
        `npx --yes saros-proxy@${PACKAGE_VERSION} --version`,
      );
      expect(stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
    },
    120_000,
  );

  it.skipIf(SKIP_NPM_SMOKE)(
    'responds to --help with usage information',
    async () => {
      const { stdout, stderr } = await execAsync(
        `npx --yes saros-proxy@${PACKAGE_VERSION} --help`,
      );
      const output = stdout + stderr;
      expect(output.toLowerCase()).toMatch(/port/);
    },
    120_000,
  );
});

// Test Group 3: Proxy Startup (heavy)
describe.skipIf(SKIP_NPM_SMOKE)('Proxy Startup via npm binary', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(`${tmpdir()}${sep}npm-smoke-test-`);
    suppressConsole();
  });

  afterEach(async () => {
    restoreConsole();
    await removeTempDir(tempDir);
  });

  it.skipIf(SKIP_NPM_SMOKE)(
    'starts and responds to /health',
    async () => {
      const port = await getRandomPort();
      const configPath = join(tempDir, 'config.yaml');

      // Write a minimal valid config
      const cfg = {
        port,
        host: '127.0.0.1',
        upstreamBaseUrl: 'https://opencode.ai',
        circuitBreakerThreshold: 3,
        circuitBreakerCooldownMs: 60_000,
        requestTimeoutMs: 30_000,
        allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],
        keys: [
          { label: 'npm-smoke', key: 'sk-npm-smoke-test-key-1234567890' },
        ],
      };
      writeFileSync(configPath, stringifyYaml(cfg), 'utf-8');

      // Spawn the npm-published binary via npx
      const child = spawn(
        `npx --yes saros-proxy@${PACKAGE_VERSION} --port ${port} --config "${configPath}"`,
        [],
        {
          cwd: tempDir,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, LOG_LEVEL: 'silent', NODE_ENV: 'production' },
          detached: false,
        },
      );

      let stderrBuf = '';
      child.stderr?.on('data', (c: Buffer) => {
        stderrBuf += c.toString();
      });

      // Poll /health until the proxy responds or we time out
      const result = await pollHealth(port, 60_000);

      // Cleanup
      killProcessTree(child);
      await new Promise((resolve) => {
        child.once('exit', () => resolve(undefined));
        setTimeout(resolve, 2000); // fallback
      });

      expect(result).toBe(true);
      if (stderrBuf) console.warn('Proxy stderr:', stderrBuf);
    },
    180_000,
  );
});
