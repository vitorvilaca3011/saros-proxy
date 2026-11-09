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
import { describe, it, expect, vi } from 'vitest';
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

/**
 * The worker-level `process.env` is shared by every file scheduled on the same
 * `vmThreads` worker, so a test that leaves a variable behind changes the
 * outcome of the next test — exactly how `SAROS_ALLOW_LEGACY_PID=1` from one
 * daemon case reached the next two. `setup-env.ts` snapshots the env before
 * each test and reconciles it afterwards; these cases are the contract.
 */
describe('per-test environment restoration', () => {
  const DIRECT = 'SAROS_TEST_ENV_LEAK_PROBE';
  const STUBBED = 'SAROS_TEST_STUB_LEAK_PROBE';

  it('starts with neither probe variable set', () => {
    expect(process.env[DIRECT]).toBeUndefined();
    expect(process.env[STUBBED]).toBeUndefined();
  });

  it('keeps a direct assignment inside its own test', () => {
    process.env[DIRECT] = 'direct';
    expect(process.env[DIRECT]).toBe('direct');
  });

  it('keeps a vi.stubEnv value inside its own test', () => {
    vi.stubEnv(STUBBED, '1');
    expect(process.env[STUBBED]).toBe('1');
  });

  it('sees neither value in the next test', () => {
    expect(process.env[DIRECT]).toBeUndefined();
    expect(process.env[STUBBED]).toBeUndefined();
  });
});

/**
 * Replacing the `process.env` object is the root cause of the leak: vitest's
 * stub proxy keeps addressing the worker's original object, so un-stubbing a
 * previously-undefined variable deletes it from the wrong object. The setup
 * file re-binds a replaced env before each test; this is that contract.
 */
describe('per-test environment object identity', () => {
  const workerEnv = process.env;

  it('starts on the worker env object', () => {
    expect(process.env).toBe(workerEnv);
  });

  it('replaces the object inside its own test', () => {
    process.env = { ...workerEnv };
    expect(process.env).not.toBe(workerEnv);
  });

  it('is back on the worker env object in the next test', () => {
    expect(process.env).toBe(workerEnv);
  });
});
