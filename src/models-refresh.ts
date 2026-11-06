/**
 * models-refresh.ts — Deterministic generator for the bundled model catalog.
 *
 * `npm run models:refresh` (scripts/refresh-models.ts) is the only writer of
 * `assets/models.json`. It merges models.dev metadata for the two providers
 * this proxy serves with the live catalogs, so a model that no longer exists
 * upstream leaves the bundle and a new one enters without a hand edit.
 *
 * The merge is a pure function (`mergeModelCatalog`) so the catalog rules are
 * testable without network access:
 *   - `opencode-go` and `commandcode` entries are gated by their live catalog;
 *   - `opencode-go` metadata wins when both providers know a model;
 *   - a field already in the current file survives when models.dev is silent
 *     about it (models.dev drops fields occasionally and a regeneration must
 *     not discard the value);
 *   - output keys, including nested object keys, are sorted so a refresh diff
 *     only shows real changes;
 *   - a failed fetch aborts before the file is touched.
 */

import { isDeepStrictEqual } from 'node:util';
import {
  DEFAULT_UPSTREAM_COMMANDCODE,
  DEFAULT_UPSTREAM_URL,
  MODELS_DEV_SAFE_FIELDS,
  MODELS_DEV_TIMEOUT_MS,
  MODELS_DEV_URL,
  MODELS_DEV_PROVIDER_ID,
  MODELS_FETCH_TIMEOUT_MS,
} from './constants.js';
import { OPENCODE_GO_USER_AGENT } from './providers/opencode-go.js';

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** models.dev's CommandCode provider id. */
export const MODELS_DEV_COMMANDCODE_PROVIDER_ID = 'commandcode';

/** Public opencode-go catalog — no auth, but Cloudflare wants a CLI signature. */
export const OPENCODE_GO_MODELS_URL = `${DEFAULT_UPSTREAM_URL}/zen/go/v1/models`;

/** Public CommandCode catalog (200 with any or no Authorization header). */
export const COMMANDCODE_MODELS_URL = `${DEFAULT_UPSTREAM_COMMANDCODE}/provider/v1/models`;

/**
 * models.dev sits behind Cloudflare and answers 403 `error code: 1010` to
 * browser-like or missing signatures. Any stable non-browser UA works.
 */
export const MODELS_REFRESH_USER_AGENT = 'saros-proxy-models-refresh';

/** Minimal fetch surface, injected in tests. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** GET a JSON document with one User-Agent header. Throws on any non-2xx. */
async function fetchJson(
  url: string,
  userAgent: string,
  label: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': userAgent },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response.json();
}

/** Fetch and validate the models.dev catalog. */
export async function fetchModelsDevCatalog(
  fetchImpl: FetchLike = fetch,
  timeoutMs = MODELS_DEV_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const parsed = await fetchJson(
    MODELS_DEV_URL,
    MODELS_REFRESH_USER_AGENT,
    'models.dev',
    fetchImpl,
    timeoutMs,
  );
  if (!isPlainObject(parsed)) throw new Error('models.dev returned a non-object payload');
  return parsed;
}

/**
 * Fetch the opencode-go live catalog ids.
 *
 * The list is authoritative for membership: models.dev keeps models the
 * provider already retired (`space-bunny`, `cat-jam-free`, …), and publishing
 * those as connectable models is what this gate prevents.
 */
export async function fetchOpencodeGoModelIds(
  fetchImpl: FetchLike = fetch,
  timeoutMs = MODELS_FETCH_TIMEOUT_MS,
): Promise<string[]> {
  return fetchModelIds(
    OPENCODE_GO_MODELS_URL,
    OPENCODE_GO_USER_AGENT,
    'opencode-go models',
    fetchImpl,
    timeoutMs,
    () => true,
  );
}

/**
 * Fetch the CommandCode live catalog ids.
 *
 * `claude-*` is excluded: those entries advertise `/messages` only and the
 * proxy relays chat/completions shapes — the same filter the provider applies
 * when it indexes its catalog (`src/providers/commandcode.ts`).
 */
export async function fetchCommandcodeModelIds(
  fetchImpl: FetchLike = fetch,
  timeoutMs = MODELS_FETCH_TIMEOUT_MS,
): Promise<string[]> {
  return fetchModelIds(
    COMMANDCODE_MODELS_URL,
    MODELS_REFRESH_USER_AGENT,
    'commandcode models',
    fetchImpl,
    timeoutMs,
    (id) => !/^claude/i.test(id),
  );
}

/** Shared `{ object: 'list', data: [{ id }] }` parser. */
async function fetchModelIds(
  url: string,
  userAgent: string,
  label: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  keep: (id: string) => boolean,
): Promise<string[]> {
  const body = await fetchJson(url, userAgent, label, fetchImpl, timeoutMs);
  if (!isPlainObject(body) || !Array.isArray(body.data)) {
    throw new Error(`${label} returned an unexpected payload`);
  }

  const ids: string[] = [];
  for (const entry of body.data) {
    if (!isPlainObject(entry)) continue;
    const id = entry.id;
    if (typeof id === 'string' && id.length > 0 && keep(id)) ids.push(id);
  }
  return ids;
}

/** Default network sources for the CLI. */
export interface RefreshFetchers {
  modelsDev: () => Promise<Record<string, unknown>>;
  opencodeModelIds: () => Promise<readonly string[]>;
  commandcodeModelIds: () => Promise<readonly string[]>;
}

/** Build the real fetchers — the only place the CLI touches the network. */
export function defaultRefreshFetchers(): RefreshFetchers {
  return {
    modelsDev: () => fetchModelsDevCatalog(),
    opencodeModelIds: () => fetchOpencodeGoModelIds(),
    commandcodeModelIds: () => fetchCommandcodeModelIds(),
  };
}

// ---------------------------------------------------------------------------
// models.dev extraction
// ---------------------------------------------------------------------------

/** Return one provider's `models` map from a parsed models.dev payload. */
export function extractModelsDevProviderModels(
  parsed: Record<string, unknown>,
  providerId: string,
): Record<string, Record<string, unknown>> {
  const provider = parsed[providerId];
  if (!isPlainObject(provider)) return {};
  const models = provider.models;
  if (!isPlainObject(models)) return {};
  return models as Record<string, Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export interface ModelCatalogMergeInput {
  /** Parsed `https://models.dev/api.json`. */
  modelsDev: Record<string, unknown>;
  /** Ids from the live opencode-go `/models` endpoint. */
  opencodeModelIds: readonly string[];
  /** Ids from the live CommandCode `/provider/v1/models` endpoint. */
  commandcodeModelIds: readonly string[];
  /** Current bundled catalog, parsed; null/absent for a fresh file. */
  current?: Record<string, unknown> | null;
}

export interface ModelCatalogMergeResult {
  /** Merged catalog with alphabetically sorted keys (top level and nested). */
  models: Record<string, Record<string, unknown>>;
  /** Keys that were absent from the current file. */
  added: string[];
  /** Keys that disappeared from both upstream catalogs. */
  removed: string[];
  /** Keys present in both files whose content changed. */
  changed: string[];
}

/**
 * Merge models.dev metadata with the live catalogs and the current file.
 *
 * Membership is decided by upstream: only ids that the live catalog advertises
 * are kept. Fields inside a surviving entry are additive — the current file's
 * value survives whenever the upstream source does not carry that field.
 */
export function mergeModelCatalog(input: ModelCatalogMergeInput): ModelCatalogMergeResult {
  const candidates = collectCandidates(input);
  const current = isPlainObject(input.current) ? input.current : {};
  const keys = [...candidates.keys()].sort();

  const models: Record<string, Record<string, unknown>> = {};
  for (const key of keys) {
    const base = isPlainObject(current[key]) ? current[key] : {};
    const upstream: Record<string, unknown> = { ...candidates.get(key), id: key };
    models[key] = sortKeysDeep(overlay(base, upstream)) as Record<string, unknown>;
  }

  return {
    models,
    added: keys.filter((key) => !(key in current)),
    removed: Object.keys(current)
      .filter((key) => !candidates.has(key))
      .sort(),
    changed: keys.filter((key) => key in current && !isDeepStrictEqual(current[key], models[key])),
  };
}

/** Build the candidate map: opencode-go first, commandcode fills the gaps. */
function collectCandidates(
  input: ModelCatalogMergeInput,
): Map<string, Record<string, unknown>> {
  const allowedOpencode = new Set(input.opencodeModelIds.map(normalizeModelKey));
  const allowedCommandcode = new Set(input.commandcodeModelIds.map(normalizeModelKey));

  const candidates = new Map<string, Record<string, unknown>>();
  addProviderModels(
    candidates,
    extractModelsDevProviderModels(input.modelsDev, MODELS_DEV_PROVIDER_ID),
    allowedOpencode,
    false,
  );
  addProviderModels(
    candidates,
    extractModelsDevProviderModels(input.modelsDev, MODELS_DEV_COMMANDCODE_PROVIDER_ID),
    allowedCommandcode,
    true,
  );
  return candidates;
}

/**
 * Add one provider's entries that exist in its live catalog.
 *
 * @param fillOnly — keep the existing entry's fields and only fill the holes
 *                   (CommandCode is secondary metadata; opencode-go is primary)
 */
function addProviderModels(
  target: Map<string, Record<string, unknown>>,
  models: Record<string, Record<string, unknown>>,
  allowed: Set<string>,
  fillOnly: boolean,
): void {
  for (const [modelId, raw] of Object.entries(models)) {
    const key = normalizeModelKey(modelId);
    if (!key || !allowed.has(key)) continue;

    const entry = sanitizeEntry(raw);
    if (!entry) continue;

    const existing = target.get(key);
    if (!existing) {
      target.set(key, entry);
    } else if (fillOnly) {
      target.set(key, fillMissing(existing, entry));
    }
  }
}

/**
 * Normalize an id to catalog key form: bare name, lower-cased, `_` → `-`.
 * Vendor-prefixed names (`zai-org/GLM-5.3`) collapse to their model name.
 */
function normalizeModelKey(modelId: string): string {
  const bare = modelId.split('/').pop() ?? modelId;
  return bare.toLowerCase().replaceAll('_', '-');
}

/** Keep only the fields the catalog schema documents. */
function sanitizeEntry(raw: unknown): Record<string, unknown> | null {
  if (!isPlainObject(raw)) return null;

  const entry: Record<string, unknown> = {};
  for (const field of MODELS_DEV_SAFE_FIELDS) {
    if (field in raw) entry[field] = raw[field];
  }
  return Object.keys(entry).length > 0 ? entry : null;
}

/** Recursive overlay: `upstream` wins at every leaf. */
function overlay(
  base: Record<string, unknown>,
  upstream: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [field, value] of Object.entries(upstream)) {
    const current = merged[field];
    merged[field] = isPlainObject(current) && isPlainObject(value)
      ? overlay(current, value)
      : value;
  }
  return merged;
}

/** Recursive fill: values already in `base` survive, holes come from `extra`. */
function fillMissing(
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [field, value] of Object.entries(extra)) {
    const current = merged[field];
    if (!(field in merged)) {
      merged[field] = value;
    } else if (isPlainObject(current) && isPlainObject(value)) {
      merged[field] = fillMissing(current, value);
    }
  }
  return merged;
}

/** Sort object keys recursively; arrays keep their order. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isPlainObject(value)) return value;

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeysDeep(value[key]);
  }
  return sorted;
}

/** Plain object (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Serialization & orchestration
// ---------------------------------------------------------------------------

/** Stable on-disk format: 2-space indent, sorted keys, trailing newline. */
export function serializeModelCatalog(models: Record<string, unknown>): string {
  return `${JSON.stringify(sortKeysDeep(models), null, 2)}\n`;
}

/** Parse a catalog file. `null`/empty content is an empty catalog. */
export function parseCatalogContent(raw: string | null): Record<string, unknown> {
  if (raw === null || raw.trim() === '') return {};

  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) throw new Error('models catalog is not a JSON object');
  return parsed;
}

export interface RefreshIo {
  /** Read the current catalog file, or null when it does not exist. */
  read: () => string | null;
  /** Write the new catalog file. */
  write: (content: string) => void;
}

export interface RefreshOptions {
  /** Show the diff and skip the write. */
  dryRun?: boolean;
}

export interface ModelCatalogRefreshResult extends ModelCatalogMergeResult {
  previousContent: string | null;
  nextContent: string;
  /** False on a dry run and when the generated bytes already match the file. */
  written: boolean;
}

/**
 * Fetch, merge, and (unless dry-running) write the catalog.
 *
 * Every fetch settles before the file is read/written: one failed source
 * aborts the whole refresh and leaves the existing catalog untouched.
 */
export async function refreshModelCatalog(
  io: RefreshIo,
  fetchers: RefreshFetchers = defaultRefreshFetchers(),
  options: RefreshOptions = {},
): Promise<ModelCatalogRefreshResult> {
  const [modelsDev, opencodeModelIds, commandcodeModelIds] = await Promise.all([
    fetchers.modelsDev(),
    fetchers.opencodeModelIds(),
    fetchers.commandcodeModelIds(),
  ]);

  const previousContent = io.read();
  const current = parseCatalogContent(previousContent);
  const merge = mergeModelCatalog({
    modelsDev,
    opencodeModelIds,
    commandcodeModelIds,
    current,
  });
  const nextContent = serializeModelCatalog(merge.models);
  const written = options.dryRun !== true && nextContent !== previousContent;
  if (written) io.write(nextContent);

  return { ...merge, previousContent, nextContent, written };
}

// ---------------------------------------------------------------------------
// Diff rendering (--dry-run)
// ---------------------------------------------------------------------------

/** Human-readable model-level diff between the old and the new catalog. */
export function formatCatalogDiff(
  previous: Record<string, unknown> | null,
  next: Record<string, unknown>,
): string {
  const lines: string[] = [];
  const previousModels = previous ?? {};
  const nextKeys = Object.keys(next);

  for (const key of Object.keys(previousModels).sort()) {
    if (!(key in next)) lines.push(...entryBlock('-', key, previousModels[key]));
  }
  for (const key of nextKeys) {
    if (!(key in previousModels)) lines.push(...entryBlock('+', key, next[key]));
  }
  for (const key of nextKeys) {
    if (!(key in previousModels)) continue;
    if (isDeepStrictEqual(previousModels[key], next[key])) continue;
    lines.push(`~ ${key}`);
    lines.push(...diffLines(prettyLines(previousModels[key]), prettyLines(next[key])));
  }

  return lines.length > 0 ? lines.join('\n') : 'no changes';
}

/** Render one model entry as a prefixed JSON block. */
function entryBlock(prefix: '-' | '+', key: string, value: unknown): string[] {
  const [first, ...rest] = prettyLines(value);
  return [`${prefix} ${JSON.stringify(key)}: ${first}`, ...rest.map((line) => `${prefix} ${line}`)];
}

/** Pretty-print a value as lines. */
function prettyLines(value: unknown): string[] {
  return JSON.stringify(value, null, 2).split('\n');
}

/** Line diff with common prefix/suffix trimmed (LCS over the middle). */
function diffLines(before: string[], after: string[]): string[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore--;
    endAfter--;
  }

  const middleBefore = before.slice(start, endBefore);
  const middleAfter = after.slice(start, endAfter);
  const out = before.slice(0, start).map((line) => `  ${line}`);
  out.push(...emitDiff(middleBefore, middleAfter));
  out.push(...before.slice(endBefore).map((line) => `  ${line}`));
  return out;
}

/** Walk the LCS table to emit ` `/`-`/`+` lines for the changed middle. */
function emitDiff(before: string[], after: string[]): string[] {
  const table = lcsTable(before, after);
  const out: string[] = [];
  let i = 0;
  let j = 0;

  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      out.push(`  ${before[i]}`);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push(`- ${before[i]}`);
      i++;
    } else {
      out.push(`+ ${after[j]}`);
      j++;
    }
  }
  for (; i < before.length; i++) out.push(`- ${before[i]}`);
  for (; j < after.length; j++) out.push(`+ ${after[j]}`);
  return out;
}

/** LCS length table where `table[i][j]` covers `before[i:]` × `after[j:]`. */
function lcsTable(before: string[], after: string[]): number[][] {
  const table = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );

  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i][j] = before[i] === after[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}
