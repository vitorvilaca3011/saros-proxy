import { describe, it, expect } from 'vitest';
import { buildUpstreamUrl, buildUpstreamHeaders, isStreamingRequest } from './proxy.js';

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
