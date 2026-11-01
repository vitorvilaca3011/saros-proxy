/**
 * secrets-boot-spawn.test.ts — Spawns the real `serve` entry point to prove a
 * failed boot exits 1 without putting the key, the passphrase or the envelope
 * on stdout/stderr. Message-level assertions are covered elsewhere; this file
 * covers the process boundary.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { encryptValue } from '../src/secrets/envelope.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PASSPHRASE = 'spawn-test-passphrase-fixture';
const WRONG_PASSPHRASE = 'wrong-spawn-passphrase-fixture';
const KEY = 'sk-spawn-test-key-that-is-long-enough-0001';
const LABEL = 'spawn-key';

let workDir: string;
let configPath: string;
let emptyPath: string;
let baseEnv: NodeJS.ProcessEnv;

function runServe(extraEnv: NodeJS.ProcessEnv): {
  status: number | null;
  output: string;
} {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(REPO_ROOT, 'src', 'index.ts'), 'serve', '--config', configPath],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...baseEnv, ...extraEnv },
      windowsHide: true,
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function expectNoSecrets(output: string): void {
  expect(output).not.toContain(KEY);
  expect(output).not.toContain(PASSPHRASE);
  expect(output).not.toContain(WRONG_PASSPHRASE);
  expect(output).not.toContain('enc:v1:');
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'saros-boot-spawn-'));
  emptyPath = join(workDir, 'empty-path');
  mkdirSync(emptyPath);
  configPath = join(workDir, 'config.yaml');
  writeFileSync(
    configPath,
    `keys:\n  - label: ${LABEL}\n    key: ${encryptValue(KEY, PASSPHRASE, LABEL)}\n`,
    'utf-8',
  );

  baseEnv = { ...process.env };
  baseEnv.PATH = emptyPath;
  baseEnv.HOME = workDir;
  baseEnv.XDG_CONFIG_HOME = join(workDir, 'xdg');
  baseEnv.SAROS_DAEMON = '1';
  baseEnv.LOG_LEVEL = 'info';
  delete baseEnv.SAROS_PASSPHRASE;
  delete baseEnv.OPENCODE_GO_KEYS;
  delete baseEnv.OPENCODE_GO_ENCRYPTION_KEY;
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('serve boot failure (spawned)', () => {
  it('exits 1 without secrets when no passphrase source exists', () => {
    const { status, output } = runServe({});
    expect(status).toBe(1);
    expect(output).toContain('Encrypted API keys found, but no passphrase source is available.');
    expect(output).toContain('SAROS_PASSPHRASE');
    expect(output).toContain('saros-proxy secret set');
    expectNoSecrets(output);
  }, 60_000);

  it('exits 1 without secrets on a wrong passphrase', () => {
    const { status, output } = runServe({ SAROS_PASSPHRASE: WRONG_PASSPHRASE });
    expect(status).toBe(1);
    expect(output).toContain(`Cannot decrypt API key "${LABEL}"`);
    expect(output).toContain('Wrong passphrase or corrupt ciphertext');
    expectNoSecrets(output);
    expect(output).not.toContain(WRONG_PASSPHRASE);
  }, 60_000);
});
