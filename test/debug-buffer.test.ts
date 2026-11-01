/**
 * debug-buffer.test.ts — Unit tests for the in-memory recent-requests buffer.
 * The proxy-level wiring (endpoint, env gate, header) lives in proxy.test.ts.
 */
import { describe, it, expect } from 'vitest';

import {
  createRecentRequestBuffer,
  isDebugBufferEnabled,
  type RecentRequestEntry,
} from '../src/debug-buffer.js';
import { RECENT_REQUESTS_CAPACITY } from '../src/constants.js';

function entry(overrides: Partial<RecentRequestEntry> = {}): RecentRequestEntry {
  return {
    requestId: 'r1',
    at: '2026-10-31T12:00:00.000Z',
    method: 'POST',
    path: '/zen/go/v1/chat/completions',
    model: 'model-a',
    provider: 'opencode-go',
    keyLabel: 'alpha',
    status: 200,
    durationMs: 12,
    stream: false,
    attempt: 1,
    ...overrides,
  };
}

describe('createRecentRequestBuffer', () => {
  it('defaults to 200 entries and starts empty', () => {
    const buffer = createRecentRequestBuffer();
    expect(buffer.capacity).toBe(RECENT_REQUESTS_CAPACITY);
    expect(buffer.snapshot()).toEqual({ capacity: 200, count: 0, entries: [] });
  });

  it('appends entries in chronological order', () => {
    const buffer = createRecentRequestBuffer(5);
    buffer.push(entry({ requestId: 'a' }));
    buffer.push(entry({ requestId: 'b' }));

    const snapshot = buffer.snapshot();
    expect(snapshot.count).toBe(2);
    expect(snapshot.entries.map((e) => e.requestId)).toEqual(['a', 'b']);
  });

  it('keeps the newest N entries and drops the oldest', () => {
    const buffer = createRecentRequestBuffer(3);
    for (let i = 1; i <= 5; i++) buffer.push(entry({ requestId: `r${i}` }));

    const snapshot = buffer.snapshot();
    expect(snapshot.capacity).toBe(3);
    expect(snapshot.count).toBe(3);
    expect(snapshot.entries.map((e) => e.requestId)).toEqual(['r3', 'r4', 'r5']);
  });

  it('returns detached copies so callers cannot mutate the buffer', () => {
    const buffer = createRecentRequestBuffer(2);
    buffer.push(entry({ requestId: 'a' }));

    const snapshot = buffer.snapshot();
    snapshot.entries[0].status = 500;
    snapshot.entries.push(entry({ requestId: 'injected' }));

    const fresh = buffer.snapshot();
    expect(fresh.entries).toHaveLength(1);
    expect(fresh.entries[0]).toMatchObject({ requestId: 'a', status: 200 });
  });
});

describe('isDebugBufferEnabled', () => {
  it('is enabled when the variable is unset', () => {
    expect(isDebugBufferEnabled({})).toBe(true);
  });

  it('is disabled only by the exact value 0', () => {
    expect(isDebugBufferEnabled({ SAROS_DEBUG_BUFFER: '0' })).toBe(false);
  });

  it('treats any other value as enabled', () => {
    expect(isDebugBufferEnabled({ SAROS_DEBUG_BUFFER: '1' })).toBe(true);
    expect(isDebugBufferEnabled({ SAROS_DEBUG_BUFFER: 'false' })).toBe(true);
  });
});
