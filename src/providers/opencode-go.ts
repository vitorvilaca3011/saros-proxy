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
   * Affinity is 'maybe' for everything: opencode-go and commandcode model
   * catalogs overlap heavily (both route glm/kimi/qwen/deepseek/...), so a
   * structural no would wrongly block opencode keys from shared models.
   * Routing treats 'maybe' as fallback-after-specific-match.
   */
  modelAffinity(_modelId: string): 'maybe' {
    return 'maybe';
  },
};
