/**
 * config.test.ts — Comprehensive tests for the config module.
 *
 * Vitest-based; run with: npx vitest run src/config.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, validateConfig, type ProxyConfig } from './config.js';
import { encryptKey } from './key-encryption.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  maskKey: (key: string) => key.slice(0, 4) + '...' + key.slice(-4),
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_KEY = 'sk-test-key-that-is-at-least-20-chars-long';
const VALID_KEY2 = 'sk-another-valid-key-that-is-twenty-chars';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid config base suitable for passing to validateConfig. */
function validBase(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    port: 8080,
    host: '0.0.0.0',
    upstreamBaseUrl: 'https://api.example.com',
    keys: [{ label: 'test', key: VALID_KEY }],
    circuitBreakerThreshold: 5,
    circuitBreakerCooldownMs: 120_000,
    requestTimeoutMs: 60_000,
    allowedOrigins: ['http://localhost:3000'],
    ...overrides,
  };
}

/** Create a minimal valid YAML file at the given path and return it. */
function writeMinimalYaml(yamlPath: string): void {
  const content = [
    'port: 9090',
    'host: 0.0.0.0',
    'upstreamBaseUrl: https://yaml.example.com',
    'circuitBreakerThreshold: 7',
    'circuitBreakerCooldownMs: 180000',
    'requestTimeoutMs: 90000',
    'allowedOrigins:',
    '  - http://yaml-origin.example.com',
    'keys:',
    '  - label: yaml-key',
    `    key: ${VALID_KEY}`,
    '',
  ].join('\n');
  writeFileSync(yamlPath, content, 'utf-8');
}

/** Create a temp directory and return its path. */
function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'config-test-'));
}

/** Remove a temp directory. */
function removeTempDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// validateConfig tests
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  // --- Port ---

  it('passes valid port (1-65535) through', () => {
    const result = validateConfig(validBase({ port: 8080 }));
    expect(result.port).toBe(8080);
  });

  it('passes through port at boundaries (1, 65535)', () => {
    expect(validateConfig(validBase({ port: 1 })).port).toBe(1);
    expect(validateConfig(validBase({ port: 65535 })).port).toBe(65535);
  });

  it('defaults to 3000 for port 0', () => {
    const result = validateConfig(validBase({ port: 0 }));
    expect(result.port).toBe(3000);
  });

  it('defaults to 3000 for negative port', () => {
    const result = validateConfig(validBase({ port: -1 }));
    expect(result.port).toBe(3000);
  });

  it('defaults to 3000 for port > 65535', () => {
    const result = validateConfig(validBase({ port: 70000 }));
    expect(result.port).toBe(3000);
  });

  it('defaults to 3000 for non-integer port', () => {
    const result = validateConfig(validBase({ port: 3.14 }));
    expect(result.port).toBe(3000);
  });

  it('defaults to 3000 when port is missing', () => {
    const { port: _p, ...rest } = validBase();
    const result = validateConfig(rest);
    expect(result.port).toBe(3000);
  });

  // --- Host ---

  it('passes valid host through', () => {
    const result = validateConfig(validBase({ host: 'my-server.local' }));
    expect(result.host).toBe('my-server.local');
  });

  it('passes through host with dots and hyphens', () => {
    expect(validateConfig(validBase({ host: 'proxy-1.internal.net' })).host).toBe(
      'proxy-1.internal.net',
    );
  });

  it('passes through IPv6 address', () => {
    expect(validateConfig(validBase({ host: '::1' })).host).toBe('::1');
  });

  it('passes through bracketed IPv6 address', () => {
    expect(validateConfig(validBase({ host: '[::1]' })).host).toBe('[::1]');
  });

  it('defaults to 127.0.0.1 for host with spaces', () => {
    const result = validateConfig(validBase({ host: 'my host' }));
    expect(result.host).toBe('127.0.0.1');
  });

  it('defaults to 127.0.0.1 for host with special characters', () => {
    const result = validateConfig(validBase({ host: 'host@name' }));
    expect(result.host).toBe('127.0.0.1');
  });

  it('defaults to 127.0.0.1 for host with spaces', () => {
    // Spaces are not in the allowed host regex
    const result = validateConfig(validBase({ host: 'my host' }));
    expect(result.host).toBe('127.0.0.1');
  });

  it('defaults to 127.0.0.1 when host is missing', () => {
    const { host: _h, ...rest } = validBase();
    const result = validateConfig(rest);
    expect(result.host).toBe('127.0.0.1');
  });

  // --- Upstream URL ---

  it('passes valid HTTPS URL through', () => {
    const result = validateConfig(validBase({ upstreamBaseUrl: 'https://api.openai.com' }));
    expect(result.upstreamBaseUrl).toBe('https://api.openai.com');
  });

  it('defaults for HTTP URL (SSRF prevention)', () => {
    const result = validateConfig(validBase({ upstreamBaseUrl: 'http://api.example.com' }));
    expect(result.upstreamBaseUrl).toBe('https://opencode.ai');
  });

  it('defaults for invalid URL', () => {
    const result = validateConfig(validBase({ upstreamBaseUrl: 'not-a-url' }));
    expect(result.upstreamBaseUrl).toBe('https://opencode.ai');
  });

  it('defaults to https://opencode.ai when upstream is missing', () => {
    const { upstreamBaseUrl: _u, ...rest } = validBase();
    const result = validateConfig(rest);
    expect(result.upstreamBaseUrl).toBe('https://opencode.ai');
  });

  it('defaults for empty string URL', () => {
    const result = validateConfig(validBase({ upstreamBaseUrl: '' }));
    expect(result.upstreamBaseUrl).toBe('https://opencode.ai');
  });

  // --- API keys ---

  it('passes valid keys (sk- prefix, >= 20 chars) through', () => {
    const keys = [
      { label: 'a', key: VALID_KEY },
      { label: 'b', key: VALID_KEY2 },
    ];
    const result = validateConfig(validBase({ keys }));
    expect(result.keys).toHaveLength(2);
    expect(result.keys[0].key).toBe(VALID_KEY);
    expect(result.keys[1].key).toBe(VALID_KEY2);
  });

  it('filters out keys without sk- prefix', () => {
    const keys = [
      { label: 'valid', key: VALID_KEY },
      { label: 'invalid', key: 'no-prefix-key-that-is-twenty-chars' },
    ];
    const result = validateConfig(validBase({ keys }));
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].key).toBe(VALID_KEY);
  });

  it('filters out keys shorter than 20 chars', () => {
    const keys = [
      { label: 'valid', key: VALID_KEY },
      { label: 'short', key: 'sk-too-short' },
    ];
    const result = validateConfig(validBase({ keys }));
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].key).toBe(VALID_KEY);
  });

  it('filters out keys that are both short and lack sk- prefix', () => {
    const keys = [
      { label: 'valid', key: VALID_KEY },
      { label: 'bad', key: 'short' },
    ];
    const result = validateConfig(validBase({ keys }));
    expect(result.keys).toHaveLength(1);
  });

  it('throws when key array is empty', () => {
    expect(() => validateConfig(validBase({ keys: [] }))).toThrow(
      'No valid API keys configured',
    );
  });

  it('throws when all keys are invalid', () => {
    const keys = [
      { label: 'a', key: 'sk-short' },
      { label: 'b', key: 'no-sk-prefix-longer-than-twenty-chars' },
    ];
    expect(() => validateConfig(validBase({ keys }))).toThrow(
      'No valid API keys configured',
    );
  });

  it('throws when keys are missing', () => {
    const { keys: _k, ...rest } = validBase();
    expect(() => validateConfig(rest)).toThrow('No valid API keys configured');
  });

  // --- Circuit breaker threshold ---

  it('passes valid threshold (1-10) through', () => {
    expect(validateConfig(validBase({ circuitBreakerThreshold: 5 })).circuitBreakerThreshold).toBe(
      5,
    );
  });

  it('passes through threshold at boundaries (1, 10)', () => {
    expect(validateConfig(validBase({ circuitBreakerThreshold: 1 })).circuitBreakerThreshold).toBe(
      1,
    );
    expect(validateConfig(validBase({ circuitBreakerThreshold: 10 })).circuitBreakerThreshold).toBe(
      10,
    );
  });

  it('defaults to 3 for threshold 0', () => {
    const result = validateConfig(validBase({ circuitBreakerThreshold: 0 }));
    expect(result.circuitBreakerThreshold).toBe(3);
  });

  it('defaults to 3 for threshold > 10', () => {
    const result = validateConfig(validBase({ circuitBreakerThreshold: 11 }));
    expect(result.circuitBreakerThreshold).toBe(3);
  });

  it('defaults to 3 for non-integer threshold', () => {
    const result = validateConfig(validBase({ circuitBreakerThreshold: 3.5 }));
    expect(result.circuitBreakerThreshold).toBe(3);
  });

  it('defaults to 3 when threshold is missing', () => {
    const { circuitBreakerThreshold: _t, ...rest } = validBase();
    const result = validateConfig(rest);
    expect(result.circuitBreakerThreshold).toBe(3);
  });

  // --- Circuit breaker cooldown ---

  it('passes valid cooldown (1000-3600000) through', () => {
    const result = validateConfig(validBase({ circuitBreakerCooldownMs: 120_000 }));
    expect(result.circuitBreakerCooldownMs).toBe(120_000);
  });

  it('passes through cooldown at boundaries (1000, 3600000)', () => {
    expect(validateConfig(validBase({ circuitBreakerCooldownMs: 1000 })).circuitBreakerCooldownMs).toBe(
      1000,
    );
    expect(validateConfig(validBase({ circuitBreakerCooldownMs: 3_600_000 })).circuitBreakerCooldownMs).toBe(
      3_600_000,
    );
  });

  it('defaults to 60000 for cooldown < 1000', () => {
    const result = validateConfig(validBase({ circuitBreakerCooldownMs: 500 }));
    expect(result.circuitBreakerCooldownMs).toBe(60_000);
  });

  it('defaults to 60000 for cooldown > 3600000', () => {
    const result = validateConfig(validBase({ circuitBreakerCooldownMs: 4_000_000 }));
    expect(result.circuitBreakerCooldownMs).toBe(60_000);
  });

  it('defaults to 60000 when cooldown is missing', () => {
    const { circuitBreakerCooldownMs: _c, ...rest } = validBase();
    const result = validateConfig(rest);
    expect(result.circuitBreakerCooldownMs).toBe(60_000);
  });

  // --- Request timeout ---

  it('passes valid timeout (1000-300000) through', () => {
    const result = validateConfig(validBase({ requestTimeoutMs: 60_000 }));
    expect(result.requestTimeoutMs).toBe(60_000);
  });

  it('passes through timeout at boundaries (1000, 300000)', () => {
    expect(validateConfig(validBase({ requestTimeoutMs: 1000 })).requestTimeoutMs).toBe(1000);
    expect(validateConfig(validBase({ requestTimeoutMs: 300_000 })).requestTimeoutMs).toBe(300_000);
  });

  it('defaults to 30000 for timeout < 1000', () => {
    const result = validateConfig(validBase({ requestTimeoutMs: 500 }));
    expect(result.requestTimeoutMs).toBe(30_000);
  });

  it('defaults to 30000 for timeout > 300000', () => {
    const result = validateConfig(validBase({ requestTimeoutMs: 400_000 }));
    expect(result.requestTimeoutMs).toBe(30_000);
  });

  it('defaults to 30000 when timeout is missing', () => {
    const { requestTimeoutMs: _r, ...rest } = validBase();
    const result = validateConfig(rest);
    expect(result.requestTimeoutMs).toBe(30_000);
  });

  // --- Allowed origins ---

  it('passes custom allowed origins through', () => {
    const origins = ['https://app.example.com', 'https://admin.example.com'];
    const result = validateConfig(validBase({ allowedOrigins: origins }));
    expect(result.allowedOrigins).toEqual(origins);
  });

  it('passes through single allowed origin', () => {
    const result = validateConfig(validBase({ allowedOrigins: ['https://app.example.com'] }));
    expect(result.allowedOrigins).toEqual(['https://app.example.com']);
  });

  it('defaults to localhost origins when missing', () => {
    const { allowedOrigins: _a, ...rest } = validBase();
    const result = validateConfig(rest);
    expect(result.allowedOrigins).toEqual([
      'http://localhost:*',
      'http://127.0.0.1:*',
    ]);
  });

  it('preserves empty array for allowedOrigins when explicitly set', () => {
    const result = validateConfig(validBase({ allowedOrigins: [] }));
    expect(result.allowedOrigins).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseCliArgs (via loadConfig) tests
// ---------------------------------------------------------------------------

describe('parseCliArgs (via loadConfig)', () => {
  const originalArgv = [...process.argv];

  beforeEach(() => {
    process.argv = ['node', 'script.js'];
    // Clear relevant env vars so they don't interfere
    delete process.env.PROXY_PORT;
    delete process.env.PROXY_HOST;
    delete process.env.UPSTREAM_BASE_URL;
    delete process.env.OPENCODE_GO_KEYS;
  });

  afterEach(() => {
    process.argv = [...originalArgv];
  });

  it('--port 8080 overrides port', () => {
    const tempDir = createTempDir();
    try {
      const yamlPath = join(tempDir, 'test.yaml');
      writeMinimalYaml(yamlPath);
      process.argv.push('--config', yamlPath, '--port', '8080');
      const result = loadConfig();
      expect(result.port).toBe(8080);
    } finally {
      removeTempDir(tempDir);
    }
  });

  it('--host 0.0.0.0 overrides host', () => {
    const tempDir = createTempDir();
    try {
      const yamlPath = join(tempDir, 'test.yaml');
      writeMinimalYaml(yamlPath);
      process.argv.push('--config', yamlPath, '--host', '0.0.0.0');
      const result = loadConfig();
      expect(result.host).toBe('0.0.0.0');
    } finally {
      removeTempDir(tempDir);
    }
  });

  it('--config custom.yaml uses custom config path', () => {
    const tempDir = createTempDir();
    try {
      const yamlPath = join(tempDir, 'custom.yaml');
      writeMinimalYaml(yamlPath);
      process.argv.push('--config', yamlPath);
      const result = loadConfig();
      // Minimal YAML has port 9090
      expect(result.port).toBe(9090);
    } finally {
      removeTempDir(tempDir);
    }
  });

  it('multiple flags work together', () => {
    const tempDir = createTempDir();
    try {
      const yamlPath = join(tempDir, 'test.yaml');
      writeMinimalYaml(yamlPath);
      process.argv.push('--config', yamlPath, '--port', '3001', '--host', '127.0.0.1');
      const result = loadConfig();
      expect(result.port).toBe(3001);
      expect(result.host).toBe('127.0.0.1');
    } finally {
      removeTempDir(tempDir);
    }
  });

  it('invalid port value is caught by validateConfig', () => {
    const tempDir = createTempDir();
    try {
      const yamlPath = join(tempDir, 'test.yaml');
      writeMinimalYaml(yamlPath);
      process.argv.push('--config', yamlPath, '--port', '70000');
      const result = loadConfig();
      expect(result.port).toBe(3000); // Invalid → defaulted back
    } finally {
      removeTempDir(tempDir);
    }
  });

  it('flag without value gets "true" but does not affect config', () => {
    const tempDir = createTempDir();
    try {
      const yamlPath = join(tempDir, 'test.yaml');
      writeMinimalYaml(yamlPath);
      process.argv.push('--config', yamlPath, '--unknown-flag');
      const result = loadConfig();
      // Should still load YAML values; unknown flag is ignored
      expect(result.port).toBe(9090);
    } finally {
      removeTempDir(tempDir);
    }
  });
});

// ---------------------------------------------------------------------------
// loadConfig tests
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  const originalArgv = [...process.argv];
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.argv = ['node', 'script.js'];
    // Clear relevant env vars
    delete process.env.PROXY_PORT;
    delete process.env.PROXY_HOST;
    delete process.env.UPSTREAM_BASE_URL;
    delete process.env.OPENCODE_GO_KEYS;
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.env = { ...originalEnv };
  });

  // --- Priority: CLI > YAML > env > defaults ---

  it('CLI args override YAML values', () => {
    const tempDir = createTempDir();
    try {
      const yamlPath = join(tempDir, 'test.yaml');
      writeMinimalYaml(yamlPath); // port = 9090
      process.argv.push('--port', '7000');
      const result = loadConfig(yamlPath);
      expect(result.port).toBe(7000);
    } finally {
      removeTempDir(tempDir);
    }
  });

  it('YAML values override environment variables', () => {
    const tempDir = createTempDir();
    try {
      const yamlPath = join(tempDir, 'test.yaml');
      writeMinimalYaml(yamlPath); // port = 9090
      process.env.PROXY_PORT = '5000';
      const result = loadConfig(yamlPath);
      expect(result.port).toBe(9090);
    } finally {
      removeTempDir(tempDir);
    }
  });

  it('Environment variables override defaults', () => {
    process.env.PROXY_PORT = '5000';
    process.env.OPENCODE_GO_KEYS = `test:${VALID_KEY}`;
    // Pass a path that does not exist to skip YAML
    const result = loadConfig(join(tmpdir(), 'nonexistent-config.yaml'));
    expect(result.port).toBe(5000);
  });

  it('Missing YAML file falls back to env/defaults', () => {
    process.env.PROXY_HOST = '0.0.0.0';
    process.env.OPENCODE_GO_KEYS = `test:${VALID_KEY}`;
    const result = loadConfig(join(tmpdir(), 'does-not-exist.yaml'));
    expect(result.host).toBe('0.0.0.0');
    // Other fields should use defaults
    expect(result.port).toBe(3000);
    expect(result.upstreamBaseUrl).toBe('https://opencode.ai');
  });

  // --- YAML file handling ---

  it('Valid YAML file is parsed correctly', () => {
    const tempDir = createTempDir();
    try {
      const yamlPath = join(tempDir, 'test.yaml');
      writeMinimalYaml(yamlPath);
      const result = loadConfig(yamlPath);
      expect(result.port).toBe(9090);
      expect(result.host).toBe('0.0.0.0');
      expect(result.upstreamBaseUrl).toBe('https://yaml.example.com');
      expect(result.circuitBreakerThreshold).toBe(7);
      expect(result.circuitBreakerCooldownMs).toBe(180_000);
      expect(result.requestTimeoutMs).toBe(90_000);
      expect(result.allowedOrigins).toEqual(['http://yaml-origin.example.com']);
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0].key).toBe(VALID_KEY);
    } finally {
      removeTempDir(tempDir);
    }
  });

  it('Invalid YAML logs error and falls back to env/defaults', () => {
    const tempDir = createTempDir();
    try {
      const yamlPath = join(tempDir, 'bad.yaml');
      writeFileSync(yamlPath, 'port: [bad yaml\n', 'utf-8'); // Invalid YAML
      process.env.PROXY_PORT = '7777';
      process.env.OPENCODE_GO_KEYS = `test:${VALID_KEY}`;
      const result = loadConfig(yamlPath);
      // Should fall back to env var
      expect(result.port).toBe(7777);
    } finally {
      removeTempDir(tempDir);
    }
  });

  it('Partial YAML (only some fields) merges with defaults', () => {
    const tempDir = createTempDir();
    try {
      const yamlPath = join(tempDir, 'partial.yaml');
      const content = [
        'port: 9090',
        'keys:',
        '  - label: partial',
        `    key: ${VALID_KEY}`,
        '',
      ].join('\n');
      writeFileSync(yamlPath, content, 'utf-8');
      const result = loadConfig(yamlPath);
      expect(result.port).toBe(9090);
      // Host should default
      expect(result.host).toBe('127.0.0.1');
      // Upstream should default
      expect(result.upstreamBaseUrl).toBe('https://opencode.ai');
    } finally {
      removeTempDir(tempDir);
    }
  });

  it('YAML with all fields uses all YAML values', () => {
    const tempDir = createTempDir();
    try {
      const yamlPath = join(tempDir, 'full.yaml');
      const content = [
        'port: 8080',
        'host: 10.0.0.1',
        'upstreamBaseUrl: https://upstream.example.com',
        'circuitBreakerThreshold: 8',
        'circuitBreakerCooldownMs: 240000',
        'requestTimeoutMs: 120000',
        'allowedOrigins:',
        '  - https://app.example.com',
        'keys:',
        '  - label: main',
        `    key: ${VALID_KEY}`,
        '  - label: secondary',
        `    key: ${VALID_KEY2}`,
        '',
      ].join('\n');
      writeFileSync(yamlPath, content, 'utf-8');
      const result = loadConfig(yamlPath);
      expect(result.port).toBe(8080);
      expect(result.host).toBe('10.0.0.1');
      expect(result.upstreamBaseUrl).toBe('https://upstream.example.com');
      expect(result.circuitBreakerThreshold).toBe(8);
      expect(result.circuitBreakerCooldownMs).toBe(240_000);
      expect(result.requestTimeoutMs).toBe(120_000);
      expect(result.allowedOrigins).toEqual(['https://app.example.com']);
      expect(result.keys).toHaveLength(2);
    } finally {
      removeTempDir(tempDir);
    }
  });

  // --- Environment variable handling ---

  it('PROXY_PORT env var sets port', () => {
    process.env.PROXY_PORT = '4000';
    process.env.OPENCODE_GO_KEYS = `test:${VALID_KEY}`;
    const result = loadConfig(join(tmpdir(), 'no-exist.yaml'));
    expect(result.port).toBe(4000);
  });

  it('PROXY_HOST env var sets host', () => {
    process.env.PROXY_HOST = '0.0.0.0';
    process.env.OPENCODE_GO_KEYS = `test:${VALID_KEY}`;
    const result = loadConfig(join(tmpdir(), 'no-exist.yaml'));
    expect(result.host).toBe('0.0.0.0');
  });

  it('UPSTREAM_BASE_URL env var sets upstream', () => {
    process.env.UPSTREAM_BASE_URL = 'https://env.example.com';
    process.env.OPENCODE_GO_KEYS = `test:${VALID_KEY}`;
    const result = loadConfig(join(tmpdir(), 'no-exist.yaml'));
    expect(result.upstreamBaseUrl).toBe('https://env.example.com');
  });

  it('OPENCODE_GO_KEYS env var parses key list', () => {
    process.env.OPENCODE_GO_KEYS = `test:${VALID_KEY},other:${VALID_KEY2}`;
    const result = loadConfig(join(tmpdir(), 'no-exist.yaml'));
    expect(result.keys).toHaveLength(2);
    expect(result.keys[0]).toEqual({ label: 'test', key: VALID_KEY });
    expect(result.keys[1]).toEqual({ label: 'other', key: VALID_KEY2 });
  });

  it('OPENCODE_GO_KEYS with invalid format (no colon) filters out', () => {
    // Without colon, the key is set to '' which fails startsWith('sk-')
    process.env.OPENCODE_GO_KEYS = 'no-colon-key';
    expect(() =>
      loadConfig(join(tmpdir(), 'no-exist.yaml')),
    ).toThrow('No valid API keys configured');
  });

  it('OPENCODE_GO_KEYS with non-sk- keys filters out', () => {
    process.env.OPENCODE_GO_KEYS = 'bad:no-sk-prefix-key-that-is-twenty-chars';
    expect(() =>
      loadConfig(join(tmpdir(), 'no-exist.yaml')),
    ).toThrow('No valid API keys configured');
  });

  it('Multiple env vars work together', () => {
    process.env.PROXY_PORT = '5000';
    process.env.PROXY_HOST = '0.0.0.0';
    process.env.UPSTREAM_BASE_URL = 'https://multi.env.example.com';
    process.env.OPENCODE_GO_KEYS = `multi:${VALID_KEY}`;
    const result = loadConfig(join(tmpdir(), 'no-exist.yaml'));
    expect(result.port).toBe(5000);
    expect(result.host).toBe('0.0.0.0');
    expect(result.upstreamBaseUrl).toBe('https://multi.env.example.com');
    expect(result.keys).toHaveLength(1);
  });

  // --- Config path parameter ---

  it('Explicit configPath parameter is used', () => {
    const tempDir = createTempDir();
    try {
      const yamlPath = join(tempDir, 'explicit.yaml');
      writeMinimalYaml(yamlPath);
      const result = loadConfig(yamlPath);
      expect(result.port).toBe(9090);
    } finally {
      removeTempDir(tempDir);
    }
  });

  it('Missing file at configPath falls back gracefully', () => {
    process.env.OPENCODE_GO_KEYS = `test:${VALID_KEY}`;
    const result = loadConfig(join(tmpdir(), 'no-such-file.yaml'));
    expect(result.port).toBe(3000);
    expect(result.host).toBe('127.0.0.1');
    expect(result.upstreamBaseUrl).toBe('https://opencode.ai');
  });

  // --- Integration: full priority chain ---

  it('Set env var, YAML file, and CLI arg for same field -> CLI wins', () => {
    const tempDir = createTempDir();
    try {
      const yamlPath = join(tempDir, 'chain.yaml');
      // YAML sets port to 7070
      const yamlContent = [
        'port: 7070',
        'keys:',
        '  - label: chain',
        `    key: ${VALID_KEY}`,
        '',
      ].join('\n');
      writeFileSync(yamlPath, yamlContent, 'utf-8');
      // Env sets port to 6060
      process.env.PROXY_PORT = '6060';
      // CLI sets port to 5050
      process.argv.push('--port', '5050');
      const result = loadConfig(yamlPath);
      expect(result.port).toBe(5050);
    } finally {
      removeTempDir(tempDir);
    }
  });

  it('Set env var and YAML for different fields -> both applied', () => {
    const tempDir = createTempDir();
    try {
      const yamlPath = join(tempDir, 'diff.yaml');
      // YAML sets port
      const yamlContent = [
        'port: 7070',
        'keys:',
        '  - label: diff',
        `    key: ${VALID_KEY}`,
        '',
      ].join('\n');
      writeFileSync(yamlPath, yamlContent, 'utf-8');
      // Env sets host (not in YAML)
      process.env.PROXY_HOST = '10.0.0.55';
      const result = loadConfig(yamlPath);
      expect(result.port).toBe(7070); // from YAML
      expect(result.host).toBe('10.0.0.55'); // from env
    } finally {
      removeTempDir(tempDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Encryption integration tests
// ---------------------------------------------------------------------------

describe('loadConfig — encryption', () => {
  const ENCRYPTION_KEY = 'test-encryption-key-at-least-16-chars';
  const VALID_PLAINTEXT = 'sk-test-key-that-is-at-least-20-chars-long';

  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'config-encrypt-test-'));
    delete process.env.OPENCODE_GO_ENCRYPTION_KEY;
    delete process.env.OPENCODE_GO_KEYS;
    delete process.env.PROXY_PORT;
    delete process.env.PROXY_HOST;
    delete process.env.UPSTREAM_BASE_URL;
    process.argv = ['node', 'script.js'];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
    process.argv = ['node', 'script.js'];
  });

  it('decrypts encrypted keys when OPENCODE_GO_ENCRYPTION_KEY is set', () => {
    const encrypted = encryptKey(VALID_PLAINTEXT, ENCRYPTION_KEY);
    const yamlPath = join(tempDir, 'config.yaml');
    writeFileSync(yamlPath, `keys:\n  - label: test\n    key: ${encrypted}\n`, 'utf-8');

    process.env.OPENCODE_GO_ENCRYPTION_KEY = ENCRYPTION_KEY;
    const config = loadConfig(yamlPath);

    expect(config.keys).toHaveLength(1);
    expect(config.keys[0].key).toBe(VALID_PLAINTEXT);
    expect(config.keys[0].label).toBe('test');
  });

  it('throws clear error when encrypted keys exist but OPENCODE_GO_ENCRYPTION_KEY is missing', () => {
    const encrypted = encryptKey(VALID_PLAINTEXT, ENCRYPTION_KEY);
    const yamlPath = join(tempDir, 'config.yaml');
    writeFileSync(yamlPath, `keys:\n  - label: test\n    key: ${encrypted}\n`, 'utf-8');

    expect(() => loadConfig(yamlPath)).toThrow('OPENCODE_GO_ENCRYPTION_KEY');
  });

  it('throws clear error when OPENCODE_GO_ENCRYPTION_KEY is wrong', () => {
    const encrypted = encryptKey(VALID_PLAINTEXT, ENCRYPTION_KEY);
    const yamlPath = join(tempDir, 'config.yaml');
    writeFileSync(yamlPath, `keys:\n  - label: test\n    key: ${encrypted}\n`, 'utf-8');

    process.env.OPENCODE_GO_ENCRYPTION_KEY = 'wrong-key-that-is-also-long-enough';
    expect(() => loadConfig(yamlPath)).toThrow('Failed to decrypt');
  });

  it('handles mixed plaintext and encrypted keys', () => {
    const encrypted = encryptKey(VALID_PLAINTEXT, ENCRYPTION_KEY);
    const plaintext2 = 'sk-another-valid-key-twenty-chars!!';
    const yamlPath = join(tempDir, 'config.yaml');
    writeFileSync(yamlPath, `keys:\n  - label: enc\n    key: ${encrypted}\n  - label: plain\n    key: ${plaintext2}\n`, 'utf-8');

    process.env.OPENCODE_GO_ENCRYPTION_KEY = ENCRYPTION_KEY;
    const config = loadConfig(yamlPath);

    expect(config.keys).toHaveLength(2);
    expect(config.keys[0].key).toBe(VALID_PLAINTEXT);
    expect(config.keys[0].label).toBe('enc');
    expect(config.keys[1].key).toBe(plaintext2);
    expect(config.keys[1].label).toBe('plain');
  });
});

// ---------------------------------------------------------------------------
// Scraping config tests
// ---------------------------------------------------------------------------

const ENCRYPTION_KEY = 'test-encryption-key-at-least-16-chars';

describe('validateConfig — scraping', () => {
  it('defaults scraping to undefined when not provided', () => {
    const result = validateConfig(validBase());
    expect(result.scraping).toBeUndefined();
  });

  it('passes valid scraping config through', () => {
    const scraping = {
      enabled: true,
      intervalMs: 60_000,
      usageThreshold: 75,
      accounts: [
        { workspaceId: 'wrk_abc123', authCookie: 'cookie1' },
        { workspaceId: 'wrk_def456', authCookie: 'cookie2' },
      ],
    };
    const result = validateConfig(validBase({ scraping }));
    expect(result.scraping).toEqual(scraping);
  });

  it('defaults enabled to false when missing', () => {
    const scraping = {
      intervalMs: 60_000,
      usageThreshold: 50,
      accounts: [],
    } as any;
    const result = validateConfig(validBase({ scraping }));
    expect(result.scraping?.enabled).toBe(false);
  });

  it('defaults intervalMs to 90000 when missing', () => {
    const scraping = {
      enabled: true,
      usageThreshold: 50,
      accounts: [],
    } as any;
    const result = validateConfig(validBase({ scraping }));
    expect(result.scraping?.intervalMs).toBe(90_000);
  });

  it('defaults intervalMs to 90000 for value < 10000', () => {
    const scraping = {
      enabled: true,
      intervalMs: 5000,
      usageThreshold: 50,
      accounts: [],
    };
    const result = validateConfig(validBase({ scraping }));
    expect(result.scraping?.intervalMs).toBe(90_000);
  });

  it('defaults intervalMs to 90000 for value > 3600000', () => {
    const scraping = {
      enabled: true,
      intervalMs: 4_000_000,
      usageThreshold: 50,
      accounts: [],
    };
    const result = validateConfig(validBase({ scraping }));
    expect(result.scraping?.intervalMs).toBe(90_000);
  });

  it('defaults intervalMs to 90000 for non-integer', () => {
    const scraping = {
      enabled: true,
      intervalMs: 60_000.5,
      usageThreshold: 50,
      accounts: [],
    };
    const result = validateConfig(validBase({ scraping }));
    expect(result.scraping?.intervalMs).toBe(90_000);
  });

  it('defaults usageThreshold to 50 when missing', () => {
    const scraping = {
      enabled: true,
      intervalMs: 60_000,
      accounts: [],
    } as any;
    const result = validateConfig(validBase({ scraping }));
    expect(result.scraping?.usageThreshold).toBe(50);
  });

  it('defaults usageThreshold to 50 for value < 1', () => {
    const scraping = {
      enabled: true,
      intervalMs: 60_000,
      usageThreshold: 0,
      accounts: [],
    };
    const result = validateConfig(validBase({ scraping }));
    expect(result.scraping?.usageThreshold).toBe(50);
  });

  it('defaults usageThreshold to 50 for value > 100', () => {
    const scraping = {
      enabled: true,
      intervalMs: 60_000,
      usageThreshold: 101,
      accounts: [],
    };
    const result = validateConfig(validBase({ scraping }));
    expect(result.scraping?.usageThreshold).toBe(50);
  });

  it('defaults usageThreshold to 50 for non-integer', () => {
    const scraping = {
      enabled: true,
      intervalMs: 60_000,
      usageThreshold: 50.5,
      accounts: [],
    };
    const result = validateConfig(validBase({ scraping }));
    expect(result.scraping?.usageThreshold).toBe(50);
  });

  it('passes through usageThreshold at boundaries (1, 100)', () => {
    expect(
      validateConfig(validBase({ scraping: { enabled: true, intervalMs: 60_000, usageThreshold: 1, accounts: [] } })).scraping?.usageThreshold,
    ).toBe(1);
    expect(
      validateConfig(validBase({ scraping: { enabled: true, intervalMs: 60_000, usageThreshold: 100, accounts: [] } })).scraping?.usageThreshold,
    ).toBe(100);
  });

  it('defaults accounts to empty array when missing', () => {
    const scraping = {
      enabled: true,
      intervalMs: 60_000,
      usageThreshold: 50,
    } as any;
    const result = validateConfig(validBase({ scraping }));
    expect(result.scraping?.accounts).toEqual([]);
  });

  it('filters out accounts with invalid workspaceId format', () => {
    const scraping = {
      enabled: true,
      intervalMs: 60_000,
      usageThreshold: 50,
      accounts: [
        { workspaceId: 'wrk_valid123', authCookie: 'cookie1' },
        { workspaceId: 'invalid-no-prefix', authCookie: 'cookie2' },
        { workspaceId: 'wrk_', authCookie: 'cookie3' }, // too short after prefix
        { workspaceId: 'wrk_valid456', authCookie: 'cookie4' },
      ],
    };
    const result = validateConfig(validBase({ scraping }));
    expect(result.scraping?.accounts).toHaveLength(2);
    expect(result.scraping?.accounts[0].workspaceId).toBe('wrk_valid123');
    expect(result.scraping?.accounts[1].workspaceId).toBe('wrk_valid456');
  });

  it('filters out accounts with empty authCookie', () => {
    const scraping = {
      enabled: true,
      intervalMs: 60_000,
      usageThreshold: 50,
      accounts: [
        { workspaceId: 'wrk_valid123', authCookie: 'cookie1' },
        { workspaceId: 'wrk_valid456', authCookie: '' },
      ],
    };
    const result = validateConfig(validBase({ scraping }));
    expect(result.scraping?.accounts).toHaveLength(1);
    expect(result.scraping?.accounts[0].workspaceId).toBe('wrk_valid123');
  });

  it('allows encrypted authCookie values', () => {
    const encrypted = encryptKey('real-cookie-value', ENCRYPTION_KEY);
    const scraping = {
      enabled: true,
      intervalMs: 60_000,
      usageThreshold: 50,
      accounts: [
        { workspaceId: 'wrk_valid123', authCookie: encrypted },
      ],
    };
    const result = validateConfig(validBase({ scraping }));
    expect(result.scraping?.accounts).toHaveLength(1);
    expect(result.scraping?.accounts[0].authCookie).toBe(encrypted);
  });

  it('scraping with enabled: false still validates accounts', () => {
    const scraping = {
      enabled: false,
      intervalMs: 60_000,
      usageThreshold: 50,
      accounts: [
        { workspaceId: 'invalid', authCookie: 'cookie' },
      ],
    };
    const result = validateConfig(validBase({ scraping }));
    expect(result.scraping?.enabled).toBe(false);
    expect(result.scraping?.accounts).toHaveLength(0); // filtered out
  });
});

describe('loadConfig — scraping', () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'config-scraping-test-'));
    delete process.env.OPENCODE_GO_ENCRYPTION_KEY;
    delete process.env.OPENCODE_GO_KEYS;
    delete process.env.PROXY_PORT;
    delete process.env.PROXY_HOST;
    delete process.env.UPSTREAM_BASE_URL;
    process.argv = ['node', 'script.js'];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
    process.argv = ['node', 'script.js'];
  });

  it('loads scraping config from YAML', () => {
    const yamlPath = join(tempDir, 'config.yaml');
    const content = [
      'keys:',
      `  - label: test`,
      `    key: ${VALID_KEY}`,
      'scraping:',
      '  enabled: true',
      '  intervalMs: 120000',
      '  usageThreshold: 75',
      '  accounts:',
      '    - workspaceId: wrk_abc123',
      '      authCookie: cookie1',
      '    - workspaceId: wrk_def456',
      '      authCookie: cookie2',
      '',
    ].join('\n');
    writeFileSync(yamlPath, content, 'utf-8');

    const config = loadConfig(yamlPath);
    expect(config.scraping).toBeDefined();
    expect(config.scraping?.enabled).toBe(true);
    expect(config.scraping?.intervalMs).toBe(120_000);
    expect(config.scraping?.usageThreshold).toBe(75);
    expect(config.scraping?.accounts).toHaveLength(2);
    expect(config.scraping?.accounts[0].workspaceId).toBe('wrk_abc123');
    expect(config.scraping?.accounts[1].workspaceId).toBe('wrk_def456');
  });

  it('scraping section is optional — missing section means undefined', () => {
    const yamlPath = join(tempDir, 'config.yaml');
    const content = [
      'keys:',
      `  - label: test`,
      `    key: ${VALID_KEY}`,
      '',
    ].join('\n');
    writeFileSync(yamlPath, content, 'utf-8');

    const config = loadConfig(yamlPath);
    expect(config.scraping).toBeUndefined();
  });

  it('decrypts encrypted authCookies when OPENCODE_GO_ENCRYPTION_KEY is set', () => {
    const encrypted = encryptKey('real-cookie-value', ENCRYPTION_KEY);
    const yamlPath = join(tempDir, 'config.yaml');
    const content = [
      'keys:',
      `  - label: test`,
      `    key: ${VALID_KEY}`,
      'scraping:',
      '  enabled: true',
      '  intervalMs: 60000',
      '  usageThreshold: 50',
      '  accounts:',
      '    - workspaceId: wrk_abc123',
      `      authCookie: ${encrypted}`,
      '',
    ].join('\n');
    writeFileSync(yamlPath, content, 'utf-8');

    process.env.OPENCODE_GO_ENCRYPTION_KEY = ENCRYPTION_KEY;
    const config = loadConfig(yamlPath);

    expect(config.scraping?.accounts).toHaveLength(1);
    expect(config.scraping?.accounts[0].authCookie).toBe('real-cookie-value');
  });

  it('throws when encrypted authCookies exist but OPENCODE_GO_ENCRYPTION_KEY is missing', () => {
    const encrypted = encryptKey('real-cookie-value', ENCRYPTION_KEY);
    const yamlPath = join(tempDir, 'config.yaml');
    const content = [
      'keys:',
      `  - label: test`,
      `    key: ${VALID_KEY}`,
      'scraping:',
      '  enabled: true',
      '  accounts:',
      '    - workspaceId: wrk_abc123',
      `      authCookie: ${encrypted}`,
      '',
    ].join('\n');
    writeFileSync(yamlPath, content, 'utf-8');

    expect(() => loadConfig(yamlPath)).toThrow('OPENCODE_GO_ENCRYPTION_KEY');
  });

  it('throws when OPENCODE_GO_ENCRYPTION_KEY is wrong for authCookie', () => {
    const encrypted = encryptKey('real-cookie-value', ENCRYPTION_KEY);
    const yamlPath = join(tempDir, 'config.yaml');
    const content = [
      'keys:',
      `  - label: test`,
      `    key: ${VALID_KEY}`,
      'scraping:',
      '  enabled: true',
      '  accounts:',
      '    - workspaceId: wrk_abc123',
      `      authCookie: ${encrypted}`,
      '',
    ].join('\n');
    writeFileSync(yamlPath, content, 'utf-8');

    process.env.OPENCODE_GO_ENCRYPTION_KEY = 'wrong-key-that-is-also-long-enough';
    expect(() => loadConfig(yamlPath)).toThrow('Failed to decrypt');
  });

  it('handles mixed plaintext and encrypted authCookies', () => {
    const encrypted = encryptKey('encrypted-cookie', ENCRYPTION_KEY);
    const yamlPath = join(tempDir, 'config.yaml');
    const content = [
      'keys:',
      `  - label: test`,
      `    key: ${VALID_KEY}`,
      'scraping:',
      '  enabled: true',
      '  accounts:',
      '    - workspaceId: wrk_abc123',
      `      authCookie: ${encrypted}`,
      '    - workspaceId: wrk_def456',
      '      authCookie: plaintext-cookie',
      '',
    ].join('\n');
    writeFileSync(yamlPath, content, 'utf-8');

    process.env.OPENCODE_GO_ENCRYPTION_KEY = ENCRYPTION_KEY;
    const config = loadConfig(yamlPath);

    expect(config.scraping?.accounts).toHaveLength(2);
    expect(config.scraping?.accounts[0].authCookie).toBe('encrypted-cookie');
    expect(config.scraping?.accounts[1].authCookie).toBe('plaintext-cookie');
  });
});
