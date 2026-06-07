/**
 * dashboard-parser.ts — Parse usage percentages from the OpenCode-Go dashboard HTML.
 *
 * The dashboard returns SolidJS SSR hydration data with usage percentages
 * for three time windows: rolling (~5h), weekly, and monthly.
 *
 * Example hydration data:
 * ```
 * rollingUsage:$R[3]={usagePercent:45.2,resetInSec:18000}
 * weeklyUsage:$R[4]={usagePercent:60.5,resetInSec:604800}
 * monthlyUsage:$R[5]={usagePercent:30.0,resetInSec:2592000}
 * ```
 *
 * Field order (usagePercent vs resetInSec) can vary between responses.
 * These functions handle both orderings by trying two regex patterns per window.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageData {
  rolling: number | null;
  weekly: number | null;
  monthly: number | null;
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

const SCRAPED_NUMBER_PATTERN = String.raw`(-?\d+(?:\.\d+)?)`;

const RE_ROLLING_PCT_FIRST = new RegExp(
  String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);
const RE_ROLLING_RESET_FIRST = new RegExp(
  String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);
const RE_WEEKLY_PCT_FIRST = new RegExp(
  String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);
const RE_WEEKLY_RESET_FIRST = new RegExp(
  String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);
const RE_MONTHLY_PCT_FIRST = new RegExp(
  String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);
const RE_MONTHLY_RESET_FIRST = new RegExp(
  String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);

// Map from window name to its two regex alternatives
const PATTERNS: Record<string, [RegExp, RegExp]> = {
  rolling: [RE_ROLLING_PCT_FIRST, RE_ROLLING_RESET_FIRST],
  weekly: [RE_WEEKLY_PCT_FIRST, RE_WEEKLY_RESET_FIRST],
  monthly: [RE_MONTHLY_PCT_FIRST, RE_MONTHLY_RESET_FIRST],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse all three usage windows (rolling, weekly, monthly) from dashboard HTML.
 * Returns null for any window that couldn't be parsed.
 *
 * @param html — Raw HTML from the OpenCode-Go dashboard page.
 * @returns An object with `rolling`, `weekly`, and `monthly` usage percentages,
 *          or null for windows that could not be parsed.
 */
export function parseAllUsage(html: string): UsageData {
  return {
    rolling: parseUsagePercent(html, 'rolling'),
    weekly: parseUsagePercent(html, 'weekly'),
    monthly: parseUsagePercent(html, 'monthly'),
  };
}

/**
 * Parse a single usage window from dashboard HTML.
 *
 * Tries two regex patterns to handle field order variance
 * (usagePercent before or after resetInSec).
 *
 * Returns null if:
 * - The window data is not found in the HTML
 * - The extracted value is not a finite number
 * - The HTML is malformed or from a non-dashboard page
 *
 * @param html  — Raw HTML from the OpenCode-Go dashboard page.
 * @param window — The time window to parse: `'rolling'`, `'weekly'`, or `'monthly'`.
 * @returns The usage percentage as a number (may be negative or exceed 100),
 *          or null if the value could not be extracted.
 */
export function parseUsagePercent(html: string, window: 'rolling' | 'weekly' | 'monthly'): number | null {
  const patterns = PATTERNS[window];
  if (!patterns) return null;

  const [rePctFirst, reResetFirst] = patterns;

  // Try usagePercent-first pattern
  const pctMatch = rePctFirst.exec(html);
  if (pctMatch) {
    // pct-first: usagePercent:$1,resetInSec:$2
    const val = Number(pctMatch[1]);
    return Number.isFinite(val) ? val : null;
  }

  // Try resetInSec-first pattern
  const resetMatch = reResetFirst.exec(html);
  if (resetMatch) {
    // reset-first: resetInSec:$1,usagePercent:$2
    const val = Number(resetMatch[2]);
    return Number.isFinite(val) ? val : null;
  }

  return null;
}


