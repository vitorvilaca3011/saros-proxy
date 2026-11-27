/**
 * docker-install.test.ts — Smoke test for the Docker install path.
 *
 * Validates the documented Docker flow:
 *   1. Build the Docker image (`docker build`) exactly once
 *   2. Run a container with a random port mapping and a temp config mount
 *   3. Verify /health responds and loads exactly the mounted config's keys
 *   4. Verify the image HEALTHCHECK reaches `healthy`
 *   5. Verify the process runs as a non-root user
 *   6. Run a second container whose keys come only from OPENCODE_GO_KEYS
 *   7. Cleanup: stop + remove both containers, remove image, remove temp dir
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

interface HealthBody {
  status?: string;
  keyCount?: number;
}

async function pollHealth(port: number, timeoutMs: number): Promise<HealthBody | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const data = (await res.json()) as HealthBody;
        if (data.status === 'ok') return data;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/**
 * Docker runs the first check after `start-period` (10s) and then every
 * `interval` (30s), so two retries already cover ~100s.
 */
async function waitForHealthyStatus(containerName: string, timeoutMs: number): Promise<string> {
  const start = Date.now();
  let status = 'not-started';
  while (Date.now() - start < timeoutMs) {
    try {
      const { stdout } = await docker(
        ['inspect', '--format', '{{.State.Health.Status}}', containerName],
        10_000,
      );
      status = stdout.trim();
      if (status === 'healthy') return status;
    } catch (err) {
      status = `inspect failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return status;
}

async function removeContainer(name: string): Promise<void> {
  try {
    await docker(['stop', name], 30_000);
  } catch {
    // Container may already be gone (--rm) or may never have started.
  }
  try {
    await docker(['rm', '-f', name], 10_000);
  } catch {
    // --rm removes it after stop; this is best effort.
  }
}

// ---------------------------------------------------------------------------
// Tests — all gated by SKIP_DOCKER_SMOKE
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_DOCKER_SMOKE)('Docker Install Smoke Test', () => {
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

      // 1. Setup: temp dir, unique names, one random port per container
      const tempDir = mkdtempSync(`${tmpdir()}${sep}docker-smoke-`);
      const suffix = randomSuffix();
      const imageTag = `saros-proxy-smoke:${suffix}`;
      const containerName = `saros-smoke-${suffix}`;
      const envContainerName = `${containerName}-env`;
      try {
        const port = await getRandomPort();
        const envPort = await getRandomPort();
        const configPath = join(tempDir, 'config.yaml');

        // 2. Write a valid config.yaml. Host 0.0.0.0: a published port is
        // DNAT'ed to the container interface, so a loopback-only bind inside
        // the container would be unreachable from the test process.
        const cfg = {
          port: 3000, // matches the EXPOSE in Dockerfile
          host: '0.0.0.0',
          upstreamBaseUrl: 'https://opencode.ai',
          circuitBreakerThreshold: 3,
          circuitBreakerCooldownMs: 60_000,
          requestTimeoutMs: 30_000,
          allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],
          keys: [
            { label: 'docker-smoke', key: 'sk-docker-smoke-aaaaaaaaaaaa' },
          ],
        };
        writeFileSync(configPath, stringifyYaml(cfg), 'utf-8');

        // Keys must pass the 20-char structural check; labels are cosmetic.
        const envKeys = 'home:sk-aaaa1111-aaaaaaaaaaaa,work:sk-bbbb2222-bbbbbbbbbbbb';

        // 3. Build the image once (slow: 2-5 minutes on a cold cache)
        const buildResult = await docker(
          ['build', '-t', imageTag, '-f', 'Dockerfile', '.'],
          600_000, // 10 min timeout
        );
        expect(buildResult.stderr).not.toMatch(/ERROR:/);

        // 4. Run the container with the mounted config
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

        // 5. /health must report the mounted config's keys, not a default
        const health = await pollHealth(port, 90_000);
        expect(health, 'proxy did not answer /health on the published port').not.toBeNull();
        expect(
          health?.keyCount,
          'mounted config.yaml was not loaded (keyCount differs)',
        ).toBe(cfg.keys.length);

        // 6. The image HEALTHCHECK itself must reach healthy
        const healthStatus = await waitForHealthyStatus(containerName, 120_000);
        expect(
          healthStatus,
          `HEALTHCHECK never became healthy (final status: ${healthStatus})`,
        ).toBe('healthy');

        // 7. The container process must not run as root
        const idResult = await docker(['exec', containerName, 'id', '-u'], 15_000);
        const uid = idResult.stdout.trim();
        expect(uid).toMatch(/^\d+$/);
        expect(uid, `container runs as root (uid ${uid})`).not.toBe('0');

        // 8. Same image, no mount: keys only from OPENCODE_GO_KEYS.
        // PROXY_HOST is required because the default bind is loopback-only.
        const envRunResult = await docker(
          [
            'run',
            '-d',
            '--rm',
            '--name',
            envContainerName,
            '-p',
            `${envPort}:3000`,
            '-e',
            `OPENCODE_GO_KEYS=${envKeys}`,
            '-e',
            'PROXY_HOST=0.0.0.0',
            imageTag,
          ],
          60_000,
        );
        expect(envRunResult.stdout.trim()).toMatch(/^[a-f0-9]{12,}$/);

        const envHealth = await pollHealth(envPort, 90_000);
        expect(
          envHealth,
          'env-only container did not answer /health',
        ).not.toBeNull();
        expect(envHealth?.keyCount, 'OPENCODE_GO_KEYS was not applied').toBe(
          envKeys.split(',').length,
        );
      } finally {
        // 9. Cleanup: both containers first, then image and temp dir
        await removeContainer(envContainerName);
        await removeContainer(containerName);
        try {
          await docker(['rmi', '-f', imageTag], 30_000);
        } catch (err) {
          console.warn(`Failed to remove image ${imageTag}:`, err);
        }
        if (existsSync(tempDir)) {
          rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
        }
      }
    },
    900_000, // 15 min total timeout
  );
});
