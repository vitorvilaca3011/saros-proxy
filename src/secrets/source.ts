/**
 * source.ts — Where the passphrase that unlocks `enc:v1:` envelopes comes from.
 *
 * Resolution order (first match wins):
 *   1. `SAROS_PASSPHRASE` in the environment — systemd / container friendly.
 *   2. The OS secret store, always through the platform's own CLI:
 *        Linux   secret-tool lookup service saros-proxy account <user>
 *        macOS   security find-generic-password -s saros-proxy -a <user> -w
 *        Windows PowerShell DPAPI, blob in %APPDATA%\saros\secret.dpapi
 *   3. A TTY prompt — only foreground `serve` asks; never a daemon child.
 *
 * Every source returns `{ value } | { reason }`. Reasons never contain the
 * secret, so they are safe for `secret status`, logs and error messages.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import type { Readable } from 'node:stream';

export const SERVICE_NAME = 'saros-proxy';
export const ENV_PASSPHRASE = 'SAROS_PASSPHRASE';

export type SecretSourceName = 'env' | 'store' | 'tty';

export interface SourceOk {
  ok: true;
  value: string;
}

export interface SourceFailure {
  ok: false;
  reason: string;
}

export type SourceResult = SourceOk | SourceFailure;

/** Only the source name and a reason ever leave this module. */
export interface SourceAttempt {
  source: SecretSourceName;
  ok: boolean;
  reason?: string;
}

export type CommandResult =
  | { ok: true; stdout: string }
  | { ok: false; stdout: ''; reason: string };

export interface CommandOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => CommandResult;

export interface StoreOptions {
  platform?: NodeJS.Platform;
  username?: string;
  run?: CommandRunner;
  dpapiPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PromptOptions {
  question?: string;
  input?: Readable & { isTTY?: boolean };
  output?: Writable;
}

export interface ResolveOptions extends StoreOptions, PromptOptions {
  allowTty?: boolean;
}

export interface ResolveSuccess {
  ok: true;
  value: string;
  source: SecretSourceName;
  attempts: SourceAttempt[];
}

export interface ResolveFailure {
  ok: false;
  attempts: SourceAttempt[];
}

export interface SecretStatus {
  env: boolean;
  store: { backend: string; populated: boolean; reason: string };
  tty: boolean;
  effective: SecretSourceName | null;
}

export interface StoreWriteResult {
  ok: boolean;
  backend: string;
  reason?: string;
}

export const NO_PASSPHRASE_MESSAGE = [
  'Encrypted API keys found, but no passphrase source is available.',
  '  a. Set SAROS_PASSPHRASE in the environment (systemd: use systemd-creds).',
  '  b. Store the passphrase in the OS secret store: saros-proxy secret set',
  '  c. Run `saros-proxy serve` in a terminal to be prompted.',
].join('\n');

/**
 * Raised when encrypted keys cannot be unlocked. The message is safe to log:
 * it names sources and options, never a passphrase, plaintext or ciphertext.
 */
export class SecretSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretSourceError';
  }
}

export function decryptFailureMessage(label: string, detail: string): string {
  return (
    `Cannot decrypt API key "${label}": ${detail}. ` +
    'Check SAROS_PASSPHRASE or run `saros-proxy secret status`.'
  );
}

/** Run a platform CLI without a shell; never returns stdout/stderr on failure. */
export function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): CommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input: options.input,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return { ok: false, stdout: '', reason: code === 'ENOENT' ? `${command} is not installed` : `${command} could not be run` };
  }
  if (result.status !== 0) {
    const detail = result.status === null ? 'was terminated' : `exited with code ${result.status}`;
    return { ok: false, stdout: '', reason: `${command} ${detail}` };
  }
  return { ok: true, stdout: result.stdout || '' };
}

/** Strip the trailing newline a CLI adds; keep spaces inside the secret. */
function firstLine(stdout: string): string {
  const line = stdout.split('\n')[0];
  return line.replace(/\r$/, '');
}

function interpret(result: CommandResult, command: string): SourceResult {
  if (!result.ok) return { ok: false, reason: result.reason };
  const value = firstLine(result.stdout);
  return value.length > 0
    ? { ok: true, value }
    : { ok: false, reason: `${command} returned an empty secret` };
}

export function readEnvPassphrase(env: NodeJS.ProcessEnv = process.env): SourceResult {
  const value = env[ENV_PASSPHRASE];
  return typeof value === 'string' && value.length > 0
    ? { ok: true, value }
    : { ok: false, reason: `${ENV_PASSPHRASE} is not set` };
}

function currentUsername(): string {
  return process.env.USER || process.env.USERNAME || 'user';
}

export function defaultDpapiPath(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'saros', 'secret.dpapi');
}

function readDpapi(passphrasePath: string, run: CommandRunner): SourceResult {
  if (!existsSync(passphrasePath)) {
    return { ok: false, reason: `DPAPI blob not found at ${passphrasePath}` };
  }
  let blob: string;
  try {
    blob = readFileSync(passphrasePath, 'utf8').trim();
  } catch {
    return { ok: false, reason: `DPAPI blob at ${passphrasePath} could not be read` };
  }
  if (blob.length === 0) {
    return { ok: false, reason: `DPAPI blob at ${passphrasePath} is empty` };
  }

  const script =
    "$ErrorActionPreference='Stop';" +
    'Add-Type -AssemblyName System.Security;' +
    `[System.Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${blob}'), $null, 'CurrentUser'))`;
  return interpret(
    run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]),
    'powershell',
  );
}

/** Read the passphrase from the OS store. Never prompts. */
export function readStorePassphrase(options: StoreOptions = {}): SourceResult {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const username = options.username ?? currentUsername();

  if (platform === 'linux') {
    return interpret(
      run('secret-tool', ['lookup', 'service', SERVICE_NAME, 'account', username]),
      'secret-tool',
    );
  }
  if (platform === 'darwin') {
    return interpret(
      run('security', ['find-generic-password', '-s', SERVICE_NAME, '-a', username, '-w']),
      'security',
    );
  }
  if (platform === 'win32') {
    const path = options.dpapiPath ?? defaultDpapiPath(options.env);
    return readDpapi(path, run);
  }
  return { ok: false, reason: `the OS secret store is not supported on ${platform}` };
}

export function isInteractive(input: Readable & { isTTY?: boolean } = process.stdin): boolean {
  return input.isTTY === true;
}

/** Read one line from stdin when it is piped (`secret set` in scripts). */
export async function readStdinLine(input: Readable): Promise<string | null> {
  let buffer = '';
  for await (const chunk of input) {
    buffer += String(chunk);
    const newline = buffer.indexOf('\n');
    if (newline !== -1) return buffer.slice(0, newline).replace(/\r$/, '');
  }
  return buffer.length > 0 ? buffer : null;
}

/** Hidden TTY prompt. Resolves null when there is no TTY or no input. */
export function promptHidden(options: PromptOptions = {}): Promise<string | null> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  if (!isInteractive(input)) return Promise.resolve(null);

  const promise = new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // A sink as readline's output discards the echoed characters; the question
    // itself is written to the real stderr.
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const rl = createInterface({ input, output: sink, terminal: true });
    output.write(options.question ?? 'Passphrase: ');

    rl.once('line', (line) => {
      finish(line.length > 0 ? line : null);
      output.write('\n');
      rl.close();
    });
    rl.once('close', () => finish(null));
  });

  return promise;
}

export async function readTtyPassphrase(options: PromptOptions = {}): Promise<SourceResult> {
  if (!isInteractive(options.input ?? process.stdin)) {
    return { ok: false, reason: 'stdin is not a TTY' };
  }
  const value = await promptHidden(options);
  return value === null
    ? { ok: false, reason: 'no passphrase entered' }
    : { ok: true, value };
}

function attempt(source: SecretSourceName, result: SourceResult): SourceAttempt {
  return result.ok ? { source, ok: true } : { source, ok: false, reason: result.reason };
}

/**
 * Resolve the passphrase in precedence order. The TTY source runs only when
 * `allowTty` is true (foreground serve), never for the daemon child.
 */
export async function resolvePassphrase(
  options: ResolveOptions = {},
): Promise<ResolveSuccess | ResolveFailure> {
  const attempts: SourceAttempt[] = [];

  const envResult = readEnvPassphrase(options.env);
  attempts.push(attempt('env', envResult));
  if (envResult.ok) {
    return { ok: true, value: envResult.value, source: 'env', attempts };
  }

  const storeResult = readStorePassphrase(options);
  attempts.push(attempt('store', storeResult));
  if (storeResult.ok) {
    return { ok: true, value: storeResult.value, source: 'store', attempts };
  }

  if (options.allowTty !== true) {
    attempts.push({
      source: 'tty',
      ok: false,
      reason: 'interactive prompt is disabled in this context',
    });
    return { ok: false, attempts };
  }

  const ttyResult = await readTtyPassphrase(options);
  attempts.push(attempt('tty', ttyResult));
  return ttyResult.ok
    ? { ok: true, value: ttyResult.value, source: 'tty', attempts }
    : { ok: false, attempts };
}

export function storeBackend(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'linux') return 'secret-tool (libsecret)';
  if (platform === 'darwin') return 'macOS Keychain (security)';
  if (platform === 'win32') return 'Windows DPAPI (CurrentUser)';
  return `unsupported platform (${platform})`;
}

/** Read-only snapshot for `saros-proxy secret status`; never returns a value. */
export function getSecretStatus(options: StoreOptions & PromptOptions = {}): SecretStatus {
  const env = readEnvPassphrase(options.env);
  const store = readStorePassphrase(options);
  const tty = isInteractive(options.input ?? process.stdin);
  return {
    env: env.ok,
    store: {
      backend: storeBackend(options.platform ?? process.platform),
      populated: store.ok,
      reason: store.ok ? '' : store.reason,
    },
    tty,
    effective: env.ok ? 'env' : store.ok ? 'store' : tty ? 'tty' : null,
  };
}

/** Store a passphrase through the platform CLI (used by `secret set`). */
export function storePassphrase(
  passphrase: string,
  options: StoreOptions = {},
): StoreWriteResult {
  const platform = options.platform ?? process.platform;
  const backend = storeBackend(platform);
  if (passphrase.length === 0) {
    return { ok: false, backend, reason: 'passphrase must not be empty' };
  }

  const run = options.run ?? runCommand;
  const username = options.username ?? currentUsername();

  if (platform === 'linux') {
    const result = run(
      'secret-tool',
      ['store', '--label=saros-proxy passphrase', 'service', SERVICE_NAME, 'account', username],
      { input: passphrase },
    );
    return result.ok ? { ok: true, backend } : { ok: false, backend, reason: result.reason };
  }
  if (platform === 'darwin') {
    const result = run('security', [
      'add-generic-password',
      '-U',
      '-s',
      SERVICE_NAME,
      '-a',
      username,
      '-w',
      passphrase,
    ]);
    return result.ok ? { ok: true, backend } : { ok: false, backend, reason: result.reason };
  }
  if (platform === 'win32') {
    const path = options.dpapiPath ?? defaultDpapiPath(options.env);
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      return { ok: false, backend, reason: `could not create ${dirname(path)}` };
    }
    const script =
      "$ErrorActionPreference='Stop';" +
      'Add-Type -AssemblyName System.Security;' +
      '$b=[System.Text.Encoding]::UTF8.GetBytes($env:SAROS_SECRET_VALUE);' +
      "$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');" +
      '[System.IO.File]::WriteAllText($env:SAROS_SECRET_BLOB,[Convert]::ToBase64String($p))';
    const result = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { SAROS_SECRET_VALUE: passphrase, SAROS_SECRET_BLOB: path },
    });
    return result.ok ? { ok: true, backend } : { ok: false, backend, reason: result.reason };
  }
  return { ok: false, backend, reason: `the OS secret store is not supported on ${platform}` };
}
