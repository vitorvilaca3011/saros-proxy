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
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = pathResolve(fileURLToPath(import.meta.url), '..', '..', '..');
const DEFAULT_PORT = 3000;
const DEFAULT_UPSTREAM = 'https://opencode.ai';

const BANNER = `
╔══════════════════════════════════════════════════════════════╗
║        OpenCode-Go Proxy — Setup Wizard                      ║
║        Configure your multi-account API proxy in minutes     ║
╚══════════════════════════════════════════════════════════════╝
`;

const DIVIDER = '─'.repeat(58);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidPort(val: string): boolean {
  const trimmed = val.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  const n = parseInt(trimmed, 10);
  return n >= 1 && n <= 65535;
}

function isValidApiKey(val: string): boolean {
  return val.startsWith('sk-') && val.length >= 20;
}

function isValidHttpsUrl(val: string): boolean {
  try {
    const url = new URL(val.trim());
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidPositiveInt(val: string, min = 1, max = 100): boolean {
  const trimmed = val.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  const n = parseInt(trimmed, 10);
  return n >= min && n <= max;
}

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '…' + key.slice(-4);
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
  secret?: boolean;
}

async function promptInput(
  rl: ReturnType<typeof createInterface>,
  options: PromptOptions,
): Promise<string> {
  const { question, defaultVal, validate, errorMsg, required = true } = options;

  while (true) {
    const suffix = defaultVal ? ` [${defaultVal}]` : '';
    const prefix = options.secret ? '' : '';
    const answer = (await rl.question(`${prefix}${question}${suffix}: `)).trim();

    if (answer === '' && defaultVal !== undefined) {
      return defaultVal;
    }

    if (answer === '' && !required) {
      return '';
    }

    if (answer === '' && required) {
      console.log('  ⚠  This field is required. Please enter a value.');
      continue;
    }

    if (validate && !validate(answer)) {
      console.log(`  ⚠  ${errorMsg || 'Invalid value. Please try again.'}`);
      continue;
    }

    return answer;
  }
}

// ---------------------------------------------------------------------------
// Config generation
// ---------------------------------------------------------------------------

interface SetupConfig {
  port: number;
  upstreamBaseUrl: string;
  keys: Array<{ label: string; key: string }>;
}

function generateYaml(cfg: SetupConfig): string {
  const config = {
    port: cfg.port,
    host: '127.0.0.1',
    upstreamBaseUrl: cfg.upstreamBaseUrl,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
    requestTimeoutMs: 30_000,
    allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],
    keys: cfg.keys,
  };

  return stringifyYaml(config);
}

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

async function testProxy(port: number, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    // Resolve the entry point relative to the package root
    const entryPoint = pathResolve(PACKAGE_ROOT, 'src', 'index.ts');

    // Use stdio: 'pipe' for all to simplify types
    const child: ChildProcess = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['tsx', entryPoint, '--port', String(port)],
      {
        cwd: PACKAGE_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        env: {
          ...process.env,
          LOG_LEVEL: 'silent',
          NODE_ENV: 'production',
        },
      },
    );

    let started = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      reject(new Error('Proxy did not start within the allotted time.'));
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
          started = true;
          clearTimeout(timer);
          clearInterval(pollId);

          const data = await res.json();
          console.log(`  ✓ Health check returned status "${data.status}"`);
          console.log(`  ✓ ${data.enabledCount}/${data.keyCount} API key(s) enabled`);
          if (data.disabledCount > 0) {
            console.log(`  ⚠  ${data.disabledCount} key(s) disabled (check API key validity)`);
          }

          // Give the server a moment to settle, then kill it
          setTimeout(() => {
            child.kill();
            resolve();
          }, 300);
        }
      } catch {
        // Server not ready yet — keep polling
      }
    }, 400);

    child.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(pollId);
      if (!started) reject(new Error(`Failed to start proxy process: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      clearInterval(pollId);

      if (!started && code !== 0 && code !== null) {
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

function backupExistingConfig(): boolean {
  const configPath = pathResolve(PACKAGE_ROOT, 'config.yaml');
  if (!existsSync(configPath)) return false;

  const backupPath = pathResolve(PACKAGE_ROOT, 'config.yaml.backup');
  try {
    const content = readFileSync(configPath, 'utf-8');
    writeFileSync(backupPath, content, 'utf-8');
    console.log(`  ℹ  Existing config.yaml backed up to config.yaml.backup`);
    return true;
  } catch (err) {
    console.log(`  ⚠  Could not create backup: ${err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Summary / next steps
// ---------------------------------------------------------------------------

function printSuccess(cfg: SetupConfig): void {
  const keysSummary = cfg.keys
    .map((k) => `    • ${k.label}: ${maskKey(k.key)}`)
    .join('\n');

  console.log(`
${DIVIDER}
 ✅  Setup complete!                                           
${DIVIDER}

Your configuration has been written to config.yaml.

  Proxy port:        ${cfg.port}
  Upstream API:      ${cfg.upstreamBaseUrl}
  API keys:          ${cfg.keys.length}
${keysSummary}

${DIVIDER}
 Next steps                                                    
${DIVIDER}

  1. Start the proxy:
     $ npm run dev

  2. Or start with a custom config:
     $ npx tsx src/index.ts --port ${cfg.port}

  3. Configure your OpenCode-Go extension to use:
     http://127.0.0.1:${cfg.port}

  4. Check the health endpoint:
     $ curl http://127.0.0.1:${cfg.port}/health

${DIVIDER}
 Need help?                                                    
${DIVIDER}

  • Edit config.yaml directly to adjust advanced settings
    (circuit breaker, CORS origins, request timeouts, etc.)
  • Run this setup again at any time:
    $ npm run setup
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function setup(): Promise<void> {
  console.log(BANNER);
  console.log('This wizard will help you configure your OpenCode-Go proxy.');
  console.log('Press Ctrl+C at any time to cancel.\n');

  const rl = createInterface({ input: stdin, output: stdout });

  try {
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

    // --- Step 3: Number of API keys ---
    const numKeysStr = await promptInput(rl, {
      question: 'Number of API keys to configure',
      defaultVal: '1',
      validate: (v) => isValidPositiveInt(v, 1, 100),
      errorMsg: 'Must be a number between 1 and 100.',
    });
    const numKeys = parseInt(numKeysStr, 10);

    // --- Step 4: Collect keys ---
    const keys: Array<{ label: string; key: string }> = [];
    for (let i = 0; i < numKeys; i++) {
      console.log(`\n  ── Key #${i + 1} ──`);
      const label = await promptInput(rl, {
        question: '  Name/label for this key',
        defaultVal: `account${i + 1}`,
        required: true,
      });

      const key = await promptInput(rl, {
        question: '  API key',
        validate: isValidApiKey,
        errorMsg:
          'API key must start with "sk-" and be at least 20 characters long.',
        secret: true,
      });

      keys.push({ label, key });

      // Show masked confirmation
      console.log(`    → Added key "${label}": ${maskKey(key)}`);
    }

    // --- Step 5: Build config and write ---
    const cfg: SetupConfig = { port, upstreamBaseUrl, keys };
    const yaml = generateYaml(cfg);

    // Backup existing config
    backupExistingConfig();

    // Write new config
    const configPath = pathResolve(PACKAGE_ROOT, 'config.yaml');
    writeFileSync(configPath, yaml, 'utf-8');
    console.log(`\n  ✓ config.yaml written to ${configPath}`);

    // --- Step 6: Smoke test ---
    console.log(`\n  🔍 Starting proxy smoke test on port ${port}...`);
    try {
      await testProxy(port);
      console.log(`  ✓ Smoke test passed — proxy is working correctly`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`\n  ⚠  Smoke test warning: ${message}`);
      console.log(`  ℹ  The config.yaml has been saved. You can troubleshoot by running:`);
      console.log(`     $ npm run dev\n`);
      // Don't exit with error — config.yaml is already written
    }

    // --- Step 7: Success ---
    printSuccess(cfg);
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
    console.error(`\n  ✖ Setup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
