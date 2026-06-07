/**
 * firefox-cookies.ts — Firefox cookie and history extraction.
 *
 * Reads cookies.sqlite and places.sqlite from the default Firefox profile.
 * Uses Node.js built-in node:sqlite (requires Node >= 22).
 */

import { existsSync, copyFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { logger } from './logger.js';

/**
 * Find the default Firefox profile directory on this system.
 *
 * Scans the platform-specific Firefox profiles directory and prefers the
 * `default-release` profile if it exists, otherwise returns the first
 * profile directory found.
 *
 * @returns The path to the Firefox profile directory, or `null` if not found.
 */
export function findFirefoxProfileDir(): string | null {
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

/**
 * Extract the `auth` cookie value for `opencode.ai` from Firefox's cookies.sqlite.
 *
 * Makes a temporary copy of the database (including WAL/SHM sidecars) to avoid
 * locking conflicts with Firefox. The temp copy is cleaned up after extraction.
 *
 * @returns An object with `cookie` (the auth cookie value, or `null` if not found)
 *          and an optional `error` message describing what went wrong.
 */
export function extractFirefoxAuthCookie(): { cookie: string | null; error?: string } {
  const profileDir = findFirefoxProfileDir();
  if (!profileDir) return { cookie: null, error: 'Firefox profile not found' };

  const cookiesDb = join(profileDir, 'cookies.sqlite');
  if (!existsSync(cookiesDb)) return { cookie: null, error: 'cookies.sqlite not found' };

  const tempDir = mkdirSync(join(tmpdir(), 'proto-setup-' + Date.now()), { recursive: true }) as string;
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
      return rows.length > 0
        ? { cookie: rows[0].value }
        : { cookie: null, error: 'No auth cookie found for opencode.ai' };
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

/**
 * Extract OpenCode workspace IDs from Firefox's places.sqlite (browser history).
 *
 * Searches `moz_places` for URLs containing `opencode.ai/workspace/` and
 * returns unique workspace IDs (wrk_...) from the most recently visited pages.
 *
 * A temporary copy of the database (including WAL/SHM sidecars) is used to
 * avoid locking conflicts with Firefox, then cleaned up after extraction.
 *
 * @returns An array of unique workspace ID strings (e.g. `["wrk_abc123"]`).
 *          Returns an empty array if none are found or if an error occurs.
 */
export function extractFirefoxWorkspaceIds(): string[] {
  const profileDir = findFirefoxProfileDir();
  if (!profileDir) return [];

  const placesDb = join(profileDir, 'places.sqlite');
  if (!existsSync(placesDb)) return [];

  const tempDir = mkdirSync(join(tmpdir(), 'proto-setup-history-' + Date.now()), { recursive: true }) as string;
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
  } catch (err) {
    logger.warn({ err }, 'Failed to extract Firefox workspace IDs');
    return [];
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
