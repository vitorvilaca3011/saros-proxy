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
import type { KeyProvider } from './providers/index.js';
import {
  COMMANDCODE_CHAT_BASE_PATH,
  OPENCODE_CHAT_BASE_PATH,
} from './constants.js';

/**
 * Resolve the upstream URL for one attempt: per-provider base URL + path
 * remapping. Canonical saros routes are /zen/go/v1/<rest>; commandcode keys
 * remap to /provider/v1/<rest> (its OpenAI-compatible surface).
 */
export function resolveUpstreamUrl(config: ProxyConfig, provider: KeyProvider, path: string): string {
  const base = (config.upstreams?.[provider.id] ?? (provider.id === 'opencode-go' ? config.upstreamBaseUrl : provider.baseUrl))
    .replace(/\/+$/, '');
  if (provider.id === 'opencode-go') {
    return buildUpstreamUrl(base, path);
  }
  const remapped = path.startsWith(OPENCODE_CHAT_BASE_PATH)
    ? COMMANDCODE_CHAT_BASE_PATH + path.slice(OPENCODE_CHAT_BASE_PATH.length)
    : path;
  return buildUpstreamUrl(base, remapped);
}

/** Provider for a key snapshot (structural inference; config already validated). */
function providerForKey(key: KeySnapshot, config: ProxyConfig): KeyProvider {
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

function generateRequestId(): string {
  return crypto.randomUUID();
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
 * Clean headers for upstream forwarding: remove hop-by-hop headers
 * and any pre-existing Authorization.
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
      lower === 'authorization'
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
  // Per-attempt upstream: keys may be mixed-provider within one failover chain
  const provider = providerForKey(key, ctx.config);
  const upstreamUrl = resolveUpstreamUrl(ctx.config, provider, ctx.path);
  const fetchOptions = buildFetchOptions(ctx.method, ctx.bodyText, ctx.kind, ctx.incomingHeaders, key.key, provider);

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
        ? selectKeyForRequest(ctx.state, ctx.requestId)
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
