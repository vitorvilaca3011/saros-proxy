/**
 * harness-sync.ts — Harness selection setting + multi-harness sync orchestrator.
 *
 * Which harnesses saros-proxy syncs is opt-in via
 * ~/.config/saros/harnesses.json (managed with the `configharness` CLI
 * command). syncModelsInAllHarnesses() reads that setting and dispatches to
 * the per-harness sync functions — it never runs a harness the user did not
 * enable.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ProxyConfig } from '../config.js';
import { syncModelsToOpencodeConfig, type OpencodeConfigResult } from './opencode-config.js';
import { syncOpencodeModelsWithUpstream } from '../models-sync.js';
import { syncModelsToPiConfig } from './pi-config.js';
import { syncModelsToOmpConfig } from './omp-config.js';
import { syncModelsToDshConfig } from './dsh-config.js';
import { buildCanonicalModels } from './harness-models.js';

export type HarnessId = 'opencode' | 'pi' | 'omp' | 'dsh';

export interface HarnessSyncResult {
  harness: HarnessId;
  result: OpencodeConfigResult;
}

const VALID_HARNESS_IDS: readonly HarnessId[] = ['opencode', 'pi', 'omp', 'dsh'];

/** Path to the harness-selection setting: ~/.config/saros/harnesses.json */
export function getHarnessSettingsPath(): string {
  return join(homedir(), '.config', 'saros', 'harnesses.json');
}

/**
 * Read enabled harness ids.
 *
 * A MISSING settings file defaults to `['opencode']` — the legacy behavior
 * where opencode was always synced — so existing installs keep auto-sync
 * without re-running setup. An existing file is authoritative: an explicit
 * empty list (`{"harnesses":[]}`) opts out of everything; an invalid file
 * yields `[]` (no sync) rather than guessing.
 */
export function readHarnessSettings(): HarnessId[] {
  const path = getHarnessSettingsPath();
  if (!existsSync(path)) return ['opencode'];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { harnesses?: unknown };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.harnesses)) return [];
    return parsed.harnesses.filter((id): id is HarnessId =>
      VALID_HARNESS_IDS.includes(id as HarnessId),
    );
  } catch {
    return [];
  }
}

/** Write the enabled harness ids (replaces any previous selection). */
export function writeHarnessSettings(ids: HarnessId[]): void {
  const path = getHarnessSettingsPath();
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ harnesses: ids }, null, 2), 'utf-8');
}

const HARNESS_ALIASES: Record<string, HarnessId> = {
  omp: 'omp',
  ohmypi: 'omp',
  pi: 'pi',
  oc: 'opencode',
  opencode: 'opencode',
  dsh: 'dsh',
  deepseek: 'dsh',
};

export interface HarnessCommandArgs {
  add: HarnessId[];
  remove: HarnessId[];
  clear: boolean;
  errors: string[];
}

/**
 * Parse `configharness` CLI args into an add/remove/clear operation.
 *
 * Harness names before `--remove` are added to the selection, names after it
 * are removed; `--clear` alone empties the selection. Unknown names land in
 * `errors` (the caller reports them and exits non-zero).
 */
export function parseHarnessCommandArgs(args: string[]): HarnessCommandArgs {
  const add: HarnessId[] = [];
  const remove: HarnessId[] = [];
  const errors: string[] = [];
  let clear = false;
  let removing = false;
  for (const arg of args) {
    if (arg === '--clear') {
      clear = true;
      continue;
    }
    if (arg === '--remove') {
      removing = true;
      continue;
    }
    const mapped = HARNESS_ALIASES[arg.toLowerCase()];
    if (!mapped) {
      errors.push(arg);
      continue;
    }
    const target = removing ? remove : add;
    if (!target.includes(mapped)) target.push(mapped);
  }
  return { add, remove, clear, errors };
}

/**
 * Apply an add/remove/clear operation to the harness selection.
 *
 * Additive by design: names are merged into the current selection, so
 * `configharness omp` followed by `configharness pi` enables both. A missing
 * settings file starts from an empty selection on the first explicit command
 * (the implicit opencode default only applies while nothing is configured).
 *
 * @returns the resulting selection after the write.
 */
export function updateHarnessSettings(op: Omit<HarnessCommandArgs, 'errors'>): HarnessId[] {
  if (op.clear) {
    writeHarnessSettings([]);
    return [];
  }
  const fileExists = existsSync(getHarnessSettingsPath());
  if (!fileExists && op.add.length === 0) {
    // Nothing configured yet and nothing to add — keep the implicit
    // opencode default instead of writing an explicit empty list.
    return readHarnessSettings();
  }
  const base = fileExists ? readHarnessSettings() : [];
  const next = base.filter((id) => !op.remove.includes(id));
  for (const id of op.add) {
    if (!next.includes(id)) next.push(id);
  }
  writeHarnessSettings(next);
  return next;
}

/**
 * Sync models to every enabled harness (opt-in via the settings file).
 *
 * @param config — Proxy config; required for the live (upstream) opencode
 *   sync. When undefined, harnesses fall back to the bundled model list.
 * @returns One result per enabled harness, in the order opencode, pi, omp.
 */
export async function syncModelsInAllHarnesses(
  config?: ProxyConfig,
): Promise<HarnessSyncResult[]> {
  const enabled = readHarnessSettings();
  if (enabled.length === 0) return [];

  const results: HarnessSyncResult[] = [];

  if (enabled.includes('opencode')) {
    if (!config) {
      results.push({ harness: 'opencode', result: syncModelsToOpencodeConfig() });
    } else {
      results.push({ harness: 'opencode', result: await syncOpencodeModelsWithUpstream(config) });
    }
  }

  if (
    enabled.includes('pi') ||
    enabled.includes('omp') ||
    enabled.includes('dsh')
  ) {
    const modelsMap = await buildCanonicalModels(config);
    const port = config?.port ?? 3000;

    if (enabled.includes('pi')) {
      results.push({ harness: 'pi', result: syncModelsToPiConfig(modelsMap, port) });
    }
    if (enabled.includes('omp')) {
      results.push({ harness: 'omp', result: syncModelsToOmpConfig(modelsMap, port) });
    }
    if (enabled.includes('dsh')) {
      results.push({ harness: 'dsh', result: syncModelsToDshConfig(modelsMap, port) });
    }
  }

  return results;
}
