/**
 * version.ts — Single cached read of the installed package version.
 *
 * Both the CLI (overview/update) and the running proxy (/health) need this
 * value; reading package.json through one module keeps them in lockstep and
 * makes the read happen once per process.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedVersion: string | undefined;

/** Installed package version, cached after the first read. */
export function getVersion(): string {
  if (cachedVersion === undefined) {
    try {
      const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf-8')) as {
        version?: unknown;
      };
      cachedVersion = typeof pkg.version === 'string' && pkg.version.length > 0
        ? pkg.version
        : '0.0.0';
    } catch {
      cachedVersion = '0.0.0';
    }
  }
  return cachedVersion;
}
