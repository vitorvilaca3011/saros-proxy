/**
 * docker-install.test.ts — Smoke test for the Docker install path.
 *
 * Validates the image artifact and the README `docker compose up` path:
 *   1. Build the Docker image (`docker build`) exactly once
 *   2. Run it with a random port, a mounted config and an explicit 0.0.0.0
 *      bind, then verify /health reports exactly the mounted key's label
 *   3. Verify the image HEALTHCHECK reaches `healthy`
 *   4. Verify the process runs as a non-root user
 *   5. Run a second container without a mount, keys only from
 *      OPENCODE_GO_KEYS plus PROXY_HOST=0.0.0.0, and verify both labels
 *   6. Run `docker compose up -d` from a copy of the repository compose file,
 *      with config.yaml taken from config.example.yaml and its
 *      `host: 127.0.0.1` unchanged: serving the published port proves the
 *      service's `--host 0.0.0.0` command overrides the YAML
 *   7. Cleanup: compose down, stop + remove both containers, image and temp dir
 *
 * Both README install paths (plain `docker run` and `docker compose up`) are
 * covered. The Compose `test` profile (`docker compose run --rm test`) stays
 * out: it runs the unit suite, not an install path.
 *
 * Gated behind RUN_DOCKER_SMOKE=1 because it requires Docker and is slow.
 * Under CI, a missing Docker binary fails the test instead of skipping.
 *
 * Run: RUN_DOCKER_SMOKE=1 npx vitest run test/docker-install.test.ts
 *      (On Windows PowerShell: $env:RUN_DOCKER_SMOKE="1"; npx vitest run test/docker-install.test.ts)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { promisify } from 'node:util';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
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

async function describeContainer(name: string): Promise<string> {
  try {
    const { stdout, stderr } = await docker(['logs', '--tail', '50', name], 10_000);
    return [stdout, stderr].map((s) => s.trim()).filter(Boolean).join('\n') || '<no logs>';
  } catch {
    return '<no logs>';
  }
}

async function describeHealthLog(name: string): Promise<string> {
  try {
    const { stdout } = await docker(
      ['inspect', '--format', '{{json .State.Health.Log}}', name],
      10_000,
    );
    return stdout.trim() || '<no health log>';
  } catch {
    return '<no health log>';
  }
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
  keys?: { label: string }[];
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
 * Docker Engine >=25 probes every `StartInterval` (5s by default) during the
 * start period, then every `interval` (30s). With start-period=10s that is
 * roughly 5s, 10s, 40s, 70s and 100s, so 120s covers the 30s cadence.
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
    // The container may never have started or may already be gone.
  }
  try {
    await docker(['rm', '-f', name], 10_000);
  } catch {
    // Best effort: a failed rm must not mask the test failure.
  }
}

async function describeCompose(projectName: string, composePath: string): Promise<string> {
  try {
    const { stdout, stderr } = await docker(
      ['compose', '-p', projectName, '-f', composePath, 'logs', '--no-color', '--tail', '50'],
      20_000,
    );
    return [stdout, stderr].map((s) => s.trim()).filter(Boolean).join('\n') || '<no logs>';
  } catch {
    return '<no logs>';
  }
}

interface ComposeService {
  build?: unknown;
  image?: string;
  container_name?: string;
  ports?: string[];
}

interface ComposeFile {
  services: Record<string, ComposeService>;
}

/**
 * Copy the repository compose file into the fixture directory, rewriting only
 * the fields that make it runnable in a test: the proxy `build` becomes the
 * image this file already built (a second build would eat the CI budget), the
 * published port becomes a free random one, and fixed container names are
 * dropped because they collide across runs. Every other field, including the
 * `--host 0.0.0.0` command, is the file the README ships.
 */
function writeComposeFixture(composeDir: string, imageTag: string, publishedPort: number): string {
  const compose = parseYaml(readFileSync('docker-compose.yml', 'utf-8')) as ComposeFile;
  const proxy = compose.services.proxy;
  delete proxy.build;
  proxy.image = imageTag;
  proxy.ports = [`${publishedPort}:3000`];
  delete proxy.container_name;
  delete compose.services.test?.container_name;

  const composePath = join(composeDir, 'docker-compose.yml');
  writeFileSync(composePath, stringifyYaml(compose), 'utf-8');
  return composePath;
}

/**
 * Write config.yaml from config.example.yaml for the compose run. Only the key
 * placeholders change; `host: 127.0.0.1` stays as shipped because the point of
 * the test is that the compose `--host 0.0.0.0` command makes the published
 * port reachable.
 */
function writeComposeConfig(composeDir: string): void {
  const example = readFileSync('config.example.yaml', 'utf-8');
  const config = example
    .replace('key: sk-abc123...', 'key: sk-compose-aaaaaaaaaaaa')
    .replace('key: sk-def456...', 'key: sk-compose-bbbbbbbbbbbb');

  const parsed = parseYaml(config) as { host?: string; keys?: { key: string }[] };
  expect(parsed.host, 'the example config must keep its loopback host').toBe('127.0.0.1');
  expect(
    parsed.keys?.every((entry) => entry.key.length >= 20),
    'config.example.yaml key placeholders must be replaced with valid keys',
  ).toBe(true);

  writeFileSync(join(composeDir, 'config.yaml'), config, 'utf-8');
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
        if (process.env.CI) {
          expect(dockerOk, 'docker is required in CI').toBe(true);
        }
        console.warn('Docker not available — skipping docker-install test');
        return;
      }

      // 1. Setup: temp dir, unique names, one random port per container
      const tempDir = mkdtempSync(`${tmpdir()}${sep}docker-smoke-`);
      const suffix = randomSuffix();
      const imageTag = `saros-proxy-smoke:${suffix}`;
      const containerName = `saros-smoke-${suffix}`;
      const envContainerName = `${containerName}-env`;
      const composeProject = `saros-compose-${suffix}`;
      const composeDir = join(tempDir, 'compose');
      const composePath = join(composeDir, 'docker-compose.yml');
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

        // 5. /health must report the mounted config's key, not a default
        const health = await pollHealth(port, 90_000);
        expect(
          health,
          `proxy did not answer /health on port ${port}\n${await describeContainer(containerName)}`,
        ).not.toBeNull();
        expect(health?.keys?.map((k) => k.label)).toEqual(['docker-smoke']);

        // 6. The image HEALTHCHECK itself must reach healthy
        const healthStatus = await waitForHealthyStatus(containerName, 120_000);
        expect(
          healthStatus,
          `HEALTHCHECK never became healthy (final status: ${healthStatus})\n` +
            `${await describeHealthLog(containerName)}\n` +
            `${await describeContainer(containerName)}`,
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
          `env-only proxy did not answer /health on port ${envPort}\n${await describeContainer(envContainerName)}`,
        ).not.toBeNull();
        expect(envHealth?.keys?.map((k) => k.label)).toEqual(['home', 'work']);

        // 9. The compose file shipped to users must serve its published port.
        // config.yaml comes from config.example.yaml with host 127.0.0.1
        // untouched: reaching /health proves the service's `--host 0.0.0.0`
        // command overrides the YAML (CLI > YAML).
        const composePort = await getRandomPort();
        mkdirSync(composeDir, { recursive: true });
        writeComposeFixture(composeDir, imageTag, composePort);
        writeComposeConfig(composeDir);

        await docker(
          ['compose', '-p', composeProject, '-f', composePath, 'up', '-d'],
          120_000,
        );

        const composeHealth = await pollHealth(composePort, 90_000);
        expect(
          composeHealth,
          `compose proxy did not answer /health on port ${composePort}\n` +
            `${await describeCompose(composeProject, composePath)}`,
        ).not.toBeNull();
        expect(composeHealth?.keys?.map((k) => k.label)).toEqual(['account1', 'account2']);
      } finally {
        // 10. Compose project first (its containers and network), then the
        // standalone containers, image and temp dir.
        try {
          await docker(
            ['compose', '-p', composeProject, '-f', composePath, 'down', '-v', '--remove-orphans'],
            120_000,
          );
        } catch (err) {
          console.warn(`Failed to bring compose project ${composeProject} down:`, err);
        }
        await removeContainer(envContainerName);
        await removeContainer(containerName);
        try {
          await docker(['rmi', '-f', imageTag], 30_000);
        } catch (err) {
          console.warn(`Failed to remove image ${imageTag}:`, err);
        }
        if (existsSync(tempDir)) {
          try {
            rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
          } catch (err) {
            console.warn(`Failed to remove temp dir ${tempDir}:`, err);
          }
        }
      }
    },
    900_000, // 15 min total timeout
  );
});
