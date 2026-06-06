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

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { stringify as stringifyYaml } from 'yaml';
import { spawn, exec, execFileSync, type ChildProcess } from 'node:child_process';
import { resolve as pathResolve, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskKey } from '../logger.js';
import { encryptKey } from '../key-encryption.js';
import { extractFirefoxAuthCookie, extractFirefoxWorkspaceIds } from '../firefox-cookies.js';
import { scrapeDashboard } from '../scraper.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = pathResolve(fileURLToPath(import.meta.url), '..', '..', '..');
const DEFAULT_PORT = 3000;
const DEFAULT_UPSTREAM = 'https://opencode.ai';

const BANNER = `
  ┌─ OpenCode-Go Proxy Setup ───────────────────────────────┐
  │  Configure your multi-account API proxy                  │
  │  Press Ctrl+C to cancel anytime                          │
  └──────────────────────────────────────────────────────────┘
`;

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
// CLI progress helpers (zero-dependency, carriage-return based)
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ['|', '/', '-', '\\'];

/**
 * Create a simple spinner that updates in-place using \r.
 * Must call .stop() or .succeed() when done.
 */
function createSpinner(text: string) {
  let interval: ReturnType<typeof setInterval> | null = null;
  let idx = 0;
  let running = true;

  const write = (frame: string) => {
    process.stdout.write(`\r  ${frame} ${text}\x1B[K`);
  };

  return {
    start() {
      running = true;
      idx = 0;
      write(SPINNER_FRAMES[0]);
      interval = setInterval(() => {
        if (!running) return;
        idx = (idx + 1) % SPINNER_FRAMES.length;
        write(SPINNER_FRAMES[idx]);
      }, 120);
    },
    stop() {
      running = false;
      if (interval) { clearInterval(interval); interval = null; }
    },
    succeed(finalText?: string) {
      this.stop();
      process.stdout.write(`\r  -> ${finalText || text}\x1B[K\n`);
    },
    fail(finalText?: string) {
      this.stop();
      process.stdout.write(`\r  [ERR] ${finalText || text}\x1B[K\n`);
    },
    message(newText: string) {
      text = newText;
    },
  };
}

/**
 * Show an in-place progress line using \r.
 * Call with done=true to finalize.
 */
function showProgress(current: number, total: number, label: string, done = false) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const width = 20;
  const filled = Math.round((current / total) * width);
  const bar = '='.repeat(filled) + '-'.repeat(Math.max(0, width - filled));
  const line = `\r  ${label}  [${bar}] ${pct}%\x1B[K`;
  if (done) {
    process.stdout.write(`${line}\n`);
  } else {
    process.stdout.write(line);
  }
}

const style = {
  section: (s: string) => `  ── ${s} ──`,
  divider: (s: string) => `  ── ${s}`,
  label: (s: string) => `  ${s}:`,
  defaultVal: (s: string) => `[${s}]`,
  success: (s: string) => `  -> ${s}`,
  error:   (s: string) => `  [ERR] ${s}`,
  warning: (s: string) => `  [!] ${s}`,
  info:    (s: string) => `  [i] ${s}`,
  bullet:  (s: string) => `  - ${s}`,
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function isValidPort(val: string): boolean {
  const trimmed = val.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  const n = parseInt(trimmed, 10);
  return n >= 1 && n <= 65535;
}

export function isValidApiKey(val: string): boolean {
  return val.startsWith('sk-') && val.length >= 20;
}

export function isValidHttpsUrl(val: string): boolean {
  try {
    const url = new URL(val.trim());
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isValidPositiveInt(val: string, min = 1, max = 100): boolean {
  const trimmed = val.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  const n = parseInt(trimmed, 10);
  return n >= min && n <= max;
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

interface PromptOptions {
  question: string;
  defaultVal?: string;
  validate?: (val: string) => boolean;
  errorMsg?: string;
  required?: boolean;
  enterToContinue?: boolean;
}

async function promptInput(
  rl: ReturnType<typeof createInterface>,
  options: PromptOptions,
): Promise<string> {
  const { question, defaultVal, validate, errorMsg, required = true, enterToContinue } = options;

  while (true) {
    let prompt: string;
    if (enterToContinue) {
      prompt = `  → Press [Enter] when ready, [Ctrl+C] to cancel `;
    } else {
      const defaultPart = defaultVal ? ` [${defaultVal}]` : '';
      prompt = `  ${question}${defaultPart}: `;
    }
    const answer = (await rl.question(prompt)).trim();

    if (answer === '' && defaultVal !== undefined) {
      return defaultVal;
    }

    if (answer === '' && !required) {
      return '';
    }

    if (answer === '' && required) {
      console.log(style.warning('This field is required. Please enter a value.'));
      continue;
    }

    if (validate && !validate(answer)) {
      console.log(style.warning(errorMsg || 'Invalid value. Please try again.'));
      continue;
    }

    return answer;
  }
}

/**
 * Prompt for a yes/no confirmation.
 */
async function promptConfirm(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultVal: 'y' | 'n' = 'n',
): Promise<boolean> {
  const answer = await promptInput(rl, {
    question: `${question} (y/n)`,
    defaultVal,
    validate: (v: string) => v.toLowerCase() === 'y' || v.toLowerCase() === 'n',
    errorMsg: 'Please enter "y" or "n".',
  });
  return answer.toLowerCase() === 'y';
}

// ---------------------------------------------------------------------------
// Masked input (character-by-character, displays * instead of plaintext)
// ---------------------------------------------------------------------------

/**
 * Read a line of input from stdin with masking (displays * instead of characters).
 *
 * Uses raw mode to capture keystrokes and clears the line (via ANSI \x1B[K)
 * before each rewrite to override any terminal echo (Windows does not suppress
 * echo in raw mode; the clear-line escape reliably erases any echoed chars).
 *
 * Falls back to visible input if raw mode is not supported (non-TTY environments).
 */
async function readMaskedInput(prompt: string): Promise<string> {
  const wasRaw = process.stdin.isRaw;

  try {
    process.stdin.setRawMode(true);
  } catch {
    throw new Error('raw mode not supported');
  }

  process.stdout.write(prompt);

  let input = '';

  // Rewrite the line with current input masked as *.
  // Uses \x1B[K (clear-to-end-of-line) to erase any terminal-echoed characters
  // that Windows raw mode doesn't suppress.
  const render = () => {
    process.stdout.write(`\r${prompt}${'*'.repeat(input.length)}\x1B[K`);
  };

  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      try { process.stdin.setRawMode(wasRaw ?? false); } catch { /* ignore */ }
    };

    const onData = (data: Buffer) => {
      for (const char of data.toString()) {
        if (char === '\r' || char === '\n') {
          cleanup();
          // The terminal echoed \r\n when Enter was pressed, moving us to the
          // next line. Just move to the beginning of that line — the * line
          // from the last render() is already visible above.
          process.stdout.write(`\r\n`);
          resolve(input);
          return;
        }
        if (char === '\x03') {
          // Ctrl+C — set proper exit code (130 = SIGINT) and let caller clean up
          cleanup();
          process.stdout.write('^C\n');
          process.exitCode = 130;
          reject(new Error('Cancelled'));
          return;
        }
        if (char === '\x7f' || char === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            render();
          }
          continue;
        }
        // Skip control characters (allow tab)
        if (char.charCodeAt(0) < 32 && char !== '\t') continue;
        input += char;
        render();
      }
    };

    const onEnd = () => {
      cleanup();
      reject(new Error('stdin closed unexpectedly'));
    };

    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
  });
}

// ---------------------------------------------------------------------------
// Secret prompt (masks input)
// ---------------------------------------------------------------------------

/**
 * Prompt for a secret value (e.g. API key or encryption key).
 * Uses character-by-character raw mode input to display * instead of plaintext.
 * Falls back to visible input if raw mode is not supported.
 */
async function promptSecret(
  rl: ReturnType<typeof createInterface>,
  options: { question: string; validate?: (val: string) => boolean; errorMsg?: string; hint?: string },
): Promise<string> {
  const { question, validate, errorMsg, hint } = options;

  while (true) {
    const hintPart = hint ? ` (${hint})` : '';
    const prompt = `  ${question}${hintPart}: `;

    let answer: string;
    try {
      answer = (await readMaskedInput(prompt)).trim();
    } catch {
      // Fall back to visible input if raw mode fails
      answer = (await rl.question(prompt)).trim();
    }

    if (answer === '') {
      console.log(style.warning('This value is required.'));
      continue;
    }

    if (validate && !validate(answer)) {
      console.log(style.warning(errorMsg || 'Invalid value. Please try again.'));
      continue;
    }

    return answer;
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

export interface ScrapingAccountSetup {
  workspaceId: string;
  authCookie: string;
}

/** @returns true if the function is exported (for backward compat) */
export const setupScrapingAccounts = undefined as unknown as
  (rl: ReturnType<typeof createInterface>, encryptionKey?: string) => Promise<ScrapingAccountSetup[]>;

export interface SetupConfig {
  port: number;
  upstreamBaseUrl: string;
  keys: Array<{ label: string; key: string }>;
  scrapingAccounts?: ScrapingAccountSetup[];
  scrapingThreshold?: number;
  scrapingIntervalMs?: number;
}

export function generateYaml(cfg: SetupConfig, encryptionEnabled = false): string {
  const config: Record<string, unknown> = {
    port: cfg.port,
    host: '127.0.0.1',
    upstreamBaseUrl: cfg.upstreamBaseUrl,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
    requestTimeoutMs: 30_000,
    allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],
    keys: cfg.keys,
  };

  if (cfg.scrapingAccounts && cfg.scrapingAccounts.length > 0) {
    config.scraping = {
      enabled: true,
      intervalMs: cfg.scrapingIntervalMs ?? 90_000,
      usageThreshold: cfg.scrapingThreshold ?? 50,
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

export async function testProxy(port: number, timeoutMs = 20_000, cwd = PACKAGE_ROOT, encryptionKey?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Resolve the entry point relative to the package root
    const entryPoint = pathResolve(PACKAGE_ROOT, 'src', 'index.ts');

    // Use single-command form with shell:true to avoid DEP0190 deprecation
    // (Node.js deprecates passing both shell:true and separate args)
    const cmd = `npx tsx "${entryPoint}" --port ${port}`;
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

          console.log(style.success(`Health check returned status "${data.status}"`));
          console.log(style.success(`${data.enabledCount}/${data.keyCount} API key(s) enabled`));
          if (data.disabledCount > 0) {
            console.log(style.warning(`${data.disabledCount} key(s) disabled (check API key validity)`));
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

export function backupExistingConfig(configDir = PACKAGE_ROOT): boolean {
  const configPath = pathResolve(configDir, 'config.yaml');
  if (!existsSync(configPath)) return false;

  const backupPath = pathResolve(configDir, 'config.yaml.backup');
  try {
    const content = readFileSync(configPath, 'utf-8');
    writeFileSync(backupPath, content, { encoding: 'utf-8', mode: 0o600 });
    console.log(style.info('Existing config.yaml backed up to config.yaml.backup'));
    return true;
  } catch (err) {
    console.log(style.warning(`Could not create backup: ${err}`));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Summary / next steps
// ---------------------------------------------------------------------------

function printSuccess(cfg: SetupConfig, encryptionEnabled = false, envSaved = false): void {
  const innerWidth = 50;
  const topBorder = `  ┌─ Configuration Summary ${'─'.repeat(Math.max(0, innerWidth - 24))}┐`;
  const bottomBorder = `  └${'─'.repeat(innerWidth)}┘`;
  const emptyLine = `  │${' '.repeat(innerWidth)}│`;

  const row = (left: string, right: string) => {
    const content = ` ${left.padEnd(21, ' ')}${right}`;
    const padded = content.padEnd(innerWidth + 1, ' ');
    return `  │${padded}│`;
  };

  console.log('');
  console.log(topBorder);
  console.log(emptyLine);
  console.log(row('Proxy port:', String(cfg.port)));
  console.log(row('Upstream API:', cfg.upstreamBaseUrl));
  console.log(row('API keys:', String(cfg.keys.length)));

  if (encryptionEnabled) {
    console.log(row('', `${cfg.keys.length} key(s) encrypted with AES-256-GCM`));
  } else {
    for (const k of cfg.keys) {
      console.log(row('', `${k.label.padEnd(12)}  ${maskKey(k.key)}`));
    }
  }

  if (cfg.scrapingAccounts && cfg.scrapingAccounts.length > 0) {
    console.log(emptyLine);
    console.log(row('Scraping accounts:', String(cfg.scrapingAccounts.length)));
    console.log(row('Usage threshold:', `${cfg.scrapingThreshold ?? 50}%`));
    console.log(row('Check interval:', `${((cfg.scrapingIntervalMs ?? 90_000) / 1000)}s`));
  }

  console.log(emptyLine);
  console.log(bottomBorder);

  if (encryptionEnabled && !envSaved) {
    console.log('');
    console.log(style.warning('IMPORTANT: Your API keys are encrypted.'));
    console.log(style.info('Set OPENCODE_GO_ENCRYPTION_KEY before starting:'));
    console.log('    $ export OPENCODE_GO_ENCRYPTION_KEY="your-master-key"');
    console.log('    $ npm run dev');
  }

  console.log('');
  console.log(style.section('Next Steps'));
  console.log('');
  console.log(style.bullet('Start the proxy:      $ npm run dev'));
  console.log(style.bullet('Extension endpoint:   http://127.0.0.1:' + cfg.port));
  console.log(style.bullet('Health check:         $ curl http://127.0.0.1:' + cfg.port + '/health'));
  console.log('');
  console.log(style.section('Manage'));
  console.log('');
  console.log(style.bullet('Re-run setup anytime: $ npm run setup'));
  console.log(style.bullet('Edit config.yaml directly (circuit breaker, CORS, timeouts)'));
  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function setup(configDir = PACKAGE_ROOT, skipSmokeTest = false): Promise<void> {
  console.log(BANNER);

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    console.log(style.section('Server Configuration'));
    console.log('');

    // --- Step 1: Proxy port ---
    const portStr = await promptInput(rl, {
      question: 'Proxy port',
      defaultVal: String(DEFAULT_PORT),
      validate: isValidPort,
      errorMsg: 'Port must be a number between 1 and 65535.',
    });
    const port = parseInt(portStr, 10);

    // --- Step 2: Upstream URL ---
    const upstreamBaseUrl = await promptInput(rl, {
      question: 'Upstream API base URL',
      defaultVal: DEFAULT_UPSTREAM,
      validate: isValidHttpsUrl,
      errorMsg: 'Must be a valid HTTPS URL (e.g. https://opencode.ai).',
    });

    // --- Step 4: Number of accounts ---
    const numAccountsStr = await promptInput(rl, {
      question: 'Number of accounts',
      defaultVal: '2',
      validate: (v) => isValidPositiveInt(v, 1, 100),
      errorMsg: 'Must be a number between 1 and 100.',
    });
    const numAccounts = parseInt(numAccountsStr, 10);

    // --- Step 4.5: Encrypt keys? ---
    const encryptKeys = await promptInput(rl, {
      question: 'Encrypt API keys (recommended for security)',
      defaultVal: 'y',
      validate: (v) => v.toLowerCase() === 'y' || v.toLowerCase() === 'n',
      errorMsg: 'Please enter "y" or "n"',
    });

    let encryptionKey: string | undefined;
    let envSaved = false;
    if (encryptKeys.toLowerCase() === 'y') {
      encryptionKey = await promptSecret(rl, {
        question: 'Master encryption key (min 16 characters)',
        validate: (v) => v.length >= 16,
        errorMsg: 'Encryption key must be at least 16 characters long',
      });
      console.log(style.success('All API keys will be encrypted with AES-256-GCM'));

      // Offer to persist OPENCODE_GO_ENCRYPTION_KEY to the environment
      const saveEnv = await promptConfirm(rl, 'Save OPENCODE_GO_ENCRYPTION_KEY to your environment', 'y');
      if (saveEnv) {
        if (saveEnvVar('OPENCODE_GO_ENCRYPTION_KEY', encryptionKey)) {
          console.log(style.success('OPENCODE_GO_ENCRYPTION_KEY saved'));
          envSaved = true;
        } else {
          console.log(style.warning('Could not save to environment. Set it manually:'));
          console.log(`    export OPENCODE_GO_ENCRYPTION_KEY="${encryptionKey}"`);
        }
      }
    }

    // --- Step 4.6: Usage-based scraping? ---
    const wantScraping = await promptConfirm(rl, 'Enable usage-based account switching', 'y');
    let scrapingAccounts: ScrapingAccountSetup[] | undefined;
    let scrapingThreshold: number | undefined;
    let scrapingIntervalMs: number | undefined;

    if (wantScraping) {
      console.log('');
      console.log(style.divider('Usage-Based Switching Config'));
      console.log('');
      const thresholdStr = await promptInput(rl, {
        question: 'Usage threshold (switch when usage exceeds this %)',
        defaultVal: '70',
        validate: (v) => /^\d+$/.test(v) && parseInt(v) >= 1 && parseInt(v) <= 100,
        errorMsg: 'Enter a number between 1 and 100.',
      });
      scrapingThreshold = parseInt(thresholdStr, 10);

      const intervalStr = await promptInput(rl, {
        question: 'Scrape interval in seconds',
        defaultVal: '90',
        validate: (v) => /^\d+$/.test(v) && parseInt(v) >= 10,
        errorMsg: 'Enter a number of seconds (minimum 10).',
      });
      scrapingIntervalMs = parseInt(intervalStr, 10) * 1000;
      scrapingAccounts = [];
    }

    // --- Step 4.7: Collect account credentials (one round per account) ---
    const keys: Array<{ label: string; key: string }> = [];
    const seenCookies = new Set<string>();
    const seenWorkspaceIds = new Set<string>();

    for (let i = 0; i < numAccounts; i++) {
      console.log('');
      console.log(style.divider(`Account ${i + 1} of ${numAccounts}`));
      console.log('');

      // --- 4.7.1: Label ---
      const label = await promptInput(rl, {
        question: 'Label for this account',
        defaultVal: `account${i + 1}`,
        required: true,
      });

      // --- 4.7.2: API key ---
      const key = await promptSecret(rl, {
        question: 'API key',
        hint: 'paste',
        validate: isValidApiKey,
        errorMsg: 'API key must start with "sk-" and be at least 20 characters long.',
      });

      // Encrypt on the spot if encryption enabled
      const finalKey = encryptionKey ? encryptKey(key, encryptionKey) : key;
      keys.push({ label, key: finalKey });
      console.log(style.success(`"${label}" API key configured`));

      // --- 4.7.3: Scraping credentials (if enabled) ---
      if (wantScraping) {
        console.log('');
        console.log(style.info(`Log into ${i === 0 ? 'first' : ordinal(i + 1)} account in Firefox, then press Enter`));

        await promptInput(rl, {
          question: '',
          enterToContinue: true,
          required: false,
        });

        // Extract cookie
        const extractSpinner = createSpinner('Extracting auth cookie from Firefox...');
        extractSpinner.start();
        const cookieResult = extractFirefoxAuthCookie();
        extractSpinner.stop();

        let authCookie: string | null = cookieResult.cookie ?? null;

        if (!authCookie) {
          console.log(`  [!] Firefox extraction: ${cookieResult.error || 'No cookie found'}`);
          authCookie = await promptInput(rl, {
            question: 'Auth cookie value (from Firefox DevTools)',
            validate: (v) => v.length >= 10,
            errorMsg: 'Cookie value must be at least 10 characters.',
          });
        } else {
          console.log('  -> Auth cookie extracted from Firefox');
        }

        // Duplicate cookie check
        if (seenCookies.has(authCookie)) {
          console.log(style.warning('This cookie matches a previous account. Did you log out?'));
          const retry = await promptConfirm(rl, 'Try again with a different account', 'y');
          if (retry) {
            authCookie = await promptInput(rl, {
              question: 'Auth cookie value (from Firefox DevTools)',
              validate: (v) => v.length >= 10,
              errorMsg: 'Cookie value must be at least 10 characters.',
            });
          }
        }

        // Extract workspace IDs
        const workspaceIds = extractFirefoxWorkspaceIds();
        let workspaceId: string | null = null;

        if (workspaceIds.length > 0) {
          if (workspaceIds.length === 1) {
            workspaceId = workspaceIds[0];
            console.log(style.success(`Found workspace: ${workspaceId}`));
          } else {
            console.log('  Workspaces found in Firefox history:\n');
            for (let w = 0; w < workspaceIds.length; w++) {
              console.log(`    ${w + 1}) ${workspaceIds[w]}`);
              console.log(`       https://opencode.ai/workspace/${workspaceIds[w]}/go`);
            }
            console.log('');
            const choiceStr = await promptInput(rl, {
              question: 'Enter the number for this account',
              defaultVal: '1',
              validate: (v) => /^\d+$/.test(v) && parseInt(v) >= 1 && parseInt(v) <= workspaceIds.length,
              errorMsg: `Enter a number between 1 and ${workspaceIds.length}.`,
            });
            workspaceId = workspaceIds[parseInt(choiceStr, 10) - 1];
          }
        } else {
          workspaceId = await promptInput(rl, {
            question: 'Workspace ID (wrk_...)',
            validate: (v) => /^wrk_[A-Za-z0-9]+$/.test(v),
            errorMsg: 'Must match format: wrk_... (e.g. wrk_abc123).',
          });
        }

        // Duplicate workspace check
        if (seenWorkspaceIds.has(workspaceId)) {
          console.log(style.warning('This workspace ID belongs to another account.'));
          const retry = await promptConfirm(rl, 'Enter a different workspace ID', 'y');
          if (retry) {
            workspaceId = await promptInput(rl, {
              question: 'Workspace ID (wrk_...)',
              validate: (v) => /^wrk_[A-Za-z0-9]+$/.test(v),
              errorMsg: 'Must match format: wrk_... (e.g. wrk_abc123).',
            });
          }
        }

        // Validate cookie by scraping dashboard
        const spinner = createSpinner('Validating cookie against opencode.ai...');
        spinner.start();
        const scrapeResult = await scrapeDashboard(workspaceId, authCookie);
        spinner.stop();

        if (scrapeResult.success) {
          const usage = scrapeResult.usage;
          const usageLine = [
            usage?.rolling !== null && usage?.rolling !== undefined ? `Rolling: ${usage.rolling}%` : '',
            usage?.weekly !== null && usage?.weekly !== undefined ? `Weekly: ${usage.weekly}%` : '',
            usage?.monthly !== null && usage?.monthly !== undefined ? `Monthly: ${usage.monthly}%` : '',
          ].filter(Boolean).join('  ');
          console.log(`  -> Cookie validated — ${usageLine}`);
        } else {
          console.log(`  [ERR] Validation failed: ${scrapeResult.error || 'Unknown error'}`);
          const retry = await promptConfirm(rl, 'Try again', 'y');
          if (retry) {
            workspaceId = await promptInput(rl, {
              question: 'Workspace ID (wrk_...)',
              validate: (v) => /^wrk_[A-Za-z0-9]+$/.test(v),
              errorMsg: 'Must match format: wrk_... (e.g. wrk_abc123).',
            });
            const retrySpinner = createSpinner(`Retrying validation with workspace ${workspaceId}...`);
            retrySpinner.start();
            const retryResult = await scrapeDashboard(workspaceId, authCookie);
            retrySpinner.stop();
            if (retryResult.success) {
              const u = retryResult.usage;
              const ul = [
                u?.rolling != null ? `Rolling: ${u.rolling}%` : '',
                u?.weekly != null ? `Weekly: ${u.weekly}%` : '',
                u?.monthly != null ? `Monthly: ${u.monthly}%` : '',
              ].filter(Boolean).join('  ');
              console.log(`  -> Cookie validated — ${ul}`);
            } else {
              console.log(`  [ERR] Still failed: ${retryResult.error || 'Unknown'}`);
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
      console.log('');
      console.log(style.success(`${scrapingAccounts.length} cookie(s) encrypted`));
    }

    // --- Step 5: Build config and write ---
    const cfg: SetupConfig = { port, upstreamBaseUrl, keys, scrapingAccounts, scrapingThreshold, scrapingIntervalMs };
    const yaml = generateYaml(cfg, encryptionKey !== undefined);

    // Backup existing config
    backupExistingConfig(configDir);

    // Write new config
    const configPath = pathResolve(configDir, 'config.yaml');
    writeFileSync(configPath, yaml, { encoding: 'utf-8', mode: 0o600 });
    console.log('');
    console.log(style.success(`config.yaml written to ${configPath}`));

    // --- Step 6: Smoke test ---
    if (!skipSmokeTest) {
      console.log('');
      console.log(style.info(`Starting proxy smoke test on port ${port}...`));
      try {
        await testProxy(port, 20_000, configDir, encryptionKey);
        console.log(style.success('Smoke test passed — proxy is working correctly'));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log('');
        console.log(style.warning(`Smoke test warning: ${message}`));
        console.log(style.info('The config.yaml has been saved. You can troubleshoot by running:'));
        console.log('    $ npm run dev');
        console.log('');
        // Don't exit with error — config.yaml is already written
      }
    }

    // --- Step 7: Success ---
    printSuccess(cfg, encryptionKey !== undefined, envSaved);
  } finally {
    rl.close();
  }
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
    console.error('');
    console.error(style.error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  });
}
