/**
 * setup-wizard.ts — Prototype: Interactive setup wizard for multi-account scraping
 *
 * Flow:
 * 1. Ask how many accounts
 * 2. For each account:
 *    - Instruct user to log in to that account in Firefox
 *    - Wait for Enter
 *    - Auto-extract cookie from Firefox cookies.sqlite
 *    - Validate cookie by scraping dashboard
 *    - Check cookie is different from previous accounts
 * 3. Write config to prototype/scraper-creds.json
 * 4. Run doctor check
 *
 * Run with: npm run proto:setup
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import * as readline from 'node:readline';
import { encryptKey } from '../src/key-encryption.js';

const ANSI = {
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  CYAN: '\x1b[36m',
  RESET: '\x1b[0m',
};

interface AccountCreds {
  workspaceId: string;
  authCookie: string;
}

// ═══════════════════════════════════════════════════════════════════════
// FIREFOX COOKIE EXTRACTION (reused from dashboard-scraper.ts)
// ══════════════════════════════════════════════════════════════════════

function findFirefoxProfileDir(): string | null {
  const platform = process.platform;
  let root: string;

  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) return null;
    root = join(appData, 'Mozilla', 'Firefox', 'Profiles');
  } else if (platform === 'darwin') {
    root = join(homedir(), 'Library', 'Application Support', 'Firefox', 'Profiles');
  } else if (platform === 'linux') {
    root = join(homedir(), '.mozilla', 'firefox');
  } else {
    return null;
  }

  if (!existsSync(root)) return null;

  try {
    const profiles = readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);

    if (profiles.length === 0) return null;

    const preferred = profiles.find(p => p.includes('default-release')) ?? profiles[0];
    return join(root, preferred);
  } catch {
    return null;
  }
}

function extractFirefoxAuthCookie(): { cookie: string | null; error?: string } {
  const profileDir = findFirefoxProfileDir();
  if (!profileDir) return { cookie: null, error: 'Firefox profile not found' };

  const cookiesDb = join(profileDir, 'cookies.sqlite');
  if (!existsSync(cookiesDb)) return { cookie: null, error: 'cookies.sqlite not found' };

  const tempDir = mkdirSync(join(tmpdir(), 'proto-setup-' + Date.now()), { recursive: true });
  if (!tempDir) return { cookie: null, error: 'Failed to create temp directory' };
  const tempDb = join(tempDir, 'cookies.sqlite');

  try {
    copyFileSync(cookiesDb, tempDb);

    for (const ext of ['-wal', '-shm']) {
      const sidecar = cookiesDb + ext;
      if (existsSync(sidecar)) {
        copyFileSync(sidecar, tempDb + ext);
      }
    }

    const db = new DatabaseSync(tempDb, { readOnly: true });
    try {
      const stmt = db.prepare(`
        SELECT name, value, host
        FROM moz_cookies
        WHERE (host = 'opencode.ai' OR host = '.opencode.ai')
          AND name = 'auth'
        ORDER BY expiry DESC
        LIMIT 1
      `);

      const rows = stmt.all() as Array<{ name: string; value: string; host: string }>;
      return rows.length > 0 ? { cookie: rows[0].value } : { cookie: null, error: 'No auth cookie found for opencode.ai' };
    } finally {
      db.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('EBUSY') || msg.includes('EPERM') || msg.includes('locked')) {
      return { cookie: null, error: 'Firefox has the database locked. Close Firefox and try again.' };
    }
    return { cookie: null, error: msg };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function extractFirefoxWorkspaceIds(): string[] {
  const profileDir = findFirefoxProfileDir();
  if (!profileDir) return [];

  const placesDb = join(profileDir!, 'places.sqlite');
  if (!existsSync(placesDb)) return [];

  const tempDir = mkdirSync(join(tmpdir(), 'proto-setup-history-' + Date.now()), { recursive: true });
  if (!tempDir) return [];
  const tempDb = join(tempDir, 'places.sqlite');

  try {
    copyFileSync(placesDb, tempDb);

    for (const ext of ['-wal', '-shm']) {
      const sidecar = placesDb + ext;
      if (existsSync(sidecar)) {
        copyFileSync(sidecar, tempDb + ext);
      }
    }

    const db = new DatabaseSync(tempDb, { readOnly: true });
    try {
      const stmt = db.prepare(`
        SELECT url
        FROM moz_places
        WHERE url LIKE '%opencode.ai/workspace/%'
        ORDER BY last_visit_date DESC
        LIMIT 50
      `);

      const rows = stmt.all() as Array<{ url: string }>;
      const workspaceIds = new Set<string>();

      for (const row of rows) {
        const match = row.url.match(/\/workspace\/(wrk_[A-Za-z0-9]+)/);
        if (match) {
          workspaceIds.add(match[1]);
        }
      }

      return Array.from(workspaceIds);
    } finally {
      db.close();
    }
  } catch {
    return [];
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// DASHBOARD VALIDATION & USAGE EXTRACTION
// ═══════════════════════════════════════════════════════════════════════

const SCRAPED_NUMBER_PATTERN = String.raw`(-?\d+(?:\.\d+)?)`;

const RE_ROLLING_PCT_FIRST = new RegExp(
  String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);
const RE_ROLLING_RESET_FIRST = new RegExp(
  String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);
const RE_WEEKLY_PCT_FIRST = new RegExp(
  String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);
const RE_WEEKLY_RESET_FIRST = new RegExp(
  String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);
const RE_MONTHLY_PCT_FIRST = new RegExp(
  String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);
const RE_MONTHLY_RESET_FIRST = new RegExp(
  String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
);

interface UsageData {
  rolling: number | null;
  weekly: number | null;
  monthly: number | null;
}

function parseUsagePercent(html: string, rePctFirst: RegExp, reResetFirst: RegExp): number | null {
  const pctFirst = rePctFirst.exec(html);
  if (pctFirst) {
    const val = Number(pctFirst[1]);
    if (Number.isFinite(val)) return val;
  }
  const resetFirst = reResetFirst.exec(html);
  if (resetFirst) {
    const val = Number(resetFirst[2]);
    if (Number.isFinite(val)) return val;
  }
  return null;
}

async function validateAndFetchUsage(workspaceId: string, authCookie: string): Promise<{ valid: boolean; usage: UsageData | null; error?: string }> {
  const url = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000); // 15s timeout

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0',
        'Accept': 'text/html',
        'Cookie': `auth=${authCookie}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status === 401 || response.status === 403) {
      return { valid: false, usage: null, error: 'Cookie expired or invalid (401/403)' };
    }

    if (response.status === 429) {
      return { valid: false, usage: null, error: 'Rate limited by opencode.ai (429)' };
    }

    if (!response.ok) {
      return { valid: false, usage: null, error: `HTTP ${response.status}` };
    }

    const html = await response.text();
    if (!html.includes('rollingUsage') || !html.includes('$R[')) {
      return { valid: false, usage: null, error: 'Dashboard HTML format changed or wrong workspace' };
    }

    return {
      valid: true,
      usage: {
        rolling: parseUsagePercent(html, RE_ROLLING_PCT_FIRST, RE_ROLLING_RESET_FIRST),
        weekly: parseUsagePercent(html, RE_WEEKLY_PCT_FIRST, RE_WEEKLY_RESET_FIRST),
        monthly: parseUsagePercent(html, RE_MONTHLY_PCT_FIRST, RE_MONTHLY_RESET_FIRST),
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { valid: false, usage: null, error: 'Request timed out (15s)' };
    }
    return { valid: false, usage: null, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// INTERACTIVE PROMPTS
// ═══════════════════════════════════════════════════════════════════════

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

function pressEnter(message: string): Promise<void> {
  return new Promise((resolve) => {
    rl.question(message, () => {
      resolve();
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════
// SETUP WIZARD
// ═══════════════════════════════════════════════════════════════════════

async function runSetupWizard(): Promise<void> {
  console.log(ANSI.BOLD + ANSI.CYAN + 'OpenCode-Go Proxy — Multi-Account Setup Wizard' + ANSI.RESET);
  console.log(ANSI.DIM + 'This wizard will help you configure multiple accounts for usage-based switching.' + ANSI.RESET);
  console.log();

  // Check Firefox is available
  const profileDir = findFirefoxProfileDir();
  if (!profileDir) {
    console.error(ANSI.RED + 'Error: Firefox not found on this system.' + ANSI.RESET);
    console.error('Please install Firefox or use manual config (prototype/scraper-creds.json).');
    process.exit(1);
  }

  console.log(ANSI.GREEN + '✓ Firefox detected' + ANSI.RESET);
  console.log();

  // Ask how many accounts
  const numAccountsStr = await ask('How many accounts do you want to configure? ');
  const numAccounts = parseInt(numAccountsStr, 10);

  if (isNaN(numAccounts) || numAccounts < 1) {
    console.error(ANSI.RED + 'Error: Please enter a valid number (1 or more).' + ANSI.RESET);
    process.exit(1);
  }

  console.log();
  console.log(ANSI.BOLD + `Configuring ${numAccounts} account(s)...` + ANSI.RESET);
  console.log();

  const accounts: AccountCreds[] = [];
  const seenCookies = new Set<string>();

  for (let i = 1; i <= numAccounts; i++) {
    console.log(ANSI.BOLD + ANSI.CYAN + `═══════════════════════════════════════════════════════════` + ANSI.RESET);
    console.log(ANSI.BOLD + `Account ${i} of ${numAccounts}` + ANSI.RESET);
    console.log(ANSI.BOLD + ANSI.CYAN + `═══════════════════════════════════════════════════════════` + ANSI.RESET);
    console.log();

    if (i === 1) {
      console.log('1. Open Firefox and go to: https://opencode.ai');
      console.log('2. Log in to account ' + i);
      console.log('3. Navigate to the Go section: https://opencode.ai/workspace/YOUR_ID/go');
      console.log();
    } else {
      console.log('1. Log out of account ' + (i - 1) + ' in Firefox');
      console.log('2. Log in to account ' + i);
      console.log('3. Navigate to the Go section: https://opencode.ai/workspace/YOUR_ID/go');
      console.log();
    }

    await pressEnter('Press Enter when ready...');

    // Extract cookie
    console.log(ANSI.DIM + 'Extracting auth cookie from Firefox...' + ANSI.RESET);
    const cookieResult = extractFirefoxAuthCookie();

    if (!cookieResult.cookie) {
      console.error(ANSI.RED + 'Error: Could not extract auth cookie from Firefox.' + ANSI.RESET);
      if (cookieResult.error) {
        console.error(ANSI.DIM + '  Reason: ' + cookieResult.error + ANSI.RESET);
      }
      console.error('Make sure you are logged into opencode.ai in Firefox.');
      console.error();
      const retry = await ask('Retry? (y/n) ');
      if (retry.toLowerCase() === 'y') {
        i--; // Decrement to retry this account
        continue;
      } else {
        console.log(ANSI.YELLOW + 'Skipping account ' + i + '.' + ANSI.RESET);
        continue;
      }
    }

    const authCookie = cookieResult.cookie;

    // Check if cookie is same as previous account
    if (seenCookies.has(authCookie)) {
      console.error(ANSI.RED + 'Error: This is the same cookie as a previous account.' + ANSI.RESET);
      console.error('Make sure you logged out of the previous account and logged into a different one.');
      console.error();
      const retry = await ask('Retry? (y/n) ');
      if (retry.toLowerCase() === 'y') {
        i--; // Decrement to retry this account
        continue;
      } else {
        console.log(ANSI.YELLOW + 'Skipping account ' + i + '.' + ANSI.RESET);
        continue;
      }
    }

    console.log(ANSI.GREEN + '✓ Auth cookie extracted' + ANSI.RESET);

    // Extract workspace ID from history
    console.log(ANSI.DIM + 'Finding workspace ID from Firefox history...' + ANSI.RESET);
    const workspaceIds = extractFirefoxWorkspaceIds();

    let workspaceId: string;

    if (workspaceIds.length === 0) {
      console.error(ANSI.YELLOW + 'Warning: No workspace IDs found in Firefox history.' + ANSI.RESET);
      workspaceId = await ask('Enter workspace ID manually (wrk_...): ');
    } else if (workspaceIds.length === 1) {
      workspaceId = workspaceIds[0];
      console.log(ANSI.GREEN + '✓ Found workspace ID: ' + workspaceId + ANSI.RESET);
    } else {
      console.log(ANSI.YELLOW + 'Multiple workspaces found in history:' + ANSI.RESET);
      workspaceIds.forEach((id, idx) => {
        console.log(`  ${idx + 1}. ${id}  →  https://opencode.ai/workspace/${id}/go`);
      });
      console.log();
      console.log(ANSI.DIM + 'Check your browser URL to find the matching workspace ID.' + ANSI.RESET);
      const choice = await ask('Which workspace is this account? (enter number) ');
      const choiceNum = parseInt(choice, 10);
      if (isNaN(choiceNum) || choiceNum < 1 || choiceNum > workspaceIds.length) {
        console.error(ANSI.RED + 'Invalid choice. Using first workspace.' + ANSI.RESET);
        workspaceId = workspaceIds[0];
      } else {
        workspaceId = workspaceIds[choiceNum - 1];
      }
    }

    // Validate workspace ID format
    if (!workspaceId || !/^wrk_[A-Za-z0-9]+$/.test(workspaceId)) {
      console.error(ANSI.RED + 'Error: Invalid workspace ID format. Must match: wrk_[A-Za-z0-9]+' + ANSI.RESET);
      const retry = await ask('Retry? (y/n) ');
      if (retry.toLowerCase() === 'y') {
        i--;
        continue;
      } else {
        console.log(ANSI.YELLOW + 'Skipping account ' + i + '.' + ANSI.RESET);
        continue;
      }
    }

    // Check for duplicate workspace IDs
    if (accounts.some(a => a.workspaceId === workspaceId)) {
      console.error(ANSI.RED + 'Error: This workspace ID is already configured.' + ANSI.RESET);
      const retry = await ask('Retry with a different workspace? (y/n) ');
      if (retry.toLowerCase() === 'y') {
        i--;
        continue;
      } else {
        console.log(ANSI.YELLOW + 'Skipping account ' + i + '.' + ANSI.RESET);
        continue;
      }
    }

    // Validate cookie
    console.log(ANSI.DIM + 'Validating cookie by scraping dashboard...' + ANSI.RESET);
    const result = await validateAndFetchUsage(workspaceId, authCookie);

    if (!result.valid) {
      console.error(ANSI.RED + 'Error: Cookie validation failed.' + ANSI.RESET);
      console.error(ANSI.DIM + '  Reason: ' + (result.error || 'Unknown error') + ANSI.RESET);
      console.error();
      const retry = await ask('Retry? (y/n) ');
      if (retry.toLowerCase() === 'y') {
        i--;
        continue;
      } else {
        console.log(ANSI.YELLOW + 'Skipping account ' + i + '.' + ANSI.RESET);
        continue;
      }
    }

    console.log(ANSI.GREEN + '✓ Cookie validated successfully' + ANSI.RESET);

    accounts.push({ workspaceId, authCookie });
    seenCookies.add(authCookie);

    console.log();
  }

  if (accounts.length === 0) {
    console.error(ANSI.RED + 'Error: No accounts configured.' + ANSI.RESET);
    process.exit(1);
  }

  // Write config
  console.log(ANSI.BOLD + ANSI.CYAN + '═══════════════════════════════════════════════════════════' + ANSI.RESET);
  console.log(ANSI.BOLD + 'Writing config file...' + ANSI.RESET);
  console.log(ANSI.BOLD + ANSI.CYAN + '═══════════════════════════════════════════════════════════' + ANSI.RESET);

  // Ask for encryption key
  console.log();
  console.log(ANSI.DIM + 'Auth cookies are sensitive session tokens.' + ANSI.RESET);
  console.log(ANSI.DIM + 'They will be encrypted with AES-256-GCM before storage.' + ANSI.RESET);
  const encryptionKey = await ask('Enter an encryption password (or press Enter to skip encryption): ');

  const configData = accounts.map(acc => ({
    workspaceId: acc.workspaceId,
    authCookie: encryptionKey ? encryptKey(acc.authCookie, encryptionKey) : acc.authCookie,
  }));

  const configPath = join(process.cwd(), 'prototype', 'scraper-creds.json');
  writeFileSync(configPath, JSON.stringify(configData, null, 2), { mode: 0o600 });

  console.log(ANSI.GREEN + '✓ Config written to: ' + configPath + ANSI.RESET);
  if (encryptionKey) {
    console.log(ANSI.GREEN + '✓ Cookies encrypted with AES-256-GCM' + ANSI.RESET);
  } else {
    console.log(ANSI.YELLOW + '⚠ Cookies stored in plaintext (not recommended for production)' + ANSI.RESET);
  }
  console.log();

  // Doctor check
  console.log(ANSI.BOLD + ANSI.CYAN + '═══════════════════════════════════════════════════════════' + ANSI.RESET);
  console.log(ANSI.BOLD + 'Running doctor check...' + ANSI.RESET);
  console.log(ANSI.BOLD + ANSI.CYAN + '═══════════════════════════════════════════════════════════' + ANSI.RESET);
  console.log();

  let allPassed = true;

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    console.log(`Account ${i + 1}: ${account.workspaceId}`);

    const result = await validateAndFetchUsage(account.workspaceId, account.authCookie);

    if (result.valid && result.usage) {
      console.log(ANSI.GREEN + '  ✓ Cookie valid' + ANSI.RESET);
      console.log(ANSI.DIM + `    Rolling (~5h): ${result.usage.rolling ?? 'N/A'}%` + ANSI.RESET);
      console.log(ANSI.DIM + `    Weekly:        ${result.usage.weekly ?? 'N/A'}%` + ANSI.RESET);
      console.log(ANSI.DIM + `    Monthly:       ${result.usage.monthly ?? 'N/A'}%` + ANSI.RESET);
    } else {
      console.log(ANSI.RED + '  ✗ Cookie invalid or expired' + ANSI.RESET);
      if (result.error) {
        console.log(ANSI.DIM + `    Reason: ${result.error}` + ANSI.RESET);
      }
      allPassed = false;
    }

    console.log();
  }

  if (allPassed) {
    console.log(ANSI.GREEN + ANSI.BOLD + '✓ All accounts configured successfully!' + ANSI.RESET);
    console.log();
    console.log('Next steps:');
    console.log('  1. Run the proxy: npm run dev');
    console.log('  2. The proxy will scrape usage data every 90 seconds');
    console.log('  3. Accounts will switch automatically when usage exceeds threshold');
  } else {
    console.log(ANSI.YELLOW + ANSI.BOLD + '⚠ Some accounts failed validation.' + ANSI.RESET);
    console.log('You may need to re-run the wizard or update cookies manually.');
  }

  rl.close();
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════

runSetupWizard().catch((err) => {
  console.error('Fatal error:', err);
  rl.close();
  process.exit(1);
});
