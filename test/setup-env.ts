/**
 * Runs before every test file (vitest `setupFiles`).
 *
 * The saros config dir must point at a throwaway directory before any
 * `src/*` module is evaluated: suites that forward real requests book
 * model-stats / token-usage counters, and must never touch the user's real
 * config dir. One `mkdtempSync` directory per test file keeps suites
 * isolated from each other as well.
 *
 * Which env var selects that directory depends on the platform
 * (`getDefaultConfigPath` in src/config.ts): `XDG_CONFIG_HOME` on Linux and
 * macOS, `LOCALAPPDATA` on Windows. Both are set here so the isolation holds
 * everywhere; the unused one is harmless.
 *
 * HOME/USERPROFILE point at the SAME directory. That is the security boundary,
 * not a nicety: paths built from `homedir()` (the pre-0.11 pid file, models
 * files, harness configs) resolve inside the throwaway dir instead of the
 * developer's real home, so no test can act on a live installation — a test
 * that read `~/.config/saros/daemon.pid` once killed the running daemon.
 *
 * `homedir()` itself is mocked too. Under the `vmThreads` pool, tests run in
 * worker threads and `os.homedir()` reads the process-level C environment, not
 * the worker's `process.env` copy — assigning HOME above is invisible to it.
 * The mock closes over a hoisted ref because the factory can run before this
 * module's body (the setup file imports from that same module).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as Os from 'node:os';
import { afterAll, vi } from 'vitest';

const homeRef = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>();
  return { ...actual, homedir: () => homeRef.home || actual.homedir() };
});

const configHome = mkdtempSync(join(Os.tmpdir(), 'saros-vitest-'));
homeRef.home = configHome;
process.env.XDG_CONFIG_HOME = configHome;
process.env.HOME = configHome;
process.env.USERPROFILE = configHome;
if (process.platform === 'win32') {
  process.env.LOCALAPPDATA = configHome;
}
// Opt-in in the operator's shell must not opt a test run in: tests never
// consult the legacy pid path, and a stray exported flag must not change that.
delete process.env.SAROS_ALLOW_LEGACY_PID;

// The account's real home, read from the passwd record (`userInfo` ignores
// $HOME, so no env var and no `node:os` mock above can change it). Published
// for the code-level guard in src/cli/daemon.ts: while under test, a PID file
// in the real installation's state dir (`~/.config/saros`,
// `~/AppData/Local/saros`) is never read or deleted, no matter which suite
// re-registered `node:os` or dropped XDG_CONFIG_HOME. That is the incident
// from #104 — a test with a temp config dir and the real HOME killed the live
// daemon — made structurally impossible instead of merely unlikely.
(globalThis as Record<string, unknown>).__SAROS_REAL_HOME__ = Os.userInfo().homedir;

afterAll(() => {
  // homeRef.home keeps pointing at the temp dir (now gone): teardown work that
  // resolves homedir() must fail on a missing temp path, never reach the real
  // home by resetting it to ''.
  try {
    rmSync(configHome, { recursive: true, force: true });
  } catch {
    // Windows file-lock races — temp dirs are non-fatal.
  }
});
