/**
 * usage.ts — `saros-proxy usage` command.
 *
 * Shows per-key quota usage (rolling 5h / weekly / monthly windows) fetched
 * live from the upstream usage API, plus the most-used models recorded by
 * the proxy in model-stats.json (only counts requests forwarded while a
 * proxy process was running).
 */

import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { fetchKeyUsage } from '../usage-client.js';
import { getProvider, inferProvider } from '../providers/index.js';
import { getModelStatsPath } from '../model-stats.js';
import { getTokenUsagePath, type KeyTokenUsage } from '../token-usage.js';
import { SecretSourceError } from '../secrets/source.js';

interface ModelStatsFile {
  since?: number;
  counts?: Record<string, number>;
}

interface TokenUsageFile {
  since?: number;
  keys?: Record<string, Partial<KeyTokenUsage>>;
}

/**
 * Read the token totals the proxy persisted (the CLI is a separate process,
 * so this file is the only shared state). Corrupt/missing files read as empty.
 */
function readTokenUsage(): { since: number; keys: Record<string, KeyTokenUsage> } {
  const path = getTokenUsagePath();
  if (!existsSync(path)) return { since: 0, keys: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as TokenUsageFile;
    const keys: Record<string, KeyTokenUsage> = {};
    for (const [label, entry] of Object.entries(parsed.keys ?? {})) {
      if (!entry || typeof entry.requests !== 'number' || entry.requests <= 0) continue;
      keys[label] = {
        requests: entry.requests,
        promptTokens: entry.promptTokens ?? 0,
        completionTokens: entry.completionTokens ?? 0,
        totalTokens: entry.totalTokens ?? 0,
        lastAt: entry.lastAt ?? 0,
      };
    }
    return { since: typeof parsed.since === 'number' ? parsed.since : 0, keys };
  } catch {
    return { since: 0, keys: {} };
  }
}

/** Compact token count: 812 → '812', 12_345 → '12.3k', 1_240_000 → '1.2M'. */
function formatTokenCount(tokens: number): string {
  const scaled = tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1_000
      ? `${(tokens / 1_000).toFixed(1)}k`
      : String(tokens);
  return scaled.replace(/\.0([Mk])$/, '$1');
}

/** Per-key token totals for display; '' when the key never reported any. */
function formatTokenTotals(usage: KeyTokenUsage | undefined): string {
  if (!usage || usage.requests === 0) return '';
  return `tokens: ${formatTokenCount(usage.totalTokens)}`
    + ` (${formatTokenCount(usage.promptTokens)} in / ${formatTokenCount(usage.completionTokens)} out,`
    + ` ${usage.requests} requests)`;
}

function formatWindow(percent: number): string {
  // Provider ratios can be fractional (CommandCode reports used/cap); the
  // console shows whole percents.
  const rounded = Math.round(percent);
  if (rounded >= 90) return chalk.red(`${rounded}%`);
  if (rounded >= 70) return chalk.yellow(`${rounded}%`);
  return chalk.green(`${rounded}%`);
}

function formatResetsAt(resetsAt: string | undefined): string {
  if (!resetsAt) return '-';
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return '-';
  const minutes = Math.max(0, Math.round((at - Date.now()) / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** Earliest reset among the three windows — when the tightest quota frees up. */
function earliestReset(usage: {
  rollingResetsAt?: string;
  weeklyResetsAt?: string;
  monthlyResetsAt?: string;
}): string {
  const times = [usage.rollingResetsAt, usage.weeklyResetsAt, usage.monthlyResetsAt]
    .map((r) => (r ? Date.parse(r) : NaN))
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) return '-';
  return formatResetsAt(new Date(Math.min(...times)).toISOString());
}

function printModelStats(): void {
  const path = getModelStatsPath();
  if (!existsSync(path)) return;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ModelStatsFile;
    const entries = Object.entries(parsed.counts ?? {})
      .filter(([, count]) => typeof count === 'number' && count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    if (entries.length === 0) return;

    const since = typeof parsed.since === 'number' ? new Date(parsed.since) : null;
    console.log('');
    console.log(
      chalk.bold('Most used models')
        + chalk.dim(since ? ` (since ${since.toISOString().slice(0, 10)})` : ''),
    );
    for (const [model, count] of entries) {
      console.log(`  ${model.padEnd(32)} ${String(count).padStart(8)} reqs`);
    }
  } catch {
    // Corrupt stats file — skip the section silently
  }
}

/**
 * Run the usage command. Returns the process exit code.
 */
export async function runUsageCommand(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof SecretSourceError) {
      console.log(
        chalk.yellow(
          '· Encrypted keys need a passphrase; showing local token totals only.',
        ),
      );
      console.log(
        chalk.dim(
          '  Set SAROS_PASSPHRASE, run `saros-proxy secret set`, or run `saros-proxy serve` in a terminal.',
        ),
      );
      printModelStats();
      return 0;
    }
    console.error('Failed to load config:', err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (config.keys.length === 0) {
    console.error(chalk.red('✗ No API keys configured'));
    return 1;
  }

  console.log(chalk.bold('Key usage') + chalk.dim(` (${config.upstreamBaseUrl})`));
  const tokenUsage = readTokenUsage();
  if (tokenUsage.since > 0) {
    console.log(
      chalk.dim(`  token totals since ${new Date(tokenUsage.since).toISOString().slice(0, 10)}`),
    );
  }

  const results = await Promise.all(
    config.keys.map(async ({ label, key, provider }) => {
      const providerId = provider ?? inferProvider({ label, key });
      const p = getProvider(providerId);
      // Providers without a usage endpoint report 'n/a' instead of an error.
      if (!p || !p.usagePath()) {
        return { label, provider: providerId, usage: null, noEntitlement: false, noUsageApi: true };
      }
      const base = config.upstreams?.[p.id] ?? (p.id === 'opencode-go' ? config.upstreamBaseUrl : p.baseUrl);
      const result = await fetchKeyUsage(base, key, p);
      return {
        label,
        provider: providerId,
        usage: result.usage,
        noEntitlement: result.noEntitlement === true,
        noUsageApi: false,
      };
    }),
  );

  let failures = 0;
  for (const { label, provider, usage, noEntitlement, noUsageApi } of results) {
    const totals = formatTokenTotals(tokenUsage.keys[label]);
    if (noUsageApi) {
      console.log(
        `  ${chalk.yellow('·')} ${label.padEnd(16)}${chalk.dim(` (${provider})`)}`
        // Reached only for a provider without a usage endpoint; token totals
        // recorded from usage chunks are then the only consumption signal.
        + chalk.dim(totals ? `  usage: n/a — ${totals}` : '  usage: n/a — provider has no queryable usage API'),
      );
      continue;
    }
    if (noEntitlement) {
      console.log(
        `  ${chalk.red('✗')} ${label.padEnd(16)}${chalk.dim(` (${provider})`)}`
        + chalk.red('  no subscription for this provider — excluded from rotation'),
      );
      continue;
    }
    if (!usage) {
      failures++;
      console.log(`  ${chalk.red('✗')} ${label.padEnd(16)}${chalk.dim(` (${provider})`)} failed to fetch usage`);
      continue;
    }
    console.log(
      `  ${chalk.green('•')} ${label.padEnd(16)}${chalk.dim(` (${provider})`)} 5h: ${formatWindow(usage.rollingPercent)}`
      + `  Weekly: ${formatWindow(usage.weeklyPercent)}`
      + `  Monthly: ${usage.monthlyAvailable ? formatWindow(usage.monthlyPercent) : chalk.dim('n/a')}`
      + chalk.dim(`  (tightest resets ${earliestReset(usage)})`)
      + (totals ? chalk.dim(`  · ${totals}`) : ''),
    );
  }

  printModelStats();

  return failures > 0 && failures === results.length ? 1 : 0;
}
