import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
      },
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/cli/setup.ts',
        // Firefox cookie extraction requires a real Firefox profile + node:sqlite
        // to be meaningful. Mocking it would test the mocks, not the code.
        'src/firefox-cookies.ts',
      ],
    },
    // Exclude compiled output to avoid running tests twice
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Force forks pool for child process cleanup on Windows
    pool: 'forks',
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
