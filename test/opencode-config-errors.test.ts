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

// Hermetic homedir: getModelsJsonPath() must resolve inside the per-test temp
// dir, otherwise a real ~/.config/saros/models.json consumes queued
// readFileSync mocks and breaks the error-path scenarios below.
const mockHomeRef = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockHomeRef.current };
});

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  return {
    ...real,
    writeFileSync: vi.fn(real.writeFileSync),
    readFileSync: vi.fn(real.readFileSync),
    copyFileSync: vi.fn(real.copyFileSync),
  };
});

// Imports MUST come after vi.mock
const { updateOpencodeConfig, syncModelsToOpencodeConfig } = await import(
  '../src/cli/opencode-config.js'
);
const mockedFs = vi.mocked(fs);

describe('opencode-config error paths', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(`${tmpdir()}${sep}opencode-config-err-`);
    mockHomeRef.current = tmpDir;
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    vi.clearAllMocks();
    // Clear mockImplementationOnce/mockReturnValueOnce queues that
    // clearAllMocks leaves behind, then re-spy on real implementations
    const realFs = await vi.importActual<typeof fs>('node:fs');
    mockedFs.readFileSync.mockReset();
    mockedFs.readFileSync.mockImplementation(realFs.readFileSync);
    mockedFs.writeFileSync.mockReset();
    mockedFs.writeFileSync.mockImplementation(realFs.writeFileSync);
    mockedFs.copyFileSync.mockReset();
    mockedFs.copyFileSync.mockImplementation(realFs.copyFileSync);
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
      .mockReturnValueOnce(existing)           // readFileSync(configPath) — initial load
      .mockImplementationOnce(() => {          // readFileSync(configPath) — verify
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
      .mockReturnValueOnce(existing)           // readFileSync(configPath) — initial load
      .mockReturnValueOnce('this is not valid json {'); // readFileSync(configPath) — verify

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

  it('returns string error when initial read throws a non-Error value', () => {
    const configPath = join(tmpDir, 'opencode.json');

    // Pre-create the file
    fs.writeFileSync(configPath, '{}', 'utf-8');

    // Simulate a non-Error throw (e.g., a string)
    mockedFs.readFileSync.mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'read failed';
    });

    const result = updateOpencodeConfig(3000, { configPath });

    expect(result.success).toBe(false);
    expect(result.error).toBe('read failed');
  });

  it('returns clear error message when existing file contains invalid JSON', () => {
    const configPath = join(tmpDir, 'opencode.json');

    // Pre-create an existing file with invalid JSON
    fs.writeFileSync(configPath, 'not valid json {', 'utf-8');

    const result = updateOpencodeConfig(3000, { configPath });

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid JSON');
  });

  it('returns error on verify failure when no backup exists', () => {
    const configPath = join(tmpDir, 'fresh.json');

    // Config does not exist initially → created=true, so no backup is made.
    // The post-write verify read then fails, and the catch must return the
    // error without trying to restore (there is no backup to restore).
    mockedFs.readFileSync.mockImplementationOnce(() => {
      throw new Error('EIO: verify read failed');
    });

    const result = updateOpencodeConfig(3000, { configPath });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to write valid JSON');
    expect(existsSync(`${configPath}.backup`)).toBe(false);
  });

  it('sync returns error when writeFileSync throws (e.g., EACCES)', () => {
    const configPath = join(tmpDir, 'opencode.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ provider: { 'saros-proxy': { options: {} } } }),
      'utf-8',
    );

    mockedFs.writeFileSync.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied, open');
    });

    const result = syncModelsToOpencodeConfig({ configPath });

    expect(result.success).toBe(false);
    expect(result.path).toBe(configPath);
    expect(result.error).toContain('EACCES');
  });

  it('sync returns string error when writeFileSync throws a non-Error value', () => {
    const configPath = join(tmpDir, 'opencode.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ provider: { 'saros-proxy': {} } }),
      'utf-8',
    );

    // Simulate a non-Error throw (e.g., a string)
    mockedFs.writeFileSync.mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'disk full';
    });

    const result = syncModelsToOpencodeConfig({ configPath });

    expect(result.success).toBe(false);
    expect(result.path).toBe(configPath);
    expect(result.error).toBe('disk full');
  });

  it('sync returns error on verify failure when no backup can be restored', () => {
    const configPath = join(tmpDir, 'opencode.json');
    const existing = JSON.stringify({ provider: { 'saros-proxy': {} } }, null, 2);
    fs.writeFileSync(configPath, existing, 'utf-8');

    // Prevent the backup from being created so the restore branch has
    // nothing to copy back (copyFileSync throws ENOENT on a missing source).
    mockedFs.copyFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    // First read (initial load) returns the valid existing content.
    // Second read (the post-write verify) throws EIO.
    mockedFs.readFileSync
      .mockReturnValueOnce(existing)
      .mockImplementationOnce(() => {
        throw new Error('EIO: I/O error');
      });

    const result = syncModelsToOpencodeConfig({ configPath });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No backup available to restore');
    // No backup existed, so nothing was restored — the synced content stays
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).provider['saros-proxy'].models).toBeDefined();
  });

  it('sync returns error when reading config fails', () => {
    const configPath = join(tmpDir, 'opencode.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ provider: { 'saros-proxy': {} } }),
      'utf-8',
    );

    mockedFs.readFileSync.mockImplementationOnce(() => {
      throw new Error('EACCES: cannot read file');
    });

    const result = syncModelsToOpencodeConfig({ configPath });

    expect(result.success).toBe(false);
    expect(result.error).toContain('EACCES');
  });

  it('sync restores from backup and returns error when verify read fails', () => {
    const configPath = join(tmpDir, 'opencode.json');
    const existing = JSON.stringify(
      { provider: { 'saros-proxy': { options: {} } } },
      null,
      2,
    );
    fs.writeFileSync(configPath, existing, 'utf-8');

    // First read (initial load) returns the valid existing content.
    // Second read (the post-write verify) throws EIO.
    mockedFs.readFileSync
      .mockReturnValueOnce(existing)
      .mockImplementationOnce(() => {
        throw new Error('EIO: I/O error');
      });

    const result = syncModelsToOpencodeConfig({ configPath });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Restored from backup');
    // Original file should be restored from backup
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual(JSON.parse(existing));
  });

  it('sync restores from backup and returns error when verify parse fails', () => {
    const configPath = join(tmpDir, 'opencode.json');
    const existing = JSON.stringify({ provider: { 'saros-proxy': {} } }, null, 2);
    fs.writeFileSync(configPath, existing, 'utf-8');

    // First read (initial load) returns the valid existing content.
    // Second read (the post-write verify) returns invalid JSON.
    mockedFs.readFileSync
      .mockReturnValueOnce(existing)
      .mockReturnValueOnce('this is not valid json {');

    const result = syncModelsToOpencodeConfig({ configPath });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Restored from backup');
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual(JSON.parse(existing));
  });
});
