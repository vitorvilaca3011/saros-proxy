/**
 * Global setup/teardown for vitest.
 * The teardown forces process exit after tests complete to prevent hanging on Windows.
 */

export function setup() {
  // No setup needed
}

export function teardown() {
  // Windows-only hang mitigation: tinypool fork workers used to keep stdio
  // pipes open, hanging the bash tool. vmThreads removed the root cause, so
  // on POSIX we let vitest exit naturally — the old unconditional
  // process.exit(0/exitCode) after 1s raced the v8 coverage serialization
  // and intermittently reported partial coverage on CI (config.ts/model-
  // stats.ts losing whole workers' data).
  if (process.platform !== 'win32') return;

  // Give processes time to clean up, then force exit. Propagate vitest's
  // pending failure code: hardcoding 0 here turns a red run green.
  setTimeout(() => {
    process.exit(process.exitCode ?? 0);
  }, 5_000);
}
