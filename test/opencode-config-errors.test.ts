/**
 * opencode-config-errors.test.ts — Error path tests for opencode-config.ts.
 *
 * Uses vi.mock('node:fs') to simulate filesystem failures that are hard
 * to trigger with real operations (e.g., read-after-write corruption,
 * writeFileSync throwing on permission denied).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import * as fs from 'node:fs';

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  return {
    ...real,
    writeFileSync: vi.fn(real.writeFileSync),
    readFileSync: vi.fn(real.readFileSync),
  };
});

// Imports MUST come after vi.mock
const { updateOpencodeConfig } = await import('../src/cli/opencode-config.js');
const mockedFs = vi.mocked(fs);

describe('opencode-config error paths', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(`${tmpdir()}${sep}opencode-config-err-`);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    vi.clearAllMocks();
  });

  it('returns error when writeFileSync throws (e.g., EACCES)', () => {
    const configPath = join(tmpDir, 'opencode.json');

    mockedFs.writeFileSync.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied, open');
    });

    const result = updateOpencodeConfig(3000, { configPath });

    expect(result.success).toBe(false);
    expect(result.path).toBe(configPath);
    expect(result.error).toContain('EACCES');
  });

  it('returns error when writeFileSync throws a non-Error value', () => {
    const configPath = join(tmpDir, 'opencode.json');

    mockedFs.writeFileSync.mockImplementationOnce(() => {
      // Simulate a non-Error throw (e.g., a string)
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'disk full';
    });

    const result = updateOpencodeConfig(3000, { configPath });

    expect(result.success).toBe(false);
    expect(result.path).toBe(configPath);
    expect(result.error).toBe('disk full');
  });

  it('restores from backup and returns error when verify read fails', () => {
    const configPath = join(tmpDir, 'opencode.json');

    // Pre-create a valid existing config so a backup can be made
    const existing = JSON.stringify({ provider: { existing: {} } }, null, 2);
    fs.writeFileSync(configPath, existing, 'utf-8');

    // First read (initial load) returns the valid existing content.
    // Second read (the post-write verify) throws EIO.
    // Using two queued mocks distinguishes the two reads without
    // self-referential recursion into the mock itself.
    mockedFs.readFileSync
      .mockReturnValueOnce(existing)
      .mockImplementationOnce(() => {
        throw new Error('EIO: I/O error');
      });

    const result = updateOpencodeConfig(3000, { configPath });

    expect(result.success).toBe(false);
    // The inner catch intentionally returns a user-friendly message
    // ("restored from backup") rather than the underlying EIO error.
    expect(result.error).toContain('restored from backup');
    // Original file should be restored from backup
    const restored = readFileSync(configPath, 'utf-8');
    expect(JSON.parse(restored)).toEqual({ provider: { existing: {} } });
  });

  it('restores from backup and returns error when verify parse fails', () => {
    const configPath = join(tmpDir, 'opencode.json');

    const existing = JSON.stringify({ provider: { existing: {} } }, null, 2);
    fs.writeFileSync(configPath, existing, 'utf-8');

    // First read (initial load) returns the valid existing content.
    // Second read (the post-write verify) returns invalid JSON, which
    // causes JSON.parse(verifyRaw) to throw, triggering the inner catch
    // that restores from backup.
    mockedFs.readFileSync
      .mockReturnValueOnce(existing)
      .mockReturnValueOnce('this is not valid json {');

    const result = updateOpencodeConfig(3000, { configPath });

    expect(result.success).toBe(false);
    expect(result.error).toContain('restored from backup');
    // Original file should be restored from backup
    const restored = readFileSync(configPath, 'utf-8');
    expect(JSON.parse(restored)).toEqual({ provider: { existing: {} } });
  });

  it('returns error when initial read of existing file fails', () => {
    const configPath = join(tmpDir, 'opencode.json');

    // Pre-create the file
    fs.writeFileSync(configPath, '{}', 'utf-8');

    // Make the first read fail
    mockedFs.readFileSync.mockImplementationOnce(() => {
      throw new Error('EACCES: cannot read file');
    });

    const result = updateOpencodeConfig(3000, { configPath });

    expect(result.success).toBe(false);
    expect(result.error).toContain('EACCES');
  });

  it('returns clear error message when existing file contains invalid JSON', () => {
    const configPath = join(tmpDir, 'opencode.json');

    // Pre-create an existing file with invalid JSON
    fs.writeFileSync(configPath, 'not valid json {', 'utf-8');

    const result = updateOpencodeConfig(3000, { configPath });

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid JSON');
  });
});
