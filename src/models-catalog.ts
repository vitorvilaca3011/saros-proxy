/**
 * models-catalog.ts — Single source of truth for the bundled model catalog.
 *
 * `models.json` at the package root is the canonical definition. It is read
 * from disk at runtime (not imported) because `rootDir` is `./src` while the
 * file lives outside it. The same path is used by the daemon to seed
 * `~/.config/saros/models.json`.
 *
 * A missing or malformed catalog degrades to an empty map (callers fall back
 * to heuristics) and logs a single warning per path.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

/** Package root — works both from `src/` (tsx/vitest) and `dist/` (build). */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Bundled catalog path: `<package root>/models.json`. */
const BUNDLED_MODELS_PATH = join(PACKAGE_ROOT, 'models.json');

/** Parsed catalogs, keyed by absolute path (parsed once per process). */
const cache = new Map<string, Record<string, unknown>>();

/**
 * Load the model catalog from disk, with in-memory caching.
 *
 * @param filePath — Catalog path (defaults to the bundled `models.json`)
 * @returns The parsed catalog, or `{}` when the file is missing/invalid
 */
export function loadModelsCatalog(filePath: string = BUNDLED_MODELS_PATH): Record<string, unknown> {
  const cached = cache.get(filePath);
  if (cached) return cached;

  const models = readCatalog(filePath);
  cache.set(filePath, models);
  return models;
}

/** Clear the in-memory cache — test helper. */
export function resetModelsCatalogCache(): void {
  cache.clear();
}

/** Read and validate one catalog file. Never throws. */
function readCatalog(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      logger.warn({ path: filePath }, 'models catalog is not a JSON object; using empty catalog');
      return {};
    }

    return parsed as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err, path: filePath }, 'failed to load models catalog; using empty catalog');
    return {};
  }
}
