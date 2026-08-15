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
import { buildCanonicalModels } from './harness-models.js';

export type HarnessId = 'opencode' | 'pi' | 'omp';

export interface HarnessSyncResult {
  harness: HarnessId;
  result: OpencodeConfigResult;
}

const VALID_HARNESS_IDS: readonly HarnessId[] = ['opencode', 'pi', 'omp'];

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
};

/** Map CLI harness-name args to canonical ids; unknown names land in errors. */
export function parseHarnessArgs(args: string[]): { ids: HarnessId[]; errors: string[] } {
  const ids: HarnessId[] = [];
  const errors: string[] = [];
  for (const arg of args) {
    const mapped = HARNESS_ALIASES[arg.toLowerCase()];
    if (mapped) {
      if (!ids.includes(mapped)) ids.push(mapped);
    } else {
      errors.push(arg);
    }
  }
  return { ids, errors };
}

/**
 * Sync models to every enabled harness (opt-in via the settings file).
 *
 * @param config — Proxy config; required for the live (upstream) opencode
 *   sync. When undefined, opencode falls back to the bundled fast-path.
 * @param opts.offline — Skip network: use bundled models.json everywhere.
 * @returns One result per enabled harness, in the order opencode, pi, omp.
 */
export async function syncModelsInAllHarnesses(
  config?: ProxyConfig,
  opts: { offline?: boolean } = {},
): Promise<HarnessSyncResult[]> {
  const enabled = readHarnessSettings();
  if (enabled.length === 0) return [];

  const results: HarnessSyncResult[] = [];

  if (enabled.includes('opencode')) {
    if (opts.offline || !config) {
      results.push({ harness: 'opencode', result: syncModelsToOpencodeConfig() });
    } else {
      results.push({ harness: 'opencode', result: await syncOpencodeModelsWithUpstream(config) });
    }
  }

  if (enabled.includes('pi') || enabled.includes('omp')) {
    const modelsMap = await buildCanonicalModels(config, opts);
    const port = config?.port ?? 3000;

    if (enabled.includes('pi')) {
      results.push({ harness: 'pi', result: syncModelsToPiConfig(modelsMap, port) });
    }
    if (enabled.includes('omp')) {
      results.push({ harness: 'omp', result: syncModelsToOmpConfig(modelsMap, port) });
    }
  }

  return results;
}
