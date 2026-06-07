# AGENTS.md — Project Instructions for AI Agents

## Project Overview

**saros-proxy** — Predictive multi-account proxy for the OpenCode-Go API. Cycles between accounts before they exhaust.

- **Language:** TypeScript (ESM, `"type": "module"`)
- **Runtime:** Node.js >= 20
- **Framework:** Hono (HTTP), Pino (logging)
- **Test:** Vitest 4.x
- **Build:** `tsc` → `dist/`

## Commands

| Task | Command |
|---|---|
| Dev server | `npm run dev` |
| Build | `npm run build` |
| Type check | `npm run lint` (runs `tsc --noEmit`) |
| Run tests | `npx vitest run` |
| Setup wizard | `npm run setup` |
| Docker build | `npm run docker:build` |

## Running Tests

**IMPORTANT:** Tests MUST be run from the user's terminal or VS Code (F5 via `.vscode/launch.json`). The bash tool's pipe capture mechanism cannot handle vitest's child process cleanup on Windows and will hang indefinitely — even though all tests pass.

- `npx vitest run` in terminal works fine (130 tests, ~5s)
- VS Code launch configs are in `.vscode/launch.json`
- `tsc --noEmit` works fine from the bash tool for type checking

### Test Structure

- `src/proxy-logic.test.ts` — Unit tests for proxy logic (49 tests)
- `test/e2e.test.ts` — E2E tests with real mock upstream + proxy servers (35 tests)
- `test/cli-setup.test.ts` — CLI setup wizard tests including smoke tests (46 tests)
- `test/global-teardown.ts` — Forces `process.exit(0)` after 1s to prevent Windows hanging

## Architecture

```
src/
  index.ts          — Entry point, starts the proxy server
  proxy.ts          — Hono app, middleware, request handling
  proxy-logic.ts    — Core failover/circuit-breaker logic (pure functions)
  config.ts         — YAML config loading and validation
  logger.ts         — Pino logger setup
  cli/
    setup.ts        — Interactive CLI setup wizard (exported for testing)
```

### Key Design Decisions

- **Config:** YAML (`config.yaml`), validated at startup. Backup created on re-setup.
- **Failover:** Round-robin across API keys with automatic fallback on errors.
- **Circuit breaker:** Per-key cooldown on 401/429/5xx. Lazy re-enable on next request.
- **Streaming:** Detects `text/event-stream` responses and pipes chunks with failover.
- **Security:** CORS origin whitelist, HTTPS-only upstream, key filtering (min 20 chars, `sk-` prefix).
- **Rate limiting:** Via `hono-rate-limiter` middleware.

## Known Issues & Gotchas

### Windows Child Process Lifecycle

- `child.kill()` on Windows only kills `cmd.exe` (the shell wrapper), not the actual `npx tsx` child process. Orphaned processes keep the event loop alive.
- **Fix:** Use `taskkill /T /F /PID <pid>` to kill the entire process tree.
- `testProxy()` in `src/cli/setup.ts` uses `killProcessTree()` for this reason.

### Vitest Hanging on Windows

- Vitest's fork workers + child processes + Windows pipe capture = hang after tests complete.
- **Fix:** `globalSetup` with `teardown()` that calls `process.exit(0)` after 1s delay.
- **Also:** `closeAllConnections()` on HTTP servers before `server.close()` to kill keep-alive sockets.
- `dist/` is excluded from vitest to prevent running tests twice (`.js` + `.ts`).

### testProxy Race Condition

- When polling `/health`, if a non-proxy server returns 200 with non-JSON body, `res.json()` throws.
- **Critical:** `started = true` and `clearTimeout()` must happen AFTER `await res.json()`, not before. Otherwise the timeout is cleared and the promise hangs forever.

### vi.mock() Hoisting

- Vitest hoists `vi.mock()` and `vi.hoisted()` to the top of the file regardless of where they're written.
- **Rule:** Always place them at the top level of the test file, not inside `describe` blocks.

### Temp Directory Cleanup on Windows

- `rmSync(tmpDir, { recursive: true, force: true })` can fail with EPERM if child processes still hold file handles.
- The smoke tests log a warning but don't fail — this is expected on Windows.

## Code Conventions

- ESM imports with `.js` extension: `import { foo } from './bar.js'`
- Export functions from `setup.ts` for testability (already done)
- No `any` unless absolutely necessary
- Prefer `const` over `let`
- Error messages should be descriptive for CLI output
- YAML config keys: `port`, `upstream`, `requestTimeoutMs`, `keys`, `allowedOrigins`

## Files NOT to Delete

These are gitignored but needed locally:
- `config.yaml` — Active proxy configuration
- `api_keys.txt` — API key reference
- `.codenomad/`, `.slim/` — Tool session artifacts
