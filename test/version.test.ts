/**
 * version.test.ts — The shared package-version read.
 *
 * node:fs is wrapped so the tests can count reads: the point of src/version.ts
 * is one read per process, not one per caller.
 *
 * Dynamic imports are deliberate (test-time module boundary): `vi.resetModules()`
 * must re-evaluate src/version.ts so its cache starts empty in every test.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolve } from 'node:path';
import type * as NodeFs from 'node:fs';

const actualReadRef = vi.hoisted(() => ({
  fn: null as null | ((...args: unknown[]) => unknown),
}));
const mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  actualReadRef.fn = actual.readFileSync as (...args: unknown[]) => unknown;
  mockReadFileSync.mockImplementation((...args: unknown[]) =>
    actualReadRef.fn!(...args),
  );
  return { ...actual, readFileSync: mockReadFileSync };
});

beforeEach(() => {
  vi.resetModules();
  mockReadFileSync.mockClear();
  mockReadFileSync.mockImplementation((...args: unknown[]) =>
    actualReadRef.fn!(...args),
  );
});

describe('getVersion', () => {
  it('reads package.json once and caches the result', async () => {
    const { getVersion } = await import('../src/version.js');

    const first = getVersion();
    const second = getVersion();
    const expected = JSON.parse(
      actualReadRef.fn!(resolve(process.cwd(), 'package.json'), 'utf-8') as string,
    ) as { version: string };

    expect(first).toBe(expected.version);
    expect(second).toBe(expected.version);
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    expect(String(mockReadFileSync.mock.calls[0][0])).toMatch(/package\.json$/);
  });

  it('falls back to 0.0.0 when the file cannot be read', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EIO: simulated unreadable package.json');
    });

    const { getVersion } = await import('../src/version.js');

    expect(getVersion()).toBe('0.0.0');
    expect(getVersion()).toBe('0.0.0');
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it('falls back when package.json has no usable version string', async () => {
    mockReadFileSync.mockReturnValue('{"version": 123}');
    let versionModule = await import('../src/version.js');
    expect(versionModule.getVersion()).toBe('0.0.0');

    vi.resetModules();
    mockReadFileSync.mockReturnValue('{"version": ""}');
    versionModule = await import('../src/version.js');
    expect(versionModule.getVersion()).toBe('0.0.0');
  });

  it('keeps the getCurrentVersion alias working', async () => {
    const { getVersion } = await import('../src/version.js');
    const { getCurrentVersion } = await import('../src/cli/update-check.js');

    expect(getCurrentVersion()).toBe(getVersion());
  });
});
