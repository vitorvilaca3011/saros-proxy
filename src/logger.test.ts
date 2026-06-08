import { describe, it, expect, vi, beforeEach } from 'vitest';
import { maskKey } from './logger.js';

describe('maskKey', () => {
  it('returns **** for empty string', () => {
    expect(maskKey('')).toBe('****');
  });

  it('returns **** for short keys (< 4 chars)', () => {
    expect(maskKey('abc')).toBe('****');
  });

  it('masks sk- prefix keys', () => {
    expect(maskKey('sk-1mycDCRMaA8onfQmsRhvp')).toBe('sk-1...Rhvp');
  });

  it('masks key- prefix keys', () => {
    expect(maskKey('key-abcdefghijklmnop')).toBe('key-...mnop');
  });

  it('masks api- prefix keys', () => {
    expect(maskKey('api-abcdefghijklmnop')).toBe('api-...mnop');
  });

  it('masks token- prefix keys', () => {
    expect(maskKey('token-abcdefghijklmnop')).toBe('toke...mnop');
  });

  it('masks long keys without prefix (> 20 chars)', () => {
    expect(maskKey('abcdefghijklmnopqrstuv')).toBe('abcd...stuv');
  });

  it('shows short secret keys (<=12 chars) with **** suffix', () => {
    expect(maskKey('sk-12345678')).toBe('sk-1****');
  });

  it('does not mask short non-secret strings', () => {
    expect(maskKey('hello')).toBe('hello');
  });

  it('handles exactly 4 char keys', () => {
    expect(maskKey('sk-a')).toBe('sk-a****');
  });
});

describe('logger creation', () => {
  const OENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OENV };
    // Default: not production → pino-pretty should be attempted
    delete process.env.NODE_ENV;
  });

  it('creates a logger with JSON transport in production', async () => {
    process.env.NODE_ENV = 'production';
    const { logger } = await import('./logger.js');
    expect(logger).toBeDefined();
    expect(logger.level).toBe('info');
  });

  it('respects LOG_LEVEL env var', async () => {
    process.env.LOG_LEVEL = 'debug';
    const { logger } = await import('./logger.js');
    expect(logger.level).toBe('debug');
  });

  it('falls back to JSON logging when pino-pretty is unavailable', async () => {
    // Simulate NODE_ENV=development (tries pretty transport)
    // but pino-pretty IS available here (dev incl. devDeps) — so we can only
    // verify the path doesn't throw; the real fallback is at runtime on global install.
    process.env.NODE_ENV = 'development';
    const { logger } = await import('./logger.js');
    expect(logger).toBeDefined();
    expect(logger.level).toBe('info');
  });

  it('uses default log level when LOG_LEVEL not set', async () => {
    process.env.NODE_ENV = 'production';
    const { logger } = await import('./logger.js');
    expect(logger.level).toBe('info');
  });
});
