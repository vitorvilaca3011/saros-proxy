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
 * CommandCode has no per-key usage-percent API saros can query without
 * browser session cookies (verified: /v1/account/usage is not a registered
 * route on api.commandcode.ai). Usage-based weighted rotation is opencode-go
 * only; commandcode keys report no usage data.
 */
export const COMMANDCODE_PROVIDER_MODELS_PATH = '/provider/v1/models';

/** Bare-name index of the live catalog (last path segment of vendor ids). */
let catalogCache: { bareNames: Set<string>; nativeByBare: Map<string, string> } | null = null;

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
    return ''; // no queryable per-key usage API without a Studio session cookie
  },

  parseUsageResponse(_body: string): KeyUsage | null {
    return null;
  },

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
    // Warm the cache in the background; meanwhile stay non-committal.
    void commandcodeProvider.fetchCatalog?.();
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
