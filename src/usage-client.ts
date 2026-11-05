/**
 * usage-client.ts — Per-key quota usage from each provider's usage API.
 *
 * Every provider owns its endpoint path, response parser and identity
 * headers (opencode-go: `/zen/go/v1/usage` behind Cloudflare, which needs the
 * CLI User-Agent; commandcode: `/alpha/billing/credits`, gated on the same
 * CLI identity). `fetchKeyUsage` only adds the bearer credential.
 *
 * Refresh strategy: stale-while-revalidate on demand. `maybeRefreshUsage`
 * is called on the request path; when data is older than USAGE_REFRESH_TTL_MS
 * and no refresh is in flight, it fires a background refresh for every key.
 * Failures keep the last known values (weighted rotation just keeps working
 * with slightly stale percentages).
 */

import { logger } from './logger.js';
import { USAGE_FETCH_TIMEOUT_MS, USAGE_REFRESH_TTL_MS } from './constants.js';
import {
  updateKeyUsage,
  setKeyEntitlement,
  type KeyUsageMetrics,
  type ProxyState,
} from './proxy-logic.js';
import type { ProxyConfig } from './config.js';
import { getProvider, inferProvider, opencodeGoProvider } from './providers/index.js';
import type { KeyProvider, ProviderId } from './providers/index.js';

/**
 * Per-key quota usage, normalized as a percentage *of the provider's own
 * budget* — never absolute capacity. `usedPercent` is the **monthly** window:
 * 0 = untouched, 100 = monthly allowance spent. `exhausted` is true when any
 * window (5h, weekly or monthly) reached 100%, which takes the key out of
 * rotation regardless of how much of the month remains — otherwise a key with
 * 50% monthly and a spent weekly window would keep receiving traffic and
 * failing upstream.
 *
 * This normalization is the contract mixed-provider pools rely on:
 * `pickWeighted` (`proxy-logic.ts`) compares the numbers from every provider
 * directly, so "30%" must always mean "30% of that provider's monthly budget".
 * Percent is the most saros can honestly compare — opencode-go's
 * `/zen/go/v1/usage` publishes only percentages
 * (`{"usage":{"rolling":{"percent":1},"weekly":{"percent":15},
 * "monthly":{"percent":19}}}`), with no token counts or absolute caps, while
 * CommandCode publishes `used`/`cap` per window plus the remaining monthly
 * credits, and its parser converts them to the same percent scale.
 */
export interface KeyUsage {
  /** Monthly used percent, 0-100, of this provider's own budget. */
  usedPercent: number;
  /** True when any window is at 100% — rotation weighs the key 0. */
  exhausted: boolean;
  rollingPercent: number;
  weeklyPercent: number;
  monthlyPercent: number;
  rollingResetsAt?: string;
  weeklyResetsAt?: string;
  monthlyResetsAt?: string;
}

/** Outcome of one usage fetch. */
export interface UsageFetchResult {
  /** Parsed usage, or null when the fetch failed / violated the contract. */
  usage: KeyUsage | null;
  /**
   * The upstream rejected the key for lack of plan (403 EntitlementError /
   * upgrade_required). Definitive, not transient: the account cannot use this
   * provider's models at all, so rotation drops the key until a later
   * refresh shows it usable again.
   */
  noEntitlement: boolean;
}

/**
 * 403 bodies that mean "this account has no plan for this provider":
 * opencode-go → `{"error":{"type":"EntitlementError","message":"OpenCode Go
 * subscription required."}}`, commandcode → `403 upgrade_required`.
 * Plan-gated *models* (opencode-go's 403 `MODEL_NOT_IN_PLAN`) are a request
 * problem, not an account one, and must not match.
 */
export function isEntitlementError(status: number, body: string): boolean {
  return status === 403 && /subscription|entitlement|upgrade_required/i.test(body);
}

/**
 * Fetch current usage for one key from its provider's endpoint. The provider
 * supplies the path, the identity headers (CommandCode and opencode-go both
 * reject requests without a CLI User-Agent) and the response parser; this
 * function only adds the bearer credential and the timeout.
 *
 * Failures (network, timeout, non-200, contract violation) yield
 * `usage: null` — callers treat that as "no fresh data". A 403 entitlement
 * rejection is reported separately because it is definitive, not transient.
 */
export async function fetchKeyUsage(
  upstreamBaseUrl: string,
  apiKey: string,
  provider: KeyProvider = opencodeGoProvider,
): Promise<UsageFetchResult> {
  const usagePath = provider.usagePath();
  if (!usagePath) return { usage: null, noEntitlement: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), USAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(usagePath, upstreamBaseUrl), {
      headers: {
        ...provider.extraUpstreamHeaders?.(),
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    // Keep the abort armed through the body read: a stalled body after a 200
    // must still time out, or refreshInFlight stays true forever and usage
    // rotation freezes on stale percentages.
    const body = await response.text();
    if (!response.ok) {
      return { usage: null, noEntitlement: isEntitlementError(response.status, body) };
    }
    try {
      return { usage: provider.parseUsageResponse(body), noEntitlement: false };
    } catch {
      return { usage: null, noEntitlement: false };
    }
  } catch {
    return { usage: null, noEntitlement: false };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Stale-while-revalidate coordinator (one per proxy process)
// ---------------------------------------------------------------------------

let lastRefreshAt = 0;
let refreshInFlight = false;

/** Test seam: reset coordinator state. */
export function resetUsageRefreshState(): void {
  lastRefreshAt = 0;
  refreshInFlight = false;
}

/**
 * Kick off a background refresh of every key's usage when the cached data is
 * older than USAGE_REFRESH_TTL_MS. Fire-and-forget: never throws, never blocks
 * the request path, deduplicates concurrent calls.
 */
export function maybeRefreshUsage(state: ProxyState, config: ProxyConfig): void {
  const now = Date.now();
  if (refreshInFlight || now - lastRefreshAt < USAGE_REFRESH_TTL_MS) return;

  refreshInFlight = true;
  lastRefreshAt = now;

  void (async () => {
    try {
      const entries = await Promise.all(
        state.keys.map(async (k) => {
          const provider = getProvider(inferProvider({ label: k.label, key: k.key, provider: k.provider as ProviderId | undefined }));
          // Providers without a usage endpoint are skipped — weighted
          // rotation simply treats them as having no fresh data.
          if (!provider || !provider.usagePath()) return [k.label, null] as const;
          const base = config.upstreams?.[provider.id] ?? (provider.id === 'opencode-go' ? config.upstreamBaseUrl : provider.baseUrl);
          const usage = await fetchKeyUsage(base, k.key, provider);
          return [k.label, usage] as const;
        }),
      );
      const metrics = new Map<string, KeyUsageMetrics>();
      for (const [label, result] of entries) {
        if (!result) continue;
        if (result.usage) {
          metrics.set(label, {
            usedPercent: result.usage.usedPercent,
            exhausted: result.usage.exhausted,
          });
          // A key that answers the usage API is entitled again.
          setKeyEntitlement(state, label, true);
        } else if (result.noEntitlement) {
          setKeyEntitlement(state, label, false);
        }
        // Transient failures leave the previous entitlement untouched.
      }
      if (metrics.size > 0) {
        updateKeyUsage(state, metrics);
        logger.debug({ keys: [...metrics.keys()] }, 'key usage refreshed');
      }
    } catch (err) {
      logger.debug({ err }, 'usage refresh failed');
    } finally {
      refreshInFlight = false;
    }
  })();
}
