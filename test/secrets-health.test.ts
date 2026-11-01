/**
 * secrets-health.test.ts — /health reports which keys are encrypted without
 * ever exposing the credential or the envelope.
 */
import { describe, it, expect } from 'vitest';
import { createProxyApp } from '../src/proxy.js';
import type { ProxyConfig } from '../src/config.js';

const PLAINTEXT = 'sk-health-fixture-key-long-enough-0001';

function config(): ProxyConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    upstreamBaseUrl: 'https://example.com',
    requestTimeoutMs: 30_000,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
    allowedOrigins: ['http://localhost:*'],
    keys: [
      { label: 'sealed', key: PLAINTEXT, encrypted: true },
      { label: 'plain', key: PLAINTEXT, encrypted: false },
    ],
  };
}

describe('/health encrypted flag', () => {
  it('marks encrypted keys and never includes the credential', async () => {
    const app = createProxyApp(config());
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      keys: Array<Record<string, unknown>>;
    };

    expect(body.keys).toEqual([
      expect.objectContaining({ label: 'sealed', encrypted: true }),
      expect.objectContaining({ label: 'plain', encrypted: false }),
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(PLAINTEXT);
    expect(serialized).not.toContain('enc:v1:');
    for (const key of body.keys) {
      expect(key).not.toHaveProperty('key');
    }
  });
});
