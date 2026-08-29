/**
 * types.ts — Provider abstraction for multi-provider API key support.
 *
 * A KeyProvider encapsulates everything saros needs to know about one
 * upstream API platform: how to recognize its keys structurally, how to
 * verify them with a cheap network ping (smoke test), where its usage
 * endpoint lives, and how to parse its usage response shape.
 */

export type ProviderId = 'opencode-go' | 'commandcode';

/** Result of a provider smoke test (key verification ping). */
export interface SmokeResult {
  /** Provider that ran the test. */
  provider: ProviderId;
  /**
   * - 'valid'      — key authenticated successfully (HTTP 200)
   * - 'invalid'    — upstream definitively rejected the key (401/403 auth)
   * - 'error'      — network/timeout/5xx; inconclusive, may retry
   */
  status: 'valid' | 'invalid' | 'error';
  /** HTTP status code when available. */
  httpStatus?: number;
  /** Human-readable detail (safe to show in the TUI — never the key). */
  detail?: string;
  /** Provider-specific extras (e.g. commandcode planId). */
  meta?: Record<string, string>;
}

/** Structural prefix check result. */
export type PrefixMatch = 'yes' | 'no' | 'maybe';

/**
 * Common interface every key provider implements.
 * All network methods must never log or echo the key itself.
 */
export interface KeyProvider {
  readonly id: ProviderId;
  /** Human-readable name for TUI output. */
  readonly displayName: string;
  /** Upstream base URL (HTTPS enforced by callers). */
  readonly baseUrl: string;
  /**
   * Canonical chat route prefix saros accepts from clients. Clients always
   * speak opencode-go shapes (/zen/go/v1/...); providers without a matching
   * upstream path get their requests remapped (see remapChatPath).
   */
  readonly chatBasePath: string;

  /**
   * Cheap structural check. 'yes' = prefix uniquely identifies this
   * provider, 'maybe' = prefix shared with another provider (empirical
   * smoke test required), 'no' = definitely not this provider's format.
   */
  quickMatch(key: string): PrefixMatch;

  /**
   * Verify a key with a cheap authenticated GET.
   * Implementations must use a read-only endpoint (no token spend).
   */
  smokeTest(key: string, timeoutMs?: number): Promise<SmokeResult>;

  /**
   * Usage/quota endpoint path for this provider (empty string when the
   * provider has no per-key usage API saros can query).
   */
  usagePath(): string;

  /**
   * Parse a usage response body into the shared KeyUsage shape.
   * Returns null when the body doesn't match this provider's contract.
   */
  parseUsageResponse(body: string): KeyUsage | null;

  /**
   * Extra headers this provider requires on upstream requests
   * (e.g. CommandCode CLI-identity headers). Called per request;
   * must not include Authorization (added by the proxy).
   */
  extraUpstreamHeaders?(): Record<string, string>;

  /**
   * Fetch this provider's live model catalog (OpenAI list shape).
   * Returns null when unavailable — callers fall back to bundled data.
   * Implementations must not require a valid key (catalogs are public).
   */
  fetchCatalog?(timeoutMs?: number): Promise<Array<Record<string, unknown>> | null>;

  /**
   * Structural model-id affinity check. Consulted BEFORE dispatching so a
   * request naming a commandcode-only model (e.g. 'claude-*') is not sent
   * with an opencode-go key (and vice versa).
   */
  modelAffinity(modelId: string): ModelAffinity;
}

/**
 * Model → provider affinity.
 *
 * 'yes' = the model id is (almost certainly) served by this provider,
 * 'no' = definitely not, 'maybe' = cannot be decided structurally — the
 * proxy tries matching providers first and falls back to any available key.
 * Used for request routing in mixed-provider key pools.
 */
export type ModelAffinity = 'yes' | 'no' | 'maybe';

/** Shared usage shape used across providers (mirrors usage-client KeyUsage). */
export interface KeyUsage {
  usedPercent: number;
  rollingPercent: number;
  weeklyPercent: number;
  monthlyPercent: number;
  rollingResetsAt?: string;
  weeklyResetsAt?: string;
  monthlyResetsAt?: string;
}
