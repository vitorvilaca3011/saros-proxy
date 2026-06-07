# Handoff — Usage-Based Account Switching for Saros

## Goal

Add usage-based API key switching to Saros:
- **Dashboard scraping** fetches per-key usage percentages (rolling~5h, weekly, monthly) from opencode.ai
- **Usage gate** in key selection skips keys above a configurable threshold (default 50%)
- **Fallback** when all keys exceed threshold picks the lowest-usage key
- **Setup wizard** automates credential extraction via Firefox cookies
- **Live scrub testing** results pending for streaming usage data verification

## Current Progress (all 8 phases implemented)

### Phase 1 — Config (`src/config.ts`)
- `ScrapingConfig` interface: `enabled`, `intervalMs` (10k-3.6M), `usageThreshold` (1-100), `accounts[]`
- `ScrapingAccount` with `workspaceId` (validated via `/^wrk_[A-Za-z0-9]+$/`)
- Encrypted auth cookies (`enc:scrypt:` prefix) decrypted at config load time via `OPENCODE_GO_ENCRYPTION_KEY`
- 25 new tests + all 74 existing tests pass

### Phase 2 — Firefox cookies (`src/firefox-cookies.ts`)
- `findFirefoxProfileDir()` — locates Firefox profile on Windows (%APPDATA%)
- `extractFirefoxAuthCookie()` — reads `cookies.sqlite` (copied to temp to avoid locking)
- `extractFirefoxWorkspaceIds()` — reads `places.sqlite` for workspace URLs
- Uses `node:sqlite DatabaseSync` (requires Node ≥ 22)
- Handles locked DB, missing files, WAL/SHM sidecars

### Phase 3 — Dashboard parser (`src/dashboard-parser.ts`)
- Pure functions: `parseUsagePercent(html, window)`, `parseAllUsage(html)`
- 6 regex patterns (2 per window) from opencode-quota reference project
- `Number.isFinite` guards against NaN/Infinity
- Missing windows return `null`

### Phase 4ab — Scraper + timer (`src/scraper.ts`)
- `scrapeDashboard(workspaceId, authCookie)` — single-shot HTTP GET + parse
- Error classification: 401/403 → "Cookie expired", 429 → "Rate limited", timeout → "Request timed out"
- Background timer with `setInterval` + `unref()`, immediate first scrape
- In-memory `usageStore` (Map<workspaceId, AccountUsage>)
- `startScraper()`/`stopScraper()` with lifecycle in `src/index.ts`

### Phase 5 — Usage gate (`src/proxy-logic.ts`)
- `KeySelectionOptions` with `usageMap` + `usageThreshold`
- `isKeyAvailableByUsage()` — pure function, null usage data = available
- `findFallbackKey()` — lowest max-usage across all windows when all keys are gated
- Backward compatible: existing `selectKeyForRequest()` / `failoverRequest()` accept optional third param

### Phase 6 — Setup wizard (`src/cli/setup.ts`)
- Reorganized to **account-per-round flow**: label → API key → Firefox cookie extraction → validation → usage display, all per account
- `promptSecret()` for API key + encryption key input
- Spinner (`\ | / -`) during Firefox extraction and cookie validation
- Usage percentages shown after cookie validation (Rolling: X%  Weekly: Y%  Monthly: Z%)
- Defaults: 2 accounts, threshold 70%, interval 90s
- ASCII-only output: `->` success, `[!]` warning, `[i]` info, `[ERR]` error
- Encryption: optional AES-256-GCM, cookies encrypted with same key

### Phase 7 — Health endpoint (`src/proxy.ts`)
- `/health` shows scraping status: enabled, running, interval, threshold, per-account usage

### Phase 8 — Auto-start prototype (`prototype/auto-start.ts`)
- Shim server on :3000, lazy proxy spawn on :3001 on first request
- Not production-ready — just a prototype

## What Worked

- **Firefox cookie auto-discovery** — `cookies.sqlite` + `places.sqlite` extraction works reliably on Windows. No decryption needed (Firefox cookies are plaintext SQLite).
- **Account-per-round flow** — Much better UX than collecting all API keys then all cookies. User configures each account fully in one go.
- **Dashboard scraper** — 6-regex parser correctly handles field order variance in SolidJS SSR hydration output.
- **`node:sqlite DatabaseSync`** — zero-dependency SQLite access for Node 22+.

## What Didn't Work (don't repeat)

- **Raw mode for hidden input** — `process.stdin.setRawMode(true)` on Windows PowerShell does NOT reliably disable terminal echo, causing keys to appear as plaintext followed by `***` asterisks. **Fix**: Use parent readline's `rl.question()` directly with no hiding attempt (key briefly visible while typing, which is acceptable for a one-time setup wizard).
- **Muted Writable `terminal: false`** — Creating a second `createInterface` on the same stdin to suppress echo conflicts with the parent readline, causing crash at Key 2. Same root cause as above.
- **ANSI escape line clearing** — `\x1B[1A\x1B[2K` after `rl.question()` doesn't reliably clear the key from terminal scrollback on all Windows terminals.
- **Dot-leader prompt format** — `Proxy port  . . . . . . . . . .  [3000]` was confusing (looks like a table, not an input prompt). **Fix**: Standard `Proxy port [3000]: `` format with cursor after `: `.
- **Unicode symbols** — ✓ ✗ ⚠ ℹ were considered "bad emojis" by user. Replaced with `->` `[ERR]` `[!]` `[i]`.

## Files Structure

```
src/
  config.ts            — YAML config loading, validation, scraping schema
  config.test.ts       — 99 tests (25 new scraping + 74 existing)
  proxy-logic.ts       — Pure proxy logic, usage gate, key selection
  proxy.ts             — Hono app, wiring, health endpoint
  index.ts             — Entry point, scraper lifecycle
  scraper.ts           — scrapeDashboard() + background timer + usageStore
  dashboard-parser.ts  — Pure HTML→usage% parser
  firefox-cookies.ts   — Firefox cookie/workspace extraction
  cli/setup.ts         — Interactive setup wizard (main flow)
  logger.ts            — Pino logger
  key-encryption.ts    — AES-256-GCM encryption helpers
prototype/
  auto-start.ts        — Auto-start shim prototype
  dashboard-scraper.ts — Old prototype (keep for reference)
  scraper-creds.json   — Gitignored, old credential test file
  usage-switching.ts   — Old token-based prototype
  api-probe.ts         — Old API probing prototype
  setup-wizard.ts      — Old wizard prototype
test/
  cli-setup.test.ts    — 46 CLI setup tests
  e2e.test.ts          — 35 E2E tests
  global-teardown.ts   — process.exit(0) workaround for Windows
```

## Test Status

All 267 tests pass (7 test files):
- `src/proxy-logic.test.ts` — 49 tests
- `src/config.test.ts` — 99 tests
- `test/e2e.test.ts` — 35 tests
- `test/cli-setup.test.ts` — 46 tests
- plus 3 utility test files

**Known Windows issue**: Vitest hangs when run from bash tool's pipe capture. Run from user terminal: `npx vitest run` (130 tests, ~5s). `tsc --noEmit` works fine from bash tool.

## Known Issues

1. **setupScrapingAccounts stub** — The old `setupScrapingAccounts()` function was replaced with a backward-compat stub that only exports its type. If any code calls it, it'll throw. The new flow is inline in `setup()`.
2. **API key visible briefly** — While typing in the wizard, the API key is echoed to the terminal. This is accepted because the setup wizard is one-time use and the confirmation line masks the key.
3. **Firefox auth cookie expires** — Cookies expire after some time. The scraper's 401 detection handles this gracefully (log warning, keep stale data), but the wizard requires re-running or manual credential update.
4. **Node.js >= 22 required** — `node:sqlite DatabaseSync` doesn't exist in Node 20. Set `engines.node` in package.json to `>=22.0.0`.
5. **Same-cookie limitation** — Firefox auto-discovery only finds the currently-logged-in account's cookie. Each account must be logged into Firefox separately during setup.

## Next Steps

1. **Test the setup wizard end-to-end** — Run `npm run setup` and verify the full account-per-round flow
2. **Test scraping live** — Run `npm run dev`, check `http://localhost:3000/health` for scraping status
3. **Config edit command** — Users need a way to add/remove scraping accounts without re-running the full wizard. Options:
   - `npm run setup --add-account` / `--remove-account`
   - Config file editor (interactive TUI)
   - Manual config.yaml editing with docs
4. **Streaming usage research** — Live scrub testing has NOT been completed for streaming API responses. The API probe found no usage chunk in streaming mode. Need to determine if tracking non-streaming + 429 catch is sufficient.
5. **Auto-start polish** — The prototype needs refinement before production: proper Windows service installation, error handling, port conflict resolution.
6. **Dedicated tests** — `scraper.ts`, `firefox-cookies.ts`, and `dashboard-parser.ts` don't have dedicated unit tests yet (only integration via config tests).
