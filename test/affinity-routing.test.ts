/**
 * affinity-routing.test.ts — Tests for model→provider affinity routing
 * (mixed-provider key pools) and the @provider suffix routing shim.
 */
import { describe, it, expect } from 'vitest';
import { createProxyState, selectKeyForRequest, failoverRequest, markKeyFailed, type ProxyState } from '../src/proxy-logic.js';
import {
  parseProviderSuffix,
  stripProviderSuffix,
  resolveUpstreamUrl,
} from '../src/proxy.js';
import { getProvider } from '../src/providers/index.js';
import { bareModelName, annotateName } from '../src/cli/harness-models.js';
import type { ProxyConfig } from '../src/config.js';

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

describe('provider pin (@provider) key selection', () => {
  /**
   * Mirrors the live catalogs: the resolver sees the raw id, suffix included,
   * so no catalog recognises it. Before the fix every provider answered 'no'
   * for a pinned bare id and the filter excluded the whole pool (503).
   */
  const catalogLike = (provider: string, modelId: string): 'yes' | 'no' | 'maybe' => {
    if (modelId.includes('@')) return 'no';
    const bare = modelId.split('/').pop() ?? modelId;
    if (bare === 'claude-opus-5') return provider === 'commandcode' ? 'yes' : 'no';
    return 'yes';
  };

  it('pins a bare model id to the named provider', () => {
    const state = makeMixedState(catalogLike);
    const snap = selectKeyForRequest(state, 'pin-cc', 'deepseek-v4.1-flash@commandcode');
    expect(snap?.provider).toBe('commandcode');
  });

  it('pins the inverse provider on a bare id', () => {
    const state = makeMixedState(catalogLike);
    const snap = selectKeyForRequest(state, 'pin-oc', 'deepseek-v4.1-flash@opencode-go');
    expect(snap?.provider).toBe('opencode-go');
  });

  it('keeps slash-carrying ids working under a pin', () => {
    const state = makeMixedState(catalogLike);
    const snap = selectKeyForRequest(state, 'pin-slash', 'deepseek/deepseek-v4-flash-fast@opencode-go');
    expect(snap?.provider).toBe('opencode-go');
  });

  it('honours the pin even when the catalog rejects the model', () => {
    // The pin is an explicit user instruction and providerForKey routes to the
    // pinned upstream unconditionally, so selection must match it. Whether the
    // provider can actually serve the model is the upstream's call — and its
    // error is far more useful than a generic 503.
    const state = makeMixedState(catalogLike);
    const snap = selectKeyForRequest(state, 'pin-exclusive', 'claude-opus-5@opencode-go');
    expect(snap?.provider).toBe('opencode-go');
  });

  it('returns null when the pinned provider has no key in the pool', () => {
    const state = makeMixedState(catalogLike);
    expect(selectKeyForRequest(state, 'pin-unknown', 'deepseek-v4.1-flash@other-provider')).toBeNull();
  });

  it('keeps the pin during failover instead of crossing providers', () => {
    const state = makeMixedState(catalogLike);
    const first = selectKeyForRequest(state, 'fo-1', 'glm-5@opencode-go');
    expect(first?.provider).toBe('opencode-go');

    // The pinned provider only has one key here; failing over must not reach
    // for the commandcode key that cannot serve the pinned upstream.
    expect(failoverRequest(state, 'fo-1')).toBeNull();
  });

  it('returns null, not a fallback, when every pinned key is out', () => {
    const state = makeMixedState(catalogLike);
    markKeyFailed(state, 'oc', 'KeyFault');

    expect(selectKeyForRequest(state, 'pin-out', 'glm-5@opencode-go')).toBeNull();
  });

  it('keeps cross-provider rotation when no pin is given', () => {
    const state = makeMixedState(catalogLike);
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const snap = selectKeyForRequest(state, `free-${i}`, 'deepseek-v4.1-flash');
      if (snap) seen.add(snap.provider);
    }
    expect(seen.size).toBe(2);
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
