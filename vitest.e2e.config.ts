import { defineConfig } from 'vitest/config';

/**
 * Config for the heavy process-spawning E2E suites (install smoke + full
 * binary model E2E). Kept separate from vitest.config.ts so the fast unit
 * suite stays the default `npx vitest run`, while these files remain runnable
 * explicitly via npm scripts and CI jobs.
 */
export default defineConfig({
  test: {
    pool: 'vmThreads',
    teardownTimeout: 15_000,
    watch: false,
    globalSetup: './test/global-teardown.ts',
    testTimeout: 180_000,
    hookTimeout: 60_000,
    include: [
      'test/install.e2e.test.ts',
      'test/model-e2e.test.ts',
      'test/live-model.e2e.test.ts',
    ],
  },
});
