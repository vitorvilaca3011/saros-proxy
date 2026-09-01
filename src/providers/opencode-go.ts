/**
 * opencode-go.ts — KeyProvider adapter for the OpenCode-Go API (opencode.ai).
 *
 * Keys: `sk-` prefix (shared with commandcode → 'maybe'), ≥ 20 chars.
 * Usage: GET /zen/go/v1/usage with Bearer = the key itself.
 */
import {
  API_KEY_PREFIX,
  MIN_KEY_LENGTH,
  USAGE_PATH,
} from '../constants.js';
import type { KeyProvider, KeyUsage, PrefixMatch, SmokeResult } from './types.js';

/** Bare-name index of the live opencode-go catalog. */
let catalogCache: { bareNames: Set<string> } | null = null;
/** Ensures the background refresh fires at most once per process. */
let refreshStarted = false;

/**
 * Fetch the public opencode-go model list and index it. The endpoint needs
 * no auth (verified live); failures keep the previous cache.
 */
async function refreshCatalog(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}${USAGE_PATH.replace(/\/usage$/, '/models')}`, {
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return false;
    const bareNames = new Set<string>();
    for (const entry of body.data) {
      if (!entry || typeof entry !== 'object') continue;
      const id = (entry as Record<string, unknown>).id;
      if (typeof id !== 'string' || !id) continue;
      bareNames.add(id.toLowerCase());
      const last = id.split('/').pop() ?? id;
      if (last) bareNames.add(last.toLowerCase());
    }
    catalogCache = { bareNames };
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

interface UsageWindow {
  status?: string;
  percent?: unknown;
  resetsAt?: string;
}

interface UsageResponse {
  usage?: Partial<Record<'rolling' | 'weekly' | 'monthly', UsageWindow>>;
}

function parsePercent(window: UsageWindow | undefined): number {
  const percent = window?.percent;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

/** Parse opencode-go usage JSON (moved from usage-client.ts). */
export function parseOpencodeUsage(body: string): KeyUsage | null {
  let parsed: UsageResponse;
  try {
    parsed = JSON.parse(body) as UsageResponse;
  } catch {
    return null;
  }
  const usage = parsed?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const rolling = parsePercent(usage.rolling);
  const weekly = parsePercent(usage.weekly);
  const monthly = parsePercent(usage.monthly);
  return {
    rollingPercent: rolling,
    weeklyPercent: weekly,
    monthlyPercent: monthly,
    usedPercent: Math.max(rolling, weekly, monthly),
    rollingResetsAt: typeof usage.rolling?.resetsAt === 'string' ? usage.rolling.resetsAt : undefined,
    weeklyResetsAt: typeof usage.weekly?.resetsAt === 'string' ? usage.weekly.resetsAt : undefined,
    monthlyResetsAt: typeof usage.monthly?.resetsAt === 'string' ? usage.monthly.resetsAt : undefined,
  };
}

export const opencodeGoProvider: KeyProvider = {
  id: 'opencode-go',
  displayName: 'OpenCode Go',
  baseUrl: 'https://opencode.ai',
  chatBasePath: '/zen/go/v1',

  quickMatch(key: string): PrefixMatch {
    // sk- is shared with commandcode → never a definitive 'yes'.
    return key.startsWith(API_KEY_PREFIX) && key.length >= MIN_KEY_LENGTH
      ? 'maybe'
      : 'no';
  },

  async smokeTest(key: string, timeoutMs = 10_000): Promise<SmokeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${USAGE_PATH}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      if (res.ok) {
        return { provider: this.id, status: 'valid', httpStatus: res.status };
      }
      // 401/403 = definitive rejection; 5xx/429 = inconclusive
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
    return USAGE_PATH;
  },

  parseUsageResponse(body: string): KeyUsage | null {
    return parseOpencodeUsage(body);
  },

  /**
   * Affinity via the live catalog when loaded; 'maybe' before the first
   * fetch resolves (non-committal, keeps the key as rotation fallback).
   */
  modelAffinity(modelId: string): 'yes' | 'no' | 'maybe' {
    if (!catalogCache) {
      if (!refreshStarted) {
        refreshStarted = true;
        void refreshCatalog(this.baseUrl, 5_000);
      }
      return 'maybe';
    }
    const bare = (modelId.split('/').pop() ?? modelId).toLowerCase();
    return catalogCache.bareNames.has(bare) ? 'yes' : 'no';
  },

  /** Same verdict as modelAffinity — the catalog index is already bare-name based. */
  modelAffinityByName(bareName: string): 'yes' | 'no' | 'maybe' {
    if (!catalogCache) {
      if (!refreshStarted) {
        refreshStarted = true;
        void refreshCatalog(this.baseUrl, 5_000);
      }
      return 'maybe';
    }
    return catalogCache.bareNames.has(bareName.toLowerCase()) ? 'yes' : 'no';
  },

  /** opencode-go ids are already bare (1:1 naming) — the input passes through. */
  resolveNativeId(bareName: string): string | null {
    return catalogCache?.bareNames.has(bareName.toLowerCase()) ? bareName : null;
  },

  /** Public catalog endpoint (no auth required, verified live). */
  async fetchCatalog(timeoutMs = 5_000): Promise<Array<Record<string, unknown>> | null> {
    const ok = await refreshCatalog(this.baseUrl, timeoutMs);
    if (!ok) return null;
    // Re-fetch and return the raw list for catalog consumers (harness sync).
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${USAGE_PATH.replace(/\/usage$/, '/models')}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: unknown };
      return Array.isArray(body.data)
        ? (body.data as Array<Record<string, unknown>>)
        : null;
    } catch {
      return null;
    }
  },
};
