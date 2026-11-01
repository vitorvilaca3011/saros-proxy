/**
 * overview.test.ts — Unit tests for the key-state rendering shared by the bare
 * `saros-proxy` overview and `saros-proxy status` (src/cli/key-state.ts).
 */
import { describe, it, expect } from 'vitest';
import { formatKeyState, formatKeyBlock } from '../src/cli/key-state.js';

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

describe('formatKeyBlock', () => {
  it('summarises the pool and marks the keys that are out', () => {
    const lines = formatKeyBlock({
      keys: [
        {
          label: 'work',
          provider: 'commandcode',
          enabled: false,
          entitled: true,
          retryAfterMs: 42_000,
          lastError: { status: 401, reason: 'auth' },
        },
        { label: 'home', provider: 'opencode-go', enabled: true, entitled: true },
      ],
    });

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('1/2 enabled');
    expect(lines[1]).toContain('work');
    expect(lines[1]).toContain('[commandcode]');
    expect(lines[1]).toContain('401');
    expect(lines[2]).toContain('home');
    expect(lines[2]).not.toContain('disabled');
  });

  it('returns nothing when the payload has no keys block', () => {
    expect(formatKeyBlock(undefined)).toEqual([]);
    expect(formatKeyBlock({ status: 'ok' })).toEqual([]);
  });
});
