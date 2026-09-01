/**
 * infer.ts — Synchronous provider inference for config-time decisions.
 *
 * Config loading must never block on network I/O, so the provider for each
 * key is inferred structurally here ('user_' → commandcode; 'sk-' →
 * opencode-go, the legacy default). The authoritative, empirical answer
 * comes from identifyKey() (async, network) — the setup wizard uses it and
 * persists the result as an explicit `provider` field in config.yaml.
 */
import type { ProviderId } from './types.js';

export interface KeyEntry {
  label: string;
  key: string;
  /** Explicit provider from config.yaml; wins over inference when present. */
  provider?: ProviderId;
}

/**
 * Infer the provider for a key entry.
 * Explicit `provider` field wins; 'user_' keys are commandcode; everything
 * else plausible defaults to opencode-go (back-compat with every existing
 * config.yaml).
 */
export function inferProvider(entry: KeyEntry): ProviderId {
  if (entry.provider === 'commandcode' || entry.provider === 'opencode-go') {
    return entry.provider;
  }
  return entry.key.startsWith('user_') ? 'commandcode' : 'opencode-go';
}
