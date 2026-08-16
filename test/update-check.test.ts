/**
 * update-check.test.ts — Tests for the npm update check.
 *
 * checkForUpdate() is the only export; compareVersions is exercised
 * through it by stubbing the global fetch.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('checkForUpdate', () => {
  const originalWarn = console.warn;

  afterEach(() => {
    vi.unstubAllGlobals();
    console.warn = originalWarn;
  });

  async function runWithRegistryVersion(version: string | null, options?: { ok?: boolean; throws?: boolean }): Promise<string[]> {
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));

    const mockFetch = options?.throws
      ? vi.fn(() => Promise.reject(new Error('network down')))
      : vi.fn(() =>
          Promise.resolve({
            ok: options?.ok ?? true,
            json: () => Promise.resolve(version === null ? {} : { version }),
          }),
        );
    vi.stubGlobal('fetch', mockFetch);

    const { checkForUpdate } = await import('../src/cli/update-check.js');
    await checkForUpdate();
    return warnings;
  }

  it('warns when a newer version is available', async () => {
    const warnings = await runWithRegistryVersion('99.0.0');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Update available');
    expect(warnings[0]).toContain('99.0.0');
  });

  it('is silent when the registry version equals the current version', async () => {
    const warnings = await runWithRegistryVersion('0.7.2');
    expect(warnings).toHaveLength(0);
  });

  it('is silent when the registry version is older', async () => {
    const warnings = await runWithRegistryVersion('0.1.0');
    expect(warnings).toHaveLength(0);
  });

  it('is silent when registry reports non-OK response', async () => {
    const warnings = await runWithRegistryVersion('99.0.0', { ok: false });
    expect(warnings).toHaveLength(0);
  });

  it('is silent when the response has no version field', async () => {
    const warnings = await runWithRegistryVersion(null);
    expect(warnings).toHaveLength(0);
  });

  it('never throws on network errors', async () => {
    const warnings = await runWithRegistryVersion(null, { throws: true });
    expect(warnings).toHaveLength(0);
  });

  it('compares version parts of different lengths (e.g. 1.0 vs 1.0.1)', async () => {
    // Version-agnostic: derive fixtures from the real package.json version
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as {
      version: string;
    };
    // '0.7' — current minus the patch segment (shorter → older)
    const shorter = pkg.version.split('.').slice(0, 2).join('.');
    // '0.7.3.1' — current plus an extra segment (longer → newer)
    const longerNewer = `${pkg.version}.1`;

    const older = await runWithRegistryVersion(shorter);
    expect(older).toHaveLength(0);
    const newer = await runWithRegistryVersion(longerNewer);
    expect(newer).toHaveLength(1);
  });
});
