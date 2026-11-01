/**
 * key-state.ts — Rendering of the per-key state block shared by the bare
 * `saros-proxy` overview and `saros-proxy status`.
 *
 * Both commands read the daemon's `/health` payload, which carries a `keys`
 * array (see describeKeys in proxy-logic.ts). This module turns one entry into
 * the one-line explanation of why a key is out and when it may return. It never
 * renders the credential.
 */

import chalk from 'chalk';

/**
 * Why one key is out of rotation, as a suffix to append after its label.
 * `entry` is undefined when the daemon is not serving (or predates the per-key
 * block), in which case there is nothing to add.
 */
export function formatKeyState(entry: Record<string, unknown> | undefined): string {
  if (!entry) return '';
  if (entry.disabledByConfig === true) return chalk.dim(' — disabled in config');
  if (entry.entitled === false) return chalk.red(' — no plan for this provider');
  if (entry.enabled !== false) return '';
  const lastError = entry.lastError as { status?: number | null; reason?: string } | null | undefined;
  const reason = lastError?.reason ? ` ${lastError.reason}` : '';
  const status = typeof lastError?.status === 'number' ? ` (${lastError.status})` : '';
  const retry =
    typeof entry.retryAfterMs === 'number' && entry.retryAfterMs > 0
      ? `, retry in ${Math.ceil(entry.retryAfterMs / 1000)}s`
      : '';
  return chalk.red(` — disabled:${reason}${status}${retry}`);
}

/**
 * Lines for the per-key block of `saros-proxy status`: a summary plus one line
 * per key. Empty when the daemon is not serving or the payload has no `keys`
 * block (older daemon), so the caller can skip it silently.
 */
export function formatKeyBlock(health: Record<string, unknown> | undefined): string[] {
  const entries = Array.isArray(health?.keys)
    ? (health.keys as Array<Record<string, unknown>>)
    : [];
  if (entries.length === 0) return [];
  const enabled = entries.filter((entry) => entry.enabled !== false).length;
  const summary = enabled === entries.length
    ? chalk.green(`${enabled}/${entries.length} enabled`)
    : chalk.yellow(`${enabled}/${entries.length} enabled`);
  return [
    `Keys: ${summary}`,
    ...entries.map((entry) => {
      const provider = typeof entry.provider === 'string' ? chalk.dim(` [${entry.provider}]`) : '';
      const encrypted = entry.encrypted === true ? chalk.dim(' [encrypted]') : '';
      return `  ${String(entry.label)}${provider}${encrypted}${formatKeyState(entry)}`;
    }),
  ];
}
