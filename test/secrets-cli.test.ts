/**
 * secrets-cli.test.ts — `secret set|status` and `keys encrypt`.
 * Fixtures only: no assertion message or console capture embeds a real secret.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import {
  MIN_PASSPHRASE_LENGTH,
  runSecretCommand,
  runSecretSet,
  runSecretStatus,
} from '../src/cli/secret.js';
import { runKeysCommand, encryptConfigFile } from '../src/cli/keys.js';
import { decryptValue, encryptValue, isEnvelope } from '../src/secrets/envelope.js';
import { loadConfig } from '../src/config.js';
import { createProxyApp } from '../src/proxy.js';
import type { CommandRunner } from '../src/secrets/source.js';

const PASSPHRASE = 'cli-test-passphrase-fixture';
const KEY = 'sk-cli-test-key-that-is-long-enough-0001';
const SECOND_KEY = 'user_cli-test-second-key-long-enough-01';

function tty(): PassThrough {
  const input = new PassThrough();
  Object.defineProperty(input, 'isTTY', { value: true, configurable: true });
  return input;
}

describe('secret command', () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores a piped passphrase through the platform CLI without echoing it', async () => {
    const run = vi.fn<CommandRunner>(() => ({ ok: true, stdout: '' }));
    const code = await runSecretSet({
      input: Readable.from([`${PASSPHRASE}\n`]),
      platform: 'linux',
      username: 'tester',
      run,
    });
    expect(code).toBe(0);
    expect(run).toHaveBeenCalledWith(
      'secret-tool',
      ['store', '--label=saros-proxy passphrase', 'service', 'saros-proxy', 'account', 'tester'],
      { input: PASSPHRASE },
    );
    expect(logs.join('\n')).toContain('stored');
    expect(logs.join('\n')).not.toContain(PASSPHRASE);
    expect(errors.join('\n')).not.toContain('shorter than');
  });

  it('warns below the minimum length but still stores the passphrase', async () => {
    const run = vi.fn<CommandRunner>(() => ({ ok: true, stdout: '' }));
    const short = 'short';
    expect(short.length).toBeLessThan(MIN_PASSPHRASE_LENGTH);
    const code = await runSecretSet({
      input: Readable.from([`${short}\n`]),
      platform: 'linux',
      run,
    });
    expect(code).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(errors.join('\n')).toContain(`shorter than ${MIN_PASSPHRASE_LENGTH} characters`);
    expect(logs.join('\n')).toContain('stored');
  });

  it('prompts twice on a TTY and refuses a mismatch', async () => {
    const run = vi.fn<CommandRunner>(() => ({ ok: true, stdout: '' }));
    const input = tty();
    const pending = runSecretSet({ input, output: new PassThrough(), platform: 'linux', run });
    input.write(`${PASSPHRASE}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    input.write(`${PASSPHRASE}\n`);
    expect(await pending).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);

    const mismatchInput = tty();
    const mismatch = runSecretSet({
      input: mismatchInput,
      output: new PassThrough(),
      platform: 'linux',
      run,
    });
    mismatchInput.write(`${PASSPHRASE}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    mismatchInput.write('different-passphrase-fixture\n');
    expect(await mismatch).toBe(1);
    expect(errors.join('\n')).toContain('do not match');
  });

  it('refuses empty input and a failing store', async () => {
    expect(
      await runSecretSet({ input: Readable.from([]), platform: 'linux' }),
    ).toBe(1);
    expect(errors.join('\n')).toContain('no passphrase on stdin');

    const code = await runSecretSet({
      input: Readable.from([`${PASSPHRASE}\n`]),
      platform: 'linux',
      run: () => ({ ok: false, stdout: '', reason: 'keyring locked' }),
    });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('keyring locked');
  });

  it('refuses an empty TTY prompt', async () => {
    const input = tty();
    const pending = runSecretSet({
      input,
      output: new PassThrough(),
      platform: 'linux',
      run: () => ({ ok: true, stdout: '' }),
    });
    input.write('\n');
    expect(await pending).toBe(1);
    expect(errors.join('\n')).toContain('no passphrase entered');
  });

  it('reports status without printing a value', async () => {
    const input = new PassThrough();
    const code = await runSecretStatus({
      input,
      env: {},
      platform: 'linux',
      configPath: '/tmp/does-not-exist.yaml',
      run: () => ({ ok: true, stdout: PASSPHRASE }),
    });
    expect(code).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Passphrase sources');
    expect(output).toContain('populated');
    expect(output).toContain('Effective source: store');
    expect(output).not.toContain(PASSPHRASE);

    const envCode = await runSecretStatus({
      input: new PassThrough(),
      env: { SAROS_PASSPHRASE: PASSPHRASE },
      platform: 'linux',
      configPath: '/tmp/does-not-exist.yaml',
      run: () => ({ ok: false, stdout: '', reason: 'not populated' }),
    });
    expect(envCode).toBe(0);
    expect(logs.join('\n')).toContain('Effective source: env');
  });

  it('reports no source and reads the config path from --config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'saros-secret-status-'));
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      `keys:\n  - label: sealed\n    key: ${encryptValue(KEY, PASSPHRASE, 'sealed')}\n`,
      'utf-8',
    );
    process.argv = ['node', 'saros-proxy', '--config', configPath];
    try {
      const code = await runSecretStatus({
        platform: 'linux',
        env: {},
        run: () => ({ ok: true, stdout: PASSPHRASE }),
      });
      expect(code).toBe(0);
      const output = logs.join('\n');
      expect(output).toContain('contains enc:v1 envelopes');
      expect(output).toContain('Effective source: store');
      expect(output).not.toContain(PASSPHRASE);
    } finally {
      process.argv = ['node', 'saros-proxy'];
      rmSync(dir, { recursive: true, force: true });
    }

    logs.length = 0;
    expect(
      await runSecretStatus({
        input: new PassThrough(),
        env: {},
        platform: 'linux',
        configPath: '/tmp/does-not-exist.yaml',
        run: () => ({ ok: false, stdout: '', reason: 'not populated' }),
      }),
    ).toBe(0);
    expect(logs.join('\n')).toContain('Effective source: none');
    expect(logs.join('\n')).toContain('not populated');

    logs.length = 0;
    expect(
      await runSecretStatus({
        input: tty(),
        env: {},
        platform: 'linux',
        configPath: '/tmp/does-not-exist.yaml',
        run: () => ({ ok: false, stdout: '', reason: 'not populated' }),
      }),
    ).toBe(0);
    expect(logs.join('\n')).toContain('available (foreground serve only)');
    expect(logs.join('\n')).toContain('Effective source: tty');
  });

  it('dispatches set/status and rejects unknown subcommands', async () => {
    expect(await runSecretCommand(['nope'], {})).toBe(1);
    expect(errors.join('\n')).toContain('Usage: saros-proxy secret');
    expect(await runSecretCommand(['set'], { input: Readable.from([]) })).toBe(1);
    expect(
      await runSecretCommand(['status'], {
        input: new PassThrough(),
        configPath: '/tmp/does-not-exist.yaml',
        platform: 'linux',
        run: () => ({ ok: false, stdout: '', reason: 'not populated' }),
      }),
    ).toBe(0);
  });

  it('falls back to process.stdin/stderr when streams are omitted', async () => {
    const originalStdin = process.stdin;
    Object.defineProperty(process, 'stdin', {
      value: Readable.from([`${PASSPHRASE}\n`]),
      configurable: true,
    });
    try {
      expect(
        await runSecretSet({
          platform: 'linux',
          run: () => ({ ok: true, stdout: '' }),
        }),
      ).toBe(0);
    } finally {
      Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    }
  });
});

describe('keys encrypt', () => {
  let tempDir: string;
  let configPath: string;
  let logs: string[];
  let errors: string[];

  const originalYaml = [
    '# keep this comment',
    'port: 3000',
    'keys:',
    `  - label: first`,
    `    key: ${KEY}`,
    `  - label: second`,
    `    key: ${SECOND_KEY}`,
    `    provider: commandcode`,
    '',
  ].join('\n');

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'saros-keys-cli-'));
    configPath = join(tempDir, 'config.yaml');
    writeFileSync(configPath, originalYaml, 'utf-8');
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('encrypts plaintext keys, keeps comments/providers and backs up once', async () => {
    const code = await encryptConfigFile({ configPath, passphrase: PASSPHRASE });
    expect(code).toBe(0);

    const backupPath = `${configPath}.backup`;
    expect(existsSync(backupPath)).toBe(true);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(backupPath, 'utf-8')).toBe(originalYaml);

    const updated = readFileSync(configPath, 'utf-8');
    expect(updated).toContain('# keep this comment');
    const parsed = parse(updated) as {
      keys: Array<{ label: string; key: string; provider?: string }>;
    };
    expect(parsed.keys).toHaveLength(2);
    expect(isEnvelope(parsed.keys[0].key)).toBe(true);
    expect(isEnvelope(parsed.keys[1].key)).toBe(true);
    expect(parsed.keys[0].provider).toBe('opencode-go');
    expect(parsed.keys[1].provider).toBe('commandcode');

    const first = decryptValue(parsed.keys[0].key, PASSPHRASE, 'first');
    const second = decryptValue(parsed.keys[1].key, PASSPHRASE, 'second');
    expect(first).toEqual({ ok: true, value: KEY });
    expect(second).toEqual({ ok: true, value: SECOND_KEY });

    const loaded = loadConfig(configPath, { passphrase: PASSPHRASE });
    expect(loaded.keys.map((entry) => entry.key)).toEqual([KEY, SECOND_KEY]);
    expect(loaded.keys.every((entry) => entry.encrypted)).toBe(true);
    expect(logs.join('\n')).toContain('PLAINTEXT — delete after the first successful boot');
  });

  it('writes no plaintext backup with --no-backup and says so', async () => {
    const code = await runKeysCommand(
      ['encrypt', '--config', configPath, '--no-backup'],
      { passphrase: PASSPHRASE },
    );
    expect(code).toBe(0);
    expect(existsSync(`${configPath}.backup`)).toBe(false);
    expect(logs.join('\n')).toContain('No backup written');
    expect(readFileSync(configPath, 'utf-8')).toContain('enc:v1:');
  });

  it.skipIf(process.platform === 'win32')(
    'encrypts the real target behind a symlinked config and keeps the link',
    async () => {
      const realPath = join(tempDir, 'dotfiles', 'config.yaml');
      mkdirSync(dirname(realPath), { recursive: true });
      writeFileSync(realPath, originalYaml, 'utf-8');
      const linkPath = join(tempDir, 'linked-config.yaml');
      symlinkSync(realPath, linkPath);

      expect(await encryptConfigFile({ configPath: linkPath, passphrase: PASSPHRASE })).toBe(0);

      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkPath)).toBe(realPath);
      const target = readFileSync(realPath, 'utf-8');
      expect(target).toContain('enc:v1:');
      expect(target).not.toContain(KEY);
      expect(target).not.toContain(SECOND_KEY);
      expect(readFileSync(linkPath, 'utf-8')).toBe(target);
      expect(readFileSync(`${realPath}.backup`, 'utf-8')).toBe(originalYaml);
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a backup failure without touching the config',
    async () => {
      const before = readFileSync(configPath, 'utf-8');
      chmodSync(tempDir, 0o500);
      try {
        expect(await encryptConfigFile({ configPath, passphrase: PASSPHRASE })).toBe(1);
        expect(errors.join('\n')).toContain('Could not rewrite');
        expect(readFileSync(configPath, 'utf-8')).toBe(before);
      } finally {
        chmodSync(tempDir, 0o700);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a backup path that is a symlink instead of writing through it',
    async () => {
      const victim = join(tempDir, 'victim.txt');
      symlinkSync(victim, `${configPath}.backup`);
      const before = readFileSync(configPath, 'utf-8');

      expect(await encryptConfigFile({ configPath, passphrase: PASSPHRASE })).toBe(1);
      expect(errors.join('\n')).toContain('not a regular file');
      expect(existsSync(victim)).toBe(false);
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
    },
  );

  it('is idempotent and preserves the original backup', async () => {
    expect(await encryptConfigFile({ configPath, passphrase: PASSPHRASE })).toBe(0);
    const once = readFileSync(configPath, 'utf-8');
    const backup = readFileSync(`${configPath}.backup`, 'utf-8');

    expect(await encryptConfigFile({ configPath, passphrase: PASSPHRASE })).toBe(0);
    expect(readFileSync(configPath, 'utf-8')).toBe(once);
    expect(readFileSync(`${configPath}.backup`, 'utf-8')).toBe(backup);
    expect(logs.join('\n')).toContain('Nothing to encrypt');
  });

  it('keeps an existing backup instead of overwriting it', async () => {
    const backupPath = `${configPath}.backup`;
    writeFileSync(backupPath, 'older-backup-fixture', 'utf-8');
    expect(await encryptConfigFile({ configPath, passphrase: PASSPHRASE })).toBe(0);
    expect(readFileSync(backupPath, 'utf-8')).toBe('older-backup-fixture');
    expect(logs.join('\n')).toContain('Existing backup kept');
  });

  it('warns about mixed legacy keys while encrypting plaintext', async () => {
    writeFileSync(
      configPath,
      [
        'keys:',
        '  - label: legacy',
        '    key: enc:scrypt:c2FsdA==:aXY=:Y3Q=:dGFn',
        `  - label: plain`,
        `    key: ${KEY}`,
        '',
      ].join('\n'),
      'utf-8',
    );
    expect(await encryptConfigFile({ configPath, passphrase: PASSPHRASE })).toBe(0);
    const updated = readFileSync(configPath, 'utf-8');
    expect(updated).toContain('enc:scrypt:');
    expect(updated).toContain('enc:v1:');
    expect(logs.join('\n')).toContain('legacy enc:scrypt');
  });

  it('leaves legacy enc:scrypt values untouched and says so', async () => {
    writeFileSync(
      configPath,
      'keys:\n  - label: legacy\n    key: enc:scrypt:c2FsdA==:aXY=:Y3Q=:dGFn\n',
      'utf-8',
    );
    expect(await encryptConfigFile({ configPath, passphrase: PASSPHRASE })).toBe(0);
    const updated = readFileSync(configPath, 'utf-8');
    expect(updated).toContain('enc:scrypt:');
    expect(updated).not.toContain('enc:v1:');
  });

  it('refuses when no passphrase source is available and leaves the file alone', async () => {
    const before = readFileSync(configPath, 'utf-8');
    const code = await encryptConfigFile({
      configPath,
      env: {},
      platform: 'linux',
      allowTty: false,
      run: () => ({ ok: false, stdout: '', reason: 'not populated' }),
    });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('SAROS_PASSPHRASE');
    expect(errors.join('\n')).toContain('saros-proxy secret set');
    expect(errors.join('\n')).toContain('Attempts:');
    expect(errors.join('\n')).toContain('store: not populated');
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
    expect(existsSync(`${configPath}.backup`)).toBe(false);
  });

  it('uses the env source and prompts only when no source exists', async () => {
    const code = await encryptConfigFile({
      configPath,
      env: { SAROS_PASSPHRASE: PASSPHRASE },
      platform: 'linux',
      allowTty: false,
    });
    expect(code).toBe(0);
    expect(readFileSync(configPath, 'utf-8')).toContain('enc:v1:');
  });

  it('defaults allowTty and resolves the config path from --config', async () => {
    process.argv = ['node', 'saros-proxy', '--config', configPath];
    try {
      const code = await encryptConfigFile({
        env: { SAROS_PASSPHRASE: PASSPHRASE },
        platform: 'linux',
      });
      expect(code).toBe(0);
      expect(readFileSync(configPath, 'utf-8')).toContain('enc:v1:');
    } finally {
      process.argv = ['node', 'saros-proxy'];
    }
  });

  it('reports a missing config and malformed YAML', async () => {
    expect(await encryptConfigFile({ configPath: join(tempDir, 'missing.yaml') })).toBe(1);
    expect(errors.join('\n')).toContain('not found');

    writeFileSync(configPath, 'keys: [unterminated\n', 'utf-8');
    expect(await encryptConfigFile({ configPath, passphrase: PASSPHRASE })).toBe(1);
    expect(errors.join('\n')).toContain('Could not parse');
  });

  it('never prints a key from a malformed YAML error', async () => {
    writeFileSync(
      configPath,
      'keys:\n  - label: leak\n    key: "sk-must-not-reach-output-0000001\n',
      'utf-8',
    );
    expect(await encryptConfigFile({ configPath, passphrase: PASSPHRASE })).toBe(1);
    const output = errors.join('\n');
    expect(output).toContain('Could not parse');
    expect(output).not.toContain('sk-must-not-reach-output');
  });

  it('does not trust encrypted: true on a plaintext entry', async () => {
    writeFileSync(
      configPath,
      `keys:\n  - label: spoofed\n    key: ${KEY}\n    encrypted: true\n`,
      'utf-8',
    );
    const loaded = loadConfig(configPath);
    expect(loaded.keys[0]).toMatchObject({ label: 'spoofed', key: KEY });
    expect(loaded.keys[0].encrypted).toBeUndefined();

    const response = await createProxyApp(loaded).request('/health');
    const body = (await response.json()) as {
      keys: Array<Record<string, unknown>>;
    };
    expect(body.keys[0]).toMatchObject({ label: 'spoofed', encrypted: false });
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it('refuses configs whose keys are not a list of labelled mappings', async () => {
    writeFileSync(configPath, 'port: 3000\n', 'utf-8');
    expect(await encryptConfigFile({ configPath, passphrase: PASSPHRASE })).toBe(1);
    expect(errors.join('\n')).toContain('no "keys" list');

    writeFileSync(configPath, 'keys:\n  - just-a-string\n', 'utf-8');
    expect(await encryptConfigFile({ configPath, passphrase: PASSPHRASE })).toBe(1);
    expect(errors.join('\n')).toContain('is not a mapping');

    writeFileSync(configPath, 'keys:\n  - key: sk-value\n', 'utf-8');
    expect(await encryptConfigFile({ configPath, passphrase: PASSPHRASE })).toBe(1);
    expect(errors.join('\n')).toContain('no string "label"');

    writeFileSync(configPath, 'keys:\n  - label: x\n', 'utf-8');
    expect(await encryptConfigFile({ configPath, passphrase: PASSPHRASE })).toBe(1);
    expect(errors.join('\n')).toContain('no string "key"');
  });

  it('parses --config and rejects unknown keys subcommands', async () => {
    const code = await runKeysCommand(['encrypt', '--config', configPath], {
      passphrase: PASSPHRASE,
    });
    expect(code).toBe(0);
    expect(readFileSync(configPath, 'utf-8')).toContain('enc:v1:');

    expect(await runKeysCommand(['nope'], {})).toBe(1);
    expect(errors.join('\n')).toContain('Usage: saros-proxy keys encrypt');
    expect(await runKeysCommand(['encrypt', '--config'], { configPath })).toBe(0);
  });
});
