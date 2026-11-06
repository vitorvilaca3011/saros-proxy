/**
 * refresh-models.ts — Regenerate `assets/models.json` from the live sources.
 *
 * Usage:
 *   npm run models:refresh                # fetch, merge, write
 *   npm run models:refresh -- --dry-run   # print the diff, write nothing
 *   npm run models:refresh -- --allow-shrink
 *
 * Sources: models.dev metadata for `opencode-go` and `commandcode`, gated by
 * each provider's public catalog. A failed or empty fetch leaves the file
 * untouched; a merge that would drop more than half of the current models
 * needs `--allow-shrink`.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatCatalogDiff,
  parseCatalogContent,
  refreshModelCatalog,
} from '../src/models-refresh.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = join(PACKAGE_ROOT, 'assets', 'models.json');
const TEMP_PATH = `${CATALOG_PATH}.tmp`;

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const allowShrink = process.argv.includes('--allow-shrink');
  let writeStarted = false;

  try {
    const result = await refreshModelCatalog(
      {
        read: () => (existsSync(CATALOG_PATH) ? readFileSync(CATALOG_PATH, 'utf-8') : null),
        // Write next to the target and rename: a crash mid-write can never
        // leave a truncated catalog behind.
        write: (content) => {
          writeStarted = true;
          try {
            writeFileSync(TEMP_PATH, content, 'utf-8');
            renameSync(TEMP_PATH, CATALOG_PATH);
          } catch (err) {
            rmSync(TEMP_PATH, { force: true });
            throw err;
          }
        },
      },
      undefined,
      { dryRun, allowShrink },
    );

    if (dryRun) {
      const diff = formatCatalogDiff(parseCatalogContent(result.previousContent), result.models);
      console.log(diff);
      if (result.formattingOnly) console.log('formatting would change');
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
    // The atomic replace means a failure after the temp write never touched
    // the target, but only claim "untouched" when no write was attempted.
    const state = writeStarted
      ? 'assets/models.json was not replaced (the temp file was discarded)'
      : 'assets/models.json left untouched';
    console.error(`refresh-models: ${message}; ${state}`);
    return 1;
  }
}

process.exitCode = await main();
