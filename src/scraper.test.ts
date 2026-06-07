/**
 * scraper.test.ts — Unit tests for the scraper module.
 *
 * Covers scrapeDashboard (single-shot), startScraper/stopScraper (timer management),
 * getAllUsage (store accessor), and scrapeAndStore failure preservation.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  scrapeDashboard,
  startScraper,
  stopScraper,
  isScraperRunning,
  getAllUsage,
  clearUsageStore,
} from './scraper.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** HTML body that parseAllUsage can extract all three windows from. */
const MOCK_HTML =
  '<html><body><script>rollingUsage:$R[3]={usagePercent:45.2,resetInSec:3600}' +
  'weeklyUsage:$R[4]={usagePercent:60.5,resetInSec:86400}' +
  'monthlyUsage:$R[5]={usagePercent:75.8,resetInSec:2592000}</script></body></html>';

const MOCK_ACCOUNTS = [
  { workspaceId: 'ws-1', authCookie: 'cookie1' },
  { workspaceId: 'ws-2', authCookie: 'cookie2' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal fetch Response-like object for vitest mocks.
 * All fields are vi.fn()-backed for spying.
 */
function mockFetchResponse(
  overrides: Partial<{
    ok: boolean;
    status: number;
    text: string;
  }> = {},
) {
  const { ok = true, status = 200, text = '' } = overrides;
  return {
    ok,
    status,
    text: vi.fn().mockResolvedValue(text),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scraper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    stopScraper();
    clearUsageStore();
  });

  // -----------------------------------------------------------------------
  // scrapeDashboard
  // -----------------------------------------------------------------------

  describe('scrapeDashboard', () => {
    it('returns usage data on 200 OK with valid HTML', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockFetchResponse({ text: MOCK_HTML })),
      );

      const result = await scrapeDashboard('ws-1', 'cookie123');

      expect(result.success).toBe(true);
      expect(result.usage).toEqual({
        rolling: 45.2,
        weekly: 60.5,
        monthly: 75.8,
      });
      expect(result.httpStatus).toBe(200);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it('returns error object on non-200 HTTP response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockFetchResponse({ ok: false, status: 500 })),
      );

      const result = await scrapeDashboard('ws-1', 'cookie123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 500');
      expect(result.httpStatus).toBe(500);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.usage).toBeUndefined();
    });

    it('returns error on network failure', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('Network failure')),
      );

      const result = await scrapeDashboard('ws-1', 'cookie123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network failure');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.httpStatus).toBeUndefined();
      expect(result.usage).toBeUndefined();
    });

    it('returns error when non-Error is thrown (Unknown fetch error)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('string error'));

      const result = await scrapeDashboard('ws-1', 'cookie123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown fetch error');
    });

    it('returns aborted error when signal is aborted via AbortController', async () => {
      const controller = new AbortController();
      controller.abort();

      // Mock fetch that respects AbortSignal
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
          if (init?.signal?.aborted) {
            const err = new DOMException('The operation was aborted', 'AbortError');
            return Promise.reject(err);
          }
          return Promise.resolve(mockFetchResponse({ text: MOCK_HTML }));
        }),
      );

      const result = await scrapeDashboard('ws-1', 'cookie123', {
        signal: controller.signal,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Aborted');
      expect(result.httpStatus).toBeUndefined();
    });

    it('returns all-null usage on empty HTML body', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockFetchResponse({ text: '' })),
      );

      const result = await scrapeDashboard('ws-1', 'cookie123');

      expect(result.success).toBe(true);
      expect(result.usage).toEqual({
        rolling: null,
        weekly: null,
        monthly: null,
      });
      expect(result.httpStatus).toBe(200);
    });

    it('returns timeout error when fetch hangs past timeoutMs', async () => {
      // Use real timers so AbortSignal.timeout fires naturally
      vi.useRealTimers();

      // Mock fetch that respects AbortSignal and hangs until the signal fires.
      // Uses signal.reason (not a hardcoded AbortError) so the catch block
      // receives the correct DOMException name (TimeoutError vs AbortError).
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
          const signal = init?.signal;
          const abortReason = () =>
            signal?.reason ?? new DOMException('Aborted', 'AbortError');

          return new Promise<never>((_resolve, reject) => {
            if (signal?.aborted) {
              return reject(abortReason());
            }
            signal?.addEventListener('abort', () => reject(abortReason()), { once: true });
          });
        }),
      );

      const result = await scrapeDashboard('ws-1', 'cookie123', {
        timeoutMs: 50,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Request timed out');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns "Cookie expired or invalid" on 401', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockFetchResponse({ ok: false, status: 401 })),
      );

      const result = await scrapeDashboard('ws-1', 'cookie123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cookie expired or invalid');
      expect(result.httpStatus).toBe(401);
    });

    it('returns "Cookie expired or invalid" on 403', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockFetchResponse({ ok: false, status: 403 })),
      );

      const result = await scrapeDashboard('ws-1', 'cookie123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cookie expired or invalid');
      expect(result.httpStatus).toBe(403);
    });

    it('returns "Rate limited by opencode.ai" on 429', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockFetchResponse({ ok: false, status: 429 })),
      );

      const result = await scrapeDashboard('ws-1', 'cookie123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Rate limited by opencode.ai');
      expect(result.httpStatus).toBe(429);
    });
  });

  // -----------------------------------------------------------------------
  // startScraper / stopScraper
  // -----------------------------------------------------------------------

  describe('startScraper / stopScraper', () => {
    it('startScraper begins periodic scraping and isScraperRunning returns true', () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockFetchResponse({ text: MOCK_HTML })),
      );

      expect(isScraperRunning()).toBe(false);

      startScraper(MOCK_ACCOUNTS, 1000);

      expect(isScraperRunning()).toBe(true);
    });

    it('calling startScraper twice clears the old timer (no duplicate cycles)', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(mockFetchResponse({ text: MOCK_HTML }));
      vi.stubGlobal('fetch', mockFetch);

      startScraper(MOCK_ACCOUNTS, 1000);
      startScraper(MOCK_ACCOUNTS, 1000);

      // The second call aborts the first schedule mid-cycle (account 1 of 2
      // already completed synchronously), then starts a fresh cycle (2 accounts).
      // Result: 1 fetch from the aborted cycle + 2 from the fresh = 3 total.
      await vi.advanceTimersByTimeAsync(1);

      expect(mockFetch).toHaveBeenCalledTimes(3);

      // Advance past one interval — second cycle should run (2 more fetches)
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockFetch).toHaveBeenCalledTimes(5);

      // And another interval — third cycle
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockFetch).toHaveBeenCalledTimes(7);
    });

    it('stopScraper clears the timer', () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockFetchResponse({ text: MOCK_HTML })),
      );

      startScraper(MOCK_ACCOUNTS, 1000);
      expect(isScraperRunning()).toBe(true);

      stopScraper();
      expect(isScraperRunning()).toBe(false);
    });

    it('recursive setTimeout prevents overlapping cycles', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(mockFetchResponse({ text: MOCK_HTML }));
      vi.stubGlobal('fetch', mockFetch);

      startScraper(MOCK_ACCOUNTS, 1000);

      // First cycle runs immediately
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Advance past interval — second cycle starts only after first completed
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('stopScraper aborts in-flight cycle', async () => {
      // Mock fetch that respects AbortSignal — rejects with signal.reason
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
          const signal = init?.signal;
          const abortReason = () =>
            signal?.reason ?? new DOMException('Aborted', 'AbortError');

          return new Promise<never>((_resolve, reject) => {
            if (signal?.aborted) {
              return reject(abortReason());
            }
            signal?.addEventListener('abort', () => reject(abortReason()), { once: true });
          });
        }),
      );

      startScraper([MOCK_ACCOUNTS[0]], 1000);

      // Let the first cycle start (it suspends on the never-resolving fetch)
      await vi.advanceTimersByTimeAsync(0);

      // Stop scraper mid-cycle — controller is aborted, timer cleared
      stopScraper();

      // No usage data was stored (cycle aborted before completing)
      expect(getAllUsage().size).toBe(0);
      expect(isScraperRunning()).toBe(false);
    });

    it('isScraperRunning returns false when scraper was never started', () => {
      expect(isScraperRunning()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // getAllUsage
  // -----------------------------------------------------------------------

  describe('getAllUsage', () => {
    it('returns empty map when no scraping has been done', () => {
      const usage = getAllUsage();
      expect(usage).toBeInstanceOf(Map);
      expect(usage.size).toBe(0);
    });

    it('returns populated map after a scrape cycle completes', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockFetchResponse({ text: MOCK_HTML })),
      );

      startScraper([MOCK_ACCOUNTS[0]], 1000);
      await vi.advanceTimersByTimeAsync(1);

      const usage = getAllUsage();
      expect(usage.size).toBe(1);

      const entry = usage.get('ws-1');
      expect(entry).toBeDefined();
      expect(entry!.usage.rolling).toBe(45.2);
      expect(entry!.usage.weekly).toBe(60.5);
      expect(entry!.usage.monthly).toBe(75.8);
      expect(entry!.lastScrapedAt).toBeInstanceOf(Date);
    });

    it('returns a copy — mutating the result does not affect the internal store', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockFetchResponse({ text: MOCK_HTML })),
      );

      startScraper([MOCK_ACCOUNTS[0]], 1000);
      await vi.advanceTimersByTimeAsync(1);

      expect(getAllUsage().size).toBe(1);

      // Mutate returned map
      const map1 = getAllUsage();
      map1.clear();

      // Internal store should be unaffected
      const map2 = getAllUsage();
      expect(map2.size).toBe(1);
      expect(map2.get('ws-1')).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // scrapeAndStore failure preservation
  // -----------------------------------------------------------------------

  describe('scrapeAndStore failure preservation', () => {
    it('preserves previous usage data when a subsequent scrape fails', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse({ text: MOCK_HTML }))
        .mockResolvedValueOnce(
          mockFetchResponse({ ok: false, status: 500 }),
        );
      vi.stubGlobal('fetch', mockFetch);

      startScraper([MOCK_ACCOUNTS[0]], 1000);

      // First cycle: succeeds → data stored
      await vi.advanceTimersByTimeAsync(1);
      expect(getAllUsage().size).toBe(1);
      expect(getAllUsage().get('ws-1')!.usage.rolling).toBe(45.2);

      // Second cycle: fails → previous data preserved, error recorded
      await vi.advanceTimersByTimeAsync(1000);
      expect(getAllUsage().size).toBe(1);
      expect(getAllUsage().get('ws-1')!.usage.rolling).toBe(45.2);
      expect(getAllUsage().get('ws-1')!.lastError).toBe('HTTP 500');
    });
  });

  // -----------------------------------------------------------------------
  // anySignal with pre-aborted signal
  // -----------------------------------------------------------------------

  describe('anySignal with pre-aborted signal', () => {
    it('returns aborted error immediately when pre-aborted signal is passed', async () => {
      // Mock fetch that respects AbortSignal
      const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          const err = new DOMException('The operation was aborted', 'AbortError');
          return Promise.reject(err);
        }
        return Promise.resolve(mockFetchResponse({ text: MOCK_HTML }));
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await scrapeDashboard('ws-1', 'cookie123', {
        signal: AbortSignal.abort(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Aborted');

      // fetch is still called because the code does not skip the call —
      // it passes the already-aborted signal which causes fetch to throw
      // immediately with an AbortError, caught by the catch block.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Note: The `logger.error('Scrape cycle failed')` (line 281) and
  // `logger.error('Initial scrape cycle failed')` (line 294) paths in
  // scraper.ts are defensive catches that never fire in the normal flow:
  // scrapeAndStore swallows errors and returns { success: false } objects
  // rather than throwing, so the .catch handlers above them are unreachable.
  // They are intentionally left as defense-in-depth in case the internal
  // scrapeAndStore contract changes to throw.
  // -----------------------------------------------------------------------
});
