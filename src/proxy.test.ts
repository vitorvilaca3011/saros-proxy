import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildUpstreamUrl,
  buildUpstreamHeaders,
  isStreamingRequest,
  createProxyApp,
  buildModelsListResponse,
} from './proxy.js';
import { OPENCODE_MODELS } from './constants.js';
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

// ---------------------------------------------------------------------------
// Models discovery endpoint
// ---------------------------------------------------------------------------

describe('buildModelsListResponse', () => {
  it('returns a Response with status 200', () => {
    const res = buildModelsListResponse();
    expect(res.status).toBe(200);
  });

  it('has content-type application/json', () => {
    const res = buildModelsListResponse();
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('returns object: list with data array', () => {
    const res = buildModelsListResponse();
    return res.json().then((body) => {
      expect(body).toHaveProperty('object', 'list');
      expect(Array.isArray(body.data)).toBe(true);
    });
  });

  it('contains all OPENCODE_MODELS entries', () => {
    const res = buildModelsListResponse();
    return res.json().then((body) => {
      expect(body.data).toHaveLength(Object.keys(OPENCODE_MODELS).length);
    });
  });

  it('each model has required OpenAI-compatible fields', () => {
    const res = buildModelsListResponse();
    return res.json().then((body) => {
      for (const model of body.data) {
        expect(model).toHaveProperty('id');
        expect(model).toHaveProperty('name');
        expect(model).toHaveProperty('object', 'model');
        expect(model).toHaveProperty('owned_by', 'saros');
      }
    });
  });

  it('each model includes rich metadata (tool_call, limit, modalities)', () => {
    const res = buildModelsListResponse();
    return res.json().then((body) => {
      for (const model of body.data) {
        expect(model).toHaveProperty('tool_call');
        expect(model).toHaveProperty('limit');
        expect(model).toHaveProperty('modalities');
      }
    });
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

  it('GET /v1/models returns all 18 models', async () => {
    const res = await app.request('/v1/models');
    const body = await res.json();
    expect(body.data).toHaveLength(Object.keys(OPENCODE_MODELS).length);
  });

  it('GET /zen/go/v1/models returns 200 with object: list', async () => {
    const res = await app.request('/zen/go/v1/models');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(Object.keys(OPENCODE_MODELS).length);
  });

  it('POST /v1/models returns 404', async () => {
    const res = await app.request('/v1/models', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('PUT /v1/models returns 404', async () => {
    const res = await app.request('/v1/models', { method: 'PUT' });
    expect(res.status).toBe(404);
  });
});
