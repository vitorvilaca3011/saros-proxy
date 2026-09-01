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
import { bareModelName, annotateName } from '../cli/harness-models.js';
import type { ProxyConfig } from '../config.js';

describe('rotation-width annotation', () => {
  it('normalizes vendor ids to bare names', () => {
    expect(bareModelName('deepseek/deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(bareModelName('GLM-5')).toBe('glm-5');
    expect(bareModelName('gpt_5_mini')).toBe('gpt-5-mini');
  });

  it('annotates names with the serving-key count', () => {
    expect(annotateName('DeepSeek V4 Flash', 3)).toBe('DeepSeek V4 Flash (3)');
    expect(annotateName('Claude Sonnet 5', 1)).toBe('Claude Sonnet 5 (1)');
    expect(annotateName('No keys model', 0)).toBe('No keys model');
  });
});

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

  it('excludes providers that definitively reject the model', () => {
    // claude-opus-5: commandcode yes, opencode-go no (no claude in its catalog)
    const state = makeMixedState((provider, modelId) => {
      if (modelId !== 'claude-opus-5') return 'maybe';
      return provider === 'commandcode' ? 'yes' : 'no';
    });
    const snap = selectKeyForRequest(state, 'r1', 'claude-opus-5');
    expect(snap?.provider).toBe('commandcode');
  });

  it('shared models (both yes) rotate across ALL serving keys', () => {
    // deepseek-v4-flash: both providers claim it → the round-robin must
    // alternate between the two keys instead of monopolizing one.
    const state = makeMixedState(() => 'yes');
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const snap = selectKeyForRequest(state, 'rr-' + i, 'deepseek-v4-flash');
      if (snap) seen.add(snap.provider);
    }
    expect(seen.size).toBe(2);
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
