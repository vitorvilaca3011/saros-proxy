/**
 * routing.test.ts — Tests for provider inference and multi-provider
 * upstream routing (config + proxy).
 */
import { describe, it, expect } from 'vitest';
import { inferProvider } from './infer.js';
import { resolveUpstreamUrl } from '../proxy.js';
import { getProvider } from './index.js';
import type { ProxyConfig } from '../config.js';

const og = getProvider('opencode-go')!;
const cc = getProvider('commandcode')!;

describe('inferProvider', () => {
  it('explicit provider field wins', () => {
    expect(inferProvider({ label: 'a', key: 'user_abcdefghijklmnop', provider: 'opencode-go' })).toBe('opencode-go');
    expect(inferProvider({ label: 'a', key: 'sk-abcdefghijklmnop', provider: 'commandcode' })).toBe('commandcode');
  });

  it('user_ keys infer commandcode', () => {
    expect(inferProvider({ label: 'a', key: 'user_' + 'x'.repeat(30) })).toBe('commandcode');
  });

  it('sk- keys default to opencode-go (back-compat)', () => {
    expect(inferProvider({ label: 'a', key: 'sk-' + 'x'.repeat(30) })).toBe('opencode-go');
  });
});

describe('resolveUpstreamUrl', () => {
  const baseConfig: ProxyConfig = {
    port: 3000,
    host: '127.0.0.1',
    keys: [],
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
    upstreamBaseUrl: 'https://opencode.ai',
    upstreams: {},
    requestTimeoutMs: 30_000,
    allowedOrigins: [],
  };

  it('opencode-go keeps canonical /zen/go/v1 paths', () => {
    const url = resolveUpstreamUrl(baseConfig, og, '/zen/go/v1/chat/completions');
    expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
  });

  it('commandcode remaps /zen/go/v1 to /provider/v1', () => {
    const url = resolveUpstreamUrl(baseConfig, cc, '/zen/go/v1/chat/completions');
    expect(url).toBe('https://api.commandcode.ai/provider/v1/chat/completions');
  });

  it('commandcode passes through non-canonical paths unchanged', () => {
    const url = resolveUpstreamUrl(baseConfig, cc, '/provider/v1/models');
    expect(url).toBe('https://api.commandcode.ai/provider/v1/models');
  });

  it('per-provider upstream override wins over defaults', () => {
    const cfg = { ...baseConfig, upstreams: { commandcode: 'https://cc-mirror.example.com' } };
    const url = resolveUpstreamUrl(cfg, cc, '/zen/go/v1/models');
    expect(url).toBe('https://cc-mirror.example.com/provider/v1/models');
  });

  it('opencode-go upstream override replaces upstreamBaseUrl', () => {
    const cfg = { ...baseConfig, upstreams: { 'opencode-go': 'https://oc-mirror.example.com' } };
    const url = resolveUpstreamUrl(cfg, og, '/zen/go/v1/usage');
    expect(url).toBe('https://oc-mirror.example.com/zen/go/v1/usage');
  });
});
