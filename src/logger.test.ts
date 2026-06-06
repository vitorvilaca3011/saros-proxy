import { describe, it, expect } from 'vitest';
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
