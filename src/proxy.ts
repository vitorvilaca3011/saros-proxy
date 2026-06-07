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
  type KeySelectionOptions,
  type UsageInfo,
} from './proxy-logic.js';
import type { ProxyConfig } from './config.js';
import { logger, maskKey } from './logger.js';
import { getAllUsage, isScraperRunning } from './scraper.js';
import {
  MAX_BODY_SIZE,
  MAX_RETRIES,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
} from './constants.js';

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

/**
 * Build usage-based key selection options from scraped data.
 * Returns undefined when no usage data is available or scraping is disabled.
 */
function buildUsageKeyOptions(config: ProxyConfig): KeySelectionOptions | undefined {
  const allUsage = getAllUsage();
  if (allUsage.size === 0) return undefined;

  const usageMap = new Map<string, UsageInfo>();
  config.keys.forEach((key, i) => {
    const account = config.scraping?.accounts?.[i];
    if (account) {
      const accountUsage = allUsage.get(account.workspaceId);
      if (accountUsage) {
        usageMap.set(key.label, accountUsage.usage);
      }
    }
  });

  if (usageMap.size === 0) return undefined;
  // Caller ensures config.scraping is defined when scraping is enabled
  return { usageMap, usageThreshold: config.scraping?.usageThreshold ?? 50 };
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
  upstreamUrl: string;
  keyOptions: KeySelectionOptions | undefined;
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
    upstreamUrl: buildUpstreamUrl(opts.config.upstreamBaseUrl, opts.path),
    keyOptions: opts.config.scraping?.enabled ? buildUsageKeyOptions(opts.config) : undefined,
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
  const fetchOptions = buildFetchOptions(ctx.method, ctx.bodyText, ctx.kind, ctx.incomingHeaders, key.key);

  try {
    const response = await fetchWithTimeout(ctx.upstreamUrl, fetchOptions, ctx.config.requestTimeoutMs);
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
    ? selectKeyForRequest(ctx.state, ctx.requestId, ctx.keyOptions)
    : failoverRequest(ctx.state, ctx.requestId, ctx.keyOptions);
}

function buildFetchOptions(
  method: string,
  bodyText: string,
  kind: RequestKind,
  incomingHeaders: Headers,
  bearerToken: string,
): RequestInit & { duplex?: 'half' } {
  const headers = buildUpstreamHeaders(incomingHeaders, bearerToken);
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
  if (lastError instanceof TimeoutError) {
    logTimeout(ctx.requestId, key, ctx.config.requestTimeoutMs, ctx.kind);
    markKeyFailed(ctx.state, key.label, 'ServerFault');
    return { kind: 'retry', lastError };
  }
  logNetworkError(ctx.requestId, key, err, ctx.kind);
  markKeyFailed(ctx.state, key.label, 'ServerFault');
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

    // Build scraping status
    const scrapingStatus = config.scraping?.enabled
      ? {
          enabled: true,
          running: isScraperRunning(),
          intervalMs: config.scraping.intervalMs,
          usageThreshold: config.scraping.usageThreshold,
          accounts: Array.from(getAllUsage().entries()).map(
            ([workspaceId, data]) => ({
              workspaceId,
              usage: data.usage,
              lastScrapedAt: data.lastScrapedAt.toISOString(),
              lastError: data.lastError ?? null,
            }),
          ),
        }
      : { enabled: false };

    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      keyCount: keys.length,
      enabledCount,
      disabledCount,
      activeRequests: activeCount,
      circuitBreakerThreshold: state.circuitBreakerThreshold,
      circuitBreakerCooldownMs: state.circuitBreakerCooldownMs,
      scraping: scrapingStatus,
    });
  });

  // --- Upstream proxy routes ---
  app.all('/zen/go/v1/*', async (c: Context) => {
    const requestId = generateRequestId();
    const method = c.req.method;
    const path = c.req.path;
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

    // Check for streaming mode
    if (bodyText && isStreamingRequest(bodyText)) {
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
  });

  return app;
}
