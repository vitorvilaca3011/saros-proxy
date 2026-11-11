/**
 * update-check.test.ts — Tests for the npm update check.
 *
 * checkForUpdate() is the only export; compareVersions is exercised
 * through it by stubbing the global fetch.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compareVersions,
  fetchLatestVersion,
  isValidVersion,
} from '../src/cli/update-check.js';

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
    expect(warnings[0]).toContain('saros-proxy update');
    expect(warnings[0]).not.toContain('npm install -g');
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

  it('ignores registry versions that are not plain semver', async () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as {
      version: string;
    };
    // The registry only serves proper semver; shortened/lengthened cores are
    // rejected before any comparison can use them.
    const shorter = pkg.version.split('.').slice(0, 2).join('.');
    const longer = `${pkg.version}.1`;

    expect(await runWithRegistryVersion(shorter)).toHaveLength(0);
    expect(await runWithRegistryVersion(longer)).toHaveLength(0);
  });
});

describe('compareVersions', () => {
  it('orders prereleases below their stable release', () => {
    expect(compareVersions('1.1.3-rc.1', '1.1.3')).toBe(-1);
    expect(compareVersions('1.1.3', '1.1.3-rc.1')).toBe(1);
    expect(compareVersions('1.1.3-rc.1', '1.1.3-rc.2')).toBe(-1);
    expect(compareVersions('1.1.3-alpha', '1.1.3-beta')).toBe(-1);
    expect(compareVersions('1.1.3-1', '1.1.3-alpha')).toBe(-1);
  });

  it('ignores build metadata and keeps the historical numeric comparison', () => {
    expect(compareVersions('1.1.3+build.1', '1.1.3')).toBe(0);
    expect(compareVersions('1.1', '1.1.2')).toBe(-1);
    expect(compareVersions('1.1.2.1', '1.1.2')).toBe(1);
  });
});

describe('fetchLatestVersion validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts plain semver, including prereleases', () => {
    expect(isValidVersion('1.1.3')).toBe(true);
    expect(isValidVersion('1.1.3-rc.1')).toBe(true);
    expect(isValidVersion('1.1.3+build.5')).toBe(true);
    expect(isValidVersion('1.1.3-rc.1+build.2')).toBe(true);
    expect(isValidVersion('latest')).toBe(false);
    expect(isValidVersion('1.1.3; rm -rf /')).toBe(false);
    expect(isValidVersion('1.1.3-rc.1+')).toBe(false);
  });

  it('rejects a registry version with shell metacharacters', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ version: '1.1.3; rm -rf /' }),
      }),
    );

    await expect(fetchLatestVersion()).rejects.toThrow('invalid version');
  });

  it('accepts a prerelease from the registry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ version: '1.1.3-rc.1' }),
      }),
    );

    await expect(fetchLatestVersion()).resolves.toBe('1.1.3-rc.1');
  });
});
