/**
 * model-probe.test.ts — Unit tests for the model probe module.
 *
 * Mocks globalThis.fetch to simulate API responses.
 * Vitest-based; run with: npx vitest run src/model-probe.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProxyConfig } from './config.js';
import {
  probeLiveness,
  probeReasoning,
  probeToolCalling,
  probeModel,
  probeAllModels,
} from './model-probe.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  maskKey: (key: string) => key.slice(0, 4) + '...' + key.slice(-4),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockConfig: ProxyConfig = {
  port: 3099,
  host: '127.0.0.1',
  keys: [{ label: 'test', key: 'sk-test-key-that-is-at-least-20-chars' }],
  circuitBreakerThreshold: 3,
  circuitBreakerCooldownMs: 60_000,
  upstreamBaseUrl: 'https://opencode.ai',
  requestTimeoutMs: 30_000,
  allowedOrigins: ['http://localhost:*'],
};

/** Build a mock fetch Response-like object. */
function mockResponse(overrides: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
} = {}) {
  const { ok = true, status = 200, json = {}, text = '' } = overrides;
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(json),
    text: vi.fn().mockResolvedValue(text),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// probeLiveness
// ---------------------------------------------------------------------------

describe('probeLiveness', () => {
  it("returns 'ok' when response has content", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        json: { choices: [{ message: { content: 'pong' } }] },
      }),
    );
    const result = await probeLiveness(mockConfig, 'test-model');
    expect(result.status).toBe('ok');
  });

  it("returns 'error' when response is non-2xx", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ ok: false, status: 500, text: 'Internal Server Error' }),
    );
    const result = await probeLiveness(mockConfig, 'test-model');
    expect(result.status).toBe('error');
    expect(result.details).toMatch(/500/);
  });

  it("returns 'error' on fetch throw", async () => {
    mockFetch.mockRejectedValue(new Error('Network failure'));
    const result = await probeLiveness(mockConfig, 'test-model');
    expect(result.status).toBe('error');
    expect(result.details).toBe('Network failure');
  });

  it("returns 'error' on timeout", async () => {
    mockFetch.mockRejectedValue(new Error('The operation was aborted'));
    const result = await probeLiveness(mockConfig, 'test-model');
    expect(result.status).toBe('error');
    expect(result.details).toBe('The operation was aborted');
  });

  it("returns 'error' when response has no content field", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        json: { choices: [{ message: {} }] },
      }),
    );
    const result = await probeLiveness(mockConfig, 'test-model');
    expect(result.status).toBe('error');
  });

  it("returns 'rate_limited' on 429", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ ok: false, status: 429 }),
    );
    const result = await probeLiveness(mockConfig, 'test-model');
    expect(result.status).toBe('rate_limited');
  });

  it("returns 'error' when content is whitespace-only", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        json: { choices: [{ message: { content: '   ' } }] },
      }),
    );
    const result = await probeLiveness(mockConfig, 'test-model');
    expect(result.status).toBe('error');
    expect(result.details).toBe('No content in response');
  });

  it("returns 'error' on 4xx (e.g. 400)", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ ok: false, status: 400, text: 'Bad Request' }),
    );
    const result = await probeLiveness(mockConfig, 'test-model');
    expect(result.status).toBe('error');
    expect(result.details).toMatch(/400/);
  });
});

// ---------------------------------------------------------------------------
// probeReasoning
// ---------------------------------------------------------------------------

describe('probeReasoning', () => {
  it("returns 'ok' when response has reasoning_content", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        json: {
          choices: [
            {
              message: {
                content: '4',
                reasoning_content: '2 + 2 = 4',
              },
            },
          ],
        },
      }),
    );
    const result = await probeReasoning(mockConfig, 'test-model');
    expect(result.status).toBe('ok');
  });

  it("returns 'unsupported' on 400 with reasoning_effort error", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        ok: false,
        status: 400,
        text: 'Model does not support "reasoning_effort" parameter',
      }),
    );
    const result = await probeReasoning(mockConfig, 'test-model');
    expect(result.status).toBe('unsupported');
  });

  it("returns 'error' on fetch throw", async () => {
    mockFetch.mockRejectedValue(new Error('Network failure'));
    const result = await probeReasoning(mockConfig, 'test-model');
    expect(result.status).toBe('error');
    expect(result.details).toBe('Network failure');
  });

  it("returns 'unsupported' on 422 with reasoning_effort error", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        ok: false,
        status: 422,
        text: 'Unprocessable: "reasoning_effort" is not supported',
      }),
    );
    const result = await probeReasoning(mockConfig, 'test-model');
    expect(result.status).toBe('unsupported');
  });

  it("returns 'error' on non-2xx without reasoning_effort mention", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ ok: false, status: 503, text: 'Service Unavailable' }),
    );
    const result = await probeReasoning(mockConfig, 'test-model');
    expect(result.status).toBe('error');
    expect(result.details).toMatch(/503/);
  });

  it("returns 'error' when response has no reasoning field (still ok)", async () => {
    // Spec says: ok = call succeeded even without reasoning fields
    mockFetch.mockResolvedValue(
      mockResponse({
        json: { choices: [{ message: { content: '4' } }] },
      }),
    );
    const result = await probeReasoning(mockConfig, 'test-model');
    expect(result.status).toBe('ok');
  });

  it("returns 'rate_limited' on 429", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ ok: false, status: 429 }),
    );
    const result = await probeReasoning(mockConfig, 'test-model');
    expect(result.status).toBe('rate_limited');
  });

  it("returns 'unsupported' on 400 with REASONING_EFFORT (case-insensitive match)", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        ok: false,
        status: 400,
        text: 'Model does not support "REASONING_EFFORT" parameter',
      }),
    );
    const result = await probeReasoning(mockConfig, 'test-model');
    expect(result.status).toBe('unsupported');
  });

  it("returns 'ok' with empty choices array", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        json: { choices: [] },
      }),
    );
    const result = await probeReasoning(mockConfig, 'test-model');
    expect(result.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// probeToolCalling
// ---------------------------------------------------------------------------

describe('probeToolCalling', () => {
  it("returns 'ok' when response has tool_calls", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        json: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const result = await probeToolCalling(mockConfig, 'test-model');
    expect(result.status).toBe('ok');
  });

  it("returns 'unsupported' on 400 with tools error", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        ok: false,
        status: 400,
        text: 'Model does not support "tools" parameter',
      }),
    );
    const result = await probeToolCalling(mockConfig, 'test-model');
    expect(result.status).toBe('unsupported');
  });

  it("returns 'unsupported' on 422 with tools error", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        ok: false,
        status: 422,
        text: 'Unprocessable: "tools" parameter not available',
      }),
    );
    const result = await probeToolCalling(mockConfig, 'test-model');
    expect(result.status).toBe('unsupported');
  });

  it("returns 'error' on non-2xx without tools mention", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ ok: false, status: 502, text: 'Bad Gateway' }),
    );
    const result = await probeToolCalling(mockConfig, 'test-model');
    expect(result.status).toBe('error');
    expect(result.details).toMatch(/502/);
  });

  it("returns 'error' on fetch throw", async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));
    const result = await probeToolCalling(mockConfig, 'test-model');
    expect(result.status).toBe('error');
    expect(result.details).toBe('Connection refused');
  });

  it("returns 'rate_limited' on 429", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ ok: false, status: 429 }),
    );
    const result = await probeToolCalling(mockConfig, 'test-model');
    expect(result.status).toBe('rate_limited');
  });

  it("returns 'error' when tool_calls is an empty array", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        json: { choices: [{ message: { content: 'sunny', tool_calls: [] } }] },
      }),
    );
    const result = await probeToolCalling(mockConfig, 'test-model');
    expect(result.status).toBe('error');
    expect(result.details).toBe('No tool_calls in response');
  });
});

// ---------------------------------------------------------------------------
// probeModel
// ---------------------------------------------------------------------------

describe('probeModel', () => {
  it('returns ModelProbe with all 3 sub-results', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        json: {
          choices: [{
            message: {
              content: 'pong',
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
            },
          }],
        },
      }),
    );
    const result = await probeModel(mockConfig, 'test-model');
    expect(result.modelId).toBe('test-model');
    expect(result.liveness.status).toBe('ok');
    expect(result.reasoning.status).toBe('ok');
    expect(result.toolCalling.status).toBe('ok');
  });

  it('all 3 sub-probes fail — returns ModelProbe with all error statuses', async () => {
    mockFetch.mockRejectedValue(new Error('Service unreachable'));
    const result = await probeModel(mockConfig, 'test-model');
    expect(result.modelId).toBe('test-model');
    expect(result.liveness.status).toBe('error');
    expect(result.reasoning.status).toBe('error');
    expect(result.toolCalling.status).toBe('error');
  });

  it('modelId is correctly reflected in result', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ json: { choices: [{ message: { content: 'pong' } }] } }),
    );
    const result = await probeModel(mockConfig, 'my-custom-model-v2');
    expect(result.modelId).toBe('my-custom-model-v2');
  });

  it('each sub-result is independent (one failure does not block others)', async () => {
    // First call succeeds, second and third fail
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({ json: { choices: [{ message: { content: 'pong' } }] } }),
      )
      .mockRejectedValueOnce(new Error('Reasoning failed'))
      .mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 400,
          text: 'Model does not support "tools" parameter',
        }),
      );
    const result = await probeModel(mockConfig, 'test-model');
    expect(result.liveness.status).toBe('ok');
    expect(result.reasoning.status).toBe('error');
    expect(result.reasoning.details).toBe('Reasoning failed');
    expect(result.toolCalling.status).toBe('unsupported');
  });
});

// ---------------------------------------------------------------------------
// probeAllModels
// ---------------------------------------------------------------------------

describe('probeAllModels', () => {
  it('empty modelIds array returns empty array', async () => {
    const results = await probeAllModels(mockConfig, []);
    expect(results).toEqual([]);
  });

  it('runs probeModel for each modelId and returns in same order', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        json: { choices: [{ message: { content: 'pong' } }] },
      }),
    );
    const results = await probeAllModels(mockConfig, ['alpha', 'beta', 'gamma']);
    expect(results).toHaveLength(3);
    expect(results[0].modelId).toBe('alpha');
    expect(results[1].modelId).toBe('beta');
    expect(results[2].modelId).toBe('gamma');
  });

  it('probes are sequential (one completes before next starts)', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First model takes time — verify no concurrent call started
        await new Promise((r) => setTimeout(r, 20));
      }
      return mockResponse({ json: { choices: [{ message: { content: 'pong' } }] } });
    });
    const start = Date.now();
    const results = await probeAllModels(mockConfig, ['alpha', 'beta']);
    const elapsed = Date.now() - start;
    // If parallel, elapsed ~= 20ms; if sequential, elapsed >= 40ms (2 models × 20ms)
    expect(elapsed).toBeGreaterThanOrEqual(15);
    expect(results).toHaveLength(2);
  });

  it('continues on individual failures', async () => {
    mockFetch
      // alpha: liveness=ok, reasoning=error, toolCalling=ok(no tool_calls→error)
      .mockResolvedValueOnce(
        mockResponse({ json: { choices: [{ message: { content: 'pong' } }] } }),
      )
      .mockRejectedValueOnce(new Error('Network failure'))
      .mockResolvedValueOnce(
        mockResponse({ json: { choices: [{ message: { content: 'pong' } }] } }),
      )
      // beta: all rejected
      .mockRejectedValueOnce(new Error('Network failure'))
      .mockRejectedValueOnce(new Error('Network failure'))
      .mockRejectedValueOnce(new Error('Network failure'))
      // gamma: liveness=ok, reasoning=ok, toolCalling=ok
      .mockResolvedValueOnce(
        mockResponse({ json: { choices: [{ message: { content: 'pong' } }] } }),
      )
      .mockResolvedValueOnce(
        mockResponse({ json: { choices: [{ message: { content: 'pong' } }] } }),
      )
      .mockResolvedValueOnce(
        mockResponse({ json: { choices: [{ message: { content: 'pong', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] } }] } }),
      );
    const results = await probeAllModels(mockConfig, ['alpha', 'beta', 'gamma']);
    expect(results).toHaveLength(3);
    expect(results[0].liveness.status).toBe('ok');
    expect(results[1].liveness.status).toBe('error');
    expect(results[2].liveness.status).toBe('ok');
  });
});
