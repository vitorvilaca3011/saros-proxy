/**
 * secret.ts — `saros-proxy secret set|status`.
 *
 * `set` stores the envelope passphrase through the platform's own credential
 * CLI, so the user never edits a file and the value is never echoed or logged.
 * `status` reports which source would win and whether the store is populated;
 * it prints no secret material.
 */

import chalk from 'chalk';
import type { Readable, Writable } from 'node:stream';
import { resolveConfigPath } from '../config.js';
import { configHasEnvelopeKeys } from '../secrets/boot.js';
import {
  getSecretStatus,
  isInteractive,
  promptHidden,
  readStdinLine,
  storePassphrase,
  type CommandRunner,
  type SourceResult,
  type StoreOptions,
} from '../secrets/source.js';

export interface SecretCommandOptions {
  input?: Readable & { isTTY?: boolean };
  output?: Writable;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  username?: string;
  run?: CommandRunner;
  dpapiPath?: string;
  configPath?: string;
}

function storeOptions(options: SecretCommandOptions): StoreOptions {
  return {
    env: options.env,
    platform: options.platform,
    username: options.username,
    run: options.run,
    dpapiPath: options.dpapiPath,
  };
}

/** Prompt twice on a TTY; read one line when stdin is piped. */
export async function readNewPassphrase(
  options: SecretCommandOptions = {},
): Promise<SourceResult> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;

  if (!isInteractive(input)) {
    const line = await readStdinLine(input);
    return line === null
      ? { ok: false, reason: 'no passphrase on stdin (pipe one line or run in a terminal)' }
      : { ok: true, value: line };
  }

  const first = await promptHidden({ input, output, question: 'New passphrase: ' });
  if (first === null) return { ok: false, reason: 'no passphrase entered' };
  const second = await promptHidden({ input, output, question: 'Confirm passphrase: ' });
  if (second !== first) return { ok: false, reason: 'passphrases do not match' };
  return { ok: true, value: first };
}

/** Below this length the passphrase is the weak link, not scrypt. */
export const MIN_PASSPHRASE_LENGTH = 12;

/** Store the passphrase in the OS store. Returns the process exit code. */
export async function runSecretSet(options: SecretCommandOptions = {}): Promise<number> {
  const passphrase = await readNewPassphrase(options);
  if (!passphrase.ok) {
    console.error(chalk.red(`✗ ${passphrase.reason}`));
    return 1;
  }

  if (passphrase.value.length < MIN_PASSPHRASE_LENGTH) {
    console.error(
      chalk.yellow(
        `⚠ Passphrase is shorter than ${MIN_PASSPHRASE_LENGTH} characters. ` +
          'scrypt makes offline guessing expensive, but passphrase entropy is what protects the keys.',
      ),
    );
  }

  const stored = storePassphrase(passphrase.value, storeOptions(options));
  if (!stored.ok) {
    console.error(chalk.red(`✗ Could not store the passphrase: ${stored.reason}`));
    return 1;
  }

  console.log(chalk.green(`✓ Passphrase stored in ${stored.backend}.`));
  console.log(chalk.dim('Resolution order: SAROS_PASSPHRASE > OS store > TTY prompt (foreground serve).'));
  return 0;
}

/** Which source would be used, without printing any value. Exit code 0. */
export async function runSecretStatus(options: SecretCommandOptions = {}): Promise<number> {
  const status = getSecretStatus({ ...storeOptions(options), input: options.input ?? process.stdin });
  const configPath = options.configPath ?? resolveConfigPath();
  const encryptedConfig = configHasEnvelopeKeys(configPath);

  console.log(chalk.bold('Passphrase sources') + chalk.dim(' (first match wins)'));
  console.log(`  env    SAROS_PASSPHRASE: ${status.env ? chalk.green('set') : 'not set'}`);
  console.log(
    `  store  ${status.store.backend}: ` +
      (status.store.populated
        ? chalk.green('populated')
        : chalk.yellow(`not populated — ${status.store.reason}`)),
  );
  console.log(
    `  tty    interactive prompt: ` +
      (status.tty ? 'available (foreground serve only)' : 'not a TTY'),
  );
  console.log(
    `Config: ${encryptedConfig ? 'contains enc:v1 envelopes' : 'no enc:v1 envelopes'} ` +
      chalk.dim(`(${configPath})`),
  );
  console.log(`Effective source: ${status.effective ?? 'none'}`);
  return 0;
}

export async function runSecretCommand(
  args: string[],
  options: SecretCommandOptions = {},
): Promise<number> {
  const subcommand = args[0];
  if (subcommand === 'set') return runSecretSet(options);
  if (subcommand === 'status') return runSecretStatus(options);
  console.error('Usage: saros-proxy secret <set|status>');
  return 1;
}
