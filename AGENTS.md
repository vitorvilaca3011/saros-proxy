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

`npx vitest run` works from any invocation (terminal, VS Code, bash tool) — see "Vitest Hanging on Windows" below for the pool choice that makes this possible.

- `npx vitest run` — full suite (~8s, 920 tests)
- `npx vitest run test/proxy-logic.test.ts` — single file
- `npx vitest run -t "pattern"` — filter by test name
- VS Code launch configs are in `.vscode/launch.json`
- `tsc --noEmit` (`npm run lint`) works fine from the bash tool for type checking

### Test Structure

- `test/proxy-logic.test.ts` — Unit tests for proxy logic (59 tests)
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
- **Token accounting:** Each forwarded response's `usage` (final SSE chunk for streams, top-level object otherwise) is booked per key label in `src/token-usage.ts` and persisted to `<config dir>/token-usage.json` with debounced atomic writes (mirrors `model-stats.ts`). Streaming requests get `stream_options.include_usage` injected when the provider advertises `supportsStreamUsage` and the client didn't set the option itself. Upstreams may repeat the same counts on several chunks (CommandCode: finish chunk + trailing usage-only chunk), so a stream is booked exactly once, preferring the usage-only chunk (`choices: []`).
- **Session headers:** `KeyProvider.sessionHeader` (OpenCode-Go: `x-opencode-session`, required live — 400 `MissingSessionID` otherwise) is forwarded when the client sends it and derived from the conversation (model + first user turn, system prompt excluded) when it doesn't. Body prep for one attempt happens in a single JSON pass (`prepareOutboundRequest` in `proxy.ts`).
- **Entitlement gating:** the usage refresh also classifies 403s that mean "account has no plan for this provider" (`src/usage-client.ts:isEntitlementError` — opencode-go `EntitlementError`, commandcode `upgrade_required`). Such keys get `entitled = false` in `ProxyState` (`setKeyEntitlement`) and are skipped by selection without touching the circuit breaker; a later refresh that returns usage flips them back. `/health` exposes `entitledCount`.
- **Key identification:** `oc_sk_…` is minted only by OpenCode-Go → definitive `yes` without a network probe; `user_…` → CommandCode; legacy `sk-…` is shared between providers, so it stays ambiguous and identification falls back to the live read-only smoke test. Validation, paste extraction and `inferProvider` accept all three prefixes.
- **Security:** CORS origin whitelist, HTTPS-only upstream, key filtering (min 20 chars; `oc_sk_`, `sk-` or `user_` prefix).
- **Rate limiting:** Via `hono-rate-limiter` middleware.

## Known Issues & Gotchas

### Windows Child Process Lifecycle

- `child.kill()` on Windows only kills `cmd.exe` (the shell wrapper), not the actual `npx tsx` child process. Orphaned processes keep the event loop alive.
- **Fix:** Use `taskkill /T /F /PID <pid>` to kill the entire process tree.
- `testProxy()` in `src/cli/setup.ts` uses `killProcessTree()` for this reason.

### Vitest Hanging on Windows

- Vitest's default `'forks'` pool hangs on Windows because tinypool fork workers don't shut down cleanly — they hold stdio pipes open, so the bash tool's pipe capture never returns.
- **Fix:** `pool: 'vmThreads'` in `vitest.config.ts` (runs tests in a VM context backed by `worker_threads`, no OS-level process boundary to leak handles). Verified: 582/582 tests pass in ~7s with no hang.
- **Also kept:** `globalSetup` with `teardown()` that calls `process.exit(0)` after 1s delay — belt-and-suspenders for the rare edge case.
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

## Versioning & Releases

**Bump the npm version only for feature or behavioral changes.** Docs-only changes (README, CHANGELOG, comments) merge to master WITHOUT a version bump and WITHOUT publishing to npm.

- Never republish a taken version. `0.7.2` through `0.10.1` are taken on npm; the next patch is `0.10.2`, the next feature release `0.11.0`.
- Git and npm are aligned at `0.10.1` — keep them in lockstep on every release. Pushing a `v*` tag is what publishes (the Publish workflow authenticates with OIDC and refuses a tag that disagrees with `package.json`).
- Feature release: `npm version <x.y.z>` → `npm run lint` + `npx vitest run` → `npm run build` → commit + `git tag v<x.y.z>` → `npm publish` → push master + tag.
- Docs-only: commit to master, push. No bump, no tag, no publish.

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
