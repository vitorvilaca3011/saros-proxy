/**
 * refresh-models.ts — Regenerate `assets/models.json` from the live sources.
 *
 * Usage:
 *   npm run models:refresh            # fetch, merge, write
 *   npm run models:refresh -- --dry-run
 *
 * Sources: models.dev metadata for `opencode-go` and `commandcode`, gated by
 * each provider's public catalog. A failed fetch leaves the file untouched.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatCatalogDiff,
  parseCatalogContent,
  refreshModelCatalog,
} from '../src/models-refresh.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = join(PACKAGE_ROOT, 'assets', 'models.json');

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');

  try {
    const result = await refreshModelCatalog(
      {
        read: () => (existsSync(CATALOG_PATH) ? readFileSync(CATALOG_PATH, 'utf-8') : null),
        write: (content) => writeFileSync(CATALOG_PATH, content, 'utf-8'),
      },
      undefined,
      { dryRun },
    );

    if (dryRun) {
      console.log(formatCatalogDiff(parseCatalogContent(result.previousContent), result.models));
    }

    const total = Object.keys(result.models).length;
    const summary =
      `${dryRun ? 'dry run — ' : ''}assets/models.json: ${total} models`
      + ` (+${result.added.length} added, -${result.removed.length} removed,`
      + ` ~${result.changed.length} changed)`;
    console.log(summary);

    if (!dryRun) {
      console.log(result.written ? 'wrote assets/models.json' : 'assets/models.json already up to date');
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`refresh-models: ${message}; assets/models.json left untouched`);
    return 1;
  }
}

process.exitCode = await main();
