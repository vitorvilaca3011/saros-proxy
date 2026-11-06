/**
 * models-catalog.test.ts — Unit tests for the bundled model catalog loader.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadModelsCatalog,
  mergeMissingModels,
  parseCatalogObject,
  resetModelsCatalogCache,
  serializeCatalogObject,
} from '../src/models-catalog.js';
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

  it('loads the bundled catalog from assets/models.json by default', () => {
    const models = loadModelsCatalog();
    const keys = Object.keys(models);

    expect(keys.length).toBeGreaterThan(0);
    expect(warnSpy).not.toHaveBeenCalled();

    for (const key of keys) {
      const entry = models[key] as Record<string, unknown>;
      const limit = entry.limit as Record<string, unknown>;
      expect(entry.id).toBe(key);
      expect(typeof limit?.context).toBe('number');
      expect(typeof limit?.output).toBe('number');
      expect(entry.modalities).toBeTypeOf('object');
    }

    const ids = keys.map((key) => (models[key] as Record<string, unknown>).id);
    expect(new Set(ids).size).toBe(ids.length);
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

describe('parseCatalogObject', () => {
  it('parses a JSON object', () => {
    expect(parseCatalogObject('{"a":{"id":"a"}}')).toEqual({ a: { id: 'a' } });
  });

  it.each([
    ['invalid JSON', '{ not json', /JSON/],
    ['an array payload', '[1]', /not a JSON object/],
    ['a null payload', 'null', /not a JSON object/],
  ])('rejects %s', (_label, raw, message) => {
    expect(() => parseCatalogObject(raw)).toThrow(message);
  });
});

describe('serializeCatalogObject', () => {
  it('writes 2-space JSON with a trailing newline', () => {
    expect(serializeCatalogObject({ a: { id: 'a' } })).toBe(
      '{\n  "a": {\n    "id": "a"\n  }\n}\n',
    );
  });
});

describe('mergeMissingModels', () => {
  it('adds only the bundle keys the user file lacks', () => {
    const existing = { a: { id: 'a' }, b: { id: 'b' } };
    const bundle = { a: { id: 'a', name: 'Bundle A' }, b: { id: 'b' }, c: { id: 'c' } };

    expect(mergeMissingModels(existing, bundle)).toEqual({
      models: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } },
      added: ['c'],
    });
  });

  it('never overwrites a customized value', () => {
    const existing = { a: { id: 'a', name: 'My A', cost: { input: 0 } } };
    const bundle = { a: { id: 'a', name: 'Bundle A', cost: { input: 9, output: 1 } } };

    expect(mergeMissingModels(existing, bundle)).toEqual({ models: existing, added: [] });
  });

  it('reports nothing to add when the file already covers the bundle', () => {
    const existing = { a: { id: 'a' } };

    expect(mergeMissingModels(existing, { a: { id: 'a' } })).toEqual({
      models: existing,
      added: [],
    });
  });
});
