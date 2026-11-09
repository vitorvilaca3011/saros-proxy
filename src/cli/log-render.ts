/**
 * log-render.ts — Render one pino record as a human CLI line.
 *
 * Pure and dependency-light on purpose: this module may only import `chalk`.
 * `src/cli/ui.ts` imports `maskKey` from `logger.ts`, so importing `ui` here
 * (logger → renderer → ui → logger) would close a cycle.
 *
 * The record may carry fields that must never reach a terminal (upstream
 * bodies, headers); only `msg` and `err.message` are rendered.
 */

import chalk from 'chalk';

export interface RenderedLogLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

type Severity = 'info' | 'warn' | 'error';

/** pino numeric levels: 40 warn, 50 error, 60 fatal; everything below is info. */
function severityOf(level: unknown): Severity {
  const numeric = typeof level === 'number' ? level : 30;
  if (numeric >= 50) return 'error';
  if (numeric >= 40) return 'warn';
  return 'info';
}

function iconFor(severity: Severity): string {
  if (severity === 'error') return chalk.red('✗');
  if (severity === 'warn') return chalk.yellow('⚠');
  return chalk.gray('·');
}

/** pino serializes an Error into `{type, message, stack}` under `err`. */
function errorMessage(err: unknown): string | null {
  if (typeof err === 'string') return err;
  if (err === null || typeof err !== 'object' || !('message' in err)) return null;
  return typeof err.message === 'string' ? err.message : null;
}

export function formatLogRecord(rec: Record<string, unknown>): RenderedLogLine {
  const severity = severityOf(rec.level);
  const msg = typeof rec.msg === 'string' ? rec.msg : '';
  const errMsg = errorMessage(rec.err);
  const body = errMsg === null ? msg : msg === '' ? errMsg : `${msg}: ${errMsg}`;

  const [first = '', ...continuation] = body.split('\n');
  const head = first === '' ? iconFor(severity) : `${iconFor(severity)} ${first}`;
  const text = head + continuation.map((line) => `\n  ${line}`).join('');

  return { stream: severity === 'info' ? 'stdout' : 'stderr', text };
}
