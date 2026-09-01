/**
 * dsh-config.ts — DeepSeek Harness (dsh) sync target.
 *
 * Updates the saros-proxy provider's model list inside the dsh profile's
 * patch layer (~/.dsh/profiles/web/cordis.patch.yml), row id `llm-pi-ai`.
 * dsh model entries use the pi/omp field names plus a `reasoningEfforts`
 * map ({ 'off': null, high: 'high', … }) instead of pi/omp's `thinking`
 * object — the transformer here converts the canonical entries.
 *
 * Only `providers["saros-proxy"].models` is replaced; every other provider
 * row (commandcode, commandcode-anthropic, agent-default-model, MCP inserts)
 * and all user fields are preserved. Leading comment lines are re-emitted
 * verbatim (the patch file documents its `!!js` allowance in a comment).
 * cordis.yml is NEVER touched (dsh rewrites it empty at every boot).
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { toPiOmpModelArray, type PiOmpModel } from './harness-models.js';
import type { OpencodeConfigResult } from './opencode-config.js';

/** Default dsh patch layer path for the web profile. */
export function getDefaultDshConfigPath(): string {
  return join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml');
}

const DSH_ROW_ID = 'llm-pi-ai';
const SAROS_PROVIDER_KEY = 'saros-proxy';

/** Convert a pi/omp model entry into the dsh patch entry shape. */
export function toDshModel(model: PiOmpModel): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: model.id,
    name: model.name,
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
  if (model.thinking && model.thinking.efforts.length > 0) {
    const efforts: Record<string, string | null> = { off: null };
    for (const effort of model.thinking.efforts) {
      efforts[effort] = effort;
    }
    entry.reasoningEfforts = efforts;
  }
  if (model.cost) {
    entry.cost = model.cost;
  }
  return entry;
}

/**
 * Split leading comment lines from the raw YAML text so they can be
 * re-emitted after stringify (the yaml package drops comments).
 */
function splitLeadingComments(raw: string): { comments: string; body: string } {
  const lines = raw.split('\n');
  const comments: string[] = [];
  let i = 0;
  while (i < lines.length && (lines[i].trimStart().startsWith('#') || lines[i].trim() === '')) {
    comments.push(lines[i]);
    i++;
  }
  return { comments: comments.join('\n'), body: lines.slice(i).join('\n') };
}

/**
 * Sync the saros-proxy provider model list into the dsh patch layer.
 *
 * @param modelsMap — Canonical model map (id → opencode-shaped entry)
 * @param port — Proxy port (unused today; kept for harness-sync parity)
 * @param options.configPath — Explicit config path (for testing)
 * @returns Result with success status and path
 */
export function syncModelsToDshConfig(
  modelsMap: Record<string, unknown>,
  port: number,
  options: { configPath?: string } = {},
): OpencodeConfigResult {
  void port;
  const configPath = options.configPath ?? getDefaultDshConfigPath();

  if (!existsSync(configPath)) {
    return { success: false, error: 'config not found at ' + configPath };
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const { comments, body } = splitLeadingComments(raw);

    let doc: unknown;
    try {
      doc = parseYaml(body);
    } catch {
      return { success: false, path: configPath, error: 'dsh patch contains invalid YAML' };
    }
    if (!Array.isArray(doc)) {
      return { success: false, path: configPath, error: 'dsh patch is not a top-level array' };
    }

    // Locate the llm-pi-ai row and its saros-proxy provider entry.
    const row = doc.find(
      (r) => r && typeof r === 'object' && !Array.isArray(r) &&
        (r as Record<string, unknown>).id === DSH_ROW_ID,
    ) as Record<string, unknown> | undefined;
    if (!row) {
      return { success: false, path: configPath, error: `dsh patch has no ${DSH_ROW_ID} row` };
    }

    const config = row.config as Record<string, unknown> | undefined;
    const providers = config?.providers as Record<string, unknown> | undefined;
    const provider = providers?.[SAROS_PROVIDER_KEY] as Record<string, unknown> | undefined;
    if (!provider) {
      return {
        success: false,
        path: configPath,
        error: `dsh patch ${DSH_ROW_ID} row has no ${SAROS_PROVIDER_KEY} provider`,
      };
    }

    // Replace ONLY the models key.
    provider.models = toPiOmpModelArray(modelsMap).map(toDshModel);

    const backupPath = configPath + '.backup';
    if (existsSync(configPath)) {
      copyFileSync(configPath, backupPath);
    }
    writeFileSync(configPath, comments ? comments + '\n' + stringifyYaml(doc) : stringifyYaml(doc), 'utf-8');
    return { success: true, path: configPath, created: false };
  } catch (err) {
    return {
      success: false,
      path: configPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
