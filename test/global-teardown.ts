/**
 * Global setup/teardown for vitest.
 * The teardown forces process exit after tests complete to prevent hanging on Windows.
 */

export function setup() {
  // No setup needed
}

export function teardown() {
  // Give processes 1 second to clean up, then force exit
  setTimeout(() => {
    process.exit(0);
  }, 1000);
}
