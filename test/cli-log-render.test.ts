/**
 * cli-log-render.test.ts — Human rendering of pino records for CLI output.
 *
 * Colors are pinned by forcing chalk to level 1: a test that accepts either
 * "colored" or "not colored" cannot tell a gray dot from a red one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { formatLogRecord } from '../src/cli/log-render.js';

const originalLevel = chalk.level;

beforeEach(() => {
  chalk.level = 1;
});

afterEach(() => {
  chalk.level = originalLevel;
});

describe('formatLogRecord', () => {
  it('renders info on stdout with the gray dot', () => {
    const line = formatLogRecord({ level: 30, msg: 'Loaded config from /tmp/config.yaml' });
    expect(line.stream).toBe('stdout');
    expect(line.text).toBe(`${chalk.gray('·')} Loaded config from /tmp/config.yaml`);
  });

  it('renders warn on stderr with the yellow triangle', () => {
    const line = formatLogRecord({ level: 40, msg: 'models.json is not a valid catalog' });
    expect(line.stream).toBe('stderr');
    expect(line.text).toBe(`${chalk.yellow('⚠')} models.json is not a valid catalog`);
  });

  it('renders error on stderr with the red cross', () => {
    const line = formatLogRecord({ level: 50, msg: 'Upstream call failed' });
    expect(line.stream).toBe('stderr');
    expect(line.text).toBe(`${chalk.red('✗')} Upstream call failed`);
  });

  it('treats fatal (60) as an error', () => {
    const line = formatLogRecord({ level: 60, msg: 'boot failed' });
    expect(line.stream).toBe('stderr');
    expect(line.text).toBe(`${chalk.red('✗')} boot failed`);
  });

  it('indents continuation lines of a multi-line message', () => {
    const msg =
      'Security: 2 keys use legacy enc:scrypt with OPENCODE_GO_ENCRYPTION_KEY.\n' +
      'alpha, beta\n' +
      'Run `saros-proxy keys encrypt` to migrate them to the enc:v1 envelope.';
    const line = formatLogRecord({ level: 40, msg });

    expect(line.stream).toBe('stderr');
    expect(line.text.split('\n')).toEqual([
      `${chalk.yellow('⚠')} Security: 2 keys use legacy enc:scrypt with OPENCODE_GO_ENCRYPTION_KEY.`,
      '  alpha, beta',
      '  Run `saros-proxy keys encrypt` to migrate them to the enc:v1 envelope.',
    ]);
  });

  it('appends the message of a serialized err', () => {
    const line = formatLogRecord({
      level: 50,
      msg: 'Upstream call failed',
      err: { type: 'Error', message: 'ECONNRESET', stack: 'at secret/path.ts:1' },
    });
    expect(line.text).toBe(`${chalk.red('✗')} Upstream call failed: ECONNRESET`);
    expect(line.text).not.toContain('secret/path.ts');
  });

  it('prints a bare string err when the log call passed one', () => {
    const line = formatLogRecord({ level: 50, msg: 'Failed', err: 'EACCES' });
    expect(line.text).toBe(`${chalk.red('✗')} Failed: EACCES`);
  });

  it('ignores an err object without a message', () => {
    const line = formatLogRecord({ level: 50, msg: 'Failed', err: { code: 'EIO' } });
    expect(line.text).toBe(`${chalk.red('✗')} Failed`);
  });

  it('ignores an err whose message is not a string', () => {
    const line = formatLogRecord({ level: 50, msg: 'Failed', err: { message: 42 } });
    expect(line.text).toBe(`${chalk.red('✗')} Failed`);
  });

  it('ignores a non-string msg', () => {
    expect(formatLogRecord({ level: 30, msg: 42 }).text).toBe(chalk.gray('·'));
  });

  it('renders an empty message as the icon alone', () => {
    expect(formatLogRecord({ level: 30 }).text).toBe(chalk.gray('·'));
  });

  it('defaults to info when the record carries no numeric level', () => {
    const line = formatLogRecord({ msg: 'no level' });
    expect(line.stream).toBe('stdout');
    expect(line.text).toBe(`${chalk.gray('·')} no level`);
  });

  it('never prints the raw record', () => {
    const line = formatLogRecord({
      level: 30,
      msg: 'request complete',
      apiKey: 'sk-super-secret-value',
      status: 200,
    });
    expect(line.text).not.toContain('sk-super-secret-value');
    expect(line.text).not.toContain('apiKey');
    expect(line.text).not.toContain('"level"');
    expect(line.text).not.toContain('{');
  });
});
