/**
 * test-env-isolation.test.ts — no test may resolve a path inside the
 * developer's real home.
 *
 * `setup-env.ts` (vitest `setupFiles`, run once per test file) points
 * XDG_CONFIG_HOME, HOME and USERPROFILE at one throwaway directory. The daemon
 * suite mocks `homedir()` to a per-test temp ref, so it cannot prove the
 * process-level protection; this file imports `node:os` WITHOUT mocks. The
 * account's real home comes from `userInfo().homedir`, which ignores $HOME —
 * that is the value a test must never see (#104 killed a live daemon that way).
 */
import { describe, it, expect } from 'vitest';
import { homedir, userInfo } from 'node:os';

describe('test environment isolation', () => {
  it('resolves homedir() inside the per-file temp dir, not the real home', () => {
    const home = homedir();

    expect(home).toBe(process.env.HOME);
    expect(home).toBe(process.env.USERPROFILE);
    expect(home).toBe(process.env.XDG_CONFIG_HOME);
    expect(home).toContain('saros-vitest-');
    expect(home).not.toBe(userInfo().homedir);
  });

  it('does not inherit a legacy PID opt-in from the operator shell', () => {
    expect(process.env.SAROS_ALLOW_LEGACY_PID).toBeUndefined();
  });

  it('publishes the real home for the daemon PID-path guard', () => {
    // src/cli/daemon.ts refuses any PID file inside a real installation's
    // state dir while under test — the structural half of this isolation.
    // Deleting this publish would silently disable that guard.
    expect((globalThis as Record<string, unknown>).__SAROS_REAL_HOME__).toBe(userInfo().homedir);
  });
});
