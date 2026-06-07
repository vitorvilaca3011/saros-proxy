/**
 * scraper.ts — Dashboard scraper; Saros uses this to predict account exhaustion.
 *
 * Provides both one-shot scraping (scrapeDashboard) and a background scraper
 * that periodically fetches dashboard pages for all configured accounts.
 * Uses recursive setTimeout (not setInterval) with AbortController to prevent
 * overlapping cycles and to support clean shutdown.
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

interface AccountUsage {
  usage: UsageData;
  lastScrapedAt: Date;
  lastError?: string;
}

/** Module-level store: workspaceId → AccountUsage */
const usageStore = new Map<string, AccountUsage>();

/** Active timer handle, if any */
let scraperTimer: ReturnType<typeof setTimeout> | null = null;

/** AbortController for the current scrape cycle, if any */
let abortController: AbortController | null = null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0';

const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Combine multiple AbortSignals into one — fires when any of them fire.
 * Cleans up listeners when any signal fires or when the resulting signal
 * is garbage collected.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener(
      'abort',
      () => controller.abort(signal.reason),
      { once: true },
    );
  }

  return controller.signal;
}

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
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<ScrapeResult> {
  const start = performance.now();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const url = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;

  try {
    // Combine external signal with timeout via race
    const externalSignal = options?.signal;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = externalSignal
      ? anySignal([externalSignal, timeoutSignal])
      : timeoutSignal;

    const response = await fetch(url, {
      headers: {
        Cookie: `auth=${authCookie}`,
        'User-Agent': FIREFOX_UA,
      },
      signal: combinedSignal,
    });

    const httpStatus = response.status;
    const durationMs = Math.round(performance.now() - start);

    // Classify HTTP error status into a user-facing error message
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

    // Intentional abort (from our AbortController during stop)
    if (err instanceof DOMException && err.name === 'AbortError') {
      return {
        success: false,
        error: 'Aborted',
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
 * Get all usage data (for health endpoint).
 */
export function getAllUsage(): Map<string, AccountUsage> {
  return new Map(usageStore);
}

/**
 * Clear the in-memory usage store (for testing).
 * Production code should NOT call this unless resetting state is intentional.
 */
export function clearUsageStore(): void {
  usageStore.clear();
}

// ---------------------------------------------------------------------------
// Timer management
// ---------------------------------------------------------------------------

/**
 * Scrape a single account and update the store.
 */
async function scrapeAndStore(account: ScrapingAccount, signal?: AbortSignal): Promise<void> {
  const result = await scrapeDashboard(account.workspaceId, account.authCookie, { signal });

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

  // Error already logged and stored above — no further action needed
}

/**
 * Run a full scrape cycle across all configured accounts sequentially.
 * Checks the abort signal between accounts and returns early if aborted.
 */
async function runScrapeCycle(
  accounts: ScrapingAccount[],
  signal?: AbortSignal,
): Promise<void> {
  for (const account of accounts) {
    if (signal?.aborted) return;
    await scrapeAndStore(account, signal);
  }
}

/**
 * Start the background scraper.
 * Scrapes all configured accounts every intervalMs using recursive setTimeout,
 * preventing overlapping cycles. If already running, aborts the previous cycle
 * and clears its timer first.
 */
export function startScraper(accounts: ScrapingAccount[], intervalMs: number): void {
  // Cancel any in-flight cycle and clear any existing timer
  stopScraper();

  const controller = new AbortController();
  abortController = controller;

  const schedule = async (): Promise<void> => {
    if (controller.signal.aborted) return;
    await runScrapeCycle(accounts, controller.signal).catch((err) => {
      logger.error({ err }, 'Scrape cycle failed');
    });
    if (controller.signal.aborted) return;
    scraperTimer = setTimeout(schedule, intervalMs);

    // Allow the process to exit even if the timer is still running
    if (scraperTimer && typeof scraperTimer === 'object' && 'unref' in scraperTimer) {
      scraperTimer.unref();
    }
  };

  // Start first cycle immediately
  schedule().catch((err) => {
    logger.error({ err }, 'Initial scrape cycle failed');
  });

  logger.info('Background scraper started (interval: %d ms, accounts: %d)', intervalMs, accounts.length);
}

/**
 * Stop the background scraper.
 * Aborts any in-flight scrape cycle and clears the scheduled timer.
 */
export function stopScraper(): void {
  if (abortController !== null) {
    abortController.abort();
    abortController = null;
  }
  if (scraperTimer !== null) {
    clearTimeout(scraperTimer);
    scraperTimer = null;
  }
  // Only log if we actually stopped something — allows idempotent calls from startScraper
  // without spurious "stopped" messages when nothing was running.
}

/**
 * Check if the scraper is currently running (either a cycle in flight or a timer scheduled).
 */
export function isScraperRunning(): boolean {
  return scraperTimer !== null || abortController !== null;
}
