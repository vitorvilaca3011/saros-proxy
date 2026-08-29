/**
 * affinity-routing.test.ts — Tests for model→provider affinity routing
 * (mixed-provider key pools) and the @provider suffix routing shim.
 */
import { describe, it, expect } from 'vitest';
import { createProxyState, selectKeyForRequest, type ProxyState } from '../proxy-logic.js';
import {
  parseProviderSuffix,
  stripProviderSuffix,
  resolveUpstreamUrl,
} from '../proxy.js';
import { getProvider } from './index.js';
import type { ProxyConfig } from '../config.js';

/** Two-key mixed pool: opencode-go + commandcode. */
function makeMixedState(affinity?: ProxyState['affinityResolver']): ProxyState {
  const state = createProxyState([
    { label: 'oc', key: 'sk-opencode-key-000000', provider: 'opencode-go' },
    { label: 'cc', key: 'user_commandcode-key-000000', provider: 'commandcode' },
  ]);
  state.affinityResolver = affinity;
  return state;
}

describe('provider suffix routing helpers', () => {
  it('parses a trailing @provider suffix', () => {
    expect(parseProviderSuffix('claude-opus-5@commandcode')).toBe('commandcode');
    expect(parseProviderSuffix('vendor/model@commandcode')).toBe('commandcode');
  });

  it('returns null when there is no suffix', () => {
    expect(parseProviderSuffix('glm-5')).toBeNull();
    expect(parseProviderSuffix('a@b@c')).toBe('c'); // last segment wins
    expect(parseProviderSuffix('@leading')).toBeNull();
    expect(parseProviderSuffix(undefined)).toBeNull();
  });

  it('strips the suffix for upstream forwarding', () => {
    expect(stripProviderSuffix('claude-opus-5@commandcode')).toBe('claude-opus-5');
    expect(stripProviderSuffix('glm-5')).toBe('glm-5');
  });
});

describe('affinity-aware key selection', () => {
  it('without a resolver or modelId, picks any key (legacy behavior)', () => {
    const state = makeMixedState();
    const snap = selectKeyForRequest(state, 'r1', 'claude-opus-5');
    expect(snap).not.toBeNull();
  });

  it('prefers keys of providers that yes-match the model', () => {
    const state = makeMixedState((provider, modelId) => {
      if (modelId === 'claude-opus-5') return provider === 'commandcode' ? 'yes' : 'maybe';
      return 'maybe';
    });
    const snap = selectKeyForRequest(state, 'r1', 'claude-opus-5');
    expect(snap?.provider).toBe('commandcode');
  });

  it('falls back to any provider when the preferred pool is busy', () => {
    const state = makeMixedState((provider, modelId) =>
      modelId === 'claude-opus-5' && provider === 'commandcode' ? 'yes' : 'maybe',
    );
    // Occupy the commandcode key with another request
    selectKeyForRequest(state, 'other-req', 'claude-opus-5');
    // This request must still get a key (opencode-go fallback), not null
    const snap = selectKeyForRequest(state, 'r1', 'claude-opus-5');
    expect(snap).not.toBeNull();
  });

  it('no provider claiming the model → any key qualifies', () => {
    const state = makeMixedState(() => 'no');
    const snap = selectKeyForRequest(state, 'r1', 'glm-5');
    expect(snap).not.toBeNull();
  });
});

describe('suffix-routed upstream resolution', () => {
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

  it('commandcode provider remaps canonical prefix', () => {
    const cc = getProvider('commandcode')!;
    const url = resolveUpstreamUrl(baseConfig, cc, '/zen/go/v1/chat/completions');
    expect(url).toBe('https://api.commandcode.ai/provider/v1/chat/completions');
  });

  it('opencode-go provider keeps the canonical prefix', () => {
    const og = getProvider('opencode-go')!;
    const url = resolveUpstreamUrl(baseConfig, og, '/zen/go/v1/chat/completions');
    expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
  });
});
