/**
 * port-owner.ts — Identify the process listening on a TCP port.
 *
 * Linux only: `ss -ltnpH` first (iproute2 ships on every mainstream distro),
 * `lsof -nP -iTCP ... -t` as the fallback. On any other platform, and when
 * neither tool reports a PID, this returns null.
 *
 * The null answer is deliberate, not a gap to fill with guesses: `update`
 * refuses to stop a listener it cannot identify, so parsing `netstat` or
 * `taskkill` output on Windows is out of scope. Adding a parser for one of
 * them must also teach `update` how to verify the process is gone.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** A listening process: PID plus the process facts needed to not guess. */
export interface PortOwner {
  pid: number;
  /** Full command line, or '' when /proc is unavailable (permissions, non-Linux). */
  command: string;
  /**
   * Field 22 of /proc/<pid>/stat (process start time, clock ticks since
   * boot), or '' when unreadable. Comparing it before a signal defeats PID
   * reuse between discovery and kill.
   */
  starttime: string;
}

/** `users:(("node",pid=4711,fd=22))` — the first PID ss reports for the socket. */
const SS_PID = /pid=(\d+)/;

/** Run a discovery tool; a missing tool or a timeout is simply "no answer". */
function execQuiet(command: string, args: readonly string[]): string {
  try {
    const output = execFileSync(command, [...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return typeof output === 'string' ? output : '';
  } catch {
    return '';
  }
}

/** /proc/<pid>/cmdline is NUL-separated; '' when unreadable. */
function readCommand(pid: number): string {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    return raw.split('\0').join(' ').trim();
  } catch {
    return '';
  }
}

/**
 * Field 22 (starttime) of /proc/<pid>/stat; '' when unreadable. The comm
 * field is parenthesised and may itself contain spaces or ')', so fields are
 * counted from the last ')' — field 3 (state) is the first token after it.
 */
function readStartTime(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '';
  } catch {
    return '';
  }
}

function pidFromSs(port: number): number | null {
  const match = SS_PID.exec(execQuiet('ss', ['-ltnpH', `sport = :${port}`]));
  return match === null ? null : Number(match[1]);
}

function pidFromLsof(port: number): number | null {
  const output = execQuiet('lsof', [
    '-nP',
    `-iTCP:${port}`,
    '-sTCP:LISTEN',
    '-t',
  ]);
  for (const line of output.split('\n')) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/**
 * The process listening on `port`, or null when it cannot be determined.
 * `platform` is a parameter so tests can pin the documented Linux-only scope.
 */
export function findPortOwner(
  port: number,
  platform: NodeJS.Platform = process.platform,
): PortOwner | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (platform !== 'linux') return null;
  const pid = pidFromSs(port) ?? pidFromLsof(port);
  return pid === null
    ? null
    : { pid, command: readCommand(pid), starttime: readStartTime(pid) };
}
