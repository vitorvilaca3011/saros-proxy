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

interface ModelStatsFile {
  since?: number;
  counts?: Record<string, number>;
}

function formatWindow(percent: number): string {
  if (percent >= 90) return chalk.red(`${percent}%`);
  if (percent >= 70) return chalk.yellow(`${percent}%`);
  return chalk.green(`${percent}%`);
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
    console.error('Failed to load config:', err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (config.keys.length === 0) {
    console.error(chalk.red('✗ No API keys configured'));
    return 1;
  }

  console.log(chalk.bold('Key usage') + chalk.dim(` (${config.upstreamBaseUrl})`));

  const results = await Promise.all(
    config.keys.map(async ({ label, key, provider }) => {
      const providerId = provider ?? inferProvider({ label, key });
      const p = getProvider(providerId);
      // Providers without a queryable usage API report 'n/a' instead of an error.
      if (!p || !p.usagePath()) {
        return { label, provider: providerId, usage: null, noUsageApi: true };
      }
      const base = config.upstreams?.[p.id] ?? (p.id === 'opencode-go' ? config.upstreamBaseUrl : p.baseUrl);
      return { label, provider: providerId, usage: await fetchKeyUsage(base, key, p.usagePath()), noUsageApi: false };
    }),
  );

  let failures = 0;
  for (const { label, provider, usage, noUsageApi } of results) {
    if (noUsageApi) {
      console.log(
        `  ${chalk.yellow('·')} ${label.padEnd(16)}${chalk.dim(` (${provider})`)}`
        + chalk.dim('  usage: n/a — provider has no queryable usage API'),
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
      + `  Monthly: ${formatWindow(usage.monthlyPercent)}`
      + chalk.dim(`  (tightest resets ${earliestReset(usage)})`),
    );
  }

  printModelStats();

  return failures > 0 && failures === results.length ? 1 : 0;
}
