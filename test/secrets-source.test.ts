/**
 * secrets-source.test.ts — Passphrase sources: env, OS-store CLIs, TTY.
 * The store is exercised through fake `secret-tool` / `security` /
 * `powershell` binaries placed on PATH, plus an injected runner for argument
 * shapes that cannot run on Linux.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { join } from 'node:path';
import * as os from 'node:os';
import {
  getSecretStatus,
  isInteractive,
  promptHidden,
  readEnvPassphrase,
  readStdinLine,
  readStorePassphrase,
  readTtyPassphrase,
  resolvePassphrase,
  runCommand,
  storeBackend,
  storePassphrase,
  defaultDpapiPath,
  type CommandRunner,
  type PromptOptions,
} from '../src/secrets/source.js';

const STORED = 'stored-passphrase-fixture';
const ENV_VALUE = 'env-passphrase-fixture';
const TTY_VALUE = 'tty-passphrase-fixture';

function ttyInput(): PassThrough {
  const input = new PassThrough();
  Object.defineProperty(input, 'isTTY', { value: true, configurable: true });
  return input;
}

function promptOptions(input: PassThrough): PromptOptions {
  const output = new PassThrough();
  return { input, output, question: 'Passphrase: ' };
}

function writeScript(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

describe('passphrase sources', () => {
  let tempDir: string;
  let oldPath: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(os.tmpdir(), 'saros-secrets-test-'));
    oldPath = process.env.PATH;
    process.env.PATH = `${tempDir}:${oldPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = oldPath;
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('env source', () => {
    it('reads SAROS_PASSPHRASE and treats empty as absent', () => {
      expect(readEnvPassphrase({ SAROS_PASSPHRASE: ENV_VALUE })).toEqual({
        ok: true,
        value: ENV_VALUE,
      });
      expect(readEnvPassphrase({ SAROS_PASSPHRASE: '' }).ok).toBe(false);
      expect(readEnvPassphrase({}).ok).toBe(false);
    });
  });

  describe('runCommand', () => {
    it('captures stdout and reports a missing binary without stderr', () => {
      const ok = runCommand(join(tempDir, 'absent-tool'), []);
      expect(ok.ok).toBe(false);
      expect(ok.reason).toContain('is not installed');
    });

    it('reports a non-zero exit with its code', () => {
      writeScript(tempDir, 'failing-tool', 'echo "nope" >&2; exit 7');
      const result = runCommand('failing-tool', []);
      expect(result).toMatchObject({
        ok: false,
        stdout: '',
        reason: 'failing-tool exited with code 7',
        status: 7,
        stderr: 'nope\n',
      });
    });

    it('reports a binary that exists but cannot be executed', () => {
      const path = join(tempDir, 'not-executable');
      writeFileSync(path, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(path, 0o644);
      const result = runCommand('not-executable', []);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('not-executable could not be run');
    });

    it('reports a process killed by a signal', () => {
      writeScript(tempDir, 'self-kill', 'kill -9 $$');
      const result = runCommand('self-kill', []);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('self-kill was terminated');
    });

    it('returns stdout on success and passes stdin', () => {
      const capture = join(tempDir, 'stdin.txt');
      writeScript(tempDir, 'reader-tool', `cat > "${capture}"; echo output`);
      const result = runCommand('reader-tool', [], { input: ENV_VALUE });
      expect(result).toEqual({ ok: true, stdout: 'output\n' });
      expect(readFileSync(capture, 'utf8')).toBe(ENV_VALUE);
    });

    it('passes extra environment variables and handles empty stdout', () => {
      writeScript(tempDir, 'env-tool', 'printf "%s" "$SAROS_TEST_ENV"');
      expect(
        runCommand('env-tool', [], { env: { SAROS_TEST_ENV: 'fixture-env' } }).stdout,
      ).toBe('fixture-env');

      writeScript(tempDir, 'silent-tool', 'exit 0');
      expect(runCommand('silent-tool', [])).toEqual({ ok: true, stdout: '' });
    });
  });

  describe('Linux store (secret-tool)', () => {
    it('looks up the service/account pair and strips only the newline', () => {
      writeScript(tempDir, 'secret-tool', `printf '${STORED}\\n'`);
      const result = readStorePassphrase({ platform: 'linux', username: 'tester' });
      expect(result).toEqual({ ok: true, value: STORED });
    });

    it('passes the exact lookup arguments', () => {
      const run = vi.fn<CommandRunner>(() => ({ ok: true, stdout: `${STORED}\n` }));
      readStorePassphrase({ platform: 'linux', username: 'tester', run });
      expect(run).toHaveBeenCalledWith('secret-tool', [
        'lookup',
        'service',
        'saros-proxy',
        'account',
        'tester',
      ]);
    });

    it('falls back through USER, USERNAME and a literal default', () => {
      const run = vi.fn<CommandRunner>(() => ({ ok: true, stdout: STORED }));
      const savedUser = process.env.USER;
      const savedUsername = process.env.USERNAME;

      process.env.USER = 'env-user';
      process.env.USERNAME = '';
      readStorePassphrase({ platform: 'linux', run });
      expect(run.mock.calls.at(-1)?.[1]).toContain('env-user');

      process.env.USER = '';
      process.env.USERNAME = 'win-user';
      readStorePassphrase({ platform: 'linux', run });
      expect(run.mock.calls.at(-1)?.[1]).toContain('win-user');

      process.env.USER = '';
      process.env.USERNAME = '';
      readStorePassphrase({ platform: 'linux', run });
      expect(run.mock.calls.at(-1)?.[1]).toContain('user');

      process.env.USER = savedUser;
      process.env.USERNAME = savedUsername;
    });

    it('reports a missing secret-tool, a non-zero exit and an empty secret', () => {
      const emptyPath = join(tempDir, 'empty-path');
      mkdirSync(emptyPath);
      const savedPath = process.env.PATH;
      process.env.PATH = emptyPath;
      const missing = readStorePassphrase({ platform: 'linux' });
      process.env.PATH = savedPath;
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.reason).toContain('is not installed');

      writeScript(tempDir, 'secret-tool', 'exit 2');
      const failed = readStorePassphrase({ platform: 'linux' });
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.reason).toContain('exited with code 2');

      writeScript(tempDir, 'secret-tool', 'printf "\\n"');
      const empty = readStorePassphrase({ platform: 'linux' });
      expect(empty.ok).toBe(false);
      if (!empty.ok) expect(empty.reason).toContain('empty secret');
    });

    it('distinguishes an absent entry from a locked keyring', () => {
      writeScript(tempDir, 'secret-tool', 'exit 1');
      const absent = readStorePassphrase({ platform: 'linux' });
      expect(absent.ok).toBe(false);
      if (!absent.ok) {
        expect(absent.reason).toContain('not found');
        expect(absent.reason).not.toContain('keyring');
      }

      writeScript(
        tempDir,
        'secret-tool',
        'echo "Cannot autolaunch D-Bus without X11 $DISPLAY" >&2; exit 1',
      );
      const locked = readStorePassphrase({ platform: 'linux' });
      expect(locked.ok).toBe(false);
      if (!locked.ok) {
        expect(locked.reason).toContain('keyring locked or error');
        expect(locked.reason).not.toContain('not found');
      }
    });
  });

  describe('macOS store (security)', () => {
    it('uses find-generic-password -w and returns the value', () => {
      const run = vi.fn<CommandRunner>(() => ({ ok: true, stdout: `${STORED}\n` }));
      const result = readStorePassphrase({ platform: 'darwin', username: 'tester', run });
      expect(result).toEqual({ ok: true, value: STORED });
      expect(run).toHaveBeenCalledWith('security', [
        'find-generic-password',
        '-s',
        'saros-proxy',
        '-a',
        'tester',
        '-w',
      ]);
    });

    it('understands a security CLI on PATH', () => {
      writeScript(tempDir, 'security', `printf '${STORED}\\r\\n'`);
      expect(readStorePassphrase({ platform: 'darwin', username: 'tester' })).toEqual({
        ok: true,
        value: STORED,
      });
    });

    it('maps errSecItemNotFound and a locked keychain to different reasons', () => {
      writeScript(tempDir, 'security', 'exit 44');
      const absent = readStorePassphrase({ platform: 'darwin', username: 'tester' });
      expect(absent.ok).toBe(false);
      if (!absent.ok) expect(absent.reason).toContain('not found');

      writeScript(tempDir, 'security', 'echo "keychain is locked" >&2; exit 1');
      const locked = readStorePassphrase({ platform: 'darwin', username: 'tester' });
      expect(locked.ok).toBe(false);
      if (!locked.ok) expect(locked.reason).toContain('keyring locked or error');
    });
  });

  describe('Windows store (DPAPI)', () => {
    it('reports an absent and an unreadable blob', () => {
      const missing = readStorePassphrase({
        platform: 'win32',
        dpapiPath: join(tempDir, 'missing.dpapi'),
        run: () => ({ ok: true, stdout: '' }),
      });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.reason).toContain('not found');

      const directory = join(tempDir, 'directory.dpapi');
      mkdirSync(directory);
      const unreadable = readStorePassphrase({
        platform: 'win32',
        dpapiPath: directory,
        run: () => ({ ok: true, stdout: '' }),
      });
      expect(unreadable.ok).toBe(false);
      if (!unreadable.ok) expect(unreadable.reason).toContain('could not be read');
    });

    it('rejects an empty blob', () => {
      const path = join(tempDir, 'empty.dpapi');
      writeFileSync(path, '   \n', 'utf8');
      const result = readStorePassphrase({
        platform: 'win32',
        dpapiPath: path,
        run: () => ({ ok: true, stdout: '' }),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('is empty');
    });

    it('calls PowerShell Unprotect with the blob in the environment', () => {
      const path = join(tempDir, 'secret.dpapi');
      const blob = Buffer.from('blob-fixture').toString('base64');
      writeFileSync(path, blob, 'utf8');
      const run = vi.fn<CommandRunner>(() => ({ ok: true, stdout: `${STORED}\n` }));
      const result = readStorePassphrase({ platform: 'win32', dpapiPath: path, run });
      expect(result).toEqual({ ok: true, value: STORED });
      const call = run.mock.calls[0];
      const args = call?.[1] ?? [];
      expect(call?.[0]).toBe('powershell');
      expect(args).toContain('-NoProfile');
      expect(args.join(' ')).toContain('Unprotect');
      expect(args.join(' ')).toContain("'CurrentUser'");
      expect(args.join(' ')).toContain('$env:SAROS_DPAPI_BLOB');
      // The blob is data for the child env, never part of the command line.
      expect(args.join(' ')).not.toContain(blob);
      expect(call?.[2]?.env).toEqual({ SAROS_DPAPI_BLOB: blob });
    });

    it('rejects a blob that could break out of a PowerShell string', () => {
      const path = join(tempDir, 'quoted.dpapi');
      writeFileSync(path, "AAAA'; Write-Output 'INJECTED'; 'BBBB", 'utf8');
      const run = vi.fn<CommandRunner>(() => ({ ok: true, stdout: `${STORED}\n` }));
      const result = readStorePassphrase({ platform: 'win32', dpapiPath: path, run });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('not valid base64');
      expect(run).not.toHaveBeenCalled();
    });

    it('rejects a blob whose base64 length is impossible', () => {
      const path = join(tempDir, 'short.dpapi');
      writeFileSync(path, 'AAAAA', 'utf8');
      const run = vi.fn<CommandRunner>(() => ({ ok: true, stdout: `${STORED}\n` }));
      const result = readStorePassphrase({ platform: 'win32', dpapiPath: path, run });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('not valid base64');
      expect(run).not.toHaveBeenCalled();
    });

    it('keeps a DPAPI failure reason and defaults a missing stderr', () => {
      const path = join(tempDir, 'secret.dpapi');
      writeFileSync(path, Buffer.from('blob-fixture').toString('base64'), 'utf8');
      const dpapiFailure = readStorePassphrase({
        platform: 'win32',
        dpapiPath: path,
        run: () => ({
          ok: false,
          stdout: '',
          reason: 'powershell exited with code 1',
          status: 1,
        }),
      });
      expect(dpapiFailure).toEqual({
        ok: false,
        reason: 'powershell exited with code 1',
      });

      const absent = readStorePassphrase({
        platform: 'linux',
        run: () => ({ ok: false, stdout: '', reason: 'secret-tool exited with code 1', status: 1 }),
      });
      expect(absent.ok).toBe(false);
      if (!absent.ok) expect(absent.reason).toContain('(not found)');
    });

    it('uses the injected APPDATA path and rejects unsupported platforms', () => {
      expect(defaultDpapiPath({ APPDATA: '/roaming-fixture' })).toBe(
        join('/roaming-fixture', 'saros', 'secret.dpapi'),
      );
      expect(defaultDpapiPath({})).toBe(
        join(os.homedir(), 'AppData', 'Roaming', 'saros', 'secret.dpapi'),
      );
      const unsupported = readStorePassphrase({ platform: 'freebsd' });
      expect(unsupported.ok).toBe(false);
      if (!unsupported.ok) expect(unsupported.reason).toContain('not supported');
    });

    it('resolves the default DPAPI path from APPDATA', () => {
      const roaming = join(tempDir, 'roaming');
      mkdirSync(join(roaming, 'saros'), { recursive: true });
      const path = join(roaming, 'saros', 'secret.dpapi');
      writeFileSync(path, Buffer.from('blob-fixture').toString('base64'), 'utf8');
      const run = vi.fn<CommandRunner>(() => ({ ok: true, stdout: `${STORED}\n` }));
      const result = readStorePassphrase({
        platform: 'win32',
        env: { APPDATA: roaming },
        run,
      });
      expect(result).toEqual({ ok: true, value: STORED });
    });

    it('names each platform backend', () => {
      expect(storeBackend('linux')).toContain('secret-tool');
      expect(storeBackend('darwin')).toContain('Keychain');
      expect(storeBackend('win32')).toContain('DPAPI');
      expect(storeBackend('freebsd')).toContain('unsupported');
    });
  });

  describe('TTY prompt', () => {
    it('returns null without a TTY', async () => {
      expect(await promptHidden({ input: new PassThrough() })).toBeNull();
      expect(await promptHidden()).toBeNull();
      expect(await readTtyPassphrase()).toEqual({ ok: false, reason: 'stdin is not a TTY' });
      expect(isInteractive(new PassThrough())).toBe(false);
      expect(await readTtyPassphrase({ input: new PassThrough() })).toEqual({
        ok: false,
        reason: 'stdin is not a TTY',
      });
    });

    it('reads a hidden line and treats an empty line as no input', async () => {
      const input = ttyInput();
      const pending = promptHidden(promptOptions(input));
      input.write(`${TTY_VALUE}\n`);
      expect(await pending).toBe(TTY_VALUE);

      const empty = ttyInput();
      const emptyPending = promptHidden(promptOptions(empty));
      empty.write('\n');
      expect(await emptyPending).toBeNull();

      const closed = ttyInput();
      const closedPending = promptHidden(promptOptions(closed));
      closed.end();
      expect(await closedPending).toBeNull();
    });

    it('readTtyPassphrase wraps the prompt result', async () => {
      const input = ttyInput();
      const pending = readTtyPassphrase(promptOptions(input));
      input.write(`${TTY_VALUE}\n`);
      expect(await pending).toEqual({ ok: true, value: TTY_VALUE });

      const empty = ttyInput();
      const emptyPending = readTtyPassphrase(promptOptions(empty));
      empty.write('\n');
      expect(await emptyPending).toEqual({ ok: false, reason: 'no passphrase entered' });
    });
  });

  describe('precedence', () => {
    it('env wins over the store and the TTY', async () => {
      const run = vi.fn<CommandRunner>(() => ({ ok: true, stdout: STORED }));
      const result = await resolvePassphrase({
        env: { SAROS_PASSPHRASE: ENV_VALUE },
        platform: 'linux',
        run,
        allowTty: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.source).toBe('env');
        expect(result.value).toBe(ENV_VALUE);
      }
      expect(run).not.toHaveBeenCalled();
    });

    it('store wins over the TTY', async () => {
      const result = await resolvePassphrase({
        env: {},
        platform: 'linux',
        run: () => ({ ok: true, stdout: STORED }),
        allowTty: true,
        input: new PassThrough(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.source).toBe('store');
        expect(result.value).toBe(STORED);
      }
    });

    it('uses the TTY only when allowed', async () => {
      const input = ttyInput();
      const pending = resolvePassphrase({
        env: {},
        platform: 'linux',
        run: () => ({ ok: false, stdout: '', reason: 'not populated' }),
        allowTty: true,
        ...promptOptions(input),
      });
      input.write(`${TTY_VALUE}\n`);
      const result = await pending;
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.source).toBe('tty');
    });

    it('reports a failed TTY prompt through the resolver', async () => {
      const input = ttyInput();
      const pending = resolvePassphrase({
        env: {},
        platform: 'linux',
        run: () => ({ ok: false, stdout: '', reason: 'not populated' }),
        allowTty: true,
        ...promptOptions(input),
      });
      input.write('\n');
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.attempts.at(-1)).toEqual({
          source: 'tty',
          ok: false,
          reason: 'no passphrase entered',
        });
      }
    });

    it('reports every failed source with no secret in the reasons', async () => {
      const result = await resolvePassphrase({
        env: {},
        platform: 'linux',
        run: () => ({ ok: false, stdout: '', reason: 'not populated' }),
        allowTty: false,
      });
      expect(result.ok).toBe(false);
      expect(result.attempts).toEqual([
        { source: 'env', ok: false, reason: 'SAROS_PASSPHRASE is not set' },
        { source: 'store', ok: false, reason: 'not populated' },
        { source: 'tty', ok: false, reason: 'interactive prompt is disabled in this context' },
      ]);
      for (const attempt of result.attempts) {
        expect(JSON.stringify(attempt)).not.toContain(ENV_VALUE);
        expect(JSON.stringify(attempt)).not.toContain(STORED);
      }
    });
  });

  describe('secret status', () => {
    it('reports the effective source without values', () => {
      const envSet = getSecretStatus({
        env: { SAROS_PASSPHRASE: ENV_VALUE },
        platform: 'linux',
        run: () => ({ ok: true, stdout: STORED }),
      });
      expect(envSet).toMatchObject({ env: true, effective: 'env' });
      expect(JSON.stringify(envSet)).not.toContain(ENV_VALUE);
      expect(JSON.stringify(envSet)).not.toContain(STORED);

      const storeSet = getSecretStatus({
        env: {},
        platform: 'linux',
        run: () => ({ ok: true, stdout: STORED }),
      });
      expect(storeSet).toMatchObject({ env: false, effective: 'store' });
      expect(storeSet.store).toEqual({
        backend: 'secret-tool (libsecret)',
        populated: true,
        reason: '',
      });

      const tty = getSecretStatus({
        env: {},
        platform: 'linux',
        run: () => ({ ok: false, stdout: '', reason: 'not populated' }),
        input: ttyInput(),
      });
      expect(tty.effective).toBe('tty');
      expect(tty.store.reason).toBe('not populated');

      const none = getSecretStatus({
        env: {},
        platform: 'linux',
        run: () => ({ ok: false, stdout: '', reason: 'not populated' }),
        input: new PassThrough(),
      });
      expect(none.effective).toBeNull();

      const defaults = getSecretStatus({
        env: {},
        run: () => ({ ok: true, stdout: STORED }),
      });
      expect(defaults.effective).toBe('store');
    });
  });

  describe('storePassphrase', () => {
    it('stores through secret-tool on Linux and feeds stdin', () => {
      const capture = join(tempDir, 'stored.txt');
      writeScript(tempDir, 'secret-tool', `cat > "${capture}"`);
      const result = storePassphrase(STORED, { platform: 'linux', username: 'tester' });
      expect(result).toEqual({ ok: true, backend: 'secret-tool (libsecret)' });
      expect(readFileSync(capture, 'utf8')).toBe(STORED);
    });

    it('stores through security on macOS', () => {
      const run = vi.fn<CommandRunner>(() => ({ ok: true, stdout: '' }));
      const result = storePassphrase(STORED, { platform: 'darwin', username: 'tester', run });
      expect(result.ok).toBe(true);
      expect(run).toHaveBeenCalledWith('security', [
        'add-generic-password',
        '-U',
        '-s',
        'saros-proxy',
        '-a',
        'tester',
        '-w',
        STORED,
      ]);
    });

    it('stores a DPAPI blob on Windows with the passphrase in the child env', () => {
      const path = join(tempDir, 'nested', 'secret.dpapi');
      const run = vi.fn<CommandRunner>(() => ({ ok: true, stdout: '' }));
      const result = storePassphrase(STORED, { platform: 'win32', dpapiPath: path, run });
      expect(result.ok).toBe(true);
      const call = run.mock.calls[0];
      expect(call?.[0]).toBe('powershell');
      expect(call?.[2]?.env).toEqual({
        SAROS_SECRET_VALUE: STORED,
        SAROS_SECRET_BLOB: path,
      });
    });

    it('refuses an empty passphrase and unsupported platforms', () => {
      expect(storePassphrase('', { platform: 'linux' }).ok).toBe(false);
      expect(storePassphrase(STORED, { platform: 'freebsd' }).ok).toBe(false);
      expect(storeBackend('freebsd')).toContain('unsupported');
    });

    it('surfaces a failing security and PowerShell command', () => {
      const macFailure = storePassphrase(STORED, {
        platform: 'darwin',
        run: () => ({ ok: false, stdout: '', reason: 'keychain locked' }),
      });
      expect(macFailure).toEqual({
        ok: false,
        backend: 'macOS Keychain (security)',
        reason: 'keychain locked',
      });

      const windowsFailure = storePassphrase(STORED, {
        platform: 'win32',
        dpapiPath: join(tempDir, 'secret.dpapi'),
        run: () => ({ ok: false, stdout: '', reason: 'powershell exited with code 1' }),
      });
      expect(windowsFailure.ok).toBe(false);
      expect(windowsFailure.reason).toContain('exited with code 1');
    });

    it('uses the host platform and default DPAPI path when omitted', () => {
      expect(
        storePassphrase(STORED, { run: () => ({ ok: true, stdout: '' }) }).ok,
      ).toBe(true);

      const roaming = join(tempDir, 'roaming-default');
      const windowsDefault = storePassphrase(STORED, {
        platform: 'win32',
        env: { APPDATA: roaming },
        run: () => ({ ok: true, stdout: '' }),
      });
      expect(windowsDefault.ok).toBe(true);
    });

    it('reports a store failure and a directory that cannot be created', () => {
      const failed = storePassphrase(STORED, {
        platform: 'linux',
        run: () => ({ ok: false, stdout: '', reason: 'locked keyring' }),
      });
      expect(failed).toEqual({
        ok: false,
        backend: 'secret-tool (libsecret)',
        reason: 'locked keyring',
      });

      const notADirectory = join(tempDir, 'file.txt');
      writeFileSync(notADirectory, 'x', 'utf8');
      const mkdirFailure = storePassphrase(STORED, {
        platform: 'win32',
        dpapiPath: join(notADirectory, 'secret.dpapi'),
        run: () => ({ ok: true, stdout: '' }),
      });
      expect(mkdirFailure.ok).toBe(false);
      expect(mkdirFailure.reason).toContain('could not create');
    });
  });

  describe('stdin line reader', () => {
    it('reads the first line, tolerates CRLF and missing newline', async () => {
      expect(await readStdinLine(Readable.from([`${STORED}\r\nignored`]))).toBe(STORED);
      expect(await readStdinLine(Readable.from([STORED]))).toBe(STORED);
      expect(await readStdinLine(Readable.from([]))).toBeNull();
    });
  });
});
