/**
 * docker-install.test.ts — Smoke test for the Docker install path.
 *
 * Validates the documented Docker flow:
 *   1. Build the Docker image (`docker build`)
 *   2. Run a container with a random port mapping and a temp config mount
 *   3. Verify /health responds from inside the container
 *   4. Cleanup: stop + remove container, remove image
 *
 * Gated behind RUN_DOCKER_SMOKE=1 because it requires Docker and is slow.
 *
 * Run: RUN_DOCKER_SMOKE=1 npx vitest run test/docker-install.test.ts
 *      (On Windows PowerShell: $env:RUN_DOCKER_SMOKE="1"; npx vitest run test/docker-install.test.ts)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Skip logic — opt-in via environment variable
// ---------------------------------------------------------------------------

const SKIP_DOCKER_SMOKE = process.env.RUN_DOCKER_SMOKE !== '1';
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function docker(
  args: string[],
  timeoutMs = 300_000,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('docker', args, {
    timeout: timeoutMs,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
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
// Tests — all gated by SKIP_DOCKER_SMOKE
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_DOCKER_SMOKE)('Docker Install Smoke Test', () => {
  let tempDir: string;
  let imageTag: string;
  let containerName: string;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it(
    'builds Docker image and runs proxy that responds to /health',
    async () => {
      // 0. Verify Docker is available
      const dockerOk = await isDockerAvailable();
      if (!dockerOk) {
        console.warn('Docker not available — skipping docker-install test');
        return;
      }

      // 1. Setup: temp dir, unique names
      tempDir = mkdtempSync(`${tmpdir()}${sep}docker-smoke-`);
      const suffix = randomSuffix();
      imageTag = `saros-proxy-smoke:${suffix}`;
      containerName = `saros-smoke-${suffix}`;
      const port = await getRandomPort();
      const configPath = join(tempDir, 'config.yaml');

      // 2. Write a valid config.yaml
      const cfg = {
        port: 3000, // matches the EXPOSE in Dockerfile
        host: '127.0.0.1',
        upstreamBaseUrl: 'https://opencode.ai',
        circuitBreakerThreshold: 3,
        circuitBreakerCooldownMs: 60_000,
        requestTimeoutMs: 30_000,
        allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],
        keys: [
          { label: 'docker-smoke', key: 'sk-docker-smoke-key-1234567890' },
        ],
      };
      writeFileSync(configPath, stringifyYaml(cfg), 'utf-8');

      // 3. Build the image (slow — 2-5 minutes on first run)
      const buildResult = await docker(
        ['build', '-t', imageTag, '-f', 'Dockerfile', '.'],
        600_000, // 10 min timeout
      );
      expect(buildResult.stderr).not.toMatch(/ERROR:/);

      try {
        // 4. Run the container
        const runResult = await docker(
          [
            'run',
            '-d',
            '--rm',
            '--name',
            containerName,
            '-p',
            `${port}:3000`,
            '-v',
            `${configPath}:/app/config.yaml:ro`,
            imageTag,
          ],
          60_000,
        );
        expect(runResult.stdout.trim()).toMatch(/^[a-f0-9]{12,}$/);

        // 5. Wait for /health (Docker startup + healthcheck can take 10-30s)
        const ok = await pollHealth(port, 90_000);
        expect(ok).toBe(true);
      } finally {
        // 6. Cleanup: stop container, remove image
        try {
          await docker(['stop', containerName], 30_000);
        } catch (err) {
          console.warn(`Failed to stop container ${containerName}:`, err);
        }
        try {
          await docker(['rm', '-f', containerName], 10_000);
        } catch {
          // --rm flag should auto-remove, but try anyway
        }
        try {
          await docker(['rmi', '-f', imageTag], 30_000);
        } catch (err) {
          console.warn(`Failed to remove image ${imageTag}:`, err);
        }
        // Cleanup temp dir
        if (tempDir && existsSync(tempDir)) {
          rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
        }
      }
    },
    900_000, // 15 min total timeout
  );
});
