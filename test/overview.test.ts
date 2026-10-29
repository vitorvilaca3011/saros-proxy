/**
 * overview.test.ts — Unit tests for the per-key state rendering of the bare
 * `saros-proxy` overview (`formatKeyState`).
 */
import { describe, it, expect } from 'vitest';
import { formatKeyState } from '../src/cli/overview.js';

describe('formatKeyState', () => {
  it('explains a disabled key with its last status and retry', () => {
    const text = formatKeyState({
      enabled: false,
      entitled: true,
      retryAfterMs: 42_000,
      lastError: { status: 401, reason: 'auth' },
    });
    expect(text).toContain('disabled');
    expect(text).toContain('auth');
    expect(text).toContain('(401)');
    expect(text).toContain('retry in 42s');
  });

  it('explains a key without plan for the provider', () => {
    const text = formatKeyState({ enabled: false, entitled: false });
    expect(text).toContain('no plan for this provider');
  });

  it('omits the retry when the cooldown already expired', () => {
    const text = formatKeyState({ enabled: false, entitled: true, retryAfterMs: 0, lastError: null });
    expect(text).toContain('disabled');
    expect(text).not.toContain('retry in');
  });

  it('says nothing about a healthy key or an unknown entry', () => {
    expect(formatKeyState({ enabled: true, entitled: true })).toBe('');
    expect(formatKeyState(undefined)).toBe('');
  });
});
