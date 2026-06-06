/**
 * dashboard-scraper.ts — Prototype: Test real dashboard scraping
 *
 * QUESTION: Can we successfully scrape OpenCode-Go usage percentages from the dashboard?
 *
 * This prototype:
 * 1. Tries Firefox auto-discovery (cookies + workspace ID from history)
 * 2. Falls back to manual config file (prototype/scraper-creds.json)
 * 3. Fetches https://opencode.ai/workspace/{workspaceId}/go
 * 4. Parses the SolidJS SSR hydration data for usage percentages
 * 5. Shows rolling (~5h), weekly, monthly usage
 *
 * Run with: npm run proto:scrape
 *
 * Firefox auto-discovery:
 * - Reads cookies.sqlite (plaintext, no encryption) from Firefox profile
 * - Reads places.sqlite for workspace URLs in browser history
 * - Works on Windows/macOS/Linux
 * - Requires Node >= 22 (uses built-in node:sqlite)
 *
 * Manual config fallback (prototype/scraper-creds.json):
 * {
 *   "workspaceId": "wrk_your_workspace_id",
 *   "authCookie": "your_auth_cookie_value"
 * }
 */

import { readFileSync, existsSync, copyFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const ANSI = {
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  CYAN: '\x1b[36m',
  RESET: '\x1b[0m',
};

interface ScraperCreds {
  workspaceId: string;
  authCookie: string;
  source: string;
}

// ═══════════════════════════════════════════════════════════════════════
// FIREFOX AUTO-DISCOVERY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Find the Firefox profile directory containing cookies.sqlite.
 * Prefers "default-release" profile (modern Firefox).
 */
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

    // Prefer default-release profile
    const preferred = profiles.find(p => p.includes('default-release')) ?? profiles[0];
    return join(root, preferred);
  } catch {
    return null;
  }
}

/**
 * Extract the "auth" cookie for opencode.ai from Firefox's cookies.sqlite.
 * Firefox cookies are NOT encrypted — just plaintext in SQLite.
 */
function extractFirefoxAuthCookie(): string | null {
  const profileDir = findFirefoxProfileDir();
  if (!profileDir) {
    console.log(ANSI.DIM + '  Firefox profile not found' + ANSI.RESET);
    return null;
  }

  const cookiesDb = join(profileDir!, 'cookies.sqlite');
  if (!existsSync(cookiesDb)) {
    console.log(ANSI.DIM + '  cookies.sqlite not found at: ' + cookiesDb + ANSI.RESET);
    return null;
  }

  console.log(ANSI.DIM + '  Firefox profile: ' + profileDir + ANSI.RESET);

  // Copy to temp dir to avoid locking issues (Firefox may have it open)
  const tempDir = mkdirSync(join(tmpdir(), 'proto-firefox-' + Date.now()), { recursive: true });
  if (!tempDir) {
    console.log(ANSI.RED + '  ✗ Failed to create temp directory' + ANSI.RESET);
    return null;
  }
  const tempDb = join(tempDir, 'cookies.sqlite');

  try {
    copyFileSync(cookiesDb, tempDb);

    // Also copy WAL/SHM sidecars if they exist
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

      if (rows.length === 0) {
        console.log(ANSI.YELLOW + '  ✗ No "auth" cookie found for opencode.ai in Firefox' + ANSI.RESET);
        console.log(ANSI.DIM + '    (Make sure you are logged into opencode.ai in Firefox)' + ANSI.RESET);
        return null;
      }

      console.log(ANSI.GREEN + '  ✓ Found auth cookie in Firefox cookies.sqlite' + ANSI.RESET);
      return rows[0].value;
    } finally {
      db.close();
    }
  } catch (err) {
    console.log(ANSI.RED + '  ✗ Failed to read Firefox cookies: ' + (err instanceof Error ? err.message : String(err)) + ANSI.RESET);
    return null;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Extract ALL workspace IDs from Firefox browser history (places.sqlite).
 * Looks for URLs matching: https://opencode.ai/workspace/wrk_XXXXX/...
 * Returns unique workspace IDs, most recently visited first.
 */
function extractFirefoxWorkspaceIds(): string[] {
  const profileDir = findFirefoxProfileDir();
  if (!profileDir) return [];

  const placesDb = join(profileDir!, 'places.sqlite');
  if (!existsSync(placesDb)) {
    console.log(ANSI.DIM + '  places.sqlite not found' + ANSI.RESET);
    return [];
  }

  // Copy to temp dir
  const tempDir = mkdirSync(join(tmpdir(), 'proto-firefox-history-' + Date.now()), { recursive: true });
  if (!tempDir) {
    console.log(ANSI.RED + '  ✗ Failed to create temp directory' + ANSI.RESET);
    return [];
  }
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

      const ids = Array.from(workspaceIds);
      
      if (ids.length === 0) {
        console.log(ANSI.YELLOW + '  ✗ No workspace IDs found in Firefox history' + ANSI.RESET);
        console.log(ANSI.DIM + '    (Visit https://opencode.ai/workspace/YOUR_ID/go in Firefox first)' + ANSI.RESET);
        return [];
      }

      console.log(ANSI.GREEN + '  ✓ Found ' + ids.length + ' workspace(s) in Firefox history:' + ANSI.RESET);
      for (const id of ids) {
        console.log(ANSI.DIM + '    - ' + id + ANSI.RESET);
      }
      return ids;
    } finally {
      db.close();
    }
  } catch (err) {
    console.log(ANSI.RED + '  ✗ Failed to read Firefox history: ' + (err instanceof Error ? err.message : String(err)) + ANSI.RESET);
    return [];
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Try to auto-discover credentials from Firefox.
 * Returns an array of credentials (one per workspace found).
 */
function tryFirefoxAutoDiscovery(): ScraperCreds[] {
  console.log('\n' + ANSI.BOLD + 'Attempting Firefox auto-discovery...' + ANSI.RESET);

  const authCookie = extractFirefoxAuthCookie();
  const workspaceIds = extractFirefoxWorkspaceIds();

  if (!authCookie) {
    console.log(ANSI.YELLOW + '✗ Firefox auto-discovery failed: no auth cookie' + ANSI.RESET);
    return [];
  }

  if (workspaceIds.length === 0) {
    console.log(ANSI.YELLOW + '✗ Firefox auto-discovery failed: no workspace IDs' + ANSI.RESET);
    return [];
  }

  console.log(ANSI.GREEN + ANSI.BOLD + '✓ Firefox auto-discovery successful!' + ANSI.RESET);
  
  // Create one credential entry per workspace
  return workspaceIds.map(workspaceId => ({
    workspaceId,
    authCookie,
    source: 'Firefox auto-discovery',
  }));
}

// ═══════════════════════════════════════════════════════════════════════
// MANUAL CONFIG FALLBACK
// ═══════════════════════════════════════════════════════════════════════

function loadManualConfig(): ScraperCreds[] | null {
  const credsPath = join(process.cwd(), 'prototype', 'scraper-creds.json');

  if (!existsSync(credsPath)) {
    return null;
  }

  console.log('\n' + ANSI.DIM + 'Loading credentials from: ' + credsPath + ANSI.RESET);

  try {
    const raw = readFileSync(credsPath, 'utf-8');
    const data = JSON.parse(raw);
    
    // Support both array format and single object format
    const credsArray = Array.isArray(data) ? data : [data];
    
    const results: ScraperCreds[] = [];
    for (let i = 0; i < credsArray.length; i++) {
      const creds = credsArray[i];
      
      if (!creds.workspaceId || !creds.authCookie) {
        console.error(ANSI.YELLOW + '  ⚠ Entry ' + (i + 1) + ' missing workspaceId or authCookie, skipping' + ANSI.RESET);
        continue;
      }
      
      results.push({
        workspaceId: creds.workspaceId,
        authCookie: creds.authCookie,
        source: credsPath + ' (entry ' + (i + 1) + ')',
      });
    }
    
    if (results.length === 0) {
      console.error(ANSI.RED + 'Error: No valid credentials found in scraper-creds.json' + ANSI.RESET);
      return null;
    }

    console.log(ANSI.GREEN + '✓ Loaded ' + results.length + ' credential(s) from manual config' + ANSI.RESET);
    return results;
  } catch (err) {
    console.error(ANSI.RED + 'Error reading scraper-creds.json: ' + (err instanceof Error ? err.message : String(err)) + ANSI.RESET);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CREDENTIAL RESOLUTION
// ═══════════════════════════════════════════════════════════════════════

function loadCreds(showCookie: boolean = false): ScraperCreds[] {
  // When --show-cookie is used, skip manual config and use Firefox auto-discovery
  // to show the fresh cookie from the currently logged-in account
  if (showCookie) {
    console.log(ANSI.YELLOW + 'Mode: Showing fresh cookie from Firefox (skipping manual config)' + ANSI.RESET);
    const firefoxCreds = tryFirefoxAutoDiscovery();
    if (firefoxCreds.length > 0) {
      return firefoxCreds;
    }
    console.error(ANSI.RED + 'Error: Firefox auto-discovery failed. Make sure you are logged into opencode.ai in Firefox.' + ANSI.RESET);
    process.exit(1);
  }

  // 1. Try manual config file FIRST (user explicitly configured this)
  const manualCreds = loadManualConfig();
  if (manualCreds && manualCreds.length > 0) {
    return manualCreds;
  }

  // 2. Fall back to Firefox auto-discovery
  const firefoxCreds = tryFirefoxAutoDiscovery();
  if (firefoxCreds.length > 0) {
    return firefoxCreds;
  }

  // 3. Nothing worked — show instructions
  console.error('\n' + ANSI.RED + 'Error: Could not find credentials' + ANSI.RESET);
  console.error('\n' + ANSI.BOLD + 'Option 1: Manual config file (recommended for multiple accounts)' + ANSI.RESET);
  console.error('  Create prototype/scraper-creds.json with:');
  console.error('  [');
  console.error('    {');
  console.error('      "workspaceId": "wrk_account1_id",');
  console.error('      "authCookie": "account1_cookie_value"');
  console.error('    },');
  console.error('    {');
  console.error('      "workspaceId": "wrk_account2_id",');
  console.error('      "authCookie": "account2_cookie_value"');
  console.error('    }');
  console.error('  ]');
  console.error('\n  To get these:');
  console.error('  1. Log into account 1 in Firefox');
  console.error('  2. Run: npm run proto:scrape -- --show-cookie');
  console.error('  3. Copy the cookie value');
  console.error('  4. Log out, log into account 2');
  console.error('  5. Run again and copy the second cookie');
  console.error('  6. Create scraper-creds.json with both entries');
  console.error('\n' + ANSI.BOLD + 'Option 2: Use Firefox (automatic, single account only)' + ANSI.RESET);
  console.error('  1. Open Firefox and go to https://opencode.ai');
  console.error('  2. Log in to your account');
  console.error('  3. Visit your workspace: https://opencode.ai/workspace/YOUR_ID/go');
  console.error('  4. Run this prototype again — it will auto-discover credentials');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════
// DASHBOARD SCRAPING (unchanged from before)
// ═══════════════════════════════════════════════════════════════════════

function maskCookie(cookie: string): string {
  if (cookie.length <= 20) return cookie;
  return cookie.slice(0, 10) + '...' + cookie.slice(-10);
}

// Regex patterns from opencode-quota (6 total, 2 per window for field order flexibility)
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

interface ScrapedWindow {
  usagePercent: number;
  resetInSec: number;
}

function parseWindow(
  html: string,
  rePctFirst: RegExp,
  reResetFirst: RegExp,
): ScrapedWindow | null {
  const pctFirst = rePctFirst.exec(html);
  if (pctFirst) {
    const usagePercent = Number(pctFirst[1]);
    const resetInSec = Number(pctFirst[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }

  const resetFirst = reResetFirst.exec(html);
  if (resetFirst) {
    const resetInSec = Number(resetFirst[1]);
    const usagePercent = Number(resetFirst[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }

  return null;
}

function formatSeconds(sec: number): string {
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h + 'h ' + m + 'm';
  }
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d + 'd ' + h + 'h';
}

function progressBar(pct: number, width: number = 20): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const color = pct >= 80 ? ANSI.RED : pct >= 50 ? ANSI.YELLOW : ANSI.GREEN;
  return color + bar + ANSI.RESET;
}

async function scrapeDashboard(creds: ScraperCreds, showCookie: boolean = false): Promise<void> {
  const url = `https://opencode.ai/workspace/${encodeURIComponent(creds.workspaceId)}/go`;

  console.log('\n' + ANSI.BOLD + ANSI.CYAN + '=== SCRAPING DASHBOARD ===' + ANSI.RESET);
  console.log('URL: ' + url);
  console.log('Auth Cookie: ' + maskCookie(creds.authCookie));
  console.log('Source: ' + creds.source);
  
  if (showCookie) {
    console.log('\n' + ANSI.YELLOW + 'Full cookie value (for manual config):' + ANSI.RESET);
    console.log(ANSI.DIM + creds.authCookie + ANSI.RESET);
  }
  
  console.log('\n' + ANSI.DIM + 'Fetching...' + ANSI.RESET);

  const startTime = Date.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0',
        'Accept': 'text/html',
        'Cookie': `auth=${creds.authCookie}`,
      },
    });

    const elapsed = Date.now() - startTime;
    console.log('\n' + ANSI.BOLD + 'Response Status:' + ANSI.RESET + ' ' + response.status + ' (' + elapsed + 'ms)');

    if (!response.ok) {
      const text = await response.text();
      console.log(ANSI.RED + 'ERROR: HTTP ' + response.status + ANSI.RESET);
      console.log('Response body (first 500 chars):');
      console.log(text.slice(0, 500));

      if (response.status === 401 || response.status === 403) {
        console.log('\n' + ANSI.YELLOW + 'Auth cookie may be expired. Get a fresh one from your browser.' + ANSI.RESET);
      }
      return;
    }

    const html = await response.text();
    console.log('HTML size: ' + html.length + ' bytes');

    const rolling = parseWindow(html, RE_ROLLING_PCT_FIRST, RE_ROLLING_RESET_FIRST);
    const weekly = parseWindow(html, RE_WEEKLY_PCT_FIRST, RE_WEEKLY_RESET_FIRST);
    const monthly = parseWindow(html, RE_MONTHLY_PCT_FIRST, RE_MONTHLY_RESET_FIRST);

    console.log('\n' + ANSI.BOLD + ANSI.CYAN + '=== PARSED USAGE DATA ===' + ANSI.RESET);

    if (!rolling && !weekly && !monthly) {
      console.log(ANSI.RED + 'ERROR: Could not parse any usage windows from HTML' + ANSI.RESET);
      console.log('\nThis could mean:');
      console.log('1. OpenCode changed their HTML format');
      console.log('2. The workspace ID is invalid');
      console.log('3. The page structure is different than expected');
      console.log('4. The auth cookie is expired or invalid');
      console.log('\nSearching for known patterns in HTML...');
      
      if (html.includes('rollingUsage')) {
        console.log(ANSI.YELLOW + '  ✓ Found "rollingUsage" in HTML' + ANSI.RESET);
      } else {
        console.log(ANSI.RED + '  ✗ "rollingUsage" not found in HTML' + ANSI.RESET);
      }
      
      if (html.includes('$R[')) {
        console.log(ANSI.YELLOW + '  ✓ Found "$R[" (SolidJS hydration) in HTML' + ANSI.RESET);
      } else {
        console.log(ANSI.RED + '  ✗ "$R[" not found in HTML' + ANSI.RESET);
      }
      
      // Show first 1000 chars of HTML for debugging
      console.log('\n' + ANSI.DIM + 'HTML preview (first 1000 chars):' + ANSI.RESET);
      console.log(html.slice(0, 1000));
      
      return;
    }

    if (rolling) {
      console.log('\n' + ANSI.BOLD + 'Rolling (~5h):' + ANSI.RESET);
      console.log('  ' + progressBar(rolling.usagePercent) + ' ' + rolling.usagePercent.toFixed(1) + '% used');
      console.log('  Resets in: ' + formatSeconds(rolling.resetInSec));
      console.log('  Reset at: ' + new Date(Date.now() + rolling.resetInSec * 1000).toLocaleString());
    } else {
      console.log('\n' + ANSI.DIM + 'Rolling: not found' + ANSI.RESET);
    }

    if (weekly) {
      console.log('\n' + ANSI.BOLD + 'Weekly:' + ANSI.RESET);
      console.log('  ' + progressBar(weekly.usagePercent) + ' ' + weekly.usagePercent.toFixed(1) + '% used');
      console.log('  Resets in: ' + formatSeconds(weekly.resetInSec));
      console.log('  Reset at: ' + new Date(Date.now() + weekly.resetInSec * 1000).toLocaleString());
    } else {
      console.log('\n' + ANSI.DIM + 'Weekly: not found' + ANSI.RESET);
    }

    if (monthly) {
      console.log('\n' + ANSI.BOLD + 'Monthly:' + ANSI.RESET);
      console.log('  ' + progressBar(monthly.usagePercent) + ' ' + monthly.usagePercent.toFixed(1) + '% used');
      console.log('  Resets in: ' + formatSeconds(monthly.resetInSec));
      console.log('  Reset at: ' + new Date(Date.now() + monthly.resetInSec * 1000).toLocaleString());
    } else {
      console.log('\n' + ANSI.DIM + 'Monthly: not found' + ANSI.RESET);
    }

    console.log('\n' + ANSI.GREEN + ANSI.BOLD + '✓ Scraping successful!' + ANSI.RESET);
    console.log('\nThis data can be used to:');
    console.log('  - Switch accounts when usage exceeds threshold (e.g., 50%)');
    console.log('  - Display usage in /health endpoint');
    console.log('  - Log usage metrics');

  } catch (err) {
    console.log(ANSI.RED + 'ERROR: ' + (err instanceof Error ? err.message : String(err)) + ANSI.RESET);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log(ANSI.BOLD + 'OpenCode-Go Dashboard Scraper Prototype' + ANSI.RESET);
  console.log('Testing real dashboard scraping to extract usage percentages\n');

  // Check for --show-cookie flag to print full cookie values
  const showCookie = process.argv.includes('--show-cookie');
  
  if (showCookie) {
    console.log(ANSI.YELLOW + 'Mode: Showing full cookie values for manual config' + ANSI.RESET);
    console.log(ANSI.DIM + '(Use this to copy cookies for scraper-creds.json)' + ANSI.RESET);
  }

  const allCreds = loadCreds(showCookie);
  console.log('\n' + ANSI.BOLD + 'Found ' + allCreds.length + ' workspace(s) to scrape' + ANSI.RESET);

  for (let i = 0; i < allCreds.length; i++) {
    const creds = allCreds[i];
    console.log('\n' + ANSI.BOLD + ANSI.CYAN + '═══════════════════════════════════════════════════════════' + ANSI.RESET);
    console.log(ANSI.BOLD + 'Workspace ' + (i + 1) + ' of ' + allCreds.length + ': ' + creds.workspaceId + ANSI.RESET);
    console.log(ANSI.BOLD + 'Source: ' + creds.source + ANSI.RESET);
    console.log(ANSI.BOLD + ANSI.CYAN + '═══════════════════════════════════════════════════════════' + ANSI.RESET);
    await scrapeDashboard(creds, showCookie);
  }

  console.log('\n' + ANSI.BOLD + ANSI.CYAN + '═══════════════════════════════════════════════════════════' + ANSI.RESET);
  console.log(ANSI.BOLD + 'All workspaces scraped!' + ANSI.RESET);
  
  if (showCookie) {
    console.log('\n' + ANSI.YELLOW + 'To create scraper-creds.json:' + ANSI.RESET);
    console.log('1. Copy the cookie values shown above');
    console.log('2. Create prototype/scraper-creds.json with:');
    console.log('   [');
    console.log('     { "workspaceId": "wrk_...", "authCookie": "Fe26.2**..." },');
    console.log('     { "workspaceId": "wrk_...", "authCookie": "Fe26.2**..." }');
    console.log('   ]');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
