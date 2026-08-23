/**
 * Global setup/teardown for vitest.
 * The teardown forces process exit after tests complete to prevent hanging on Windows.
 */

export function setup() {
  // No setup needed
}

export function teardown() {
  // Give processes 1 second to clean up, then force exit.
  // Propagate vitest's pending failure code: hardcoding 0 here overrides the
  // nonzero exit code vitest sets for failed suites, turning a red run green.
  setTimeout(() => {
    process.exit(process.exitCode ?? 0);
  }, 1000);
}
