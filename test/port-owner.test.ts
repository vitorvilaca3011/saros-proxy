/**
 * port-owner.test.ts — `findPortOwner` parsing with the OS tools mocked.
 *
 * `ss`, `lsof` and /proc are never touched: the shapes below are the real
 * outputs of iproute2 6.x (`ss -ltnpH`) and lsof 4.95 (`lsof -t`) on Linux.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as NodeFs from 'node:fs';

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// Partial mock: only the /proc read is controlled, everything else stays real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  };
});

import { findPortOwner } from '../src/cli/port-owner.js';

/** A single ss listener line for an orphan proxy on 3000. */
const SS_ORPHAN =
  'LISTEN 0      511        127.0.0.1:3000      0.0.0:*    users:(("node",pid=4711,fd=22))\n';

/** /proc/4711/stat, cut after field 22 (starttime = 987654). */
const STAT_ORPHAN =
  '4711 (node) S 1 4711 4711 0 -1 4194560 1000 0 0 0 12 3 0 0 20 0 1 0 987654 123456789 4567';

beforeEach(() => {
  mockExecFileSync.mockReset();
  mockReadFileSync.mockReset();
});

describe('findPortOwner', () => {
  it('reads the PID from ss, and the command line and start time from /proc', () => {
    mockExecFileSync.mockReturnValue(SS_ORPHAN);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/proc/4711/cmdline') return 'node\0/srv/orphan/dist/index.js\0serve\0';
      if (path === '/proc/4711/stat') return STAT_ORPHAN;
      throw new Error('ENOENT');
    });

    expect(findPortOwner(3000)).toEqual({
      pid: 4711,
      command: 'node /srv/orphan/dist/index.js serve',
      starttime: '987654',
    });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'ss',
      ['-ltnpH', 'sport = :3000'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
    expect(mockReadFileSync).toHaveBeenCalledWith('/proc/4711/cmdline', 'utf-8');
    expect(mockReadFileSync).toHaveBeenCalledWith('/proc/4711/stat', 'utf-8');
  });

  it('counts stat fields from the last ")" so a comm with spaces still parses', () => {
    mockExecFileSync.mockReturnValue(SS_ORPHAN);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === '/proc/4711/cmdline') return 'node\0';
      return '4711 (node (odd) name) S 1 4711 4711 0 -1 4194560 1000 0 0 0 12 3 0 0 20 0 1 0 424242 123456789 4567';
    });

    expect(findPortOwner(3000)?.starttime).toBe('424242');
  });

  it('falls back to lsof when ss reports no PID, and tolerates an unreadable /proc', () => {
    mockExecFileSync.mockImplementation((command: string) =>
      command === 'ss' ? 'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*\n' : '\n4712\n',
    );
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    expect(findPortOwner(3000)).toEqual({ pid: 4712, command: '', starttime: '' });
    expect(mockExecFileSync).toHaveBeenLastCalledWith(
      'lsof',
      ['-nP', '-iTCP:3000', '-sTCP:LISTEN', '-t'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('returns null when neither tool reports a listener', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    expect(findPortOwner(3000)).toBeNull();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('treats a non-string tool output as no answer', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(SS_ORPHAN));
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    expect(findPortOwner(3000)).toBeNull();
  });

  it('leaves the start time empty when /proc/<pid>/stat is truncated', () => {
    mockExecFileSync.mockReturnValue(SS_ORPHAN);
    mockReadFileSync.mockImplementation((path: string) =>
      path.endsWith('cmdline') ? 'node\0' : '4711 (node) S 1',
    );

    expect(findPortOwner(3000)).toMatchObject({ pid: 4711, starttime: '' });
  });

  it('rejects an impossible port before running a tool', () => {
    expect(findPortOwner(0)).toBeNull();
    expect(findPortOwner(70_000)).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('does not guess on platforms without a parser (documented limitation)', () => {
    expect(findPortOwner(3000, 'darwin')).toBeNull();
    expect(findPortOwner(3000, 'win32')).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
