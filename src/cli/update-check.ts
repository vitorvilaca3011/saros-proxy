/**
 * update-check.ts — Check npm registry for newer versions.
 */

import { getVersion } from '../version.js';

const REGISTRY_URL = 'https://registry.npmjs.org/saros-proxy/latest';
const REGISTRY_TIMEOUT_MS = 5000;

/** Backwards-compatible alias for the shared cached version read. */
export { getVersion as getCurrentVersion };

/**
 * Compare two semver-like version strings. Returns:
 *   -1 if a < b
 *    0 if a == b
 *    1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aVal = aParts[i] ?? 0;
    const bVal = bParts[i] ?? 0;
    if (aVal < bVal) return -1;
    if (aVal > bVal) return 1;
  }
  return 0;
}

/**
 * Read the `latest` version from the npm registry.
 *
 * Throws a human-readable error when the registry cannot answer — callers that
 * only warn (the boot check) swallow it, `update --check` reports it.
 * `fetchImpl` is injectable so tests never touch the network.
 */
export async function fetchLatestVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(REGISTRY_URL, {
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`registry responded with HTTP ${res.status}`);
  }
  const data = (await res.json()) as { version?: unknown };
  if (typeof data.version !== 'string' || data.version.length === 0) {
    throw new Error('registry response has no version field');
  }
  return data.version;
}

/**
 * Check npm registry for the latest version.
 * Prints a warning to stderr if a newer version is available.
 * Never throws — failures are silently ignored.
 */
export async function checkForUpdate(): Promise<void> {
  const current = getVersion();
  try {
    const latest = await fetchLatestVersion();
    if (compareVersions(current, latest) < 0) {
      console.warn(
        `\n⚠️  Update available: ${current} → ${latest}. Run: saros-proxy update\n`,
      );
    }
  } catch {
    // Network error or timeout — silently ignore
  }
}
