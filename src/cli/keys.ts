/**
 * keys.ts — `saros-proxy keys encrypt`.
 *
 * Rewrites plaintext credentials in config.yaml as `enc:v1:` envelopes,
 * preserving comments and every unrelated field. The previous file is copied
 * to `<config>.backup` once; a second run is a no-op (idempotent).
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import chalk from 'chalk';
import { isMap, isSeq, parseDocument, type YAMLMap } from 'yaml';
import { resolveConfigPath } from '../config.js';
import { inferProvider } from '../providers/infer.js';
import { encryptValue, isEnvelope } from '../secrets/envelope.js';
import { isEncryptedKey } from '../key-encryption.js';
import {
  NO_PASSPHRASE_MESSAGE,
  resolvePassphrase,
  type CommandRunner,
  type SourceResult,
} from '../secrets/source.js';

export interface KeysCommandOptions {
  configPath?: string;
  passphrase?: string;
  allowTty?: boolean;
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

function backupConfig(configPath: string): string | null {
  const backupPath = `${configPath}.backup`;
  if (existsSync(backupPath)) return null;
  copyFileSync(configPath, backupPath);
  chmodSync(backupPath, 0o600);
  return backupPath;
}

function writeConfig(configPath: string, content: string): void {
  const temporary = `${configPath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf-8', mode: 0o600 });
    renameSync(temporary, configPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function resolveEncryptPassphrase(options: KeysCommandOptions): Promise<SourceResult> {
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
    : { ok: false, reason: 'no passphrase source available' };
}

/** Encrypt one already-parsed config document; exported for tests. */
export async function encryptConfigFile(options: KeysCommandOptions = {}): Promise<number> {
  const configPath = options.configPath ?? resolveConfigPath();
  if (!existsSync(configPath)) {
    console.error(chalk.red(`✗ Config file not found: ${configPath}`));
    return 1;
  }

  let document;
  try {
    document = parseDocument(readFileSync(configPath, 'utf-8'));
    if (document.errors.length > 0) {
      throw new KeysCommandError(document.errors.map((error) => error.message).join('; '));
    }
  } catch (err) {
    console.error(chalk.red(`✗ Could not parse ${configPath}: ${errorMessage(err)}`));
    return 1;
  }

  let keys: KeyNode[];
  try {
    keys = collectKeys(document.get('keys'));
  } catch (err) {
    console.error(chalk.red(`✗ ${errorMessage(err)}`));
    return 1;
  }

  const plaintext = keys.filter(
    (entry) => !isEnvelope(entry.key) && !isEncryptedKey(entry.key),
  );
  if (plaintext.length === 0) {
    console.log(chalk.green('✓ Nothing to encrypt — every key is already an enc: value.'));
    return 0;
  }

  const passphrase = await resolveEncryptPassphrase(options);
  if (!passphrase.ok) {
    console.error(chalk.red('✗ No passphrase source available.\n') + NO_PASSPHRASE_MESSAGE);
    return 1;
  }

  for (const entry of plaintext) {
    if (entry.node.get('provider') === undefined) {
      entry.node.set('provider', inferProvider({ label: entry.label, key: entry.key }));
    }
    entry.node.set('key', encryptValue(entry.key, passphrase.value, entry.label));
  }

  const legacy = keys.filter((entry) => isEncryptedKey(entry.key)).length;
  const backupPath = backupConfig(configPath);
  writeConfig(configPath, document.toString());

  console.log(
    chalk.green(`✓ Encrypted ${plaintext.length} key(s) in ${configPath}.`),
  );
  if (backupPath) {
    console.log(chalk.dim(`  Backup: ${backupPath} (mode 0600)`));
  } else {
    console.log(chalk.dim(`  Existing backup kept: ${configPath}.backup`));
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function parseKeysArgs(args: string[]): KeysCommandOptions {
  const options: KeysCommandOptions = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      options.configPath = args[++i];
    }
  }
  return options;
}

export async function runKeysCommand(
  args: string[],
  options: KeysCommandOptions = {},
): Promise<number> {
  if (args[0] !== 'encrypt') {
    console.error('Usage: saros-proxy keys encrypt [--config <path>]');
    return 1;
  }
  return encryptConfigFile({ ...options, ...parseKeysArgs(args.slice(1)) });
}
