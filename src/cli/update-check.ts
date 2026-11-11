/**
 * update-check.ts — Check npm registry for newer versions.
 */

import { getVersion } from '../version.js';

const REGISTRY_URL = 'https://registry.npmjs.org/saros-proxy/latest';
const REGISTRY_TIMEOUT_MS = 5000;

/**
 * A registry version must be plain semver before it is interpolated into an
 * `npm install` argument (on Windows that runs through a shell).
 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Backwards-compatible alias for the shared cached version read. */
export { getVersion as getCurrentVersion };

export function isValidVersion(version: string): boolean {
  return VERSION_PATTERN.test(version);
}

interface ParsedVersion {
  core: number[];
  /** Dot-separated prerelease identifiers; null for a stable release. */
  prerelease: string[] | null;
}

/**
 * Split semver into numeric core and prerelease. Build metadata (`+…`) is
 * ignored: it does not participate in precedence.
 */
function parseVersion(version: string): ParsedVersion {
  const withoutBuild = version.trim().replace(/^v/, '').split('+')[0];
  const dash = withoutBuild.indexOf('-');
  const core = (dash === -1 ? withoutBuild : withoutBuild.slice(0, dash))
    .split('.')
    .map(Number);
  return {
    core,
    prerelease: dash === -1 ? null : withoutBuild.slice(dash + 1).split('.'),
  };
}

/**
 * Compare two semver-like version strings. Returns:
 *   -1 if a < b
 *    0 if a == b
 *    1 if a > b
 *
 * A prerelease sorts below its stable release (`1.1.3-rc.1 < 1.1.3`), as
 * `saros-proxy update` uses this to decide whether to install.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const coreLength = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < coreLength; i++) {
    const aVal = left.core[i] ?? 0;
    const bVal = right.core[i] ?? 0;
    if (aVal < bVal) return -1;
    if (aVal > bVal) return 1;
  }

  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;

  const prereleaseLength = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < prereleaseLength; i++) {
    const aId = left.prerelease[i];
    const bId = right.prerelease[i];
    if (aId === undefined) return -1;
    if (bId === undefined) return 1;
    const aNumeric = /^\d+$/.test(aId);
    const bNumeric = /^\d+$/.test(bId);
    if (aNumeric && bNumeric) {
      const diff = Number(aId) - Number(bId);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (aNumeric !== bNumeric) {
      // Numeric identifiers have lower precedence than alphanumeric ones.
      return aNumeric ? -1 : 1;
    } else if (aId !== bId) {
      return aId < bId ? -1 : 1;
    }
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
  if (!isValidVersion(data.version)) {
    throw new Error(`registry returned an invalid version: ${data.version}`);
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
