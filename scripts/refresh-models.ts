/**
 * refresh-models.ts — Regenerate `assets/models.json` from the live sources.
 *
 * Usage:
 *   npm run models:refresh                # fetch, merge, write
 *   npm run models:refresh -- --dry-run   # print the diff, write nothing
 *   npm run models:refresh -- --check     # gate: exit 1 when the catalog drifted
 *   npm run models:refresh -- --allow-shrink
 *
 * Sources: models.dev metadata for `opencode-go` and `commandcode`, gated by
 * each provider's public catalog. A failed or empty fetch leaves the file
 * untouched; a merge that would drop more than half of the current models
 * needs `--allow-shrink`.
 *
 * `--check` never writes: it prints the same diff as `--dry-run` and exits 1
 * when the generated catalog differs from the file. A formatting-only
 * difference is not drift and exits 0. `--check` with `--dry-run` is rejected
 * (exit 2) because the two flags ask for different outcomes, and a failed
 * fetch still exits non-zero instead of claiming the catalog is current.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  formatCatalogDiff,
  parseCatalogContent,
  refreshModelCatalog,
} from '../src/models-refresh.js';
import type { ModelCatalogRefreshResult } from '../src/models-refresh.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = join(PACKAGE_ROOT, 'assets', 'models.json');
const TEMP_PATH = `${CATALOG_PATH}.tmp`;

/** The refresh entry point, injectable so the CLI contract is testable. */
export type RefreshRunner = typeof refreshModelCatalog;

/** Print the check verdict and map it to a process exit code. */
function reportCheck(result: ModelCatalogRefreshResult): number {
  if (result.drift.changed) {
    console.log('check — catalog is out of date; run npm run models:refresh to update it');
    return 1;
  }
  console.log(
    result.drift.formattingOnly
      ? 'check — only formatting would change; catalog is up to date'
      : 'check — assets/models.json is up to date',
  );
  return 0;
}

export async function runRefreshCli(
  argv: readonly string[],
  refresh: RefreshRunner = refreshModelCatalog,
): Promise<number> {
  const dryRun = argv.includes('--dry-run');
  const check = argv.includes('--check');
  const allowShrink = argv.includes('--allow-shrink');

  if (check && dryRun) {
    console.error('refresh-models: --check and --dry-run are different intents; pass only one');
    return 2;
  }

  let writeStarted = false;

  try {
    const result = await refresh(
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
      // `--check` is a dry run with a verdict: it must never write.
      { dryRun: dryRun || check, allowShrink },
    );

    if (dryRun || check) {
      const diff = formatCatalogDiff(parseCatalogContent(result.previousContent), result.models);
      console.log(diff);
      if (dryRun && result.formattingOnly) console.log('formatting would change');
    }

    const total = Object.keys(result.models).length;
    const label = check ? 'check — ' : dryRun ? 'dry run — ' : '';
    console.log(
      `${label}assets/models.json: ${total} models`
      + ` (+${result.added.length} added, -${result.removed.length} removed,`
      + ` ~${result.changed.length} changed)`,
    );

    if (check) return reportCheck(result);

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

const invokedPath = process.argv[1];
const invokedDirectly = invokedPath !== undefined
  && pathToFileURL(resolve(invokedPath)).href === import.meta.url;

if (invokedDirectly) process.exitCode = await runRefreshCli(process.argv.slice(2));
