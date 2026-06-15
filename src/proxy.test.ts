import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  buildUpstreamUrl,
  buildUpstreamHeaders,
  isStreamingRequest,
  createProxyApp,
} from './proxy.js';
import { resetModelsFetcherState } from './models-fetcher.js';
import { loadModelsFromJson } from './cli/opencode-config.js';
import type { ProxyConfig } from './config.js';

describe('buildUpstreamUrl', () => {
  it('combines base URL and path', () => {
    expect(buildUpstreamUrl('https://api.example.com', '/v1/chat')).toBe('https://api.example.com/v1/chat');
  });

  it('strips trailing slash from base', () => {
    expect(buildUpstreamUrl('https://api.example.com/', '/v1/chat')).toBe('https://api.example.com/v1/chat');
    expect(buildUpstreamUrl('https://api.example.com///', '/v1/chat')).toBe('https://api.example.com/v1/chat');
  });

  it('adds leading slash to path if missing', () => {
    expect(buildUpstreamUrl('https://api.example.com', 'v1/chat')).toBe('https://api.example.com/v1/chat');
  });

  it('handles path with query parameters', () => {
    expect(buildUpstreamUrl('https://api.example.com', '/v1/chat?stream=true')).toBe('https://api.example.com/v1/chat?stream=true');
  });

  it('handles empty path', () => {
    expect(buildUpstreamUrl('https://api.example.com', '')).toBe('https://api.example.com/');
  });

  it('handles root path', () => {
    expect(buildUpstreamUrl('https://api.example.com', '/')).toBe('https://api.example.com/');
  });

  it('rejects path traversal attempts', () => {
    expect(() => buildUpstreamUrl('https://api.example.com', '/../../../etc/passwd')).toThrow('Path traversal detected');
    expect(() => buildUpstreamUrl('https://api.example.com', '/v1/../../internal')).toThrow('Path traversal detected');
  });
});

describe('buildUpstreamHeaders', () => {
  it('removes hop-by-hop headers', () => {
    const incoming = new Headers({
      'host': 'localhost:3000',
      'connection': 'keep-alive',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      'authorization': 'Bearer old-token',
      'content-type': 'application/json',
      'x-custom': 'value',
    });

    const result = buildUpstreamHeaders(incoming, 'new-token');

    expect(result.get('host')).toBeNull();
    expect(result.get('connection')).toBeNull();
    expect(result.get('keep-alive')).toBeNull();
    expect(result.get('transfer-encoding')).toBeNull();
    expect(result.get('content-type')).toBe('application/json');
    expect(result.get('x-custom')).toBe('value');
  });

  it('replaces Authorization header with new bearer token', () => {
    const incoming = new Headers({
      'authorization': 'Bearer old-token',
    });

    const result = buildUpstreamHeaders(incoming, 'new-token');

    expect(result.get('authorization')).toBe('Bearer new-token');
  });

  it('adds Authorization header even if not present', () => {
    const incoming = new Headers({
      'content-type': 'application/json',
    });

    const result = buildUpstreamHeaders(incoming, 'new-token');

    expect(result.get('authorization')).toBe('Bearer new-token');
  });

  it('preserves case-insensitive header matching', () => {
    const incoming = new Headers({
      'Host': 'localhost:3000',
      'CONNECTION': 'close',
      'Authorization': 'Bearer old',
    });

    const result = buildUpstreamHeaders(incoming, 'new-token');

    expect(result.get('host')).toBeNull();
    expect(result.get('connection')).toBeNull();
    expect(result.get('authorization')).toBe('Bearer new-token');
  });
});

describe('isStreamingRequest', () => {
  it('returns true when stream is true', () => {
    expect(isStreamingRequest('{"stream": true}')).toBe(true);
    expect(isStreamingRequest('{"model": "gpt-4", "stream": true}')).toBe(true);
  });

  it('returns false when stream is false', () => {
    expect(isStreamingRequest('{"stream": false}')).toBe(false);
  });

  it('returns false when stream field is missing', () => {
    expect(isStreamingRequest('{"model": "gpt-4"}')).toBe(false);
  });

  it('returns false for invalid JSON', () => {
    expect(isStreamingRequest('not json')).toBe(false);
    expect(isStreamingRequest('')).toBe(false);
    expect(isStreamingRequest('{')).toBe(false);
  });

  it('returns false when stream is not boolean', () => {
    expect(isStreamingRequest('{"stream": "true"}')).toBe(false);
    expect(isStreamingRequest('{"stream": 1}')).toBe(false);
    expect(isStreamingRequest('{"stream": null}')).toBe(false);
  });
});

describe('createProxyApp — /v1/models routes', () => {
  let app: ReturnType<typeof createProxyApp>;

  const testConfig: ProxyConfig = {
    port: 0,
    host: '127.0.0.1',
    upstreamBaseUrl: 'https://example.com',
    requestTimeoutMs: 30000,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60000,
    allowedOrigins: ['*'],
    keys: [{ label: 'test', key: 'sk-test-key-12345' }],
  };

  beforeEach(() => {
    resetModelsFetcherState();
    // Prevent real network calls — upstreamBaseUrl is https://example.com
    // which would otherwise cause 5s AbortSignal.timeout waits.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
  });

  beforeAll(() => {
    app = createProxyApp(testConfig);
  });

  it('GET /v1/models returns 200 with object: list', async () => {
    const res = await app.request('/v1/models');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('GET /v1/models returns all models', async () => {
    const res = await app.request('/v1/models');
    const body = await res.json();
    expect(body.data).toHaveLength(Object.keys(loadModelsFromJson()).length);
  });

  it('GET /v1/models each model entry has minimal format (id, object, created, owned_by)', async () => {
    const res = await app.request('/v1/models');
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const entry of body.data) {
      expect(entry).toHaveProperty('id');
      expect(entry.object).toBe('model');
      expect(entry.owned_by).toBe('saros');
      expect(typeof entry.created).toBe('number');
    }
  });

  it('GET /zen/go/v1/models returns 200 with object: list', async () => {
    const res = await app.request('/zen/go/v1/models');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(Object.keys(loadModelsFromJson()).length);
  });

  it('POST /v1/* paths are proxied to upstream (no longer 404)', async () => {
    const res1 = await app.request('/v1/models', { method: 'POST' });
    expect(res1.status).not.toBe(404);

    const res2 = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res2.status).not.toBe(404);
  });
});
