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
 *   - membership follows the live catalogs: a model the provider serves enters
 *     with the metadata the live payload carries even when models.dev omits it,
 *     and it stays while the provider keeps advertising it;
 *   - `opencode-go` metadata wins when both providers know a model;
 *   - a field already in the current file survives when models.dev is silent
 *     about it (models.dev drops fields occasionally and a regeneration must
 *     not discard the value);
 *   - two raw ids that collapse to the same bare key abort the refresh;
 *   - output keys, including nested object keys, are sorted so a refresh diff
 *     only shows real changes;
 *   - a failed fetch — or an empty/partial response — aborts before the file is
 *     read, and a merge that would drop more than half of the current models
 *     needs `allowShrink` before it writes anything.
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
import { parseCatalogObject, serializeCatalogObject } from './models-catalog.js';
import { extractProviderModels } from './models-dev.js';

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
 * One entry of a live provider catalog: the id plus the metadata the payload
 * carries. `name` and `context_length` seed a catalog entry when models.dev
 * does not know the model yet.
 */
export interface LiveModel {
  id: string;
  name?: string;
  context_length?: number;
}

/**
 * Fetch the opencode-go live catalog.
 *
 * The list is authoritative for membership: models.dev keeps models the
 * provider already retired (`space-bunny`, `cat-jam-free`, …), and publishing
 * those as connectable models is what this gate prevents.
 */
export async function fetchOpencodeGoModels(
  fetchImpl: FetchLike = fetch,
  timeoutMs = MODELS_FETCH_TIMEOUT_MS,
): Promise<LiveModel[]> {
  return fetchLiveModels(
    OPENCODE_GO_MODELS_URL,
    OPENCODE_GO_USER_AGENT,
    'opencode-go models',
    fetchImpl,
    timeoutMs,
    () => true,
  );
}

/**
 * Fetch the CommandCode live catalog.
 *
 * Only models that advertise `/chat/completions` are usable through the proxy,
 * which relays chat/completions shapes. `claude-*` entries list `/messages`
 * only (verified live: chat/completions → unsupported_model); a vendor-prefixed
 * Claude model would slip past a bare `^claude` test, so the endpoint field —
 * not the id — decides.
 */
export async function fetchCommandcodeModels(
  fetchImpl: FetchLike = fetch,
  timeoutMs = MODELS_FETCH_TIMEOUT_MS,
): Promise<LiveModel[]> {
  return fetchLiveModels(
    COMMANDCODE_MODELS_URL,
    MODELS_REFRESH_USER_AGENT,
    'commandcode models',
    fetchImpl,
    timeoutMs,
    supportsChatCompletions,
  );
}

/** True when the live entry advertises the OpenAI chat/completions endpoint. */
function supportsChatCompletions(entry: Record<string, unknown>): boolean {
  const endpoints = entry.supported_endpoints;
  return Array.isArray(endpoints) && endpoints.includes('/chat/completions');
}

/** Shared `{ object: 'list', data: [{ id }] }` parser. */
async function fetchLiveModels(
  url: string,
  userAgent: string,
  label: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  keep: (entry: Record<string, unknown>) => boolean,
): Promise<LiveModel[]> {
  const body = await fetchJson(url, userAgent, label, fetchImpl, timeoutMs);
  if (!isPlainObject(body) || !Array.isArray(body.data)) {
    throw new Error(`${label} returned an unexpected payload`);
  }

  const models: LiveModel[] = [];
  for (const entry of body.data) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || entry.id.length === 0) continue;
    if (keep(entry)) models.push(toLiveModel(entry, entry.id));
  }
  return models;
}

/** Keep the fields the live payload can seed a catalog entry with. */
function toLiveModel(entry: Record<string, unknown>, id: string): LiveModel {
  const model: LiveModel = { id };
  if (typeof entry.name === 'string' && entry.name.length > 0) model.name = entry.name;
  if (typeof entry.context_length === 'number' && Number.isFinite(entry.context_length)) {
    model.context_length = entry.context_length;
  }
  return model;
}

/** Default network sources for the CLI. */
export interface RefreshFetchers {
  modelsDev: () => Promise<Record<string, unknown>>;
  opencodeModels: () => Promise<readonly LiveModel[]>;
  commandcodeModels: () => Promise<readonly LiveModel[]>;
}

/** Build the real fetchers — the only place the CLI touches the network. */
export function defaultRefreshFetchers(): RefreshFetchers {
  return {
    modelsDev: () => fetchModelsDevCatalog(),
    opencodeModels: () => fetchOpencodeGoModels(),
    commandcodeModels: () => fetchCommandcodeModels(),
  };
}

// ---------------------------------------------------------------------------
// models.dev extraction
// ---------------------------------------------------------------------------

/**
 * Return one provider's `models` map from a parsed models.dev payload.
 *
 * Thin delegate: the parse lives in `models-dev.ts` so the generator and the
 * runtime read agree on what a provider slice is.
 */
export function extractModelsDevProviderModels(
  parsed: Record<string, unknown>,
  providerId: string,
): Record<string, Record<string, unknown>> {
  return extractProviderModels(parsed, providerId);
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export interface ModelCatalogMergeInput {
  /** Parsed `https://models.dev/api.json`. */
  modelsDev: Record<string, unknown>;
  /** Live opencode-go `/models` entries. */
  opencodeModels: readonly LiveModel[];
  /** Live CommandCode `/provider/v1/models` entries (chat/completions only). */
  commandcodeModels: readonly LiveModel[];
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
 * are kept, and a live id enters even when models.dev has never heard of it.
 * Fields inside a surviving entry are additive — the current file's value
 * survives whenever the upstream source does not carry that field.
 */
export function mergeModelCatalog(input: ModelCatalogMergeInput): ModelCatalogMergeResult {
  const metadata = collectCandidates(input);
  const live = indexLiveModels(input);
  const current = isPlainObject(input.current) ? input.current : {};

  const models: Record<string, Record<string, unknown>> = {};
  const added: string[] = [];
  const changed: string[] = [];
  const entries = [...live].sort(([left], [right]) => (left < right ? -1 : 1));

  for (const [key, liveModel] of entries) {
    const base = isPlainObject(current[key]) ? current[key] : {};
    const fromModelsDev = metadata.get(key);
    // models.dev wins over the current file (it is the richer source); the
    // live payload only fills the holes models.dev leaves, so a value the user
    // customized is never replaced by a bare live stub.
    const entry = fromModelsDev ? overlay(base, { ...fromModelsDev, id: key }) : base;
    const merged = fillMissing(entry, liveStub(key, liveModel));
    models[key] = sortKeysDeep({ ...merged, id: key }) as Record<string, unknown>;

    if (!(key in current)) added.push(key);
    else if (!isDeepStrictEqual(current[key], models[key])) changed.push(key);
  }

  return {
    models,
    added,
    removed: Object.keys(current)
      .filter((key) => !live.has(key))
      .sort(),
    changed,
  };
}

/** Build the models.dev candidate map: opencode-go first, commandcode fills the gaps. */
function collectCandidates(
  input: ModelCatalogMergeInput,
): Map<string, Record<string, unknown>> {
  const opencodeCatalog = extractModelsDevProviderModels(input.modelsDev, MODELS_DEV_PROVIDER_ID);
  const commandcodeCatalog = extractModelsDevProviderModels(
    input.modelsDev,
    MODELS_DEV_COMMANDCODE_PROVIDER_ID,
  );

  const opencodeKeys = indexProviderIds(MODELS_DEV_PROVIDER_ID, input.opencodeModels);
  const commandcodeKeys = indexProviderIds(
    MODELS_DEV_COMMANDCODE_PROVIDER_ID,
    input.commandcodeModels,
  );

  const candidates = new Map<string, Record<string, unknown>>();
  addProviderModels(candidates, MODELS_DEV_PROVIDER_ID, opencodeCatalog, opencodeKeys, false);
  addProviderModels(
    candidates,
    MODELS_DEV_COMMANDCODE_PROVIDER_ID,
    commandcodeCatalog,
    commandcodeKeys,
    true,
  );
  return candidates;
}

/**
 * Index both live catalogs by key. opencode-go is the primary provider, so its
 * entry wins when the same model is served by both.
 */
function indexLiveModels(input: ModelCatalogMergeInput): Map<string, LiveModel> {
  const byKey = new Map<string, LiveModel>();
  for (const model of [...input.opencodeModels, ...input.commandcodeModels]) {
    const key = normalizeModelKey(model.id);
    if (key && !byKey.has(key)) byKey.set(key, model);
  }
  return byKey;
}

/**
 * Index one provider's live ids by catalog key, rejecting ambiguity.
 *
 * Two different raw ids (`vendorA/foo`, `vendorB/foo`) that collapse to the
 * same bare key would silently overwrite each other, so the refresh aborts
 * instead of picking one.
 */
function indexProviderIds(providerId: string, live: readonly LiveModel[]): Map<string, LiveModel> {
  const byKey = new Map<string, LiveModel>();
  for (const model of live) {
    const key = normalizeModelKey(model.id);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) throw collisionError(providerId, existing.id, model.id, key);
    byKey.set(key, model);
  }
  return byKey;
}

/** The bare-name collision message: which raw ids fought over one key. */
function collisionError(providerId: string, first: string, second: string, key: string): Error {
  return new Error(
    `bare-name collision in ${providerId}: "${first}" and "${second}" both map to "${key}"; `
    + 'rename one of them upstream or teach normalizeModelKey about the difference',
  );
}

/**
 * Add one provider's models.dev entries that exist in its live catalog.
 *
 * @param fillOnly — keep the existing entry's fields and only fill the holes
 *                   (CommandCode is secondary metadata; opencode-go is primary)
 */
function addProviderModels(
  target: Map<string, Record<string, unknown>>,
  providerId: string,
  models: Record<string, Record<string, unknown>>,
  allowed: Map<string, LiveModel>,
  fillOnly: boolean,
): void {
  for (const [modelId, raw] of Object.entries(models)) {
    const key = normalizeModelKey(modelId);
    const liveModel = allowed.get(key);
    if (!liveModel) continue;
    // The same model under a different raw id in models.dev and the live
    // payload is the cross-source form of the bare-name collision.
    if (liveModel.id !== modelId) throw collisionError(providerId, liveModel.id, modelId, key);

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
 * Fallback context window for a live-only model whose payload carries no
 * `context_length`; same default `providerCatalogToCanonical` uses.
 */
const LIVE_STUB_CONTEXT_FALLBACK = 262_144;

/** Fallback max output tokens; same default `providerCatalogToCanonical` uses. */
const LIVE_STUB_OUTPUT_FALLBACK = 65_536;

/**
 * Minimal catalog entry from a live payload: id, name, context window and the
 * canonical defaults the harness pipeline (`providerCatalogToCanonical`) gives
 * a model with no models.dev metadata. Every value here only fills a hole, so
 * models.dev and the current file still win wherever they have a field.
 */
function liveStub(key: string, model: LiveModel): Record<string, unknown> {
  const stub: Record<string, unknown> = {
    id: key,
    tool_call: true,
    reasoning: true,
    limit: {
      context: model.context_length ?? LIVE_STUB_CONTEXT_FALLBACK,
      output: LIVE_STUB_OUTPUT_FALLBACK,
    },
    modalities: { input: ['text'], output: ['text'] },
    // Conservative effort ladder: the commandcode gateway accepts
    // low|medium|high|xhigh and rejects minimal, so declare the safe three.
    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
  };
  if (model.name !== undefined) stub.name = model.name;
  return stub;
}

/**
 * Normalize an id to catalog key form: bare name, lower-cased, `_` → `-`.
 * Vendor-prefixed names (`zai-org/GLM-5.3`) collapse to their model name.
 */
function normalizeModelKey(modelId: string): string {
  const bare = modelId.substring(modelId.lastIndexOf('/') + 1);
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
  return serializeCatalogObject(sortKeysDeep(models) as Record<string, unknown>);
}

/** Parse a catalog file. `null`/empty content is an empty catalog. */
export function parseCatalogContent(raw: string | null): Record<string, unknown> {
  if (raw === null || raw.trim() === '') return {};
  return parseCatalogObject(raw);
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
  /** Allow a merge that removes more than half of the current models. */
  allowShrink?: boolean;
}

export interface ModelCatalogRefreshResult extends ModelCatalogMergeResult {
  previousContent: string | null;
  nextContent: string;
  /** False on a dry run and when the generated bytes already match the file. */
  written: boolean;
  /** True when only key order/whitespace differs from the file on disk. */
  formattingOnly: boolean;
}

/**
 * Fetch, merge, and (unless dry-running) write the catalog.
 *
 * Sources are validated before the file is read: a 2xx with an empty body (a
 * Cloudflare hiccup, a partial rollout) used to empty the catalog and mark
 * every model removed. A merge that would drop more than half of the current
 * models is treated the same way unless `allowShrink` opts in.
 */
export async function refreshModelCatalog(
  io: RefreshIo,
  fetchers: RefreshFetchers = defaultRefreshFetchers(),
  options: RefreshOptions = {},
): Promise<ModelCatalogRefreshResult> {
  const [modelsDev, opencodeModels, commandcodeModels] = await Promise.all([
    fetchers.modelsDev(),
    fetchers.opencodeModels(),
    fetchers.commandcodeModels(),
  ]);
  assertRefreshSources(modelsDev, opencodeModels, commandcodeModels);

  const previousContent = io.read();
  const current = parseCatalogContent(previousContent);
  const merge = mergeModelCatalog({
    modelsDev,
    opencodeModels,
    commandcodeModels,
    current,
  });
  assertShrinkAllowed(merge, current, options.allowShrink);

  const nextContent = serializeModelCatalog(merge.models);
  const bytesChanged = nextContent !== previousContent;
  const formattingOnly = bytesChanged
    && merge.added.length === 0
    && merge.removed.length === 0
    && merge.changed.length === 0;
  const written = options.dryRun !== true && bytesChanged;
  if (written) io.write(nextContent);

  return { ...merge, previousContent, nextContent, written, formattingOnly };
}

/**
 * Reject a source that answered 2xx with an empty or partial payload.
 *
 * models.dev must carry both provider maps; each live catalog must carry at
 * least one usable id. Anything else is a network hiccup, not a catalog.
 */
function assertRefreshSources(
  modelsDev: Record<string, unknown>,
  opencodeModels: readonly LiveModel[],
  commandcodeModels: readonly LiveModel[],
): void {
  for (const providerId of [MODELS_DEV_PROVIDER_ID, MODELS_DEV_COMMANDCODE_PROVIDER_ID]) {
    const models = extractModelsDevProviderModels(modelsDev, providerId);
    if (Object.keys(models).length === 0) {
      throw new Error(
        `models.dev returned no ${providerId} models; refusing to treat an empty response as a catalog`,
      );
    }
  }

  if (opencodeModels.length === 0) {
    throw new Error('opencode-go returned no models; refusing to treat an empty response as a catalog');
  }
  if (commandcodeModels.length === 0) {
    throw new Error('commandcode returned no models; refusing to treat an empty response as a catalog');
  }
}

/**
 * Refuse a merge that removes more than half of the current models.
 *
 * A partial upstream response looks exactly like a mass retirement, and the
 * resulting file would drop models the proxy still serves. `allowShrink` is
 * the operator's statement that the removal is intentional.
 */
function assertShrinkAllowed(
  merge: ModelCatalogMergeResult,
  current: Record<string, unknown>,
  allowShrink: boolean | undefined,
): void {
  if (allowShrink) return;

  const total = Object.keys(current).length;
  if (total === 0 || merge.removed.length * 2 <= total) return;

  const percent = Math.round((merge.removed.length / total) * 100);
  throw new Error(
    `refusing to remove ${merge.removed.length} of ${total} models (${percent}%): `
    + 'neither live catalog lists them any more, which is how a partial upstream response looks. '
    + 'Rerun with --allow-shrink if the removal is intentional',
  );
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
