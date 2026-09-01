import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 95,
        branches: 95,
        functions: 95,
        statements: 95,
      },
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/cli/setup.ts',
        // Firefox cookie extraction requires a real Firefox profile + node:sqlite
        // to be meaningful. Mocking it would test the mocks, not the code.
        'src/firefox-cookies.ts',
        // Daemon lifecycle (spawn/stop/status) owns process.exit() and
        // process.kill() paths inside timers; unit-testing it safely requires
        // exit/kill mocking that would test the mocks, not the daemon.
        'src/cli/daemon.ts',
        // Type-only module (interfaces/type aliases erase at runtime); it has
        // zero executable statements, so it can never be covered.
        'src/providers/types.ts',
      ],
    },
    // Exclude compiled output to avoid running tests twice, plus the heavy
    // process-spawning suites (run explicitly via npm scripts / CI jobs).
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'test/install.e2e.test.ts',
      'test/model-e2e.test.ts',
      'test/live-model.e2e.test.ts',
    ],
    // Use vmThreads pool: the default 'forks' pool causes the test process to
    // hang on Windows (tinypool fork workers don't shut down cleanly, keeping
    // stdio pipes open). vmThreads runs tests in a VM context backed by
    // worker_threads — no OS-level process boundary, so there's nothing to
    // leak. Verified: 582/582 tests pass in ~7s with no hang from the bash
    // tool. Trade-off: no process.chdir() in tests (not used in this project).
    pool: 'vmThreads',
    // Give workers enough time to clean up (especially on Windows)
    teardownTimeout: 15_000,
    // Don't watch for file changes
    watch: false,
    // Global teardown to force exit after tests (prevents hanging on Windows)
    globalSetup: './test/global-teardown.ts',
    // Timeout for individual tests
    testTimeout: 60_000,
    // Timeout for beforeAll/afterAll hooks
    hookTimeout: 15_000,
  },
});
