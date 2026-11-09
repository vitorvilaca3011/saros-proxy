/**
 * log-render.ts — Render one pino record as a human CLI line.
 *
 * Pure and dependency-light on purpose: this module may only import `chalk`.
 * `src/cli/ui.ts` imports `maskKey` from `logger.ts`, so importing `ui` here
 * (logger → renderer → ui → logger) would close a cycle.
 *
 * The record may carry fields that must never reach a terminal (upstream
 * bodies, headers); only `msg`, `err.message` and the fixed public-field tail
 * below are rendered.
 */

import chalk from 'chalk';

/**
 * C0/C1 control characters except `\t` and `\n`. JSON escaped them; a rendered
 * line must not hand an ESC/OSC/BEL sequence from a header or an upstream body
 * to the terminal.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

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

function formatLabel(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The only record fields a human line may show, in this order. Everything else
 * (bodies, headers, raw errors) stays out; absent or mistyped values are
 * omitted, not rendered empty.
 */
const TAIL_FIELDS: ReadonlyArray<[string, (value: unknown) => string | null]> = [
  ['status', (value) => (typeof value === 'number' ? String(value) : null)],
  ['keyLabel', formatLabel],
  ['provider', formatLabel],
  ['durationMs', (value) => (typeof value === 'number' ? `${value}ms` : null)],
  ['requestId', formatLabel],
];

/** Compact gray suffix, e.g. `200 · key-a · opencode-go · 120ms · req-1`. */
function tailFor(rec: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [field, format] of TAIL_FIELDS) {
    const value = format(rec[field]);
    if (value !== null) parts.push(value);
  }
  return parts.join(' · ');
}

export function formatLogRecord(rec: Record<string, unknown>): RenderedLogLine {
  const severity = severityOf(rec.level);
  const msg = typeof rec.msg === 'string' ? rec.msg : '';
  const errMsg = errorMessage(rec.err);
  const raw = errMsg === null ? msg : msg === '' ? errMsg : `${msg}: ${errMsg}`;
  const body = raw.replace(CONTROL_CHARS, '');

  const [first = '', ...continuation] = body.split('\n');
  const head = first === '' ? iconFor(severity) : `${iconFor(severity)} ${first}`;
  const tail = tailFor(rec);
  const text =
    head +
    continuation.map((line) => `\n  ${line}`).join('') +
    (tail === '' ? '' : ` ${chalk.gray(tail)}`);

  return { stream: severity === 'info' ? 'stdout' : 'stderr', text };
}
