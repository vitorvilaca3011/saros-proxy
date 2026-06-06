/**
 * proxy.ts — Hono HTTP proxy app for OpenCode-Go Multi-Account Proxy.
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

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB — prevent DoS via oversized request bodies

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
      lower === 'transfer-encoding' ||
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
  return { usageMap, usageThreshold: config.scraping!.usageThreshold };
}

// ---------------------------------------------------------------------------
// Upstream forwarding with failover
// ---------------------------------------------------------------------------

/**
 * Forward a (non-streaming) request to the upstream with automatic
 * key failover on KeyFault and ServerFault responses.
 */
async function handleWithFailover(
  state: ProxyState,
  requestId: string,
  config: ProxyConfig,
  method: string,
  path: string,
  incomingHeaders: Headers,
  bodyText: string,
  maxRetries: number = 2,
): Promise<Response> {
  const upstreamUrl = buildUpstreamUrl(config.upstreamBaseUrl, path);
  let lastError: Error | null = null;

  // Build usage-gated key selection options from scraped data
  const keyOptions: KeySelectionOptions | undefined = config.scraping?.enabled
    ? buildUsageKeyOptions(config)
    : undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const key: KeySnapshot | null =
      attempt === 0
        ? selectKeyForRequest(state, requestId, keyOptions)
        : failoverRequest(state, requestId, keyOptions);

    if (!key) {
      logger.warn({ requestId }, 'No API keys available on attempt %d', attempt);
      completeRequest(state, requestId, false);
      return new Response(
        JSON.stringify({ error: 'All API keys are temporarily unavailable' }),
        {
          status: 503,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    logger.info(
      { requestId, keyLabel: key.label, attempt },
      'Forwarding request to upstream using key %s',
      maskKey(key.key),
    );

    const headers = buildUpstreamHeaders(incomingHeaders, key.key);

    try {
      const fetchOptions: RequestInit = {
        method,
        headers,
      };
      if (method !== 'GET' && method !== 'HEAD' && bodyText) {
        fetchOptions.body = bodyText;
        (fetchOptions as { duplex: string }).duplex = 'half';
      }

      const response = await fetchWithTimeout(
        upstreamUrl,
        fetchOptions,
        config.requestTimeoutMs,
      );

      if (response.ok) {
        logger.info(
          { requestId, keyLabel: key.label, status: response.status },
          'Upstream request succeeded',
        );
        markKeySucceeded(state, key.label);
        completeRequest(state, requestId, true);

        // Reconstruct response to hop through our server
        const responseBody = await response.text();
        return new Response(responseBody, {
          status: response.status,
          headers: response.headers,
        });
      }

      // Error path: classify and decide
      const errorBody = await response.text();
      const errorType = classifyHttpError(response.status, errorBody);

      logger.warn(
        { requestId, keyLabel: key.label, status: response.status, errorType },
        'Upstream returned error: %s',
        errorBody.slice(0, 200),
      );

      if (errorType === 'RequestFault') {
        // Client error — don't retry, don't penalise the key
        completeRequest(state, requestId, false);
        // Sanitize upstream error - don't leak internal details
        let safeError;
        try {
          const parsed = JSON.parse(errorBody);
          safeError = JSON.stringify({
            error: parsed.error?.message || parsed.error || 'Bad Request',
            requestId,
          });
        } catch {
          safeError = JSON.stringify({ error: 'Bad Request', requestId });
        }
        return new Response(safeError, {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        });
      }

      // KeyFault or ServerFault — penalise the key and retry
      markKeyFailed(state, key.label, errorType);
      lastError = new Error(
        `Upstream error ${response.status}: ${errorBody.slice(0, 200)}`,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError instanceof TimeoutError) {
        logger.warn(
          { requestId, keyLabel: key.label },
          'Request timed out after %dms',
          config.requestTimeoutMs,
        );
        markKeyFailed(state, key.label, 'ServerFault');
        completeRequest(state, requestId, false);
        return new Response(
          JSON.stringify({
            error: 'Gateway Timeout',
            message: `Upstream request timed out after ${config.requestTimeoutMs}ms`,
          }),
          {
            status: 504,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      logger.error(
        { requestId, keyLabel: key.label, err },
        'Network error forwarding to upstream',
      );
      markKeyFailed(state, key.label, 'ServerFault');
    }
  }

  // All retries exhausted
  completeRequest(state, requestId, false);
  logger.error(
    { requestId, err: lastError },
    'All %d retries exhausted, returning 502',
    maxRetries,
  );
  return new Response(
    JSON.stringify({
      error: 'Bad Gateway',
      message: 'Upstream service unavailable after multiple attempts',
      requestId,
    }),
    {
      status: 502,
      headers: { 'content-type': 'application/json' },
    },
  );
}

/**
 * Handle a streaming request with automatic key failover and mid-stream
 * error detection.  Streams SSE chunks directly to the client and wraps
 * the stream to detect error markers mid-response.
 */
async function handleStreamingRequest(
  state: ProxyState,
  requestId: string,
  config: ProxyConfig,
  method: string,
  path: string,
  incomingHeaders: Headers,
  bodyText: string,
  maxRetries: number = 2,
): Promise<Response> {
  const upstreamUrl = buildUpstreamUrl(config.upstreamBaseUrl, path);
  let lastError: Error | null = null;

  // Build usage-gated key selection options from scraped data
  const keyOptions: KeySelectionOptions | undefined = config.scraping?.enabled
    ? buildUsageKeyOptions(config)
    : undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const key: KeySnapshot | null =
      attempt === 0
        ? selectKeyForRequest(state, requestId, keyOptions)
        : failoverRequest(state, requestId, keyOptions);

    if (!key) {
      logger.warn(
        { requestId, attempt },
        'No API keys available for streaming on attempt %d',
        attempt,
      );
      completeRequest(state, requestId, false);
      return new Response(
        JSON.stringify({ error: 'All API keys are temporarily unavailable' }),
        {
          status: 503,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    logger.info(
      { requestId, keyLabel: key.label, attempt },
      'Streaming request with key %s',
      maskKey(key.key),
    );

    const headers = buildUpstreamHeaders(incomingHeaders, key.key);

    try {
      const fetchOptions: RequestInit = {
        method,
        headers,
      };
      if (bodyText) {
        fetchOptions.body = bodyText;
        (fetchOptions as { duplex: string }).duplex = 'half';
      }

      const response = await fetchWithTimeout(
        upstreamUrl,
        fetchOptions,
        config.requestTimeoutMs,
      );

      if (!response.ok) {
        const errorBody = await response.text();
        const errorType = classifyHttpError(response.status, errorBody);

        logger.warn(
          { requestId, keyLabel: key.label, status: response.status },
          'Upstream streaming error',
        );

        if (errorType === 'RequestFault') {
          completeRequest(state, requestId, false);
          // Sanitize upstream error - don't leak internal details
          let safeError;
          try {
            const parsed = JSON.parse(errorBody);
            safeError = JSON.stringify({
              error: parsed.error?.message || parsed.error || 'Bad Request',
              requestId,
            });
          } catch {
            safeError = JSON.stringify({ error: 'Bad Request', requestId });
          }
          return new Response(safeError, {
            status: response.status,
            headers: { 'content-type': 'application/json' },
          });
        }

        markKeyFailed(state, key.label, errorType);
        continue; // retry with next key
      }

      // Success — pipe the stream
      markKeySucceeded(state, key.label);

      // Wrap the stream to detect mid-stream errors
      const wrappedStream = wrapStreamWithErrorDetection(
        response.body!,
        state,
        requestId,
        key.label,
      );

      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('content-type', 'text/event-stream');
      responseHeaders.set('cache-control', 'no-cache');
      responseHeaders.set('connection', 'keep-alive');

      completeRequest(state, requestId, true);

      return new Response(wrappedStream, {
        status: 200,
        headers: responseHeaders,
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError instanceof TimeoutError) {
        logger.warn(
          { requestId, keyLabel: key.label },
          'Streaming request timed out after %dms',
          config.requestTimeoutMs,
        );
        markKeyFailed(state, key.label, 'ServerFault');
        completeRequest(state, requestId, false);
        return new Response(
          JSON.stringify({
            error: 'Gateway Timeout',
            message: `Upstream streaming timed out after ${config.requestTimeoutMs}ms`,
          }),
          {
            status: 504,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      logger.error(
        { requestId, keyLabel: key.label, err },
        'Network error during streaming',
      );
      markKeyFailed(state, key.label, 'ServerFault');
      // continue to next retry
    }
  }

  completeRequest(state, requestId, false);
  logger.error(
    { requestId, err: lastError },
    'Streaming failed after %d attempts',
    maxRetries,
  );
  return new Response(
    JSON.stringify({
      error: 'Bad Gateway',
      message: 'Streaming service unavailable after multiple attempts',
      requestId,
    }),
    {
      status: 502,
      headers: { 'content-type': 'application/json' },
    },
  );
}

/**
 * Wrap an upstream SSE stream with error detection.
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

        // Decode chunk and check for SSE error markers
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        // Check for error in SSE data (e.g. {"error":...} or {"type":"error",...})
        if (buffer.includes('"error"') || buffer.includes('"type":"error"')) {
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

        // Pass through the chunk as-is
        controller.enqueue(value);

        // Clear buffer periodically to avoid memory bloat
        if (buffer.length > 10000) {
          buffer = buffer.slice(-1000);
        }
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
    windowMs: 60 * 1000, // 1 minute
    limit: 100, // 100 requests per minute per IP
    standardHeaders: true, // Return rate limit info in headers
    keyGenerator: (c) => {
      const forwarded = c.req.header('x-forwarded-for');
      if (forwarded) return forwarded.split(',')[0].trim();
      const realIp = c.req.header('x-real-ip');
      if (realIp) return realIp;
      // Fall back to socket remote address for direct connections
      // @ts-expect-error -- env.remote is set by @hono/node-server
      return c.env?.remote?.address ?? 'unknown';
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
          const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp('^' + escaped.replace(/\\\*/g, '.*') + '$');
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
    if (contentLength && parseInt(contentLength) > MAX_BODY_SIZE) {
      return c.json({ error: 'Request body too large' }, 413);
    }

    // Read the body text once (needed for streaming detection and forwarding)
    const bodyText = method === 'GET' || method === 'HEAD' ? '' : await c.req.text();

    // Reject requests whose actual body exceeds the limit
    if (bodyText.length > MAX_BODY_SIZE) {
      return c.json({ error: 'Request body too large' }, 413);
    }

    // Check for streaming mode
    if (bodyText && isStreamingRequest(bodyText)) {
      logger.info({ requestId, method, path }, 'Streaming request detected');
      return handleStreamingRequest(
        state,
        requestId,
        config,
        method,
        path,
        incomingHeaders,
        bodyText,
      );
    }

    // Non-streaming request with failover
    return handleWithFailover(
      state,
      requestId,
      config,
      method,
      path,
      incomingHeaders,
      bodyText,
    );
  });

  return app;
}
