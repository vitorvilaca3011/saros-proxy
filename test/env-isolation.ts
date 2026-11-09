/**
 * env-isolation.ts — restore `process.env` without replacing the object.
 *
 * The object identity is load-bearing, not a detail. Vitest's `vi.stubEnv`
 * writes through a proxy created once per worker around the `process.env`
 * object that existed when the worker started. Assigning a new object
 * (`process.env = { ...snapshot }`) orphans that proxy, and the proxy has no
 * `deleteProperty` trap: `vi.unstubAllEnvs()` therefore deletes a
 * previously-undefined variable from the orphaned object while the live
 * `process.env` keeps the stubbed value. The stub then leaks into the next
 * test and into every later file scheduled on the same worker — this is how
 * `SAROS_ALLOW_LEGACY_PID=1` from one `test/daemon.test.ts` case reached the
 * next two cases under the `vmThreads` pool.
 *
 * Restoring by assignment has the same defect, so suites reconcile the live
 * object in place: keys absent from the snapshot are deleted, snapshot values
 * are written back. `process.env` is never reassigned.
 */

export type EnvSnapshot = Record<string, string | undefined>;

/** Copy the current environment. Only strings are present in practice. */
export function snapshotEnv(): EnvSnapshot {
  return { ...process.env };
}

/**
 * Make the live `process.env` match `snapshot` exactly, in place.
 *
 * Pure reconciliation: the object reference stays the one vitest and the
 * worker share, so `vi.stubEnv`/`vi.unstubAllEnvs` keep addressing the object
 * the code under test actually reads.
 */
export function restoreEnv(snapshot: EnvSnapshot): void {
  const live = process.env;
  for (const key of Object.keys(live)) {
    if (!Object.hasOwn(snapshot, key)) delete live[key];
  }
  for (const key of Object.keys(snapshot)) {
    const value = snapshot[key];
    if (value === undefined) {
      delete live[key];
    } else if (live[key] !== value) {
      live[key] = value;
    }
  }
}
