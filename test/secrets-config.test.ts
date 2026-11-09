/**
 * secrets-config.test.ts — Boot integration: enc:v1 envelopes, source
 * selection, fail-fast messages, plaintext warning, legacy enc:scrypt.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../src/logger.js', async (importOriginal) => {
  const actual = await importOriginal<LoggerModule>();
  return { ...actual, logger: loggerMock };
});

import { loadConfig, resolveConfigPath } from '../src/config.js';
import { encryptKey } from '../src/key-encryption.js';
import { restoreEnv } from './env-isolation.js';
import type * as LoggerModule from '../src/logger.js';
import { encryptValue } from '../src/secrets/envelope.js';
import {
  NO_SOURCE_MESSAGE,
  SecretSourceError,
  decryptFailureMessage,
} from '../src/secrets/source.js';
import {
  buildBootLog,
  configHasEnvelopeKeys,
  prepareBootPassphrase,
} from '../src/secrets/boot.js';

const PASSPHRASE = 'boot-test-passphrase-fixture';
const KEY = 'sk-boot-test-key-that-is-long-enough-0001';
const LABEL = 'boot-key';

describe('loadConfig — enc:v1 envelopes', () => {
  let tempDir: string;
  let yamlPath: string;
  let emptyPath: string;
  const originalEnv = { ...process.env };

  function writeConfig(keys: Array<Record<string, unknown>>): void {
    const yaml =
      'port: 3000\n' +
      'keys:\n' +
      keys
        .map((entry) =>
          Object.entries(entry)
            .map(([field, value], index) => `  ${index === 0 ? '- ' : '  '}${field}: ${String(value)}\n`)
            .join(''),
        )
        .join('');
    writeFileSync(yamlPath, yaml, 'utf-8');
  }

  function envelope(key = KEY, label = LABEL, passphrase = PASSPHRASE): string {
    return encryptValue(key, passphrase, label);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'saros-secrets-config-'));
    yamlPath = join(tempDir, 'config.yaml');
    emptyPath = join(tempDir, 'empty-path');
    mkdirSync(emptyPath);
    restoreEnv(originalEnv);
    delete process.env.SAROS_PASSPHRASE;
    delete process.env.OPENCODE_GO_ENCRYPTION_KEY;
    delete process.env.OPENCODE_GO_KEYS;
    delete process.env.PROXY_PORT;
    delete process.env.PROXY_HOST;
    delete process.env.UPSTREAM_BASE_URL;
    delete process.env.SAROS_DAEMON;
    process.env.PATH = emptyPath;
    process.argv = ['node', 'saros-proxy'];
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
  });

  afterEach(() => {
    restoreEnv(originalEnv);
    process.argv = ['node', 'saros-proxy'];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('decrypts with SAROS_PASSPHRASE and marks the key encrypted', () => {
    writeConfig([{ label: LABEL, key: envelope() }]);
    process.env.SAROS_PASSPHRASE = PASSPHRASE;

    const config = loadConfig(yamlPath);
    expect(config.keys).toHaveLength(1);
    expect(config.keys[0]).toMatchObject({ label: LABEL, encrypted: true });
    expect(config.keys[0].key).toBe(KEY);
  });

  it('accepts a passphrase already resolved by serve', () => {
    writeConfig([{ label: LABEL, key: envelope() }]);
    const config = loadConfig(yamlPath, { passphrase: PASSPHRASE });
    expect(config.keys[0].key).toBe(KEY);
  });

  it('fails fast with the three documented options when no source exists', () => {
    writeConfig([{ label: LABEL, key: envelope() }]);
    let caught: unknown;
    try {
      loadConfig(yamlPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SecretSourceError);
    const message = (caught as Error).message;
    expect(message).toContain(NO_SOURCE_MESSAGE);
    expect(message).toContain('SAROS_PASSPHRASE');
    expect(message).toContain('saros-proxy secret set');
    expect(message).toContain('saros-proxy serve');
    expect(message).toContain('Store: secret-tool is not installed');
    expect(message).not.toContain(PASSPHRASE);
    expect(message).not.toContain(KEY);
    expect(message).not.toContain('enc:v1:');
  });

  it('carries an absent-store reason into the fail-fast message', () => {
    writeConfig([{ label: LABEL, key: envelope() }]);
    const store = join(tempDir, 'secret-tool');
    writeFileSync(store, '#!/bin/sh\nexit 1\n', 'utf-8');
    chmodSync(store, 0o755);
    process.env.PATH = `${tempDir}:${emptyPath}`;

    let caught: unknown;
    try {
      loadConfig(yamlPath);
    } catch (err) {
      caught = err;
    }
    const message = (caught as Error).message;
    expect(message).toContain('no entry for service saros-proxy (not found)');
    expect(message).not.toContain(PASSPHRASE);
    expect(message).not.toContain(KEY);
  });

  it('reports a wrong passphrase without leaking either secret', () => {
    writeConfig([{ label: LABEL, key: envelope() }]);
    process.env.SAROS_PASSPHRASE = 'wrong-passphrase-fixture';
    let caught: unknown;
    try {
      loadConfig(yamlPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SecretSourceError);
    const message = (caught as Error).message;
    expect(message).toMatch(/wrong passphrase or corrupt ciphertext/i);
    expect(message).toContain(LABEL);
    expect(message).not.toContain(KEY);
    expect(message).not.toContain('wrong-passphrase-fixture');
    expect(message).not.toContain(PASSPHRASE);
    expect(message).not.toContain('enc:v1:');
  });

  it('reads the passphrase from a populated OS store', () => {
    writeConfig([{ label: LABEL, key: envelope() }]);
    const store = join(tempDir, 'secret-tool');
    writeFileSync(store, `#!/bin/sh\nprintf '%s\\n' '${PASSPHRASE}'\n`, 'utf-8');
    chmodSync(store, 0o755);
    process.env.PATH = `${tempDir}:${emptyPath}`;

    expect(loadConfig(yamlPath).keys[0].key).toBe(KEY);
  });

  it('strips encrypted: true from a plaintext entry', () => {
    writeConfig([{ label: 'spoofed', key: KEY, encrypted: true }]);
    const config = loadConfig(yamlPath);
    expect(config.keys[0]).toMatchObject({ label: 'spoofed', key: KEY });
    expect(config.keys[0].encrypted).toBeUndefined();
  });

  it('logs a malformed YAML failure without the offending key line', () => {
    writeFileSync(
      yamlPath,
      'keys:\n  - label: leak\n    key: "sk-log-leak-fixture-00000001\n',
      'utf-8',
    );
    process.env.OPENCODE_GO_KEYS = `env:${KEY}`;

    expect(loadConfig(yamlPath).keys).toHaveLength(1);
    const logged = loggerMock.error.mock.calls.map((args) => JSON.stringify(args)).join('\n');
    expect(logged).toContain('Failed to parse config file');
    expect(logged).not.toContain('sk-log-leak-fixture');
  });

  it('warns loudly for plaintext keys but still loads them', () => {
    writeConfig([{ label: 'plain', key: KEY }]);
    const config = loadConfig(yamlPath);
    expect(config.keys[0].key).toBe(KEY);
    expect(config.keys[0].encrypted).toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      { evt: 'security.plaintext-keys' },
      expect.stringContaining('saros-proxy keys encrypt'),
      yamlPath,
    );
  });

  it('does not warn when every key is encrypted', () => {
    writeConfig([{ label: LABEL, key: envelope() }]);
    process.env.SAROS_PASSPHRASE = PASSPHRASE;
    loadConfig(yamlPath);
    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      { evt: 'security.plaintext-keys' },
      expect.anything(),
      expect.anything(),
    );
  });

  it('handles a mixed envelope/plaintext pool', () => {
    writeConfig([
      { label: LABEL, key: envelope() },
      { label: 'plain', key: KEY },
    ]);
    process.env.SAROS_PASSPHRASE = PASSPHRASE;
    const config = loadConfig(yamlPath);
    expect(config.keys).toEqual([
      expect.objectContaining({ label: LABEL, encrypted: true, key: KEY }),
      expect.objectContaining({ label: 'plain', key: KEY }),
    ]);
    expect(config.keys[1].encrypted).toBeUndefined();
  });

  it('keeps legacy enc:scrypt keys readable with OPENCODE_GO_ENCRYPTION_KEY', () => {
    const master = 'legacy-master-key-fixture-at-least-16';
    writeConfig([{ label: 'legacy', key: encryptKey(KEY, master) }]);
    process.env.OPENCODE_GO_ENCRYPTION_KEY = master;
    const config = loadConfig(yamlPath);
    expect(config.keys[0]).toMatchObject({ key: KEY, encrypted: true });
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = loggerMock.warn.mock.calls[0];
    expect(fields).toEqual({ evt: 'security.legacy-encryption' });
    expect(message).toContain('1 key uses legacy enc:scrypt');
    expect(message).toContain('legacy');
    expect(message).toContain('saros-proxy keys encrypt');
  });

  it('emits one legacy warning for two keys, listing both labels', () => {
    const master = 'legacy-master-key-fixture-at-least-16';
    writeConfig([
      { label: 'legacy-a', key: encryptKey(KEY, master) },
      { label: 'legacy-b', key: encryptKey('sk-boot-test-key-that-is-long-enough-0002', master) },
    ]);
    process.env.OPENCODE_GO_ENCRYPTION_KEY = master;
    const config = loadConfig(yamlPath);

    expect(config.keys).toHaveLength(2);
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = loggerMock.warn.mock.calls[0];
    expect(fields).toEqual({ evt: 'security.legacy-encryption' });
    expect(message).toContain('2 keys use legacy enc:scrypt');
    expect(message).toContain('legacy-a, legacy-b');
    expect(message).toContain('saros-proxy keys encrypt');
  });

  it('still refuses legacy keys without the legacy env var', () => {
    writeConfig([{ label: 'legacy', key: encryptKey(KEY, 'legacy-master-key-fixture-16+') }]);
    expect(() => loadConfig(yamlPath)).toThrow('OPENCODE_GO_ENCRYPTION_KEY');
  });

  it('rejects a wrong legacy key without leaking the credential', () => {
    writeConfig([{ label: 'legacy', key: encryptKey(KEY, 'legacy-master-key-fixture-16+') }]);
    process.env.OPENCODE_GO_ENCRYPTION_KEY = 'wrong-legacy-master-key-16+';
    let caught: unknown;
    try {
      loadConfig(yamlPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('legacy');
    expect(message).toContain('OPENCODE_GO_ENCRYPTION_KEY');
    expect(message).not.toContain(KEY);
  });
});

describe('prepareBootPassphrase', () => {
  let tempDir: string;
  let yamlPath: string;
  let emptyPath: string;
  const originalEnv = { ...process.env };

  function configWithEnvelope(): void {
    writeFileSync(
      yamlPath,
      `keys:\n  - label: ${LABEL}\n    key: ${encryptValue(KEY, PASSPHRASE, LABEL)}\n`,
      'utf-8',
    );
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'saros-secrets-boot-'));
    yamlPath = join(tempDir, 'config.yaml');
    emptyPath = join(tempDir, 'empty-path');
    mkdirSync(emptyPath);
    restoreEnv(originalEnv);
    delete process.env.SAROS_PASSPHRASE;
    delete process.env.SAROS_DAEMON;
    process.env.PATH = emptyPath;
  });

  afterEach(() => {
    restoreEnv(originalEnv);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns undefined when the config has no envelopes', async () => {
    expect(await prepareBootPassphrase({ configPath: join(tempDir, 'missing.yaml') })).toBeUndefined();
    writeFileSync(yamlPath, `keys:\n  - label: p\n    key: ${KEY}\n`, 'utf-8');
    expect(await prepareBootPassphrase({ configPath: yamlPath })).toBeUndefined();
  });

  it('returns the env passphrase when present', async () => {
    configWithEnvelope();
    process.env.SAROS_PASSPHRASE = PASSPHRASE;
    expect(await prepareBootPassphrase({ configPath: yamlPath })).toBe(PASSPHRASE);
  });

  it('resolves the config path from --config when none is passed', async () => {
    configWithEnvelope();
    process.env.SAROS_PASSPHRASE = PASSPHRASE;
    process.argv = ['node', 'saros-proxy', '--config', yamlPath];
    expect(await prepareBootPassphrase()).toBe(PASSPHRASE);
    process.argv = ['node', 'saros-proxy'];
  });

  it('fails with attempts and the documented options when every source fails', async () => {
    configWithEnvelope();
    process.env.SAROS_DAEMON = '1';
    let caught: unknown;
    try {
      await prepareBootPassphrase({ configPath: yamlPath });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SecretSourceError);
    const message = (caught as Error).message;
    expect(message).toContain(NO_SOURCE_MESSAGE);
    expect(message).toContain('env: SAROS_PASSPHRASE is not set');
    expect(message).toContain('store:');
    expect(message).toContain('tty: interactive prompt is disabled in this context');
    expect(message).not.toContain(PASSPHRASE);
  });

  it('prompts on a TTY when allowed', async () => {
    configWithEnvelope();
    const input = new PassThrough();
    Object.defineProperty(input, 'isTTY', { value: true, configurable: true });
    const pending = prepareBootPassphrase({
      configPath: yamlPath,
      allowTty: true,
      input,
      output: new PassThrough(),
    });
    input.write(`${PASSPHRASE}\n`);
    expect(await pending).toBe(PASSPHRASE);
  });

  it('treats malformed YAML and non-list keys as no envelope', () => {
    expect(configHasEnvelopeKeys(join(tempDir, 'missing.yaml'))).toBe(false);
    writeFileSync(yamlPath, 'keys: [unterminated', 'utf-8');
    expect(configHasEnvelopeKeys(yamlPath)).toBe(false);
    writeFileSync(yamlPath, 'keys: not-a-list\n', 'utf-8');
    expect(configHasEnvelopeKeys(yamlPath)).toBe(false);
  });
});

describe('boot log line', () => {
  it('emits labels/providers/flags but no key material', () => {
    const envelope = encryptValue(KEY, PASSPHRASE, LABEL);
    const log = buildBootLog(
      {
        port: 3000,
        host: '127.0.0.1',
        keys: [
          { label: LABEL, key: KEY, encrypted: true },
          { label: 'plain', key: KEY, encrypted: false },
        ],
        circuitBreakerThreshold: 3,
        circuitBreakerCooldownMs: 60_000,
        upstreamBaseUrl: 'https://example.com',
        requestTimeoutMs: 30_000,
        allowedOrigins: [],
      },
      '/tmp/config.yaml',
      {
        version: '0.0.0-test',
        node: 'v22',
        platform: 'linux',
        bundledModels: 1,
        logLevel: 'info',
      },
    );
    expect(log.evt).toBe('boot');
    expect(log.keys).toEqual([
      { label: LABEL, provider: undefined, encrypted: true },
      { label: 'plain', provider: undefined, encrypted: false },
    ]);
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(PASSPHRASE);
    expect(serialized).not.toContain(envelope.slice(0, 24));
  });
});

describe('decryptFailureMessage', () => {
  it('names the key but never the secret', () => {
    const message = decryptFailureMessage(LABEL, 'Wrong passphrase or corrupt ciphertext');
    expect(message).toContain(LABEL);
    expect(message).toContain('SAROS_PASSPHRASE');
    expect(message).not.toContain(KEY);
  });
});

describe('resolveConfigPath', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('honours --config and an explicit path', () => {
    process.argv = ['node', 'saros-proxy', '--config', '/tmp/from-argv.yaml'];
    expect(resolveConfigPath()).toBe('/tmp/from-argv.yaml');
    expect(resolveConfigPath('/tmp/explicit.yaml')).toBe('/tmp/explicit.yaml');
  });
});
