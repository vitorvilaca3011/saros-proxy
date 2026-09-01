/**
 * index.ts — Provider registry and key identification.
 *
 * identifyKey() classifies a pasted key by pinging candidate providers in
 * parallel: a 200 is a definitive positive, a 401/403 a definitive negative,
 * network errors are inconclusive. Handles the sk- collision between
 * opencode-go and commandcode empirically.
 */
import { opencodeGoProvider } from './opencode-go.js';
import { commandcodeProvider } from './commandcode.js';
import type { KeyProvider, ProviderId, SmokeResult } from './types.js';

export * from './types.js';
export { inferProvider, type KeyEntry } from './infer.js';
export { opencodeGoProvider, parseOpencodeUsage } from './opencode-go.js';
export {
  commandcodeProvider,
  commandcodeClientHeaders,
  resolveClientVersion,
  parsePlanId,
  COMMANDCODE_BASE_URL,
  COMMANDCODE_BILLING_PATH,
} from './commandcode.js';

const ALL_PROVIDERS: readonly KeyProvider[] = [opencodeGoProvider, commandcodeProvider];

/** Get a provider by id. */
export function getProvider(id: ProviderId): KeyProvider | undefined {
  return ALL_PROVIDERS.find((p) => p.id === id);
}

/** All registered providers. */
export function allProviders(): readonly KeyProvider[] {
  return ALL_PROVIDERS;
}

/** Structural validity: at least one provider accepts the format. */
export function isPlausibleKey(key: string): boolean {
  return ALL_PROVIDERS.some((p) => p.quickMatch(key) !== 'no');
}

/** Providers whose quickMatch does not rule the key out. */
function candidates(key: string): KeyProvider[] {
  return ALL_PROVIDERS.filter((p) => p.quickMatch(key) !== 'no');
}

export interface KeyIdentification {
  /** Provider the key belongs to, or null when unknown/invalid. */
  provider: ProviderId | null;
  /** 'unverified' when only the prefix matched (no definitive ping). */
  confidence: 'verified' | 'unverified' | 'invalid' | 'unknown';
  /** Per-provider smoke results (diagnostics for the TUI). */
  attempts: SmokeResult[];
}

/**
 * Identify which provider a key belongs to.
 *
 * Decision tree:
 * 1. Providers whose prefix says 'no' are skipped entirely.
 * 2. Remaining candidates are smoke-tested in parallel.
 * 3. First 'valid' wins (definitive positive).
 * 4. All candidates 'invalid' → the key is rejected.
 * 5. Only inconclusive 'error' results → unknown (network problem).
 * 6. No candidates at all → prefix not recognized by any provider.
 *
 * When `verify: false`, skips the network and returns the prefix-level
 * answer ('unverified') — used by config validation where offline tolerance
 * is required.
 */
export async function identifyKey(
  key: string,
  options?: { verify?: boolean; timeoutMs?: number },
): Promise<KeyIdentification> {
  const cands = candidates(key);
  if (cands.length === 0) {
    return { provider: null, confidence: 'unknown', attempts: [] };
  }

  if (options?.verify === false) {
    const unique = new Set(cands.map((c) => c.id));
    const provider = unique.size === 1 ? cands[0]!.id : null;
    return { provider, confidence: 'unverified', attempts: [] };
  }

  const attempts = await Promise.all(
    cands.map((c) => c.smokeTest(key, options?.timeoutMs)),
  );

  const valid = attempts.find((a) => a.status === 'valid');
  if (valid) {
    return { provider: valid.provider, confidence: 'verified', attempts };
  }
  if (attempts.every((a) => a.status === 'invalid')) {
    return { provider: null, confidence: 'invalid', attempts };
  }
  return { provider: null, confidence: 'unknown', attempts };
}

/**
 * Extract candidate API keys from arbitrary pasted text (TUI drop-a-key
 * flow). Matches user_... and sk-... tokens of plausible length; dedupes.
 */
export function extractKeys(text: string): string[] {
  const matches = text.match(/(?:user_|sk-)[A-Za-z0-9_-]{16,}/g) ?? [];
  return [...new Set(matches)];
}
