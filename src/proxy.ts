/**
 * proxy.ts — Hono HTTP proxy app. Saros predicts account exhaustion and cycles between accounts.
 *
 * Routes /zen/go/v1/* requests to the upstream API with automatic key
 * selection, circuit-breaker failover, and streaming pass-through.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { rateLimiter } from 'hono-rate-limiter';
import type { Context } from 'hono';
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  createProxyState,
  selectKeyForRequest,
  failoverRequest,
  completeRequest,
  markKeyFailed,
  markKeySucceeded,
  classifyHttpError,
  type ProxyState,
  type KeySnapshot,
} from './proxy-logic.js';
import type { ProxyConfig } from './config.js';
import { logger, maskKey } from './logger.js';
import {
  MAX_BODY_SIZE,
  MAX_RETRIES,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
} from './constants.js';
import { getModelsList } from './models-fetcher.js';
import { maybeRefreshUsage } from './usage-client.js';
import { recordModelRequest } from './model-stats.js';
import { getProvider, inferProvider } from './providers/index.js';
import type { KeyProvider, ProviderId } from './providers/index.js';

/** Canonical client-facing chat route prefix (the opencode-go shape). */
const CANONICAL_CHAT_BASE = '/zen/go/v1';

/**
 * Resolve the upstream URL for one attempt: per-provider base URL + path
 * remapping. Clients always speak canonical saros routes (/zen/go/v1/<rest>,
 * the opencode-go shape); requests routed to a provider with a different
 * chat surface get the prefix remapped (e.g. /provider/v1 for commandcode).
 */
export function resolveUpstreamUrl(config: ProxyConfig, provider: KeyProvider, path: string): string {
  const base = (config.upstreams?.[provider.id] ?? (provider.id === 'opencode-go' ? config.upstreamBaseUrl : provider.baseUrl))
    .replace(/\/+$/, '');
  if (provider.chatBasePath === CANONICAL_CHAT_BASE) {
    return buildUpstreamUrl(base, path);
  }
  const remapped = path.startsWith(CANONICAL_CHAT_BASE)
    ? provider.chatBasePath + path.slice(CANONICAL_CHAT_BASE.length)
    : path;
  return buildUpstreamUrl(base, remapped);
}

/**
 * Extract a provider-suffix routing hint from a model id
 * (e.g. 'claude-…@commandcode' → 'commandcode'). Returns null when absent.
 */
export function parseProviderSuffix(modelId: string | undefined): string | null {
  if (!modelId) return null;
  const at = modelId.lastIndexOf('@');
  if (at <= 0 || at === modelId.length - 1) return null;
  return modelId.slice(at + 1);
}

/** Strip the @provider routing suffix from a model id for upstream forwarding. */
export function stripProviderSuffix(modelId: string): string {
  const at = modelId.lastIndexOf('@');
  return at > 0 ? modelId.slice(0, at) : modelId;
}

function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Opt-in diagnostics: when SAROS_CAPTURE_4XX=1, write the full request
 * context of every upstream 4xx to <config dir>/captures/ so provider-side
 * errors (role validation, plan gating) can be replayed and debugged.
 * Never enabled by default — bodies may contain user content.
 */
function captureFailedRequest(ctx: RetryContext, status: number, errorBody: string): void {
  if (process.env.SAROS_CAPTURE_4XX !== '1') return;
  if (status < 400 || status >= 500) return;
  try {
    const dir = join(homedir(), '.config', 'saros', 'captures');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${Date.now()}-${ctx.requestId.slice(0, 8)}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          requestId: ctx.requestId,
          status,
          method: ctx.method,
          path: ctx.path,
          model: ctx.modelId ?? null,
          kind: ctx.kind,
          upstreamError: errorBody.slice(0, 2000),
          requestBody: ctx.bodyText.slice(0, 100_000),
        },
        null,
        2,
      ),
      'utf-8',
    );
    logger.warn({ requestId: ctx.requestId, file }, 'captured failing request (SAROS_CAPTURE_4XX)');
  } catch {
    // diagnostics must never break the proxy
  }
}

/**
 * Rewrite the model field inside a JSON request body. Returns the original
 * text unchanged when the body isn't valid JSON or has no model field.
 */
function rewriteModelInBody(bodyText: string, modelId: string): string {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bodyText;
    if (typeof parsed.model !== 'string') return bodyText;
    parsed.model = modelId;
    return JSON.stringify(parsed);
  } catch {
    return bodyText;
  }
}

/**
 * Rewrite a request's model id for the provider about to serve it.
 *
 * 1. '@provider' suffix → strip it (the suffix is saros's routing shim).
 * 2. Otherwise, when the serving provider names the same model differently
 *    (bare name matches its catalog under a vendor-prefixed id — e.g.
 *    'deepseek-v4-flash' → 'deepseek/deepseek-v4-flash' on commandcode),
 *    rewrite to the provider's native id so the upstream recognizes it.
 *    This is what makes cross-provider round-robin seamless: one id in,
 *    any of the serving keys out.
 */
function rewriteModelForProvider(
  bodyText: string,
  modelId: string | undefined,
  provider: KeyProvider,
): string {
  if (!modelId) return bodyText;
  if (parseProviderSuffix(modelId)) {
    return rewriteModelInBody(bodyText, stripProviderSuffix(modelId));
  }
  const bare = modelId.split('/').pop() ?? modelId;
  const native = provider.resolveNativeId?.(bare.toLowerCase());
  if (native && native !== modelId) {
    return rewriteModelInBody(bodyText, native);
  }
  return bodyText;
}

/**
 * Provider for a key snapshot. Suffix-routed requests (​@provider model ids)
 * pin the provider; otherwise structural inference from the key itself.
 */
function providerForKey(key: KeySnapshot, config: ProxyConfig, modelId?: string): KeyProvider {
  const suffixProvider = parseProviderSuffix(modelId);
  if (suffixProvider) {
    const pinned = getProvider(suffixProvider as ProviderId);
    if (pinned) return pinned;
  }
  const inferred = inferProvider({ label: key.label, key: key.key });
  void config;
  return getProvider(inferred) ?? getProvider('opencode-go')!;
}

// Augment Hono's ContextVariableMap for @hono/node-server remote address
declare module 'hono' {
  interface ContextVariableMap {
    remote: { address: string };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch with configurable timeout using AbortController.
 * Returns 504 Gateway Timeout response if the request times out.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new TimeoutError('Request timed out');
    }
    throw err;
  }
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Build upstream URL from base + request path.
 */
export function buildUpstreamUrl(base: string, path: string): string {
  // Strip trailing slash from base, ensure leading slash on path
  const normalizedBase = base.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : '/' + path;
  // Reject path traversal attempts
  if (normalizedPath.includes('..')) {
    throw new Error('Path traversal detected');
  }
  return normalizedBase + normalizedPath;
}

/**
 * Clean headers for upstream forwarding: remove hop-by-hop headers,
 * pre-existing Authorization, and content-length (the forwarded body may be
 * rewritten — model-id aliasing / suffix strip — so a stale content-length
 * makes the upstream wait for bytes that never arrive; undici recomputes it
 * from the real body).
 */
export function buildUpstreamHeaders(
  incoming: Headers,
  bearerToken: string,
): Headers {
  const headers = new Headers();
  for (const [key, value] of incoming) {
    const lower = key.toLowerCase();
    if (
      lower === 'host' ||
      lower === 'connection' ||
      lower === 'keep-alive' ||
      lower === 'proxy-authenticate' ||
      lower === 'proxy-authorization' ||
      lower === 'te' ||
      lower === 'transfer-encoding' ||
      lower === 'upgrade' ||
      lower === 'authorization' ||
      lower === 'content-length'
    ) {
      continue;
    }
    headers.set(key, value);
  }
  headers.set('Authorization', `Bearer ${bearerToken}`);
  return headers;
}

/**
 * Clean headers for downstream (client) response: strip hop-by-hop headers,
 * security-sensitive headers, internal debug headers, and content-length
 * (the Response constructor recalculates content-length automatically).
 */
export function buildDownstreamHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of upstreamHeaders) {
    const lower = key.toLowerCase();
    if (
      // Hop-by-hop headers (RFC 7230 §6.1)
      lower === 'connection' ||
      lower === 'keep-alive' ||
      lower === 'proxy-authenticate' ||
      lower === 'proxy-authorization' ||
      lower === 'te' ||
      lower === 'trailer' ||
      lower === 'transfer-encoding' ||
      lower === 'upgrade' ||
      // Security-sensitive
      lower === 'set-cookie' ||
      // Body is already decoded: Node fetch transparently gunzips upstream
      // responses, so forwarding content-encoding would make clients try to
      // decompress plain text (found live against api.commandcode.ai).
      lower === 'content-encoding' ||
      // The forwarded body may be rewritten (model-id aliasing/suffix strip),
      // so a forwarded content-length can disagree with the actual body and
      // hang the upstream waiting for missing bytes (found live). Undici
      // recomputes content-length from the real body.
      lower === 'content-length' ||
      // Internal debug
      lower === 'x-request-id' ||
      // Response constructor recalculates content-length
      lower === 'content-length'
    ) {
      continue;
    }
    headers.set(key, value);
  }
  return headers;
}

/**
 * Check if a request body indicates streaming mode.
 */
export function isStreamingRequest(bodyText: string): boolean {
  try {
    const parsed = JSON.parse(bodyText);
    return parsed.stream === true;
  } catch {
    return false;
  }
}

/** Single JSON parse of a request body; null on invalid/missing input. */
function parseRequestBody(bodyText: string): Record<string, unknown> | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Upstream forwarding with failover
// ---------------------------------------------------------------------------

type RequestKind = 'standard' | 'streaming';

type SuccessHandler = (
  response: Response,
  state: ProxyState,
  requestId: string,
  keyLabel: string,
) => Promise<Response>;

interface RetryContext {
  state: ProxyState;
  requestId: string;
  config: ProxyConfig;
  method: string;
  path: string;
  incomingHeaders: Headers;
  bodyText: string;
  kind: RequestKind;
  /** Model id parsed from the request body (for affinity routing); optional. */
  modelId?: string;
  onSuccess: SuccessHandler;
}

type AttemptResult =
  | { kind: 'done'; response: Response }
  | { kind: 'retry'; lastError: Error | null };

/**
 * Shared retry loop for both streaming and non-streaming requests.
 * Handles key selection, failover, error classification, and retry logic.
 * Delegates the success-path response construction to `ctx.onSuccess`.
 */
async function executeWithRetry(opts: {
  state: ProxyState;
  requestId: string;
  config: ProxyConfig;
  method: string;
  path: string;
  incomingHeaders: Headers;
  bodyText: string;
  kind: RequestKind;
  modelId?: string;
  onSuccess: SuccessHandler;
  maxRetries: number;
}): Promise<Response> {
  const ctx: RetryContext = {
    state: opts.state,
    requestId: opts.requestId,
    config: opts.config,
    method: opts.method,
    path: opts.path,
    incomingHeaders: opts.incomingHeaders,
    bodyText: opts.bodyText,
    kind: opts.kind,
    modelId: opts.modelId,
    onSuccess: opts.onSuccess,
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
    const result = await executeSingleAttempt(attempt, ctx);
    if (result.kind === 'done') return result.response;
    lastError = result.lastError;
  }

  return handleAllRetriesFailed(ctx, opts.maxRetries, lastError);
}

async function executeSingleAttempt(attempt: number, ctx: RetryContext): Promise<AttemptResult> {
  const key = pickKey(ctx, attempt);
  if (!key) {
    return { kind: 'done', response: buildNoKeysResponse(ctx.state, ctx.requestId, ctx.kind, attempt) };
  }

  logKeyAttempt(ctx.requestId, key, attempt, ctx.kind);
  // Per-attempt upstream: keys may be mixed-provider within one failover chain.
  // Suffix-routed models (@provider) pin the provider and lose the suffix
  // in the forwarded body; the upstream never sees saros's routing shim.
  const provider = providerForKey(key, ctx.config, ctx.modelId);
  const upstreamUrl = resolveUpstreamUrl(ctx.config, provider, ctx.path);
  const outboundBody = ctx.bodyText
    ? rewriteModelForProvider(ctx.bodyText, ctx.modelId, provider)
    : ctx.bodyText;
  const fetchOptions = buildFetchOptions(ctx.method, outboundBody, ctx.kind, ctx.incomingHeaders, key.key, provider);

  try {
    const response = await fetchWithTimeout(upstreamUrl, fetchOptions, ctx.config.requestTimeoutMs);
    if (response.ok) {
      markKeySucceeded(ctx.state, key.label);
      completeRequest(ctx.state, ctx.requestId, true);
      return {
        kind: 'done',
        response: await ctx.onSuccess(response, ctx.state, ctx.requestId, key.label),
      };
    }
    return await handleUpstreamErrorResponse(response, ctx, key);
  } catch (err) {
    return handleNetworkError(err, ctx, key);
  }
}

function pickKey(ctx: RetryContext, attempt: number): KeySnapshot | null {
  return attempt === 0
        ? selectKeyForRequest(ctx.state, ctx.requestId, ctx.modelId)
    : failoverRequest(ctx.state, ctx.requestId);
}

function buildFetchOptions(
  method: string,
  bodyText: string,
  kind: RequestKind,
  incomingHeaders: Headers,
  bearerToken: string,
  provider?: KeyProvider,
): RequestInit & { duplex?: 'half' } {
  const headers = buildUpstreamHeaders(incomingHeaders, bearerToken);
  // Provider-specific identity headers (e.g. CommandCode CLI headers)
  if (provider?.extraUpstreamHeaders) {
    for (const [name, value] of Object.entries(provider.extraUpstreamHeaders())) {
      headers.set(name, value);
    }
  }
  const options: RequestInit & { duplex?: 'half' } = { method, headers };
  if (!bodyText) return options;
  // Node.js fetch requires `duplex: 'half'` when body is a stream or string
  // that may be streamed. TypeScript's DOM RequestInit lacks this field.
  if (kind === 'standard' && (method === 'GET' || method === 'HEAD')) return options;
  options.body = bodyText;
  options.duplex = 'half';
  return options;
}

async function handleUpstreamErrorResponse(
  response: Response,
  ctx: RetryContext,
  key: KeySnapshot,
): Promise<AttemptResult> {
  const errorBody = await response.text();
  const errorType = classifyHttpError(response.status, errorBody);
  logUpstreamError(ctx.requestId, key, response.status, errorType, errorBody, ctx.kind);
  captureFailedRequest(ctx, response.status, errorBody);

  if (errorType === 'RequestFault') {
    // Client error — don't retry, don't penalise the key
    completeRequest(ctx.state, ctx.requestId, false);
    return { kind: 'done', response: buildClientErrorResponse(response.status, errorBody, ctx.requestId) };
  }

  // KeyFault or ServerFault — penalise the key and retry
  markKeyFailed(ctx.state, key.label, errorType);
  const lastError = ctx.kind === 'standard'
    ? new Error(`Upstream error ${response.status}: ${errorBody.slice(0, 200)}`)
    : null;
  return { kind: 'retry', lastError };
}

function handleNetworkError(err: unknown, ctx: RetryContext, key: KeySnapshot): AttemptResult {
  const lastError = err instanceof Error ? err : new Error(String(err));
  // Timeouts / connection errors are shared-upstream failures, not per-key
  // faults: penalising them disabled every key during upstream hangs and
  // locked the proxy into "all keys unavailable" until cooldown expired.
  if (lastError instanceof TimeoutError) {
    logTimeout(ctx.requestId, key, ctx.config.requestTimeoutMs, ctx.kind);
  } else {
    logNetworkError(ctx.requestId, key, err, ctx.kind);
  }
  markKeyFailed(ctx.state, key.label, 'NetworkFault');
  return { kind: 'retry', lastError };
}

function buildNoKeysResponse(state: ProxyState, requestId: string, kind: RequestKind, attempt: number): Response {
  logger.warn(
    { requestId, attempt, kind },
    kind === 'standard'
      ? 'No API keys available on attempt %d'
      : 'No API keys available for streaming on attempt %d',
    attempt,
  );
  completeRequest(state, requestId, false);
  return new Response(
    JSON.stringify({ error: 'All API keys are temporarily unavailable', requestId }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  );
}

function buildClientErrorResponse(status: number, errorBody: string, requestId: string): Response {
  // Sanitize upstream error - don't leak internal details
  let safeError: string;
  try {
    const parsed = JSON.parse(errorBody);
    const message = parsed.error?.message || parsed.error || 'Bad Request';
    safeError = JSON.stringify({ error: message, requestId });
  } catch {
    safeError = JSON.stringify({ error: 'Bad Request', requestId });
  }
  return new Response(safeError, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function handleAllRetriesFailed(ctx: RetryContext, maxRetries: number, lastError: Error | null): Response {
  completeRequest(ctx.state, ctx.requestId, false);
  logger.error(
    { requestId: ctx.requestId, err: lastError, kind: ctx.kind },
    ctx.kind === 'standard'
      ? 'All %d retries exhausted, returning 502'
      : 'Streaming failed after %d attempts',
    maxRetries,
  );
  const message = ctx.kind === 'standard'
    ? 'Upstream service unavailable after multiple attempts'
    : 'Streaming service unavailable after multiple attempts';
  return new Response(
    JSON.stringify({ error: 'Bad Gateway', message, requestId: ctx.requestId }),
    { status: 502, headers: { 'content-type': 'application/json' } },
  );
}

// --- Logging helpers (preserve original log message format) ---

function logKeyAttempt(requestId: string, key: KeySnapshot, attempt: number, kind: RequestKind): void {
  logger.info(
    { requestId, keyLabel: key.label, attempt, kind },
    kind === 'standard'
      ? 'Forwarding request to upstream using key %s'
      : 'Streaming request with key %s',
    maskKey(key.key),
  );
}

function logUpstreamError(
  requestId: string,
  key: KeySnapshot,
  status: number,
  errorType: string,
  errorBody: string,
  kind: RequestKind,
): void {
  if (kind === 'standard') {
    logger.warn(
      { requestId, keyLabel: key.label, status, errorType, kind },
      'Upstream returned error: %s',
      errorBody.slice(0, 200),
    );
  } else {
    logger.warn(
      { requestId, keyLabel: key.label, status, kind },
      'Upstream streaming error',
    );
  }
}

function logTimeout(requestId: string, key: KeySnapshot, timeoutMs: number, kind: RequestKind): void {
  logger.warn(
    { requestId, keyLabel: key.label, kind },
    kind === 'standard'
      ? 'Request timed out after %dms, retrying with next key'
      : 'Streaming request timed out after %dms, retrying with next key',
    timeoutMs,
  );
}

function logNetworkError(requestId: string, key: KeySnapshot, err: unknown, kind: RequestKind): void {
  logger.error(
    { requestId, keyLabel: key.label, err, kind },
    kind === 'standard'
      ? 'Network error forwarding to upstream'
      : 'Network error during streaming',
  );
}

// ---------------------------------------------------------------------------
// Success handlers
// ---------------------------------------------------------------------------

const standardSuccessHandler: SuccessHandler = async (response, state, requestId, keyLabel) => {
  logger.info(
    { requestId, keyLabel, status: response.status },
    'Upstream request succeeded',
  );
  const responseBody = await response.text();
  const downstreamHeaders = buildDownstreamHeaders(response.headers);
  downstreamHeaders.set('X-Proxy-Key-Label', keyLabel);
  downstreamHeaders.set('X-Proxy-Request-Id', requestId);
  return new Response(responseBody, {
    status: response.status,
    headers: downstreamHeaders,
  });
};

const streamingSuccessHandler: SuccessHandler = async (response, state, requestId, keyLabel) => {
  if (!response.body) {
    logger.error({ requestId, keyLabel }, 'Streaming response missing body');
    return new Response(
      JSON.stringify({ error: 'Bad Gateway', message: 'Upstream response missing body', requestId }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }
  const wrappedStream = wrapStreamWithErrorDetection(response.body, state, requestId, keyLabel);
  const responseHeaders = buildDownstreamHeaders(response.headers);
  responseHeaders.set('content-type', 'text/event-stream');
  responseHeaders.set('cache-control', 'no-cache');
  responseHeaders.set('connection', 'keep-alive');
  responseHeaders.set('X-Proxy-Key-Label', keyLabel);
  responseHeaders.set('X-Proxy-Request-Id', requestId);
  return new Response(wrappedStream, { status: 200, headers: responseHeaders });
};

interface HandleRequestOptions {
  state: ProxyState;
  requestId: string;
  config: ProxyConfig;
  method: string;
  path: string;
  incomingHeaders: Headers;
  bodyText: string;
  /** Model id from the request body — drives provider-affinity routing. */
  modelId?: string;
  maxRetries?: number;
}

/**
 * Forward a (non-streaming) request to the upstream with automatic
 * key failover on KeyFault and ServerFault responses.
 */
async function handleWithFailover(opts: HandleRequestOptions): Promise<Response> {
  return executeWithRetry({
    state: opts.state,
    requestId: opts.requestId,
    config: opts.config,
    method: opts.method,
    path: opts.path,
    incomingHeaders: opts.incomingHeaders,
    bodyText: opts.bodyText,
    kind: 'standard',
    modelId: opts.modelId,
    onSuccess: standardSuccessHandler,
    maxRetries: opts.maxRetries ?? MAX_RETRIES,
  });
}

/**
 * Handle a streaming request with automatic key failover and mid-stream
 * error detection.  Streams SSE chunks directly to the client and wraps
 * the stream to detect error markers mid-response.
 */
async function handleStreamingRequest(opts: HandleRequestOptions): Promise<Response> {
  return executeWithRetry({
    state: opts.state,
    requestId: opts.requestId,
    config: opts.config,
    method: opts.method,
    path: opts.path,
    incomingHeaders: opts.incomingHeaders,
    bodyText: opts.bodyText,
    kind: 'streaming',
    modelId: opts.modelId,
    onSuccess: streamingSuccessHandler,
    maxRetries: opts.maxRetries ?? MAX_RETRIES,
  });
}

/**
 * Wrap an upstream SSE stream with error detection.
 * Parses SSE events properly to avoid false positives on
 * `"error"` appearing in non-error JSON payloads.
 * If an error marker is detected mid-stream, the failed key is penalised,
 * a proxy_error SSE event is sent to the client, and the stream is closed.
 */
function wrapStreamWithErrorDetection(
  upstreamStream: ReadableStream<Uint8Array>,
  state: ProxyState,
  requestId: string,
  keyLabel: string,
): ReadableStream<Uint8Array> {
  const reader = upstreamStream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();
          return;
        }

        // Decode chunk and parse SSE events
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        // SSE events are delimited by \n\n
        const events = buffer.split('\n\n');
        // Keep the last incomplete event (partial data) in the buffer
        buffer = events.pop() || '';

        for (const event of events) {
          const dataLine = event.split('\n').find(line => line.startsWith('data:'));
          if (!dataLine) continue;
          try {
            const parsed = JSON.parse(dataLine.slice(5).trim());
            if (parsed && (parsed.error || parsed.type === 'error')) {
              logger.warn({ requestId, keyLabel }, 'Error detected in stream');
              markKeyFailed(state, keyLabel, 'ServerFault');
              controller.enqueue(
                encoder.encode(
                  'data: {"type":"proxy_error","message":"Upstream stream error"}\n\n',
                ),
              );
              controller.close();
              return;
            }
          } catch {
            // Invalid JSON in SSE event — not an error we can classify, ignore
          }
        }

        // Pass through the chunk as-is
        controller.enqueue(value);
      } catch (err) {
        logger.error({ requestId, keyLabel, err }, 'Stream read error');
        markKeyFailed(state, keyLabel, 'ServerFault');
        controller.enqueue(
          encoder.encode(
            'data: {"type":"proxy_error","message":"Stream interrupted"}\n\n',
          ),
        );
        controller.close();
      }
    },

    cancel() {
      reader.cancel();
    },
  });
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createProxyApp(config: ProxyConfig): Hono {
  const state: ProxyState = createProxyState(config.keys, {
    circuitBreakerThreshold: config.circuitBreakerThreshold,
    circuitBreakerCooldownMs: config.circuitBreakerCooldownMs,
  });
  // Model→provider affinity: requests naming a provider-specific model
  // (e.g. commandcode's vendor-prefixed ids) are routed to a matching key
  // first; 'maybe' providers remain as fallback. Bare-name matching lets
  // shared models (deepseek-v4-flash etc.) rotate across ALL serving keys
  // cross-provider. No-op for single-provider pools and when no provider
  // claims the model.
  state.affinityResolver = (providerId, modelId) => {
    const provider = getProvider(providerId as ProviderId);
    if (!provider) return 'maybe';
    const direct = provider.modelAffinity(modelId);
    if (direct !== 'maybe') return direct;
    // Bare-name cross-check: 'deepseek-v4-flash' may be commandcode's
    // 'deepseek/deepseek-v4-flash'.
    const bare = (modelId.split('/').pop() ?? modelId).toLowerCase();
    return provider.modelAffinityByName?.(bare) ?? 'maybe';
  };

  const app = new Hono();

  // --- Rate limiting (prevent DoS and key exhaustion) ---
  app.use('*', rateLimiter({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: RATE_LIMIT_MAX,
    standardHeaders: true, // Return rate limit info in headers
    keyGenerator: (c) => {
      const forwarded = c.req.header('x-forwarded-for');
      if (forwarded) return forwarded.split(',')[0].trim();
      const realIp = c.req.header('x-real-ip');
      if (realIp) return realIp;
      // Fall back to socket remote address for direct connections
      // c.get('remote') is set by @hono/node-server via ContextVariableMap augmentation
      return c.get('remote')?.address ?? 'unknown';
    },
    message: { error: 'Too many requests, please try again later' },
  }));

  // --- CORS (configurable origins) ---
  app.use(
    '*',
    cors({
      origin: (origin: string) => {
        if (!origin) return null; // Non-browser requests (no Origin header) — skip CORS
        const allowed = config.allowedOrigins.some((pattern) => {
          // Escape regex special chars, then replace \* with .*
          const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
          const regex = new RegExp('^' + escaped.replaceAll(String.raw`\*`, '.*') + '$');
          return regex.test(origin);
        });
        if (allowed) return origin;
        logger.warn('CORS violation: origin "%s" not allowed', origin);
        return null;
      },
    }),
  );

  // --- Health check ---
  app.get('/health', (c: Context) => {
    const keys = state.keys;
    const enabledCount = keys.filter((k) => k.enabled).length;
    const disabledCount = keys.length - enabledCount;
    const activeCount = state.activeRequests.size;

    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      keyCount: keys.length,
      enabledCount,
      disabledCount,
      activeRequests: activeCount,
      circuitBreakerThreshold: state.circuitBreakerThreshold,
      circuitBreakerCooldownMs: state.circuitBreakerCooldownMs,
      // Per-provider key counts (multi-provider pools)
      providers: keys.reduce<Record<string, { total: number; enabled: number }>>((acc, k) => {
        const entry = (acc[k.provider] ??= { total: 0, enabled: 0 });
        entry.total++;
        if (k.enabled) entry.enabled++;
        return acc;
      }, {}),
    });
  });

  // --- Models discovery endpoint (OpenAI-compatible) ---
  // Returns the full model list so the OpenCode client can discover all
  // available models. Without this, OpenCode falls back to a hardcoded
  // list of ~3 models (one per series).
  // NOTE: Rate limiting applies to these routes via the '*' middleware above.
  app.get('/v1/models', (_c: Context) => getModelsList(config));
  app.get('/zen/go/v1/models', (_c: Context) => getModelsList(config));

  // --- Upstream proxy handler (reused by both routes) ---
  async function handleProxyRequest(c: Context, path: string): Promise<Response> {
    const requestId = generateRequestId();
    const method = c.req.method;
    const incomingHeaders = c.req.raw.headers;

    // Reject oversized requests early via Content-Length header
    const contentLength = c.req.header('content-length');
    if (contentLength && Number.parseInt(contentLength) > MAX_BODY_SIZE) {
      return c.json({ error: 'Request body too large', requestId }, 413);
    }

    // Read the body text once (needed for streaming detection and forwarding)
    const bodyText = method === 'GET' || method === 'HEAD' ? '' : await c.req.text();

    // Reject requests whose actual body exceeds the limit
    if (bodyText.length > MAX_BODY_SIZE) {
      return c.json({ error: 'Request body too large', requestId }, 413);
    }

    maybeRefreshUsage(state, config);

    // Parse once: used for both streaming detection and model tracking
    const parsedBody = parseRequestBody(bodyText);

    // Track most-used models for `saros-proxy usage` (best-effort)
    if (parsedBody) {
      const model = parsedBody.model;
      if (typeof model === 'string' && model.length > 0) recordModelRequest(model);
    }

    // Check for streaming mode
    if (parsedBody?.stream === true) {
      logger.info({ requestId, method, path }, 'Streaming request detected');
      return handleStreamingRequest({
        state,
        requestId,
        config,
        method,
        path,
        incomingHeaders,
        bodyText,
        modelId: typeof parsedBody.model === 'string' ? parsedBody.model : undefined,
      });
    }

    // Non-streaming request with failover
    return handleWithFailover({
      state,
      requestId,
      config,
      method,
      path,
      incomingHeaders,
      bodyText,
      modelId: typeof parsedBody?.model === 'string' ? parsedBody.model : undefined,
    });
  }

  // Unified catch-all: rewrites /v1/* → /zen/go/v1/* for upstream forwarding
  app.all('/zen/go/v1/*', (c: Context) => handleProxyRequest(c, c.req.path));
  // OpenAI-compatible proxy path — lets standard API clients (e.g. Odysseus,
  // Cursor, LibreChat) use the proxy without the /zen/go/ prefix.
  // The path is rewritten to the upstream's native prefix so the upstream
  // receives /zen/go/v1/... and returns a valid response.
  app.all('/v1/*', (c: Context) => handleProxyRequest(c, c.req.path.replace('/v1/', '/zen/go/v1/')));

  return app;
}
