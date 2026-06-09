/**
 * update-check.ts — Check npm registry for newer versions.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let currentVersion: string | undefined;

function getCurrentVersion(): string {
  if (!currentVersion) {
    try {
      const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
      currentVersion = pkg.version;
    } catch {
      currentVersion = '0.0.0';
    }
  }
  return currentVersion;
}

/**
 * Compare two semver-like version strings. Returns:
 *   -1 if a < b
 *    0 if a == b
 *    1 if a > b
 */
function compareVersions(a: string, b: string): number {
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
 * Check npm registry for the latest version.
 * Prints a warning to stderr if a newer version is available.
 * Never throws — failures are silently ignored.
 */
export async function checkForUpdate(): Promise<void> {
  const current = getCurrentVersion();
  try {
    const res = await fetch('https://registry.npmjs.org/saros-proxy/latest', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest) return;
    if (compareVersions(current, latest) < 0) {
      console.warn(
        `\n⚠️  Update available: ${current} → ${latest}. Run: npm install -g saros-proxy\n`,
      );
    }
  } catch {
    // Network error or timeout — silently ignore
  }
}
