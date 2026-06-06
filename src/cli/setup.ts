#!/usr/bin/env node

/**
 * setup.ts — Interactive CLI setup wizard for the OpenCode-Go Multi-Account Proxy.
 *
 * Usage:
 *   npx tsx src/cli/setup.ts
 *   npm run setup
 *
 * Prompts for configuration values, writes config.yaml, and runs a quick
 * smoke test to verify the proxy starts and responds to health checks.
 */

import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { stringify as stringifyYaml } from 'yaml';
import { spawn, exec, execFileSync, type ChildProcess } from 'node:child_process';
import { resolve as pathResolve, join as pathJoin, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { encryptKey } from '../key-encryption.js';
import { extractFirefoxAuthCookie, extractFirefoxWorkspaceIds } from '../firefox-cookies.js';
import { scrapeDashboard } from '../scraper.js';
import {
  getDefaultOpencodeConfigPath,
  updateOpencodeConfig,
  generateManualConfigSnippet,
  type OpencodeConfigResult,
} from './opencode-config.js';
import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_UPSTREAM_URL,
  DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SCRAPE_INTERVAL_MS,
  DEFAULT_USAGE_THRESHOLD,
} from '../constants.js';
import { isValidPort, isValidApiKey, isValidHttpsUrl, isValidPositiveInt } from '../validation.js';
import { getDefaultConfigPath } from '../config.js';
import * as ui from './ui.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = pathResolve(fileURLToPath(import.meta.url), '..', '..', '..');

// ---------------------------------------------------------------------------
// Environment variable persistence
// ---------------------------------------------------------------------------

/** Try to save an environment variable persistently so the user doesn't
 *  have to export it manually each time.
 *
 *  - Windows: `setx <name> <value>` (user-level, persists across reboots)
 *  - Linux/macOS: append `export <name>=<value>` to ~/.bashrc or ~/.zshrc
 *
 *  Returns true on success, false on failure (non-fatal).
 */
function saveEnvVar(name: string, value: string): boolean {
  try {
    if (process.platform === 'win32') {
      // Use execFileSync to avoid shell injection (setx PATH "foo & calc & ")
      execFileSync('setx', [name, value], { windowsHide: true, timeout: 5000 });
      return true;
    }

    // Linux/macOS — append to shell profile
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return false;

    const profilePaths = [
      pathJoin(home, '.zshrc'),
      pathJoin(home, '.bashrc'),
      pathJoin(home, '.bash_profile'),
      pathJoin(home, '.profile'),
    ];

    const existing = profilePaths.find((p) => existsSync(p));
    const targetPath = existing || profilePaths[0];

    // Escape single quotes for shell profile: 'foo' -> '"'"'  (breaks out of single quotes, inserts literal ', resumes)
    const escaped = value.replace(/'/g, `'\\''`);
    const line = `\nexport ${name}='${escaped}'\n`;

    // Avoid adding duplicates — anchored to line start
    const content = existsSync(targetPath) ? readFileSync(targetPath, 'utf-8') : '';
    if (new RegExp(`^export ${name}=`, 'm').test(content)) return false;

    writeFileSync(targetPath, content + line, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scraping accounts setup
// ---------------------------------------------------------------------------

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0] || 'th');
}

export interface SetupConfig {
  port: number;
  upstreamBaseUrl: string;
  keys: Array<{ label: string; key: string }>;
  scrapingAccounts?: Array<{ workspaceId: string; authCookie: string }>;
  scrapingThreshold?: number;
  scrapingIntervalMs?: number;
}

export function generateYaml(cfg: SetupConfig, encryptionEnabled = false): string {
  const config: Record<string, unknown> = {
    port: cfg.port,
    host: DEFAULT_HOST,
    upstreamBaseUrl: cfg.upstreamBaseUrl,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],
    keys: cfg.keys,
  };

  if (cfg.scrapingAccounts && cfg.scrapingAccounts.length > 0) {
    config.scraping = {
      enabled: true,
      intervalMs: cfg.scrapingIntervalMs ?? DEFAULT_SCRAPE_INTERVAL_MS,
      usageThreshold: cfg.scrapingThreshold ?? DEFAULT_USAGE_THRESHOLD,
      accounts: cfg.scrapingAccounts,
    };
  }

  let yaml = stringifyYaml(config);
  if (encryptionEnabled) {
    yaml = `# [!] API keys are encrypted with AES-256-GCM\n# Set OPENCODE_GO_ENCRYPTION_KEY environment variable to start the proxy\n\n${yaml}`;
  }
  return yaml;
}

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

/** Kill a process and all its children (cross-platform, non-blocking). */
function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;

  if (process.platform === 'win32') {
    exec(`taskkill /T /F /PID ${child.pid}`, { windowsHide: true }, () => {});
  } else {
    child.kill('SIGKILL');
  }
}

export async function testProxy(port: number, timeoutMs = 20_000, cwd = PACKAGE_ROOT, encryptionKey?: string, configPath?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Resolve the entry point relative to the package root
    const entryPoint = pathResolve(PACKAGE_ROOT, 'src', 'index.ts');

    // Use single-command form with shell:true to avoid DEP0190 deprecation
    // (Node.js deprecates passing both shell:true and separate args)
    const configFlag = configPath ? ` --config "${configPath}"` : '';
    const cmd = `npx tsx "${entryPoint}" --port ${port}${configFlag}`;
    const child: ChildProcess = spawn(cmd, [], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      detached: false, // killProcessTree() handles cleanup on both platforms
      env: {
        ...process.env,
        LOG_LEVEL: 'silent',
        NODE_ENV: 'production',
        ...(encryptionKey ? { OPENCODE_GO_ENCRYPTION_KEY: encryptionKey } : {}),
      },
    });

    let started = false;
    let timedOut = false;
    let resolved = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      if (!resolved) {
        resolved = true;
        reject(new Error('Proxy did not start within the allotted time.'));
      }
    }, timeoutMs);

    // Collect stderr for error reporting
    let stderrBuf = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });
    }

    // Poll the health endpoint until we get a response
    const pollId = setInterval(async () => {
      if (timedOut) {
        clearInterval(pollId);
        return;
      }

      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          // Parse JSON first — don't mark as started until we confirm it's our proxy
          const data = await res.json();

          started = true;
          clearTimeout(timer);
          clearInterval(pollId);

          ui.success(`Health check returned status "${data.status}"`);
          ui.success(`${data.enabledCount}/${data.keyCount} API key(s) enabled`);
          if (data.disabledCount > 0) {
            ui.warn(`${data.disabledCount} key(s) disabled (check API key validity)`);
          }

          // Kill the child and wait for it to exit before resolving
          killProcessTree(child);
          child.once('exit', () => {
            if (!resolved) {
              resolved = true;
              resolve();
            }
          });
          // Fallback: if exit doesn't fire within 2s, resolve anyway
          setTimeout(() => {
            if (!resolved) {
              resolved = true;
              resolve();
            }
          }, 2000);
        }
      } catch {
        // Server not ready yet — keep polling
      }
    }, 400);

    child.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(pollId);
      if (!started && !resolved) {
        resolved = true;
        reject(new Error(`Failed to start proxy process: ${err.message}`));
      }
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      clearInterval(pollId);

      // If child exits before we detected it as started, that's a failure
      // (on Windows with shell:true, exit code may be 0 even when proxy failed)
      if (!started && !resolved) {
        resolved = true;
        const hint = stderrBuf.includes('EADDRINUSE')
          ? `Port ${port} is already in use. Choose a different port.`
          : stderrBuf.includes('No valid API keys')
            ? 'No valid API keys found. Ensure keys start with "sk-" and are at least 20 characters.'
            : `Proxy exited with code ${code}${stderrBuf ? `\n  Stderr: ${stderrBuf.slice(0, 500)}` : ''}`;
        reject(new Error(hint));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Backup existing config
// ---------------------------------------------------------------------------

export function backupExistingConfig(configDir = dirname(getDefaultConfigPath())): boolean {
  const configPath = pathResolve(configDir, 'config.yaml');
  if (!existsSync(configPath)) return false;

  const backupPath = pathResolve(configDir, 'config.yaml.backup');
  try {
    const content = readFileSync(configPath, 'utf-8');
    writeFileSync(backupPath, content, { encoding: 'utf-8', mode: 0o600 });
    ui.info('Existing config.yaml backed up to config.yaml.backup');
    return true;
  } catch (err) {
    ui.warn(`Could not create backup: ${err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function setup(configDir = dirname(getDefaultConfigPath()), skipSmokeTest = false): Promise<void> {
  ui.intro('OpenCode-Go Proxy Setup');

  ui.step('Server Configuration');

  // --- Step 1: Proxy port ---
  const portStr = ui.assertNotCancelled(await ui.text({
    message: 'Proxy port',
    placeholder: String(DEFAULT_PORT),
    validate: (v) => {
      if (v && !isValidPort(v)) return 'Port must be a number between 1 and 65535.';
    },
  }));
  const port = parseInt(portStr || String(DEFAULT_PORT), 10);

  // --- Step 2: Upstream URL ---
  const upstreamBaseUrl = ui.assertNotCancelled(await ui.text({
    message: 'Upstream API base URL',
    placeholder: DEFAULT_UPSTREAM_URL,
    validate: (v) => {
      if (v && !isValidHttpsUrl(v)) return 'Must be a valid HTTPS URL (e.g. https://opencode.ai).';
    },
  })) || DEFAULT_UPSTREAM_URL;

  // --- Step 4: Number of accounts ---
  const numAccountsStr = ui.assertNotCancelled(await ui.text({
    message: 'Number of accounts',
    placeholder: '2',
    validate: (v) => {
      if (v && !isValidPositiveInt(v, 1, 100)) return 'Must be a number between 1 and 100.';
    },
  }));
  const numAccounts = parseInt(numAccountsStr || '2', 10);

  // --- Step 4.5: Encrypt keys? ---
  const encryptKeys = ui.assertNotCancelled(await ui.confirm({
    message: 'Encrypt API keys? (recommended for security)',
    initialValue: true,
  }));

  let encryptionKey: string | undefined;
  let envSaved = false;
  if (encryptKeys) {
    encryptionKey = ui.assertNotCancelled(await ui.password({
      message: 'Master encryption key (min 16 characters)',
      validate: (v) => {
        if (!v || v.length < 16) return 'Encryption key must be at least 16 characters long';
      },
    }));
    ui.success('All API keys will be encrypted with AES-256-GCM');

    // Offer to persist OPENCODE_GO_ENCRYPTION_KEY to the environment
    const saveEnv = ui.assertNotCancelled(await ui.confirm({
      message: 'Save OPENCODE_GO_ENCRYPTION_KEY to your environment?',
      initialValue: true,
    }));
    if (saveEnv) {
      if (saveEnvVar('OPENCODE_GO_ENCRYPTION_KEY', encryptionKey)) {
        ui.success('OPENCODE_GO_ENCRYPTION_KEY saved');
        envSaved = true;
      } else {
        ui.warn('Could not save to environment. Set it manually:');
        ui.info(`    export OPENCODE_GO_ENCRYPTION_KEY="${encryptionKey}"`);
      }
    }
  }

  // --- Step 4.6: Usage-based scraping? ---
  const wantScraping = ui.assertNotCancelled(await ui.confirm({
    message: 'Enable usage-based account switching?',
    initialValue: true,
  }));
  let scrapingAccounts: Array<{ workspaceId: string; authCookie: string }> | undefined;
  let scrapingThreshold: number | undefined;
  let scrapingIntervalMs: number | undefined;

  if (wantScraping) {
    ui.step('Usage-Based Switching Config');

    const thresholdStr = ui.assertNotCancelled(await ui.text({
      message: 'Usage threshold (switch when usage exceeds this %)',
      placeholder: '70',
      validate: (v) => {
        if (v && (!/^\d+$/.test(v) || parseInt(v) < 1 || parseInt(v) > 100))
          return 'Enter a number between 1 and 100.';
      },
    }));
    scrapingThreshold = parseInt(thresholdStr || '70', 10);

    const intervalStr = ui.assertNotCancelled(await ui.text({
      message: 'Scrape interval in seconds',
      placeholder: '90',
      validate: (v) => {
        if (v && (!/^\d+$/.test(v) || parseInt(v) < 10))
          return 'Enter a number of seconds (minimum 10).';
      },
    }));
    scrapingIntervalMs = parseInt(intervalStr || '90', 10) * 1000;
    scrapingAccounts = [];
  }

  // --- Step 4.7: Collect account credentials (one round per account) ---
  const keys: Array<{ label: string; key: string }> = [];
  const seenCookies = new Set<string>();
  const seenWorkspaceIds = new Set<string>();

  for (let i = 0; i < numAccounts; i++) {
    ui.step(`Account ${i + 1} of ${numAccounts}`);

    // --- 4.7.1: Label ---
    const label = ui.assertNotCancelled(await ui.text({
      message: 'Label for this account',
      placeholder: `account${i + 1}`,
      validate: (v) => {
        if (v === '') return 'This field is required.';
      },
    })) || `account${i + 1}`;

    // --- 4.7.2: API key ---
    const key = ui.assertNotCancelled(await ui.password({
      message: 'API key',
      validate: (v) => {
        if (!v || !isValidApiKey(v)) return 'API key must start with "sk-" and be at least 20 characters long.';
      },
    }));

    // Encrypt on the spot if encryption enabled
    const finalKey = encryptionKey ? encryptKey(key, encryptionKey) : key;
    keys.push({ label, key: finalKey });
    ui.success(`"${label}" API key configured`);

    // --- 4.7.3: Scraping credentials (if enabled) ---
    if (wantScraping) {
      ui.info(`Log into ${i === 0 ? 'first' : ordinal(i + 1)} account in Firefox, then press Enter`);

      ui.assertNotCancelled(await ui.text({
        message: 'Press Enter when ready (log into Firefox first)',
        placeholder: 'Press Enter to continue',
        validate: () => undefined,
      }));

      // Extract cookie
      const extractSpinner = ui.spinner();
      extractSpinner.start('Extracting auth cookie from Firefox...');
      const cookieResult = extractFirefoxAuthCookie();
      if (cookieResult.cookie) {
        extractSpinner.stop('Extracted');
      } else {
        extractSpinner.error('No cookie found');
      }

      let authCookie: string | null = cookieResult.cookie ?? null;

      if (!authCookie) {
        ui.warn(`Firefox extraction: ${cookieResult.error || 'No cookie found'}`);
        authCookie = ui.assertNotCancelled(await ui.text({
          message: 'Auth cookie value (from Firefox DevTools)',
          validate: (v) => {
            if (!v || v.length < 10) return 'Cookie value must be at least 10 characters.';
          },
        }));
      } else {
        ui.success('Auth cookie extracted from Firefox');
      }

      // Duplicate cookie check
      if (seenCookies.has(authCookie)) {
        ui.warn('This cookie matches a previous account. Did you log out?');
        const retry = ui.assertNotCancelled(await ui.confirm({
          message: 'Try again with a different account?',
          initialValue: true,
        }));
        if (retry) {
          authCookie = ui.assertNotCancelled(await ui.text({
            message: 'Auth cookie value (from Firefox DevTools)',
            validate: (v) => {
              if (!v || v.length < 10) return 'Cookie value must be at least 10 characters.';
            },
          }));
        }
      }

      // Extract workspace IDs
      const workspaceIds = extractFirefoxWorkspaceIds();
      let workspaceId: string | null = null;

      if (workspaceIds.length > 0) {
        if (workspaceIds.length === 1) {
          workspaceId = workspaceIds[0];
          ui.success(`Found workspace: ${workspaceId}`);
        } else {
          ui.listWorkspaces(workspaceIds);
          const choiceStr = ui.assertNotCancelled(await ui.text({
            message: 'Enter the number for this account',
            placeholder: '1',
            validate: (v) => {
              if (v && (!/^\d+$/.test(v) || parseInt(v) < 1 || parseInt(v) > workspaceIds.length))
                return `Enter a number between 1 and ${workspaceIds.length}.`;
            },
          }));
          workspaceId = workspaceIds[parseInt(choiceStr || '1', 10) - 1];
        }
      } else {
          workspaceId = ui.assertNotCancelled(await ui.text({
            message: 'Workspace ID (wrk_...)',
            validate: (v) => {
              if (!v || !/^wrk_[A-Za-z0-9]+$/.test(v))
                return 'Must match format: wrk_... (e.g. wrk_abc123).';
            },
          }));
        }

        // Duplicate workspace check
        if (seenWorkspaceIds.has(workspaceId)) {
          ui.warn('This workspace ID belongs to another account.');
          const retry = ui.assertNotCancelled(await ui.confirm({
            message: 'Enter a different workspace ID?',
            initialValue: true,
          }));
          if (retry) {
            workspaceId = ui.assertNotCancelled(await ui.text({
              message: 'Workspace ID (wrk_...)',
              validate: (v) => {
                if (!v || !/^wrk_[A-Za-z0-9]+$/.test(v))
                  return 'Must match format: wrk_... (e.g. wrk_abc123).';
              },
            }));
        }
      }

      // Validate cookie by scraping dashboard
      const vSpinner = ui.spinner();
      vSpinner.start('Validating cookie against opencode.ai...');
      const scrapeResult = await scrapeDashboard(workspaceId, authCookie);
      if (scrapeResult.success) {
        vSpinner.stop('Validated');
      } else {
        vSpinner.error('Validation failed');
      }

      if (scrapeResult.success) {
        const usage = scrapeResult.usage;
        const usageLine = [
          usage?.rolling !== null && usage?.rolling !== undefined ? `Rolling: ${usage.rolling}%` : '',
          usage?.weekly !== null && usage?.weekly !== undefined ? `Weekly: ${usage.weekly}%` : '',
          usage?.monthly !== null && usage?.monthly !== undefined ? `Monthly: ${usage.monthly}%` : '',
        ].filter(Boolean).join('  ');
        ui.success(`Cookie validated — ${usageLine}`);
      } else {
        ui.error(`Validation failed: ${scrapeResult.error || 'Unknown error'}`);
        const retry = ui.assertNotCancelled(await ui.confirm({
          message: 'Try again?',
          initialValue: true,
        }));
        if (retry) {
          workspaceId = ui.assertNotCancelled(await ui.text({
            message: 'Workspace ID (wrk_...)',
            validate: (v) => {
              if (!v || !/^wrk_[A-Za-z0-9]+$/.test(v))
                return 'Must match format: wrk_... (e.g. wrk_abc123).';
            },
          }));
          const retrySpinner = ui.spinner();
          retrySpinner.start(`Retrying validation with workspace ${workspaceId}...`);
          const retryResult = await scrapeDashboard(workspaceId, authCookie);
          if (retryResult.success) {
            retrySpinner.stop('Validated');
          } else {
            retrySpinner.error('Validation failed');
          }
          if (retryResult.success) {
            const u = retryResult.usage;
            const ul = [
              u?.rolling != null ? `Rolling: ${u.rolling}%` : '',
              u?.weekly != null ? `Weekly: ${u.weekly}%` : '',
              u?.monthly != null ? `Monthly: ${u.monthly}%` : '',
            ].filter(Boolean).join('  ');
            ui.success(`Cookie validated — ${ul}`);
          } else {
            ui.error(`Still failed: ${retryResult.error || 'Unknown'}`);
          }
        }
      }

      // Store scraping credentials
      seenCookies.add(authCookie);
      seenWorkspaceIds.add(workspaceId);
      const acc = { workspaceId, authCookie: encryptionKey ? encryptKey(authCookie, encryptionKey) : authCookie };
      scrapingAccounts!.push(acc);
    }
  }

  if (encryptionKey && scrapingAccounts && scrapingAccounts.length > 0) {
    ui.success(`${scrapingAccounts.length} cookie(s) encrypted`);
  }

  // --- Step 5: Build config and write ---
  const cfg: SetupConfig = { port, upstreamBaseUrl, keys, scrapingAccounts, scrapingThreshold, scrapingIntervalMs };
  const yaml = generateYaml(cfg, encryptionKey !== undefined);

  // Backup existing config
  backupExistingConfig(configDir);

  // Ensure config directory exists
  mkdirSync(configDir, { recursive: true });

  // Write new config
  const configPath = pathResolve(configDir, 'config.yaml');
  writeFileSync(configPath, yaml, { encoding: 'utf-8', mode: 0o600 });
  ui.success(`config.yaml written to ${configPath}`);

  // --- Step 6: Smoke test ---
  if (!skipSmokeTest) {
    ui.info(`Starting proxy smoke test on port ${port}...`);
    try {
      await testProxy(port, 20_000, configDir, encryptionKey, configPath);
      ui.success('Smoke test passed — proxy is working correctly');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ui.warn(`Smoke test warning: ${message}`);
      ui.info('The config.yaml has been saved. You can troubleshoot by running:');
      ui.info('    $ npm run dev');
      // Don't exit with error — config.yaml is already written
    }
  }

  // --- Step 7: OpenCode client configuration ---
  ui.step('OpenCode Client Configuration');

  const defaultOpencodePath = getDefaultOpencodeConfigPath();
  const opencodeExists = existsSync(defaultOpencodePath);

  let opencodePath: string | undefined;

  if (!opencodeExists) {
    ui.info(`Default OpenCode config not found at ${defaultOpencodePath}`);
    const customPath = ui.assertNotCancelled(await ui.text({
      message: 'Path to opencode.json (or press Enter to skip)',
      placeholder: 'Press Enter to skip',
      validate: () => undefined,
    }));

    if (customPath && customPath.trim()) {
      opencodePath = customPath.trim();
    }
  } else {
    opencodePath = defaultOpencodePath;
  }

  if (opencodePath) {
    const shouldConfigure = ui.assertNotCancelled(await ui.confirm({
      message: 'Configure opencode.json to use this proxy?',
      initialValue: true,
    }));

    if (shouldConfigure) {
      const result = updateOpencodeConfig(port, { configPath: opencodePath });

      if (result.success) {
        if (result.created) {
          ui.success(`Created opencode.json at ${result.path}`);
        } else {
          ui.success(`Updated opencode.json at ${result.path}`);
          ui.info('A backup was saved to opencode.json.backup');
        }
        ui.info('If OpenCode is running, restart it to pick up the changes');
      } else {
        ui.warn(`Could not update opencode.json: ${result.error}`);
        ui.info('You can manually add this to your opencode.json:');
        console.log(chalk.dim(generateManualConfigSnippet(port)));
      }
    } else {
      ui.info('Skipped automatic configuration. Add this to your opencode.json manually:');
      console.log(chalk.dim(generateManualConfigSnippet(port)));
    }
  } else {
    ui.info('Skipped OpenCode configuration. Add this to your opencode.json manually:');
    console.log(chalk.dim(generateManualConfigSnippet(port)));
  }

  // --- Step 8: Success ---
  ui.printConfigSummary(cfg, encryptionKey !== undefined, envSaved);
  ui.printNextSteps(cfg.port);
  ui.outro('Setup complete');
}

// ---------------------------------------------------------------------------
// Entry point when run directly
// ---------------------------------------------------------------------------

// Only run if this is the main module
const isMain =
  process.argv[1] &&
  (pathResolve(process.argv[1]) === pathResolve(fileURLToPath(import.meta.url)) ||
    process.argv[1].endsWith('setup.ts'));

if (isMain) {
  setup().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    ui.outro(chalk.red(`Setup failed: ${message}`));
    process.exit(1);
  });
}
