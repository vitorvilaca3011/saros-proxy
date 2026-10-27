/**
 * models-catalog.test.ts — Unit tests for the bundled model catalog loader.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { loadModelsCatalog, resetModelsCatalogCache } from '../src/models-catalog.js';
import { logger } from '../src/logger.js';

describe('loadModelsCatalog', () => {
  let tmpDir: string;
  let warnSpy: MockInstance;

  beforeEach(() => {
    tmpDir = mkdtempSync(`${tmpdir()}${sep}models-catalog-test-`);
    resetModelsCatalogCache();
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    resetModelsCatalogCache();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort on Windows
    }
  });

  it('loads the bundled catalog from the package root by default', () => {
    const models = loadModelsCatalog();

    expect(Object.keys(models).length).toBeGreaterThan(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('parses an explicit catalog path', () => {
    const path = join(tmpDir, 'models.json');
    writeFileSync(path, JSON.stringify({ 'gpt-test': { id: 'gpt-test' } }), 'utf-8');

    expect(loadModelsCatalog(path)).toEqual({ 'gpt-test': { id: 'gpt-test' } });
  });

  it('caches the parsed catalog per path', () => {
    const path = join(tmpDir, 'cached.json');
    writeFileSync(path, JSON.stringify({ a: { id: 'a' } }), 'utf-8');

    const first = loadModelsCatalog(path);
    writeFileSync(path, JSON.stringify({ b: { id: 'b' } }), 'utf-8');

    expect(loadModelsCatalog(path)).toBe(first);
    expect(loadModelsCatalog(path)).toEqual({ a: { id: 'a' } });
  });

  it('re-reads the file after resetModelsCatalogCache()', () => {
    const path = join(tmpDir, 'reset.json');
    writeFileSync(path, JSON.stringify({ a: { id: 'a' } }), 'utf-8');
    loadModelsCatalog(path);

    writeFileSync(path, JSON.stringify({ b: { id: 'b' } }), 'utf-8');
    resetModelsCatalogCache();

    expect(loadModelsCatalog(path)).toEqual({ b: { id: 'b' } });
  });

  it('returns an empty catalog and warns once when the file is missing', () => {
    const path = join(tmpDir, 'missing', 'models.json');

    expect(loadModelsCatalog(path)).toEqual({});
    expect(loadModelsCatalog(path)).toEqual({});
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns an empty catalog and warns once on invalid JSON', () => {
    const path = join(tmpDir, 'broken.json');
    writeFileSync(path, '{ not json', 'utf-8');

    expect(loadModelsCatalog(path)).toEqual({});
    expect(loadModelsCatalog(path)).toEqual({});
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['array', '[{"id":"a"}]'],
    ['null', 'null'],
    ['scalar', '42'],
  ])('returns an empty catalog for non-object JSON (%s)', (_label, raw) => {
    const path = join(tmpDir, 'shape.json');
    writeFileSync(path, raw, 'utf-8');

    expect(loadModelsCatalog(path)).toEqual({});
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
