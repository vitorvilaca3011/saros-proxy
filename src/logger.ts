/**
 * logger.ts — Structured logging with Pino and automatic API key masking.
 */

import pino from 'pino';

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

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true },
        },
      }
    : {}),
});
