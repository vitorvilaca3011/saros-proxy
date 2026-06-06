/**
 * scraper.ts — Single-shot HTTP fetch + parse wrapper for the OpenCode-Go dashboard.
 *
 * Fetches the dashboard page for a given workspace and parses usage percentages
 * using the dashboard-parser module. Designed for one-shot use — no timers,
 * no intervals, no retries.
 */

import { parseAllUsage, type UsageData } from './dashboard-parser.js';
import { logger } from './logger.js';
import type { ScrapingAccount } from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScrapeResult {
  /** Whether the fetch and parse completed successfully. */
  success: boolean;
  /** Parsed usage data when successful. */
  usage?: UsageData;
  /** Human-readable error message on failure. */
  error?: string;
  /** HTTP status code returned by the upstream server, if reachable. */
  httpStatus?: number;
  /** Wall-clock duration of the entire fetch+parse operation in milliseconds. */
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// In-memory usage store
// ---------------------------------------------------------------------------

export interface AccountUsage {
  usage: UsageData;
  lastScrapedAt: Date;
  lastError?: string;
}

/** Module-level store: workspaceId → AccountUsage */
const usageStore = new Map<string, AccountUsage>();

/** Active timer handle, if any */
let scraperTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0';

const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the OpenCode-Go dashboard and parse usage percentages.
 *
 * Makes a single HTTP GET request to `https://opencode.ai/workspace/{workspaceId}/go`
 * with the provided auth cookie. On a successful 2xx response the HTML is parsed
 * with {@link parseAllUsage} and the resulting usage data is returned.
 *
 * @param workspaceId — The OpenCode workspace identifier.
 * @param authCookie  — The `auth` cookie value for authentication.
 * @param options     - Optional settings.
 * @param options.timeoutMs - Request timeout in milliseconds (default: 15000).
 * @returns A {@link ScrapeResult} with status, parsed data, and timing info.
 */
export async function scrapeDashboard(
  workspaceId: string,
  authCookie: string,
  options?: { timeoutMs?: number },
): Promise<ScrapeResult> {
  const start = performance.now();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const url = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;

  try {
    const response = await fetch(url, {
      headers: {
        Cookie: `auth=${authCookie}`,
        'User-Agent': FIREFOX_UA,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const httpStatus = response.status;
    const durationMs = Math.round(performance.now() - start);

    // Handle non-2xx responses
    if (!response.ok) {
      let error: string;
      if (httpStatus === 401 || httpStatus === 403) {
        error = 'Cookie expired or invalid';
      } else if (httpStatus === 429) {
        error = 'Rate limited by opencode.ai';
      } else {
        error = `HTTP ${httpStatus}`;
      }

      return {
        success: false,
        error,
        httpStatus,
        durationMs,
      };
    }

    // Parse HTML body
    const html = await response.text();
    const usage = parseAllUsage(html);

    return {
      success: true,
      usage,
      httpStatus,
      durationMs,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);

    // Timeout
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return {
        success: false,
        error: 'Request timed out',
        durationMs,
      };
    }

    // Network or other errors
    const message =
      err instanceof Error ? err.message : 'Unknown fetch error';

    return {
      success: false,
      error: message,
      durationMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Usage store accessors
// ---------------------------------------------------------------------------

/**
 * Get the latest usage data for a workspace.
 * Returns null if no data has been scraped yet.
 */
export function getUsageForAccount(workspaceId: string): AccountUsage | null {
  return usageStore.get(workspaceId) ?? null;
}

/**
 * Get all usage data (for health endpoint).
 */
export function getAllUsage(): Map<string, AccountUsage> {
  return usageStore;
}

// ---------------------------------------------------------------------------
// Timer management
// ---------------------------------------------------------------------------

/**
 * Scrape a single account and update the store.
 */
async function scrapeAndStore(account: ScrapingAccount): Promise<void> {
  const result = await scrapeDashboard(account.workspaceId, account.authCookie);

  if (result.success && result.usage) {
    usageStore.set(account.workspaceId, {
      usage: result.usage,
      lastScrapedAt: new Date(),
    });
    logger.info(
      { workspaceId: account.workspaceId, durationMs: result.durationMs },
      'Scraped dashboard for %s',
      account.workspaceId,
    );
  } else {
    const prev = usageStore.get(account.workspaceId);
    usageStore.set(account.workspaceId, {
      usage: prev?.usage ?? { rolling: null, weekly: null, monthly: null },
      lastScrapedAt: new Date(),
      lastError: result.error ?? 'Unknown error',
    });
    logger.warn(
      { workspaceId: account.workspaceId, error: result.error, httpStatus: result.httpStatus },
      'Failed to scrape dashboard for %s: %s',
      account.workspaceId,
      result.error,
    );
  }

  // Handle non-2xx HTTP responses silently — we already logged and stored the error
}

/**
 * Run a full scrape cycle across all configured accounts sequentially.
 */
async function runScrapeCycle(accounts: ScrapingAccount[]): Promise<void> {
  for (const account of accounts) {
    await scrapeAndStore(account);
  }
}

/**
 * Start the background scraper timer.
 * Scrapes all configured accounts every intervalMs.
 * If already running, stops the previous timer first.
 */
export function startScraper(accounts: ScrapingAccount[], intervalMs: number): void {
  // Stop any existing timer first (idempotent)
  stopScraper();

  // Do an immediate first scrape (don't wait for first interval)
  runScrapeCycle(accounts).catch((err) => {
    logger.error({ err }, 'Initial scrape cycle failed');
  });

  // Schedule subsequent scrapes
  scraperTimer = setInterval(() => {
    runScrapeCycle(accounts).catch((err) => {
      logger.error({ err }, 'Scheduled scrape cycle failed');
    });
  }, intervalMs);

  // Allow the process to exit even if the timer is still running
  if (scraperTimer && typeof scraperTimer === 'object' && 'unref' in scraperTimer) {
    scraperTimer.unref();
  }

  logger.info('Background scraper started (interval: %d ms, accounts: %d)', intervalMs, accounts.length);
}

/**
 * Stop the background scraper timer.
 */
export function stopScraper(): void {
  if (scraperTimer !== null) {
    clearInterval(scraperTimer);
    scraperTimer = null;
    logger.info('Background scraper stopped');
  }
}

/**
 * Check if the scraper is currently running.
 */
export function isScraperRunning(): boolean {
  return scraperTimer !== null;
}
