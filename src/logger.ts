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

function createLogger() {
  const isDev = process.env.NODE_ENV !== 'production';

  return pino({
    level: process.env.LOG_LEVEL || 'info',
    ...(isDev
      ? {
          transport: tryTransport('pino-pretty', { colorize: true }),
        }
      : {}),
  });
}

/**
 * Try to load a pino transport; return undefined if the target package
 * is not available. This lets the CLI work from a `npm install -g` that
 * only ships production dependencies.
 */
function tryTransport(
  target: string,
  options: Record<string, unknown>,
): { target: string; options: Record<string, unknown> } | undefined {
  try {
    // pino.transport throws at runtime if the target package is missing
    pino.transport({ target, options });
    return { target, options };
  } catch {
    return undefined; // fall back to JSON logging
  }
}

export const logger = createLogger();
