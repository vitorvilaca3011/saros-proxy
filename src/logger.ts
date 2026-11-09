/**
 * logger.ts — Structured logging with Pino and automatic API key masking.
 *
 * Two destinations:
 *  - JSON (daemon child, systemd journal, `SAROS_LOG_JSON=1`): pino's default
 *    NDJSON stream. Lines are parsed by tools and by `daemon.log` readers.
 *  - Human (every other CLI process, including a foreground `serve`): one
 *    rendered line per record, written synchronously in-process so CLI output
 *    and log lines keep their order.
 */

import pino from 'pino';
import { formatLogRecord } from './cli/log-render.js';

/**
 * Object paths pino must censor. Secrets live in headers and provider
 * credentials; nothing in a log line ever needs their value, so the redaction
 * is unconditional (not env-gated).
 */
export const LOG_REDACT_PATHS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'apiKey',
  'token',
  'key',
  'passphrase',
  'secret',
  'secretValue',
  'masterKey',
  'encryptionKey',
  'SAROS_PASSPHRASE',
  'headers.authorization',
  'headers.cookie',
  'err.config.headers.authorization',
] as const;

/**
 * Mask a secret key: show first 4 and last 4 characters.
 * Masks keys matching common patterns (sk-, key-, api-, token-)
 * or any string longer than 20 characters.
 */
export function maskKey(key: string): string {
  if (!key || key.length < 4) return '****';

  // Detect common secret patterns
  const patterns = [/^sk-/, /^key-/, /^api-/, /^token-/];
  const isSecret = patterns.some((p) => p.test(key)) || key.length > 20;

  if (!isSecret) return key; // Not a known secret pattern, show as-is

  // Mask: show first 4 and last 4 chars
  if (key.length <= 12) return key.slice(0, 4) + '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

/**
 * The daemon child and the systemd unit are configured for JSON; the escape
 * hatch forces it for a CLI run whose output is being parsed (scripts, CI).
 */
export function isJsonLogMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SAROS_LOG_JSON === '1' || env.SAROS_DAEMON === '1' || env.NODE_ENV === 'production';
}

function parseRecord(line: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  // JSON objects are string-keyed; the guard above rules out every other shape.
  return parsed as Record<string, unknown>;
}

/**
 * Synchronous in-process destination. A transport worker would write on its
 * own thread and reorder log lines against `console.log`/`chalk` output.
 * warn/error go to stderr so `2>/dev/null` leaves a clean report.
 */
function createHumanDestination(): { write: (line: string) => void } {
  return {
    write(line: string): void {
      const record = parseRecord(line);
      if (record === null) {
        // Not pino's NDJSON — pass it through rather than lose it.
        process.stdout.write(line);
        return;
      }
      const { stream, text } = formatLogRecord(record);
      (stream === 'stderr' ? process.stderr : process.stdout).write(`${text}\n`);
    },
  };
}

function createLogger() {
  const options = {
    level: process.env.LOG_LEVEL || 'info',
    // Fields that must never reach a log line, even nested under an error or a
    // request object. Key material is masked by callers (maskKey); this is the
    // safety net for everything else.
    redact: {
      paths: [...LOG_REDACT_PATHS],
      censor: '[redacted]',
    },
  };

  return isJsonLogMode() ? pino(options) : pino(options, createHumanDestination());
}

export const logger = createLogger();
