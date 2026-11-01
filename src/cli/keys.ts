/**
 * keys.ts — `saros-proxy keys encrypt`.
 *
 * Rewrites plaintext credentials in config.yaml as `enc:v1:` envelopes,
 * preserving comments and every unrelated field. The previous file is copied
 * to `<config>.backup` once; a second run is a no-op (idempotent).
 */

import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import chalk from 'chalk';
import { isMap, isSeq, parseDocument, type YAMLMap } from 'yaml';
import { resolveConfigPath } from '../config.js';
import { redactErrorMessage } from '../log-redact.js';
import { inferProvider } from '../providers/infer.js';
import { encryptValue, isEnvelope } from '../secrets/envelope.js';
import { isEncryptedKey } from '../key-encryption.js';
import {
  NO_SOURCE_MESSAGE,
  formatAttempts,
  resolvePassphrase,
  type CommandRunner,
  type SourceAttempt,
} from '../secrets/source.js';

export interface KeysCommandOptions {
  configPath?: string;
  passphrase?: string;
  allowTty?: boolean;
  noBackup?: boolean;
  input?: Readable & { isTTY?: boolean };
  output?: Writable;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  username?: string;
  run?: CommandRunner;
  dpapiPath?: string;
}

interface KeyNode {
  node: YAMLMap;
  label: string;
  key: string;
}

/**
 * The failure variant carries no secret-derived field: attempts are produced
 * by the resolver and are safe to print.
 */
type EncryptPassphraseResult =
  | { ok: true; value: string }
  | { ok: false; attempts: SourceAttempt[] };

class KeysCommandError extends Error {}

function collectKeys(sequence: unknown): KeyNode[] {
  if (!isSeq(sequence)) throw new KeysCommandError('config.yaml has no "keys" list');
  return sequence.items.map((item, index) => {
    if (!isMap(item)) throw new KeysCommandError(`keys[${index}] is not a mapping`);
    const label = item.get('label');
    const key = item.get('key');
    if (typeof label !== 'string' || label.length === 0) {
      throw new KeysCommandError(`keys[${index}] has no string "label"`);
    }
    if (typeof key !== 'string' || key.length === 0) {
      throw new KeysCommandError(`keys[${index}] ("${label}") has no string "key"`);
    }
    return { node: item, label, key };
  });
}

/**
 * Copy the plaintext config once, refusing to follow a pre-created symlink at
 * the backup path (COPYFILE_EXCL fails with EEXIST instead of writing through).
 */
function backupConfig(configPath: string): string | null {
  const backupPath = `${configPath}.backup`;
  try {
    copyFileSync(configPath, backupPath, constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (!lstatSync(backupPath).isFile()) {
      throw new KeysCommandError(
        `Refusing to use ${backupPath} as the backup: it exists and is not a regular file`,
      );
    }
    return null;
  }
  chmodSync(backupPath, 0o600);
  return backupPath;
}

/**
 * Write through an unpredictable temp file created inside a fresh private
 * directory, opened with `wx` so an existing path can never capture the
 * plaintext. Renaming over the real target keeps symlinked configs intact.
 */
function writeConfig(configPath: string, content: string): void {
  const directory = mkdtempSync(join(dirname(configPath), `.${basename(configPath)}.tmp-`));
  const temporary = join(directory, basename(configPath));
  try {
    writeFileSync(temporary, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, configPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function resolveEncryptPassphrase(
  options: KeysCommandOptions,
): Promise<EncryptPassphraseResult> {
  if (options.passphrase !== undefined && options.passphrase.length > 0) {
    return { ok: true, value: options.passphrase };
  }
  const resolved = await resolvePassphrase({
    allowTty: options.allowTty ?? true,
    env: options.env,
    input: options.input,
    output: options.output,
    platform: options.platform,
    username: options.username,
    run: options.run,
    dpapiPath: options.dpapiPath,
  });
  return resolved.ok
    ? { ok: true, value: resolved.value }
    : { ok: false, attempts: resolved.attempts };
}

/** Encrypt one already-parsed config document; exported for tests. */
export async function encryptConfigFile(options: KeysCommandOptions = {}): Promise<number> {
  const requestedPath = options.configPath ?? resolveConfigPath();
  if (!existsSync(requestedPath)) {
    console.error(chalk.red(`✗ Config file not found: ${requestedPath}`));
    return 1;
  }

  // A dotfile-managed config is usually a symlink; rewriting the link would
  // leave the real target (the file the proxy reads) in plaintext.
  let configPath: string;
  let document;
  try {
    configPath = realpathSync(requestedPath);
    document = parseDocument(readFileSync(configPath, 'utf-8'));
    if (document.errors.length > 0) {
      throw new KeysCommandError(
        document.errors.map((error) => redactErrorMessage(error)).join('; '),
      );
    }
  } catch (err) {
    console.error(
      chalk.red(`✗ Could not parse ${requestedPath}: ${redactErrorMessage(err)}`),
    );
    return 1;
  }

  let keys: KeyNode[];
  try {
    keys = collectKeys(document.get('keys'));
  } catch (err) {
    console.error(chalk.red(`✗ ${redactErrorMessage(err)}`));
    return 1;
  }

  const plaintext = keys.filter(
    (entry) => !isEnvelope(entry.key) && !isEncryptedKey(entry.key),
  );
  if (plaintext.length === 0) {
    console.log(chalk.green('✓ Nothing to encrypt — every key is already an enc: value.'));
    return 0;
  }

  const resolved = await resolveEncryptPassphrase(options);
  if (!resolved.ok) {
    console.error(
      chalk.red('✗ No passphrase source available.\n') +
        NO_SOURCE_MESSAGE +
        `\nAttempts:\n${formatAttempts(resolved.attempts)}`,
    );
    return 1;
  }

  for (const entry of plaintext) {
    if (entry.node.get('provider') === undefined) {
      entry.node.set('provider', inferProvider({ label: entry.label, key: entry.key }));
    }
    entry.node.set('key', encryptValue(entry.key, resolved.value, entry.label));
  }

  const legacy = keys.filter((entry) => isEncryptedKey(entry.key)).length;
  let backupPath: string | null = null;
  try {
    const content = document.toString();
    if (options.noBackup !== true) backupPath = backupConfig(configPath);
    writeConfig(configPath, content);
  } catch (err) {
    console.error(chalk.red(`✗ Could not rewrite ${requestedPath}: ${redactErrorMessage(err)}`));
    return 1;
  }

  console.log(
    chalk.green(`✓ Encrypted ${plaintext.length} key(s) in ${requestedPath}.`),
  );
  if (options.noBackup === true) {
    console.log(chalk.dim('  No backup written (--no-backup); the old plaintext file is gone.'));
  } else if (backupPath) {
    console.log(
      chalk.dim(
        `  Backup: ${backupPath} (mode 0600, PLAINTEXT — delete after the first successful boot)`,
      ),
    );
  } else {
    console.log(
      chalk.dim(
        `  Existing backup kept: ${configPath}.backup (PLAINTEXT — delete after the first successful boot)`,
      ),
    );
  }
  if (legacy > 0) {
    console.log(
      chalk.yellow(
        `  ${legacy} legacy enc:scrypt key(s) left untouched — set OPENCODE_GO_ENCRYPTION_KEY to keep using them, or replace them with plaintext and re-run.`,
      ),
    );
  }
  return 0;
}

export function parseKeysArgs(args: string[]): KeysCommandOptions {
  const options: KeysCommandOptions = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      options.configPath = args[++i];
    } else if (args[i] === '--no-backup') {
      options.noBackup = true;
    }
  }
  return options;
}

export async function runKeysCommand(
  args: string[],
  options: KeysCommandOptions = {},
): Promise<number> {
  if (args[0] !== 'encrypt') {
    console.error('Usage: saros-proxy keys encrypt [--config <path>] [--no-backup]');
    return 1;
  }
  return encryptConfigFile({ ...options, ...parseKeysArgs(args.slice(1)) });
}
