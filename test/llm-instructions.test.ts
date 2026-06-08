/**
 * llm-instructions.test.ts — Smoke test for LLM setup instructions.
 *
 * Verifies that LLM_INSTRUCTIONS.md is valid, complete, and the documented
 * setup flow actually works end-to-end with real functions.
 *
 * Run: npx vitest run test/llm-instructions.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { join, sep, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { testProxy } from '../src/cli/setup.js';
import { encryptKey, isEncryptedKey } from '../src/key-encryption.js';
import { updateOpencodeConfig } from '../src/cli/opencode-config.js';
import { validateConfig } from '../src/config.js';
import { OPENCODE_MODELS } from '../src/constants.js';

// ---------------------------------------------------------------------------
// Read LLM_INSTRUCTIONS.md once at module scope
// ---------------------------------------------------------------------------

const LLM_INSTRUCTIONS = readFileSync(
  resolve(process.cwd(), 'LLM_INSTRUCTIONS.md'),
  'utf-8',
);

let parsedQuestions: Array<Record<string, unknown>> | null = null;
try {
  const jsonMatch = LLM_INSTRUCTIONS.match(/```json\n?([\s\S]*?)```/);
  if (jsonMatch) {
    const parsed = JSON.parse(jsonMatch[1].trim()) as Record<string, unknown>;
    parsedQuestions = (parsed.questions ?? null) as Array<Record<string, unknown>> | null;
  }
} catch {
  // parsedQuestions stays null — first Phase-1 test will fail with a clear message
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
  return mkdtempSync(`${tmpdir()}${sep}llm-instructions-test-`);
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
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
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

/** Suppress console output during tests (spawned proxy is noisy). */
function suppressConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

function restoreConsole(): void {
  vi.restoreAllMocks();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LLM Instructions Smoke Test', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    suppressConsole();
  });

  afterEach(async () => {
    restoreConsole();
    await removeTempDir(tempDir);
  });

  // -----------------------------------------------------------------------
  // Phase 1: Question Format Validation
  // -----------------------------------------------------------------------

  describe('Phase 1: Question Format Validation', () => {
    it('contains a valid JSON code block with questions array', () => {
      expect(parsedQuestions).not.toBeNull();
      expect(Array.isArray(parsedQuestions)).toBe(true);
      expect(parsedQuestions!.length).toBeGreaterThanOrEqual(7);
    });

    it('covers Operating System question', () => {
      expect(
        parsedQuestions!.some((q) => String(q.header).includes('Operating')),
      ).toBe(true);
    });

    it('covers Install Method question', () => {
      expect(
        parsedQuestions!.some((q) => String(q.header).includes('Install')),
      ).toBe(true);
    });

    it('covers API Keys question', () => {
      const hasAccountCount = parsedQuestions!.some((q) =>
        String(q.header).includes('Account'),
      );
      const hasKeyFile = parsedQuestions!.some((q) =>
        String(q.header).includes('Key'),
      );
      expect(hasAccountCount || hasKeyFile).toBe(true);
    });

    it('covers Port question', () => {
      expect(
        parsedQuestions!.some((q) => String(q.header) === 'Port'),
      ).toBe(true);
    });

    it('covers Key Encryption question', () => {
      expect(
        parsedQuestions!.some((q) => String(q.header).includes('Encryption')),
      ).toBe(true);
    });

    it('covers OpenCode Integration question', () => {
      expect(
        parsedQuestions!.some((q) => String(q.header).includes('OpenCode')),
      ).toBe(true);
    });

    it('contains scraping warning text with required phrases', () => {
      expect(LLM_INSTRUCTIONS).toContain(
        'Do NOT enable usage-based account switching',
      );
      expect(LLM_INSTRUCTIONS).toContain('always answer');
      expect(LLM_INSTRUCTIONS).toContain('"n"');
      expect(LLM_INSTRUCTIONS).toContain('setup wizard asks');
      expect(LLM_INSTRUCTIONS).toContain('agent-friendly encryption');
    });

    it('each question has required fields (question, header, options)', () => {
      expect(parsedQuestions).not.toBeNull();
      for (const q of parsedQuestions!) {
        expect(q).toHaveProperty('question');
        expect(q).toHaveProperty('header');
        expect(q).toHaveProperty('options');
        expect(Array.isArray(q.options)).toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Phase 2: Setup Execution
  // -----------------------------------------------------------------------

  describe('Phase 2: Setup Execution', () => {
    // -------------------------------------------------------------------
    // Config Generation
    // -------------------------------------------------------------------

    describe('Config Generation', () => {
      it('parses api_keys.txt and generates valid config.yaml validated with validateConfig', async () => {
        const port = await getRandomPort();
        const keysData = [
          { label: 'main', key: 'sk-test-key-12345678901' },
          { label: 'backup', key: 'sk-test-key-23456789012' },
        ];

        // Write api_keys.txt with two keys (format: label sk-key)
        writeFileSync(
          join(tempDir, 'api_keys.txt'),
          keysData.map((k) => `${k.label} ${k.key}`).join('\n'),
          'utf-8',
        );

        // Parse api_keys.txt back
        const raw = readFileSync(join(tempDir, 'api_keys.txt'), 'utf-8');
        const parsedKeys = raw
          .trim()
          .split('\n')
          .map((line) => {
            const idx = line.indexOf(' ');
            return { label: line.slice(0, idx), key: line.slice(idx + 1) };
          });

        expect(parsedKeys).toEqual(keysData);

        // Generate config YAML from parsed data
        const configObj = {
          port,
          host: '127.0.0.1',
          upstreamBaseUrl: 'https://opencode.ai',
          circuitBreakerThreshold: 3,
          circuitBreakerCooldownMs: 60_000,
          requestTimeoutMs: 30_000,
          allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],
          keys: parsedKeys,
        };
        const yaml = stringifyYaml(configObj);
        writeFileSync(join(tempDir, 'config.yaml'), yaml, 'utf-8');

        // Parse generated YAML back
        const writtenYaml = readFileSync(join(tempDir, 'config.yaml'), 'utf-8');
        const parsed = parseYaml(writtenYaml) as Record<string, unknown>;

        // Run through validateConfig to ensure it's a valid proxy config
        const validated = validateConfig(
          parsed as unknown as Parameters<typeof validateConfig>[0],
        );

        expect(validated.port).toBe(port);
        expect(validated.host).toBe('127.0.0.1');
        expect(validated.upstreamBaseUrl).toBe('https://opencode.ai');
        expect(validated.keys).toHaveLength(2);
        expect(validated.keys[0].label).toBe('main');
        expect(validated.keys[1].label).toBe('backup');
        expect(validated.circuitBreakerThreshold).toBe(3);
        expect(validated.circuitBreakerCooldownMs).toBe(60_000);
        expect(validated.requestTimeoutMs).toBe(30_000);
        expect(validated.allowedOrigins).toEqual([
          'http://localhost:*',
          'http://127.0.0.1:*',
        ]);
      });
    });

    // -------------------------------------------------------------------
    // Proxy Smoke Test
    // -------------------------------------------------------------------

    describe('Proxy Smoke Test', () => {
      it('starts proxy with valid config and responds to health check', async () => {
        const port = await getRandomPort();
        const configPath = join(tempDir, 'config.yaml');
        const cfg = {
          port,
          host: '127.0.0.1',
          upstreamBaseUrl: 'https://opencode.ai',
          circuitBreakerThreshold: 3,
          circuitBreakerCooldownMs: 60_000,
          requestTimeoutMs: 30_000,
          allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],
          keys: [
            { label: 'main', key: 'sk-test-key-12345678901' },
            { label: 'backup', key: 'sk-test-key-23456789012' },
          ],
        };
        writeFileSync(configPath, stringifyYaml(cfg), 'utf-8');

        await expect(
          testProxy(port, 60_000, tempDir, undefined, configPath),
        ).resolves.toBeUndefined();
      }, 120_000);
    });

    // -------------------------------------------------------------------
    // Encrypted Keys
    // -------------------------------------------------------------------

    describe('Encrypted Keys', () => {
      it('encrypts a key and verifies the encrypted format', () => {
        const encrypted = encryptKey(
          'sk-test-key-12345678901',
          'my-master-key-1234567890123456',
        );
        expect(isEncryptedKey(encrypted)).toBe(true);
        expect(encrypted).toMatch(/^enc:scrypt:/);
      });

      it('rejects proxy startup when config has encrypted keys but no encryption key is provided', async () => {
        const port = await getRandomPort();
        const configPath = join(tempDir, 'config.yaml');
        const masterKey = 'my-master-key-1234567890123456';
        const encryptedKey = encryptKey('sk-test-key-12345678901', masterKey);

        const cfg = {
          port,
          host: '127.0.0.1',
          upstreamBaseUrl: 'https://opencode.ai',
          circuitBreakerThreshold: 3,
          circuitBreakerCooldownMs: 60_000,
          requestTimeoutMs: 30_000,
          allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],
          keys: [{ label: 'main', key: encryptedKey }],
        };
        writeFileSync(configPath, stringifyYaml(cfg), 'utf-8');

        // Without encryption key -> assertNoEncryptedSecrets throws
        await expect(
          testProxy(port, 10_000, tempDir, undefined, configPath),
        ).rejects.toThrow();
      }, 30_000);

      it('starts proxy with encrypted keys when the encryption key is provided', async () => {
        const port = await getRandomPort();
        const configPath = join(tempDir, 'config.yaml');
        const masterKey = 'my-master-key-1234567890123456';
        const encryptedKey = encryptKey('sk-test-key-12345678901', masterKey);

        const cfg = {
          port,
          host: '127.0.0.1',
          upstreamBaseUrl: 'https://opencode.ai',
          circuitBreakerThreshold: 3,
          circuitBreakerCooldownMs: 60_000,
          requestTimeoutMs: 30_000,
          allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],
          keys: [{ label: 'main', key: encryptedKey }],
        };
        writeFileSync(configPath, stringifyYaml(cfg), 'utf-8');

        await expect(
          testProxy(port, 60_000, tempDir, masterKey, configPath),
        ).resolves.toBeUndefined();
      }, 120_000);
    });

    // -------------------------------------------------------------------
    // OpenCode Config
    // -------------------------------------------------------------------

    describe('OpenCode Config', () => {
      it('updates existing opencode.json preserving pre-existing keys', () => {
        const port = 3456;
        const opencodePath = join(tempDir, 'opencode.json');

        // Pre-create config with existing provider and plugins
        const preExisting = {
          provider: {
            openai: {
              npm: '@ai-sdk/openai',
              name: 'OpenAI',
              options: { apiKey: 'sk-existing-key-12345678901' },
            },
          },
          plugins: ['some-plugin'],
        };
        writeFileSync(
          opencodePath,
          JSON.stringify(preExisting, null, 2),
          'utf-8',
        );

        const result = updateOpencodeConfig(port, {
          configPath: opencodePath,
        });

        // Result checks
        expect(result.success).toBe(true);
        expect(result.path).toBe(opencodePath);
        expect(result.created).toBe(false);

        // Backup was created
        const backupPath = `${opencodePath}.backup`;
        expect(existsSync(backupPath)).toBe(true);
        expect(readFileSync(backupPath, 'utf-8')).toBe(
          JSON.stringify(preExisting, null, 2),
        );

        // Verify file content
        const content = JSON.parse(readFileSync(opencodePath, 'utf-8'));

        // Pre-existing keys are preserved
        expect(content.provider.openai).toBeDefined();
        expect(content.provider.openai.options.apiKey).toBe(
          'sk-existing-key-12345678901',
        );
        expect(content.plugins).toEqual(['some-plugin']);

        // New saros-proxy provider is configured correctly
        expect(content.provider['saros-proxy']).toBeDefined();
        expect(content.provider['saros-proxy'].options.baseURL).toBe(
          `http://127.0.0.1:${port}/zen/go/v1`,
        );
        expect(content.provider['saros-proxy'].options.apiKey).toBe(
          'not-used',
        );
        expect(content.provider['saros-proxy'].models).toEqual(
          OPENCODE_MODELS,
        );
      });
    });
  });

  // -----------------------------------------------------------------------
  // Reference: Config Options
  // -----------------------------------------------------------------------

  describe('Reference: Config Options', () => {
    it('documents all required config option names in LLM_INSTRUCTIONS.md', () => {
      const options = [
        'port',
        'host',
        'upstreamBaseUrl',
        'circuitBreakerThreshold',
        'circuitBreakerCooldownMs',
        'requestTimeoutMs',
        'allowedOrigins',
        'keys',
        'OPENCODE_GO_ENCRYPTION_KEY',
      ];
      for (const option of options) {
        expect(LLM_INSTRUCTIONS).toContain(option);
      }
    });

    it('documents troubleshooting section with common symptoms', () => {
      expect(LLM_INSTRUCTIONS).toContain('Troubleshooting');
      expect(LLM_INSTRUCTIONS).toContain('No valid API keys');
      expect(LLM_INSTRUCTIONS).toContain('Port in use');
      expect(LLM_INSTRUCTIONS).toContain('504 Gateway Timeout');
      expect(LLM_INSTRUCTIONS).toContain('CORS error');
    });
  });
});
