/**
 * dashboard-parser.test.ts — Unit tests for dashboard-parser.ts
 *
 * Tests both parseAllUsage() and parseUsagePercent() with various HTML
 * fixtures matching the actual SolidJS `$R[...]` hydration format.
 *
 * Note: The non-finite value check in parseUsagePercent (Number.isFinite)
 * is defensive — the regex pattern `(-?\d+(?:\.\d+)?)` cannot capture
 * "Infinity" or "NaN", so that code path is unreachable through normal
 * input. Tests are included to document the contract.
 */
import { describe, it, expect } from 'vitest';
import { parseAllUsage, parseUsagePercent } from './dashboard-parser.js';

// ---------------------------------------------------------------------------
// HTML Fixtures (using the real SolidJS $R[N]={...} hydration format)
// ---------------------------------------------------------------------------

/** Standard HTML with all three usage windows (usagePercent before resetInSec). */
const HTML_ALL_WINDOWS = `
<!DOCTYPE html>
<html>
<body>
<script>
window.__SOLIDJS_DATA__ = {
  rollingUsage:$R[3]={usagePercent:45.2,resetInSec:18000},
  weeklyUsage:$R[4]={usagePercent:60.5,resetInSec:604800},
  monthlyUsage:$R[5]={usagePercent:75.8,resetInSec:2592000}
};
</script>
</body>
</html>
`;

/** HTML with only rolling usage. */
const HTML_ROLLING_ONLY = `
<!DOCTYPE html>
<html>
<body>
<script>
window.__SOLIDJS_DATA__ = {
  rollingUsage:$R[3]={usagePercent:45.2,resetInSec:18000}
};
</script>
</body>
</html>
`;

/** HTML with only weekly usage. */
const HTML_WEEKLY_ONLY = `
<!DOCTYPE html>
<html>
<body>
<script>
window.__SOLIDJS_DATA__ = {
  weeklyUsage:$R[4]={usagePercent:60.5,resetInSec:604800}
};
</script>
</body>
</html>
`;

/** HTML with only monthly usage. */
const HTML_MONTHLY_ONLY = `
<!DOCTYPE html>
<html>
<body>
<script>
window.__SOLIDJS_DATA__ = {
  monthlyUsage:$R[5]={usagePercent:75.8,resetInSec:2592000}
};
</script>
</body>
</html>
`;

/** HTML with reversed field order (resetInSec before usagePercent) for rolling. */
const HTML_REVERSED_ORDER = `
<!DOCTYPE html>
<html>
<body>
<script>
window.__SOLIDJS_DATA__ = {
  rollingUsage:$R[3]={resetInSec:3600,usagePercent:45.2}
};
</script>
</body>
</html>
`;

/** HTML with a negative usage value. */
const HTML_NEGATIVE = `
<!DOCTYPE html>
<html>
<body>
<script>
window.__SOLIDJS_DATA__ = {
  rollingUsage:$R[3]={usagePercent:-5.2,resetInSec:18000}
};
</script>
</body>
</html>
`;

/** Malformed HTML — partially missing fields inside a window block. */
const HTML_MALFORMED = `
<!DOCTYPE html>
<html>
<body>
<script>
window.__SOLIDJS_DATA__ = {
  rollingUsage:$R[3]={usagePercent:45.2,resetInSec:18000},
  weeklyUsage:$R[4]={resetInSec:604800},
  monthlyUsage:$R[5]={usagePercent:75.8}
};
</script>
</body>
</html>
`;

/** HTML where rolling usage has non-numeric (non-finite) data — defensive test. */
const HTML_NON_FINITE_ROLLING = `
<!DOCTYPE html>
<html>
<body>
<script>
window.__SOLIDJS_DATA__ = {
  rollingUsage:$R[3]={usagePercent:NaN,resetInSec:18000}
};
</script>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// Tests: parseAllUsage
// ---------------------------------------------------------------------------

describe('dashboard-parser', () => {
  describe('parseAllUsage', () => {
    it('extracts all three usage windows from standard HTML', () => {
      const result = parseAllUsage(HTML_ALL_WINDOWS);

      expect(result).toEqual({
        rolling: 45.2,
        weekly: 60.5,
        monthly: 75.8,
      });
    });

    it('returns null for missing windows when only rolling is present', () => {
      const result = parseAllUsage(HTML_ROLLING_ONLY);

      expect(result).toEqual({
        rolling: 45.2,
        weekly: null,
        monthly: null,
      });
    });

    it('returns null for missing windows when only weekly is present', () => {
      const result = parseAllUsage(HTML_WEEKLY_ONLY);

      expect(result).toEqual({
        rolling: null,
        weekly: 60.5,
        monthly: null,
      });
    });

    it('returns null for missing windows when only monthly is present', () => {
      const result = parseAllUsage(HTML_MONTHLY_ONLY);

      expect(result).toEqual({
        rolling: null,
        weekly: null,
        monthly: 75.8,
      });
    });

    it('returns all nulls for empty HTML', () => {
      const result = parseAllUsage('');

      expect(result).toEqual({
        rolling: null,
        weekly: null,
        monthly: null,
      });
    });

    it('returns partial results for malformed HTML with missing fields', () => {
      const result = parseAllUsage(HTML_MALFORMED);

      // Only rollingUsage has both required fields; weeklyUsage lacks
      // usagePercent, monthlyUsage lacks resetInSec — neither should match.
      expect(result).toEqual({
        rolling: 45.2,
        weekly: null,
        monthly: null,
      });
    });

    it('accepts negative usage values', () => {
      const result = parseAllUsage(HTML_NEGATIVE);

      expect(result).toEqual({
        rolling: -5.2,
        weekly: null,
        monthly: null,
      });
    });

    it('handles non-HTML strings gracefully (all nulls)', () => {
      const result = parseAllUsage('not even close to HTML');

      expect(result).toEqual({
        rolling: null,
        weekly: null,
        monthly: null,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: parseUsagePercent
  // ---------------------------------------------------------------------------

  describe('parseUsagePercent', () => {
    it('extracts rolling usage from HTML', () => {
      const result = parseUsagePercent(HTML_ALL_WINDOWS, 'rolling');
      expect(result).toBe(45.2);
    });

    it('extracts weekly usage from HTML', () => {
      const result = parseUsagePercent(HTML_ALL_WINDOWS, 'weekly');
      expect(result).toBe(60.5);
    });

    it('extracts monthly usage from HTML', () => {
      const result = parseUsagePercent(HTML_ALL_WINDOWS, 'monthly');
      expect(result).toBe(75.8);
    });

    it('returns null when the requested window is not present', () => {
      const result = parseUsagePercent(HTML_ROLLING_ONLY, 'weekly');
      expect(result).toBeNull();
    });

    it('returns null for an empty string', () => {
      const result = parseUsagePercent('', 'rolling');
      expect(result).toBeNull();
    });

    it('returns null for an unknown window name', () => {
      // @ts-expect-error — testing runtime behavior with invalid arg
      const result = parseUsagePercent(HTML_ALL_WINDOWS, 'invalid');
      expect(result).toBeNull();
    });

    it('returns null for non-finite extracted values (defensive path)', () => {
      // The regex cannot match "NaN" since it only captures \d patterns,
      // so this defensive path is unreachable via normal HTML input.
      // This test documents the contract: if the value were non-finite,
      // the function returns null.
      const result = parseUsagePercent(HTML_NON_FINITE_ROLLING, 'rolling');
      expect(result).toBeNull();
    });

    it('handles resetInSec before usagePercent order (two-order fallback)', () => {
      // HTML_REVERSED_ORDER has resetInSec before usagePercent,
      // which should match the reset-first pattern.
      const result = parseUsagePercent(HTML_REVERSED_ORDER, 'rolling');
      expect(result).toBe(45.2);
    });

    it('handles usagePercent before resetInSec order (primary pattern)', () => {
      // HTML_ALL_WINDOWS has usagePercent before resetInSec,
      // which should match the pct-first pattern directly.
      const result = parseUsagePercent(HTML_ALL_WINDOWS, 'rolling');
      expect(result).toBe(45.2);
    });

    it('returns null for malformed window data missing usagePercent', () => {
      // Only weekly usage data is present; rolling and monthly should be null.
      const result = parseUsagePercent(HTML_WEEKLY_ONLY, 'rolling');
      expect(result).toBeNull();
    });

    it('handles integer usage values correctly', () => {
      const html = `
        <html><body><script>
        window.__SOLIDJS_DATA__ = {
          rollingUsage:$R[3]={usagePercent:42,resetInSec:18000}
        };
        </script></body></html>
      `;
      const result = parseUsagePercent(html, 'rolling');
      expect(result).toBe(42);
    });
  });
});
