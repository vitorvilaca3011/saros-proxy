/**
 * upstream-log-redaction.test.ts — a provider that echoes the submitted bearer
 * must not put a working key into the log stream.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const warnings = vi.hoisted(() => [] as unknown[][]);

vi.mock('../src/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/logger.js')>();
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      // pino's warn(obj, msg, ...interp): the upstream body arrives as an
      // interpolation argument, so capture every argument, not just the object.
      warn: vi.fn((...args: unknown[]) => {
        warnings.push(args);
      }),
      error: vi.fn(),
      debug: vi.fn(),
      level: 'info',
    },
  };
});

import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'saros-redact-test-'));

import { createProxyApp } from '../src/proxy.js';
import type { ProxyConfig } from '../src/config.js';

function makeConfig(): ProxyConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    upstreamBaseUrl: 'https://example.com',
    requestTimeoutMs: 30_000,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
    allowedOrigins: ['*'],
    keys: [{ label: 'alpha', key: 'sk-alpha-key-0001' }],
  };
}

describe('upstream error logging', () => {
  beforeEach(() => {
    warnings.length = 0;
  });

  it('redacts a key the upstream echoed back', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"error":"Incorrect API key provided: sk-leaked-key-abcdef123456"}', {
        status: 401,
      }),
    );
    const app = createProxyApp(makeConfig());

    await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [] }),
      headers: { 'content-type': 'application/json' },
    });

    const dump = JSON.stringify(warnings);
    expect(dump).toContain('[redacted-key]');
    expect(dump).not.toContain('sk-leaked-key-abcdef123456');
  });
});
