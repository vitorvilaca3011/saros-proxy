/**
 * Runs before every test file (vitest `setupFiles`).
 *
 * The saros config dir must point at a throwaway directory before any
 * `src/*` module is evaluated: suites that forward real requests book
 * model-stats / token-usage counters, and must never touch the user's real
 * config dir. One `mkdtempSync` directory per test file keeps suites
 * isolated from each other as well.
 *
 * Which env var selects that directory depends on the platform
 * (`getDefaultConfigPath` in src/config.ts): `XDG_CONFIG_HOME` on Linux and
 * macOS, `LOCALAPPDATA` on Windows. Both are set here so the isolation holds
 * everywhere; the unused one is harmless.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const configHome = mkdtempSync(join(tmpdir(), 'saros-vitest-'));
process.env.XDG_CONFIG_HOME = configHome;
if (process.platform === 'win32') {
  process.env.LOCALAPPDATA = configHome;
}

afterAll(() => {
  try {
    rmSync(configHome, { recursive: true, force: true });
  } catch {
    // Windows file-lock races — temp dirs are non-fatal.
  }
});
