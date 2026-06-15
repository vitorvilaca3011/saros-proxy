/**
 * model-probe.ts — Probe runner for model capabilities.
 *
 * Sends real API requests through the proxy's own endpoint (http://127.0.0.1:{port})
 * to test liveness, reasoning, and tool-calling capabilities of each model.
 *
 * Uses the user's own proxy so results reflect the actual configured setup,
 * including circuit breaker and key failover behavior.
 */

import { type ProxyConfig } from './config.js';
import {
  PROBE_REQUEST_TIMEOUT_MS,
  PROBE_LIVENESS_PROMPT,
  PROBE_REASONING_PROMPT,
  PROBE_TOOL_CALLING_PROMPT,
} from './constants.js';
import { type ProbeResult, type ModelProbe } from './probe-cache.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ChatCompletionMessage {
  content?: string | null;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: Array<Record<string, unknown>>;
}

interface ChatCompletionChoice {
  message?: ChatCompletionMessage;
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

interface FetchResult {
  ok: boolean;
  status: number;
  data?: ChatCompletionResponse;
  errorText?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the proxy base URL from config. */
function buildBaseURL(config: ProxyConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

/**
 * Perform a chat completion request through the proxy.
 *
 * Handles HTTP errors, 429 rate limiting, and network/timeout errors uniformly.
 * Returns a normalized FetchResult for the probe functions to interpret.
 */
async function fetchCompletion(
  baseURL: string,
  body: Record<string, unknown>,
): Promise<FetchResult> {
  try {
    const response = await fetch(`${baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_REQUEST_TIMEOUT_MS),
    });

    // 429 is handled specially
    if (response.status === 429) {
      return { ok: false, status: 429 };
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return { ok: false, status: response.status, errorText };
    }

    const data = (await response.json()) as ChatCompletionResponse;
    return { ok: true, status: response.status, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, errorText: message };
  }
}

// ---------------------------------------------------------------------------
// Individual probe functions
// ---------------------------------------------------------------------------

/**
 * Probe a model for basic liveness.
 *
 * Sends a simple prompt and expects a text response.
 * Returns 'ok' if the response contains non-empty content.
 */
export async function probeLiveness(
  config: ProxyConfig,
  modelId: string,
): Promise<ProbeResult> {
  const baseURL = buildBaseURL(config);
  const result = await fetchCompletion(baseURL, {
    model: modelId,
    messages: [{ role: 'user', content: PROBE_LIVENESS_PROMPT }],
    max_tokens: 10,
    stream: false,
  });

  if (result.status === 429) {
    return { status: 'rate_limited', ts: Date.now() };
  }

  if (!result.ok) {
    return {
      status: 'error',
      ts: Date.now(),
      details:
        result.status > 0
          ? result.errorText
            ? `${result.status}: ${result.errorText}`
            : `HTTP ${result.status}`
          : result.errorText ?? 'Unknown error',
    };
  }

  // Verify the response contains actual content
  const content = result.data?.choices?.[0]?.message?.content;
  if (!content || content.trim().length === 0) {
    return { status: 'error', ts: Date.now(), details: 'No content in response' };
  }

  return { status: 'ok', ts: Date.now() };
}

/**
 * Probe a model for reasoning (thinking) capability.
 *
 * Sends a prompt with `reasoning_effort: "low"` via `extra_body`.
 * Models that do not support reasoning return 400/422 with an error
 * referencing "reasoning_effort" — those are marked 'unsupported'.
 * Models that accept the parameter but return reasoning_content are 'ok'.
 */
export async function probeReasoning(
  config: ProxyConfig,
  modelId: string,
): Promise<ProbeResult> {
  const baseURL = buildBaseURL(config);
  const result = await fetchCompletion(baseURL, {
    model: modelId,
    messages: [{ role: 'user', content: PROBE_REASONING_PROMPT }],
    max_tokens: 200,
    stream: false,
    extra_body: { reasoning_effort: 'low' },
  });

  if (result.status === 429) {
    return { status: 'rate_limited', ts: Date.now() };
  }

  if (!result.ok) {
    // 400/422 with "reasoning_effort" in the error message → unsupported
    const errorMsg = (result.errorText ?? '').toLowerCase();
    if (
      (result.status === 400 || result.status === 422) &&
      errorMsg.includes('reasoning_effort')
    ) {
      return {
        status: 'unsupported',
        ts: Date.now(),
        details: (result.status === 400 ? '400: ' : '422: ') + (result.errorText ?? ''),
      };
    }

    return {
      status: 'error',
      ts: Date.now(),
      details:
        result.status > 0
          ? result.errorText
            ? `${result.status}: ${result.errorText}`
            : `HTTP ${result.status}`
          : result.errorText ?? 'Unknown error',
    };
  }

  // Call succeeded — some models accept reasoning_effort silently
  // even if they don't return reasoning_content. That's still 'ok'.
  return { status: 'ok', ts: Date.now() };
}

/**
 * Probe a model for tool-calling (function calling) capability.
 *
 * Sends a request with a tool definition and expects `tool_calls` in the response.
 * Models that do not support tools return 400/422 with "tools" in the error.
 */
export async function probeToolCalling(
  config: ProxyConfig,
  modelId: string,
): Promise<ProbeResult> {
  const baseURL = buildBaseURL(config);
  const result = await fetchCompletion(baseURL, {
    model: modelId,
    messages: [{ role: 'user', content: PROBE_TOOL_CALLING_PROMPT }],
    max_tokens: 100,
    stream: false,
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ],
    tool_choice: 'auto',
  });

  if (result.status === 429) {
    return { status: 'rate_limited', ts: Date.now() };
  }

  if (!result.ok) {
    // 400/422 with "tools" in the error message → unsupported
    const errorMsg = (result.errorText ?? '').toLowerCase();
    if (
      (result.status === 400 || result.status === 422) &&
      errorMsg.includes('tools')
    ) {
      return {
        status: 'unsupported',
        ts: Date.now(),
        details: (result.status === 400 ? '400: ' : '422: ') + (result.errorText ?? ''),
      };
    }

    return {
      status: 'error',
      ts: Date.now(),
      details:
        result.status > 0
          ? result.errorText
            ? `${result.status}: ${result.errorText}`
            : `HTTP ${result.status}`
          : result.errorText ?? 'Unknown error',
    };
  }

  // Verify the response contains tool_calls
  const toolCalls = result.data?.choices?.[0]?.message?.tool_calls;
  if (!toolCalls || toolCalls.length === 0) {
    return { status: 'error', ts: Date.now(), details: 'No tool_calls in response' };
  }

  return { status: 'ok', ts: Date.now() };
}

// ---------------------------------------------------------------------------
// Composite probes
// ---------------------------------------------------------------------------

/**
 * Run all three probes (liveness, reasoning, tool calling) for a single model.
 *
 * All probes run concurrently via Promise.all so one failure does not block others.
 */
export async function probeModel(
  config: ProxyConfig,
  modelId: string,
): Promise<ModelProbe> {
  const [liveness, reasoning, toolCalling] = await Promise.all([
    probeLiveness(config, modelId),
    probeReasoning(config, modelId),
    probeToolCalling(config, modelId),
  ]);

  return { modelId, liveness, reasoning, toolCalling };
}

/**
 * Run probeModel for every model ID in the array.
 *
 * Models are probed sequentially (one at a time) to avoid overwhelming the proxy.
 * Returns results in the same order as the input array.
 * Individual failures are captured per-model and do not halt the batch.
 */
export async function probeAllModels(
  config: ProxyConfig,
  modelIds: string[],
): Promise<ModelProbe[]> {
  const results: ModelProbe[] = [];

  for (const modelId of modelIds) {
    try {
      const probe = await probeModel(config, modelId);
      results.push(probe);
    } catch (err) {
      // Catastrophic failure (shouldn't happen since probeModel catches internally)
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        modelId,
        liveness: { status: 'error', ts: Date.now(), details: message },
        reasoning: { status: 'error', ts: Date.now(), details: message },
        toolCalling: { status: 'error', ts: Date.now(), details: message },
      });
    }
  }

  return results;
}
