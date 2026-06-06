/**
 * cli-setup.test.ts — Comprehensive E2E tests for the CLI setup wizard.
 *
 * Covers validation functions, config generation, backup functionality,
 * smoke test (real proxy startup), and full integration with mocked stdin.
 *
 * Run: npx vitest run test/cli-setup.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  isValidPort,
  isValidApiKey,
  isValidHttpsUrl,
  isValidPositiveInt,
  generateYaml,
  backupExistingConfig,
  testProxy,
  setup,
  type SetupConfig,
} from '../src/cli/setup.js';

// ---------------------------------------------------------------------------
// Hoisted mocks (must be at top level per Vitest)
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  // Prompt order in setup():
  //   1. promptInput → port
  //   2. promptInput → upstream
  //   3. promptInput → num accounts
  //   4. promptInput → encrypt keys (y/n)
  //   5. promptConfirm → usage switching (y/n)
  //   6. promptInput   → acc 1 label
  //   7. promptSecret* → acc 1 api key  (* falls back to rl.question in test)
  //   8. promptInput   → acc 2 label
  //   9. promptSecret* → acc 2 api key
  answers: [
    '3001',                                           // 0. port
    'https://opencode.ai',                            // 1. upstream
    '2',                                              // 2. num accounts
    'n',                                              // 3. encrypt? → NO
    'n',                                              // 4. usage switching? → NO
    'main',                                           // 5. acc 1 label
    'sk-valid-key-111111111111111',                   // 6. acc 1 api key
    'backup',                                         // 7. acc 2 label
    'sk-valid-key-222222222222222',                   // 8. acc 2 api key
  ],
  idx: 0,
}));

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(() => {
      const ans = Promise.resolve(mockState.answers[mockState.idx]);
      mockState.idx++;
      return ans;
    }),
    close: vi.fn(),
    [Symbol.asyncIterator]: async function* () {
      /* no-op */
    },
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory for test isolation. */
function createTempDir(): string {
  return mkdtempSync(`${tmpdir()}${sep}cli-setup-test-`);
}

/** Recursively remove a temporary directory with retry logic for Windows. */
async function removeTempDir(dir: string): Promise<void> {
  if (!existsSync(dir)) return;

  const maxRetries = 5;
  const retryDelay = 500;

  for (let i = 0; i < maxRetries; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay });
      return;
    } catch (err: unknown) {
      if (i === maxRetries - 1) {
        // Last retry failed — log but don't throw (CI cleanup will handle it)
        console.warn(`Failed to remove temp dir ${dir}: ${err}`);
        return;
      }
      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}

/** Get a random available port by binding to port 0, then releasing. */
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

/** Write a minimal valid config.yaml into the given directory. */
function writeValidConfig(dir: string): void {
  const cfg = {
    port: 3001,
    host: '127.0.0.1',
    upstreamBaseUrl: 'https://opencode.ai',
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
    requestTimeoutMs: 30_000,
    allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],
    keys: [{ label: 'test', key: 'sk-test-valid-key-12345678901' }],
  };
  writeFileSync(join(dir, 'config.yaml'), stringifyYaml(cfg), 'utf-8');
}

/** Suppress console.log output during tests. */
function suppressConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
}

/** Restore console.log. */
function restoreConsole(): void {
  vi.restoreAllMocks();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLI Setup Wizard', () => {
  // -----------------------------------------------------------------------
  // 1. Validation Functions
  // -----------------------------------------------------------------------

  describe('Validation Functions', () => {
    describe('isValidPort', () => {
      it('accepts port 1', () => {
        expect(isValidPort('1')).toBe(true);
      });

      it('accepts port 80', () => {
        expect(isValidPort('80')).toBe(true);
      });

      it('accepts port 65535', () => {
        expect(isValidPort('65535')).toBe(true);
      });

      it('rejects port 0', () => {
        expect(isValidPort('0')).toBe(false);
      });

      it('rejects port 65536', () => {
        expect(isValidPort('65536')).toBe(false);
      });

      it('rejects non-numeric input', () => {
        expect(isValidPort('abc')).toBe(false);
      });

      it('rejects empty string', () => {
        expect(isValidPort('')).toBe(false);
      });

      it('rejects negative numbers', () => {
        expect(isValidPort('-1')).toBe(false);
      });

      it('trims whitespace', () => {
        expect(isValidPort('  8080  ')).toBe(true);
      });
    });

    describe('isValidApiKey', () => {
      it('accepts valid key with sk- prefix and sufficient length', () => {
        expect(isValidApiKey('sk-' + 'a'.repeat(20))).toBe(true);
      });

      it('accepts key exactly 20 characters total', () => {
        // sk- (3) + 17 = 20 total
        expect(isValidApiKey('sk-' + 'a'.repeat(17))).toBe(true);
      });

      it('accepts long valid key', () => {
        expect(isValidApiKey('sk-' + 'a'.repeat(50))).toBe(true);
      });

      it('rejects key without sk- prefix', () => {
        expect(isValidApiKey('ak-' + 'a'.repeat(20))).toBe(false);
      });

      it('rejects key shorter than 20 characters', () => {
        expect(isValidApiKey('sk-' + 'a'.repeat(5))).toBe(false);
      });

      it('rejects empty string', () => {
        expect(isValidApiKey('')).toBe(false);
      });

      it('rejects key with wrong case prefix', () => {
        expect(isValidApiKey('SK-' + 'a'.repeat(20))).toBe(false);
      });
    });

    describe('isValidHttpsUrl', () => {
      it('accepts valid HTTPS URL', () => {
        expect(isValidHttpsUrl('https://opencode.ai')).toBe(true);
      });

      it('accepts HTTPS URL with path', () => {
        expect(isValidHttpsUrl('https://opencode.ai/api/v1')).toBe(true);
      });

      it('accepts HTTPS URL with port', () => {
        expect(isValidHttpsUrl('https://opencode.ai:8443')).toBe(true);
      });

      it('rejects HTTP URL', () => {
        expect(isValidHttpsUrl('http://opencode.ai')).toBe(false);
      });

      it('rejects invalid URL string', () => {
        expect(isValidHttpsUrl('not-a-url')).toBe(false);
      });

      it('rejects empty string', () => {
        expect(isValidHttpsUrl('')).toBe(false);
      });

      it('rejects FTP URL', () => {
        expect(isValidHttpsUrl('ftp://opencode.ai')).toBe(false);
      });

      it('trims whitespace', () => {
        expect(isValidHttpsUrl('  https://opencode.ai  ')).toBe(true);
      });
    });

    describe('isValidPositiveInt', () => {
      it('accepts value within range', () => {
        expect(isValidPositiveInt('5', 1, 10)).toBe(true);
      });

      it('accepts min boundary', () => {
        expect(isValidPositiveInt('1', 1, 10)).toBe(true);
      });

      it('accepts max boundary', () => {
        expect(isValidPositiveInt('10', 1, 10)).toBe(true);
      });

      it('rejects value below min', () => {
        expect(isValidPositiveInt('0', 1, 10)).toBe(false);
      });

      it('rejects value above max', () => {
        expect(isValidPositiveInt('11', 1, 10)).toBe(false);
      });

      it('rejects non-numeric string', () => {
        expect(isValidPositiveInt('abc', 1, 10)).toBe(false);
      });

      it('rejects empty string', () => {
        expect(isValidPositiveInt('', 1, 10)).toBe(false);
      });

      it('rejects negative numbers', () => {
        expect(isValidPositiveInt('-5', 1, 10)).toBe(false);
      });

      it('uses default min=1, max=100', () => {
        expect(isValidPositiveInt('50')).toBe(true);
        expect(isValidPositiveInt('0')).toBe(false);
        expect(isValidPositiveInt('101')).toBe(false);
      });

      it('trims whitespace', () => {
        expect(isValidPositiveInt('  7  ', 1, 10)).toBe(true);
      });
    });
  });

  // -----------------------------------------------------------------------
  // 2. Config Generation
  // -----------------------------------------------------------------------

  describe('Config Generation', () => {
    it('generates valid YAML with all required fields', () => {
      const cfg: SetupConfig = {
        port: 3001,
        upstreamBaseUrl: 'https://opencode.ai',
        keys: [{ label: 'main', key: 'sk-valid-key-111111111111111' }],
      };

      const yaml = generateYaml(cfg);
      const parsed = parseYaml(yaml) as Record<string, unknown>;

      expect(parsed.port).toBe(3001);
      expect(parsed.host).toBe('127.0.0.1');
      expect(parsed.upstreamBaseUrl).toBe('https://opencode.ai');
      expect(parsed.circuitBreakerThreshold).toBe(3);
      expect(parsed.circuitBreakerCooldownMs).toBe(60_000);
      expect(parsed.requestTimeoutMs).toBe(30_000);
      expect(parsed.allowedOrigins).toEqual([
        'http://localhost:*',
        'http://127.0.0.1:*',
      ]);
      expect(parsed.keys).toEqual([
        { label: 'main', key: 'sk-valid-key-111111111111111' },
      ]);
    });

    it('handles multiple keys', () => {
      const cfg: SetupConfig = {
        port: 4000,
        upstreamBaseUrl: 'https://example.com',
        keys: [
          { label: 'key1', key: 'sk-valid-key-111111111111111' },
          { label: 'key2', key: 'sk-valid-key-222222222222222' },
          { label: 'key3', key: 'sk-valid-key-333333333333333' },
        ],
      };

      const yaml = generateYaml(cfg);
      const parsed = parseYaml(yaml) as Record<string, unknown>;
      const keys = parsed.keys as Array<{ label: string; key: string }>;

      expect(keys).toHaveLength(3);
      expect(keys[0].label).toBe('key1');
      expect(keys[1].label).toBe('key2');
      expect(keys[2].label).toBe('key3');
    });

    it('uses correct defaults for circuit breaker and timeout', () => {
      const cfg: SetupConfig = {
        port: 5000,
        upstreamBaseUrl: 'https://opencode.ai',
        keys: [{ label: 'main', key: 'sk-valid-key-111111111111111' }],
      };

      const yaml = generateYaml(cfg);
      const parsed = parseYaml(yaml) as Record<string, unknown>;

      expect(parsed.circuitBreakerThreshold).toBe(3);
      expect(parsed.circuitBreakerCooldownMs).toBe(60_000);
      expect(parsed.requestTimeoutMs).toBe(30_000);
      expect(parsed.host).toBe('127.0.0.1');
    });

    it('outputs valid YAML syntax', () => {
      const cfg: SetupConfig = {
        port: 3000,
        upstreamBaseUrl: 'https://opencode.ai',
        keys: [{ label: 'test', key: 'sk-test-key-123456789012345' }],
      };

      const yaml = generateYaml(cfg);
      expect(() => parseYaml(yaml)).not.toThrow();
      expect(yaml).toContain('keys:');
      expect(yaml).toContain('- label:');
      expect(yaml).toContain('sk-test-key');
    });
  });

  // -----------------------------------------------------------------------
  // 3. Backup Functionality
  // -----------------------------------------------------------------------

  describe('Backup Functionality', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = createTempDir();
      suppressConsole();
    });

    afterEach(async () => {
      restoreConsole();
      await removeTempDir(tmpDir);
    });

    it('creates backup when config.yaml exists', () => {
      writeFileSync(join(tmpDir, 'config.yaml'), 'port: 3000\n', 'utf-8');
      const result = backupExistingConfig(tmpDir);

      expect(result).toBe(true);
      expect(existsSync(join(tmpDir, 'config.yaml.backup'))).toBe(true);
    });

    it('returns false when no config exists', () => {
      const result = backupExistingConfig(tmpDir);

      expect(result).toBe(false);
      expect(existsSync(join(tmpDir, 'config.yaml.backup'))).toBe(false);
    });

    it('preserves original content', () => {
      const originalContent = 'port: 9999\nhost: 0.0.0.0\n';
      writeFileSync(join(tmpDir, 'config.yaml'), originalContent, 'utf-8');

      backupExistingConfig(tmpDir);

      const backupContent = readFileSync(join(tmpDir, 'config.yaml.backup'), 'utf-8');
      expect(backupContent).toBe(originalContent);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Smoke Test (real proxy startup)
  // -----------------------------------------------------------------------

  describe('Smoke Test', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = createTempDir();
      suppressConsole();
    });

    afterEach(async () => {
      restoreConsole();
      await removeTempDir(tmpDir);
    });

    it('successfully starts proxy with valid config', async () => {
      writeValidConfig(tmpDir);
      const port = await getRandomPort();

      // Allow up to 60s for tsx to compile and start
      await expect(testProxy(port, 60_000, tmpDir)).resolves.toBeUndefined();
    }, 120_000);

    it('handles port already in use', async () => {
      writeValidConfig(tmpDir);
      const port = await getRandomPort();

      // Start a dummy server on the port to make it unavailable
      const dummyServer: Server = createServer((_req, res) => {
        res.writeHead(200);
        res.end('dummy');
      });

      await new Promise<void>((resolve) => {
        dummyServer.listen(port, '127.0.0.1', () => resolve());
      });

      try {
        // Use Promise.race to ensure test rejects even if testProxy hangs
        await expect(
          Promise.race([
            testProxy(port, 15_000, tmpDir),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('testProxy did not reject in time')), 10_000)
            ),
          ])
        ).rejects.toThrow();
      } finally {
        await new Promise<void>((resolve) => dummyServer.close(() => resolve()));
      }
    }, 20_000);

    it('times out if proxy does not start within timeout', async () => {
      writeValidConfig(tmpDir);
      const port = await getRandomPort();

      // Very short timeout — the proxy cannot start this fast
      await expect(testProxy(port, 10, tmpDir)).rejects.toThrow(
        'Proxy did not start within the allotted time',
      );
    }, 15_000);
  });

  // -----------------------------------------------------------------------
  // 5. Full Integration (mocked stdin)
  // -----------------------------------------------------------------------

  describe('Full Integration', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = createTempDir();
      mockState.idx = 0;
      suppressConsole();
    });

    afterEach(async () => {
      restoreConsole();
      await removeTempDir(tmpDir);
    });

    it('runs setup wizard with mocked stdin and validates output', async () => {
      // Create an existing config.yaml to exercise the backup path
      writeFileSync(join(tmpDir, 'config.yaml'), 'port: 9999\n', 'utf-8');

      // Run the setup wizard (skip the real smoke test for speed)
      await setup(tmpDir, true);

      // --- Verify config.yaml was created ---
      const configPath = join(tmpDir, 'config.yaml');
      expect(existsSync(configPath)).toBe(true);

      // --- Verify config content ---
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = parseYaml(raw) as Record<string, unknown>;

      expect(parsed.port).toBe(3001);
      expect(parsed.upstreamBaseUrl).toBe('https://opencode.ai');
      expect(parsed.host).toBe('127.0.0.1');

      const keys = parsed.keys as Array<{ label: string; key: string }>;
      expect(keys).toHaveLength(2);
      expect(keys[0].label).toBe('main');
      expect(keys[0].key).toBe('sk-valid-key-111111111111111');
      expect(keys[1].label).toBe('backup');
      expect(keys[1].key).toBe('sk-valid-key-222222222222222');

      // --- Verify backup was created from pre-existing config ---
      const backupPath = join(tmpDir, 'config.yaml.backup');
      expect(existsSync(backupPath)).toBe(true);
      const backupContent = readFileSync(backupPath, 'utf-8');
      expect(backupContent).toBe('port: 9999\n');
    });

    it('creates config.yaml when no prior config exists', async () => {
      // No pre-existing config.yaml in tmpDir
      expect(existsSync(join(tmpDir, 'config.yaml'))).toBe(false);

      await setup(tmpDir, true);

      // Config should now exist
      const configPath = join(tmpDir, 'config.yaml');
      expect(existsSync(configPath)).toBe(true);

      // No backup should exist since there was no prior config
      expect(existsSync(join(tmpDir, 'config.yaml.backup'))).toBe(false);
    });
  });
});
