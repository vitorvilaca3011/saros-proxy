/**
 * commandcode.ts — KeyProvider adapter for the CommandCode API
 * (api.commandcode.ai).
 *
 * Keys: `user_` tokens (definitive) and `sk-` console keys (ambiguous with
 * opencode-go → empirical smoke test required).
 *
 * Smoke test: GET /alpha/billing/subscriptions — cheap, read-only, no token
 * spend; 200 with planId = valid, 401 = invalid. Requests must carry
 * CLI-identity headers (the server gates on client version, verified live:
 * without them /alpha/generate returns 403 upgrade_required).
 * Usage: GET /alpha/billing/credits (5-hour and weekly windows + credits),
 * also gated behind the CLI-identity headers.
 */
import { MIN_KEY_LENGTH } from '../constants.js';
import type { KeyProvider, KeyUsage, PrefixMatch, SmokeResult } from './types.js';

export const COMMANDCODE_BASE_URL = 'https://api.commandcode.ai';
export const COMMANDCODE_BILLING_PATH = '/alpha/billing/subscriptions';

/** Latest CLI version, resolved lazily and cached for the process lifetime. */
let cachedClientVersion: string | null = null;

/** Resolve the current command-code CLI version from the npm registry. */
export async function resolveClientVersion(timeoutMs = 5_000): Promise<string> {
  if (cachedClientVersion) return cachedClientVersion;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://registry.npmjs.org/command-code/latest', {
      signal: controller.signal,
    });
    if (res.ok) {
      const body = (await res.json()) as { version?: unknown };
      if (typeof body.version === 'string' && /^\d+\.\d+\.\d+/.test(body.version)) {
        cachedClientVersion = body.version;
        return cachedClientVersion;
      }
    }
  } catch {
    // fall through to fallback
  } finally {
    clearTimeout(timer);
  }
  // Conservative floor: server rejects versions below 0.18.10 (verified live).
  return (cachedClientVersion = '0.18.10');
}

/** CLI-identity headers every authenticated CommandCode request needs. */
export function commandcodeClientHeaders(version: string): Record<string, string> {
  return {
    'User-Agent': `CommandCodeCLI/${version}`,
    'X-Command-Code-Version': version,
    'X-CLI-Environment': 'production',
    'X-Project-Slug': 'command-code',
    'X-CommandCode-Client': 'cli',
    'X-CommandCode-Client-Version': version,
    'X-CommandCode-CLI-Version': version,
    'X-Command-Code-Client-Version': version,
    'X-Command-Code-CLI-Version': version,
  };
}

interface SubscriptionBody {
  success?: boolean;
  data?: { planId?: unknown; status?: unknown };
  error?: { code?: unknown };
}

/** Extract planId from a billing/subscriptions response (opencommand-compatible). */
export function parsePlanId(body: string): string | undefined {
  let parsed: SubscriptionBody;
  try {
    parsed = JSON.parse(body) as SubscriptionBody;
  } catch {
    return undefined;
  }
  const planId = parsed?.data?.planId;
  return typeof planId === 'string' && planId.trim() ? planId.trim() : undefined;
}

/**
 * Per-key quota endpoint (undocumented but live, verified 2026-11-05):
 * GET /alpha/billing/credits returns credits plus the 5-hour and weekly
 * caps. It answers only when the request carries the CLI identity headers,
 * so `fetchKeyUsage` forwards `extraUpstreamHeaders()`.
 */
export const COMMANDCODE_CREDITS_PATH = '/alpha/billing/credits';

interface CreditsWindow {
  used?: unknown;
  cap?: unknown;
  resetAt?: unknown;
}

interface CreditsLimits {
  fiveHour?: CreditsWindow;
  weekly?: CreditsWindow;
}

interface CreditsBody {
  /** `monthlyCredits` is what remains of the monthly allowance. */
  credits?: { monthlyCredits?: unknown };
  windowLimits?: CreditsLimits;
}

/** Percent consumed in one window; null when the payload has no usable cap. */
function windowPercent(window: CreditsWindow | undefined): number | null {
  const used = window?.used;
  const cap = window?.cap;
  if (typeof used !== 'number' || typeof cap !== 'number') return null;
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return null;
  return Math.min(100, Math.max(0, (used / cap) * 100));
}

/** Credits reported as used by the 5-hour/weekly windows (0 when absent). */
function windowUsedCredits(limits: CreditsLimits): number {
  const used = [limits.fiveHour?.used, limits.weekly?.used]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return used.length > 0 ? Math.max(...used) : 0;
}

/**
 * The payload does not carry the monthly cap. Against the dashboard
 * (2026-11-05) the windows are 20% / 50% / 100% of the monthly allowance, so
 * the nominal cap is 2 × weekly.cap, falling back to 5 × fiveHour.cap. A cap
 * is only accepted when the remaining credits are consistent with it in the
 * same unit: `remaining <= cap` and consumed (`cap − remaining`) must cover
 * the largest window usage. Otherwise the derived ladder is wrong and the
 * next candidate is tried; when none fits, null preserves the previous state
 * instead of turning bad data into maximum weight.
 */
function monthlyPercent(limits: CreditsLimits, remaining: number | null): number | null {
  if (remaining === null) return null;
  const used = windowUsedCredits(limits);
  const weeklyCap = limits.weekly?.cap;
  const fiveHourCap = limits.fiveHour?.cap;
  const candidateCaps = [
    typeof weeklyCap === 'number' && Number.isFinite(weeklyCap) && weeklyCap > 0 ? weeklyCap * 2 : 0,
    typeof fiveHourCap === 'number' && Number.isFinite(fiveHourCap) && fiveHourCap > 0 ? fiveHourCap * 5 : 0,
  ].filter((cap) => cap > 0);

  for (const cap of candidateCaps) {
    const consumed = cap - remaining;
    if (remaining <= cap && consumed >= used) {
      return Math.min(100, Math.max(0, (consumed / cap) * 100));
    }
  }
  return null;
}

/** Epoch-ms reset timestamp → ISO; undefined when absent or invalid. */
function resetIso(epochMs: unknown): string | undefined {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return undefined;
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Parse a /alpha/billing/credits body into KeyUsage. The payload exposes
 * `fiveHour` (saros' rolling window) and `weekly` as `used`/`cap`, plus the
 * remaining `credits.monthlyCredits`; the monthly cap is derived from the
 * window ladder (see `monthlyPercent`). `usedPercent` is the monthly measure;
 * `exhausted` turns true when any window reaches 100%.
 *
 * Returns null when no window and no monthly value can be derived — a 200
 * with an empty/shape-less body must not overwrite the last good usage (doing
 * so would reset an exhausted key to 0% and hand it the whole pool). A body
 * with only an underivable monthly metric but usable windows still yields
 * usage, with the monthly percent at 0.
 */
export function parseCommandcodeUsage(body: string): KeyUsage | null {
  let parsed: CreditsBody;
  try {
    parsed = JSON.parse(body) as CreditsBody;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const limits: CreditsLimits = parsed.windowLimits && typeof parsed.windowLimits === 'object'
    ? parsed.windowLimits
    : {};
  const remainingRaw = parsed.credits?.monthlyCredits;
  const remaining = typeof remainingRaw === 'number' && Number.isFinite(remainingRaw)
    ? remainingRaw
    : null;
  const rolling = windowPercent(limits.fiveHour);
  const weekly = windowPercent(limits.weekly);
  const monthly = monthlyPercent(limits, remaining);
  // Numeric credits with no cap that validates the derived ladder: the data
  // is contradictory, so keep the previous state rather than weigh it at 0%.
  if (remaining !== null && monthly === null) return null;
  if (rolling === null && weekly === null && monthly === null) return null;

  const rollingPct = rolling ?? 0;
  const weeklyPct = weekly ?? 0;
  const monthlyPct = monthly ?? 0;
  return {
    rollingPercent: rollingPct,
    weeklyPercent: weeklyPct,
    monthlyPercent: monthlyPct,
    usedPercent: monthly,
    exhausted: rollingPct >= 100 || weeklyPct >= 100 || monthlyPct >= 100,
    monthlyAvailable: monthly !== null,
    rollingResetsAt: resetIso(limits.fiveHour?.resetAt),
    weeklyResetsAt: resetIso(limits.weekly?.resetAt),
    monthlyResetsAt: undefined,
  };
}

export const COMMANDCODE_PROVIDER_MODELS_PATH = '/provider/v1/models';

/** Bare-name index of the live catalog (last path segment of vendor ids). */
let catalogCache: { bareNames: Set<string>; nativeByBare: Map<string, string> } | null = null;
/** Ensures the background warm-up fires at most once per process. */
let warmupStarted = false;

function indexCatalog(models: Array<Record<string, unknown>>): void {
  const bareNames = new Set<string>();
  const nativeByBare = new Map<string, string>();
  for (const entry of models) {
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!id) continue;
    bareNames.add(id.toLowerCase());
    const lastSegment = id.split('/').pop() ?? id;
    if (lastSegment) {
      bareNames.add(lastSegment.toLowerCase());
      if (!nativeByBare.has(lastSegment.toLowerCase())) {
        nativeByBare.set(lastSegment.toLowerCase(), id);
      }
    }
  }
  catalogCache = { bareNames, nativeByBare };
}

export const commandcodeProvider: KeyProvider = {
  id: 'commandcode',
  displayName: 'CommandCode',
  baseUrl: COMMANDCODE_BASE_URL,
  chatBasePath: '/provider/v1',

  quickMatch(key: string): PrefixMatch {
    if (key.startsWith('user_') && key.length >= MIN_KEY_LENGTH) return 'yes';
    // sk- shared with opencode-go → empirical test required
    return key.startsWith('sk-') && key.length >= MIN_KEY_LENGTH ? 'maybe' : 'no';
  },

  async smokeTest(key: string, timeoutMs = 10_000): Promise<SmokeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const version = await resolveClientVersion();
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${COMMANDCODE_BILLING_PATH}`, {
        headers: {
          ...commandcodeClientHeaders(version),
          Accept: 'application/json',
          Authorization: `Bearer ${key}`,
        },
        signal: controller.signal,
      });
      if (res.ok) {
        const planId = parsePlanId(await res.text());
        return {
          provider: this.id,
          status: 'valid',
          httpStatus: res.status,
          detail: planId ? `plan: ${planId}` : undefined,
          ...(planId ? { meta: { planId } } : {}),
        };
      }
      const definitive = res.status === 401 || res.status === 403;
      return {
        provider: this.id,
        status: definitive ? 'invalid' : 'error',
        httpStatus: res.status,
        detail: definitive ? 'upstream rejected the key' : 'upstream unavailable',
      };
    } catch (err) {
      return {
        provider: this.id,
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  },

  usagePath(): string {
    return COMMANDCODE_CREDITS_PATH;
  },

  parseUsageResponse(body: string): KeyUsage | null {
    return parseCommandcodeUsage(body);
  },

  // Documented contract (commandcode.ai/docs/provider §Streaming): every
  // stream ends with a `usage` chunk, and stream_options.include_usage is the
  // documented way to request it. saros reads those counts for per-key
  // accounting — CommandCode exposes no quota API to poll.
  supportsStreamUsage: true,

  extraUpstreamHeaders() {
    return commandcodeClientHeaders(cachedClientVersion ?? '0.18.10');
  },

  /**
   * Live provider catalog. Verified live: this route is fully public
   * (200 with any or no Authorization header).
   */
  async fetchCatalog(timeoutMs = 5_000): Promise<Array<Record<string, unknown>> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(
        `${COMMANDCODE_BASE_URL.replace(/\/$/, '')}${COMMANDCODE_PROVIDER_MODELS_PATH}`,
        { signal: controller.signal },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: unknown };
      if (!Array.isArray(body.data)) return null;
      const models = (body.data.filter(
        (m): m is Record<string, unknown> =>
          typeof m === 'object' && m !== null && typeof (m as Record<string, unknown>).id === 'string',
      )).filter((m) => {
        // claude-* is served via the Anthropic Messages endpoint only
        // (verified live: chat/completions → unsupported_model). saros relays
        // chat/completions shapes, so these models are unusable through it.
        const id = typeof m.id === 'string' ? m.id : '';
        return !/^claude/i.test(id);
      });
      indexCatalog(models);
      return models;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Vendor-prefixed ids ('vendor/model') and Claude models are
   * commandcode-specific naming (opencode-go uses bare ids like 'glm-5').
   * Everything else is 'maybe' — catalogs overlap.
   */
  modelAffinity(modelId: string): 'yes' | 'no' | 'maybe' {
    if (modelId.includes('/')) return 'yes';
    if (/^claude/i.test(modelId)) return 'yes';
    return 'maybe';
  },

  /**
   * Bare-name affinity against the live catalog: 'deepseek-v4-flash' matches
   * the catalog entry 'deepseek/deepseek-v4-flash' (last path segment).
   * Cached after the first catalog fetch; 'maybe' until the catalog loads.
   */
  modelAffinityByName(bareName: string): 'yes' | 'no' | 'maybe' {
    if (catalogCache) {
      return catalogCache.bareNames.has(bareName.toLowerCase()) ? 'yes' : 'no';
    }
    // Warm the cache in the background (once per process); stay non-committal meanwhile.
    if (!warmupStarted) {
      warmupStarted = true;
      void commandcodeProvider.fetchCatalog?.();
    }
    return 'maybe';
  },

  /**
   * Bare name → commandcode's native id ('deepseek-v4-flash' →
   * 'deepseek/deepseek-v4-flash'). null when the catalog isn't loaded or
   * doesn't serve the name.
   */
  resolveNativeId(bareName: string): string | null {
    if (!catalogCache) return null;
    return catalogCache.nativeByBare.get(bareName.toLowerCase()) ?? null;
  },
};
