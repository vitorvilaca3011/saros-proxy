/**
 * Runs before every test file (vitest `setupFiles`).
 *
 * The saros config dir must point at a throwaway directory before any
 * `src/*` module is evaluated: suites that forward real requests book
 * model-stats / token-usage counters, and must never touch the user's real
 * ~/.config/saros/. One `mkdtempSync` directory per test file keeps suites
 * isolated from each other as well.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const configHome = mkdtempSync(join(tmpdir(), 'saros-vitest-'));
process.env.XDG_CONFIG_HOME = configHome;

afterAll(() => {
  try {
    rmSync(configHome, { recursive: true, force: true });
  } catch {
    // Windows file-lock races — temp dirs are non-fatal.
  }
});
