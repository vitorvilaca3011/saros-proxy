/**
 * proxy-model-pin.test.ts — A model id pinned to a provider with the
 * `@provider` routing suffix must still reach the upstream under the id that
 * provider actually serves. Reproduced live on 1.3.1: pinning
 * 'deepseek-v4.1-flash@commandcode' forwarded the bare short name, which
 * commandcode answers with 400 unsupported_model.
 *
 * Module-level catalog state (commandcode / opencode-go) is per-file under
 * vitest isolation, so the catalogs are loaded once in `beforeAll` and every
 * assertion below runs against a populated index.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createProxyApp, prepareOutboundRequest } from '../src/proxy.js';
import { commandcodeProvider } from '../src/providers/commandcode.js';
import { opencodeGoProvider } from '../src/providers/opencode-go.js';
import type { ProxyConfig } from '../src/config.js';

const COMMANDCODE_CATALOG = [
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
];

const OPENCODE_CATALOG = [{ id: 'glm-5', name: 'GLM 5' }, { id: 'kimi-k2', name: 'Kimi K2' }];

beforeAll(async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const data = url.includes('/provider/v1/models') ? COMMANDCODE_CATALOG : OPENCODE_CATALOG;
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
  await commandcodeProvider.fetchCatalog();
  await opencodeGoProvider.fetchCatalog();
  fetchMock.mockRestore();
  // Guard: the assertions below are meaningless without a loaded index.
  expect(commandcodeProvider.resolveNativeId('deepseek-v4.1-flash')).toBe(
    'deepseek/deepseek-v4.1-flash',
  );
  expect(opencodeGoProvider.resolveNativeId('glm-5')).toBe('glm-5');
});

function bodyModel(bodyText: string): unknown {
  const parsed: unknown = JSON.parse(bodyText);
  return parsed && typeof parsed === 'object' && 'model' in parsed ? parsed.model : undefined;
}

function prepare(bodyText: string, modelId: string) {
  // commandcode has no session header and no reasoning whitelist change is
  // needed for these bodies; keep stream-usage injection off so the only
  // possible edit is the model id.
  return prepareOutboundRequest(bodyText, modelId, commandcodeProvider, {
    wantsStreamUsage: false,
  });
}

describe('prepareOutboundRequest — pinned model id resolves the native id', () => {
  it('rewrites a pinned short name to the provider native id', () => {
    const prepared = prepare(
      '{"model":"deepseek-v4.1-flash@commandcode","messages":[]}',
      'deepseek-v4.1-flash@commandcode',
    );
    expect(bodyModel(prepared.bodyText)).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('strips the pin and leaves an already native id alone', () => {
    const input = '{"model":"deepseek/deepseek-v4.1-flash@commandcode","messages":[]}';
    const prepared = prepare(input, 'deepseek/deepseek-v4.1-flash@commandcode');
    expect(bodyModel(prepared.bodyText)).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('strips the pin on opencode-go without rewriting the bare id', () => {
    const prepared = prepareOutboundRequest(
      '{"model":"glm-5@opencode-go","messages":[]}',
      'glm-5@opencode-go',
      opencodeGoProvider,
      { wantsStreamUsage: false, clientSessionId: 'session-1' },
    );
    expect(bodyModel(prepared.bodyText)).toBe('glm-5');
  });

  it('leaves an unpinned native id byte-identical', () => {
    const input = '{"model":"deepseek/deepseek-v4.1-flash","messages":[]}';
    expect(prepare(input, 'deepseek/deepseek-v4.1-flash').bodyText).toBe(input);
  });

  it('keeps an unpinned short name resolving to the native id (unchanged behaviour)', () => {
    const prepared = prepare('{"model":"deepseek-v4.1-flash","messages":[]}', 'deepseek-v4.1-flash');
    expect(bodyModel(prepared.bodyText)).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('strips the pin without a rewrite when the catalog does not carry the name', () => {
    const prepared = prepare('{"model":"model-x@commandcode","messages":[]}', 'model-x@commandcode');
    expect(bodyModel(prepared.bodyText)).toBe('model-x');
  });

  it('leaves a body without a model untouched', () => {
    const input = '{"prompt":"hi"}';
    expect(prepare(input, 'deepseek-v4.1-flash@commandcode').bodyText).toBe(input);
  });
});

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    upstreamBaseUrl: 'https://example.com',
    requestTimeoutMs: 30_000,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
    allowedOrigins: ['*'],
    keys: [{ label: 'cc', key: 'user_cc-key-0001', provider: 'commandcode' }],
    ...overrides,
  };
}

describe('createProxyApp — the body forwarded upstream carries the native id', () => {
  /** Collect the single upstream call the proxy makes for one chat request. */
  function mockUpstreamFetch() {
    // A fresh Response per call: createProxyApp also fetches on its own, and a
    // shared body can only be read once.
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{"ok":true}', { status: 200 }));
  }

  /** Body the proxy actually forwarded on the chat completions relay. */
  function forwardedModel(fetchMock: { mock: { calls: Parameters<typeof fetch>[] } }): unknown {
    const call = fetchMock.mock.calls.find(([input]) => String(input).includes('/chat/completions'));
    expect(call, 'no chat/completions upstream call').toBeDefined();
    expect(String(call![0])).toBe('https://api.commandcode.ai/provider/v1/chat/completions');
    return bodyModel(String((call![1] as RequestInit).body));
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards a pinned short name as the provider native id', async () => {
    const fetchMock = mockUpstreamFetch();
    const app = createProxyApp(makeConfig());
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek-v4.1-flash@commandcode', messages: [] }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(forwardedModel(fetchMock)).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('forwards an already native pinned id unchanged', async () => {
    const fetchMock = mockUpstreamFetch();
    const app = createProxyApp(makeConfig());
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash@commandcode', messages: [] }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(forwardedModel(fetchMock)).toBe('deepseek/deepseek-v4.1-flash');
  });
});
