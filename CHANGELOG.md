# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0] - 2026-08-29

### Added

- **Multi-provider API keys** — mix OpenCode-Go and CommandCode keys in one
  pool. New `src/providers/` abstraction (`KeyProvider`: prefix match, smoke
  test, usage path, catalog, model affinity) with adapters for both
  providers and a registry that identifies pasted keys by pinging each
  candidate provider (`identifyKey`).
- **Paste-a-key setup flow** — the setup wizard accepts arbitrary text
  containing keys (a `.env` dump, chat message, notes file), extracts every
  key-looking token, identifies its provider with a live read-only smoke
  test (no token spend; also reports the CommandCode subscription plan),
  and labels each account.
- **Cross-provider model routing** — clients always speak the canonical
  OpenCode-Go shapes; requests served by a CommandCode key are remapped to
  its OpenAI-compatible surface (`/zen/go/v1/…` → `/provider/v1/…`) with
  provider identity headers injected per attempt. Model→provider affinity
  routes provider-specific models to a serving key first, with other
  providers as fallback; failover re-applies the same constraint.
- **Cross-provider model aliasing** — the same model served by several
  providers under different ids (`deepseek-v4-flash` vs
  `deepseek/deepseek-v4-flash`) is one entry with aliases, rotating across
  all serving keys. Synced harness configs annotate each model name with
  its rotation width: `DeepSeek V4 Flash (3)` = 3 accounts serve it.
- **dsh (DeepSeek Harness) sync target** — `configharness dsh` adds the
  profile patch layer (`~/.dsh/profiles/web/cordis.patch.yml`) as a fourth
  sync target alongside OpenCode, pi and oh-my-pi; only the saros-proxy
  provider's models are replaced, all other rows preserved.
- `GET /health` reports per-provider key counts (`providers` object).
- `saros-proxy usage` tags each key with its provider; providers without a
  queryable usage API (CommandCode) show `usage: n/a` instead of failing.
- `SAROS_CAPTURE_4XX=1` environment flag: writes the full request context
  of every upstream 4xx to `~/.config/saros/captures/` for replaying
  provider-side validation errors (opt-in; bodies may contain user content).

### Fixed

- Forwarded `content-encoding` no longer leaks downstream: Node's fetch
  transparently decompresses upstream bodies (api.commandcode.ai gzips,
  opencode.ai doesn't), so clients previously received double-encoded
  responses.
- Forwarded `content-length` is dropped when the request body is rewritten
  (model-id aliasing) — a stale length made the upstream wait for missing
  bytes until timeout.
- Plan-gated models (HTTP 403 `MODEL_NOT_IN_PLAN`) and unknown models
  (opencode-go returns 401 `ModelError` with a valid key) are classified as
  request faults — they no longer disable keys via the circuit breaker.
- Non-interactive setup infers the provider before encrypting keys, so
  encrypted CommandCode keys route correctly after a restart; the
  documented `label:key:provider` key-file column is now actually parsed.

### Changed

- `isValidApiKey` accepts `sk-…` (OpenCode-Go / CommandCode console) and
  `user_…` (CommandCode token) of ≥ 20 chars; provider inference is
  `user_` → commandcode, `sk-` → opencode-go unless `provider:` is set
  explicitly in config.yaml. Per-provider upstream overrides via the new
  `upstreams:` config map (HTTPS only).
- CommandCode-only models are synced to harnesses as `<id>@commandcode`
  (e.g. `claude-…` excluded — served via the Anthropic Messages endpoint
  only, unusable through the proxy); selected models declare a conservative
  reasoning-effort ladder instead of harness-invented ones.

## [0.7.4] - 2026-08-16

### Fixed

- `saros-proxy status` no longer reports "not running" when the proxy is
  genuinely serving but has no PID file (started manually, via autostart, or
  in another session). It now falls back to an os-agnostic `/health` port
  probe, and prints the enabled harnesses (`configharness` selection) so you
  can see which harnesses the proxy is installed on.
- `saros-proxy start` now refuses with a clear "port already in use — a proxy
  instance appears to be running" message instead of the misleading
  "Proxy exited shortly after starting. Check your config." when the port is
  occupied. Child stderr is captured to `~/.config/saros/daemon.log`, and the
  real startup failure (EADDRINUSE, invalid API keys, etc.) is surfaced when
  a fresh instance dies.

### Changed

- Bare `saros-proxy` (no subcommand) no longer starts the proxy — it prints
  an overview instead: running state (PID/port), enabled harnesses, masked
  API keys, and config path. Starting the proxy now requires an explicit
  `saros-proxy start` (daemon) or the new `saros-proxy serve` (foreground,
  also what the daemon child and Docker entrypoint run). Running bare
  previously crashed with an unhandled `EADDRINUSE` when the port was taken.
- `configharness` is now additive: `saros-proxy configharness omp` followed by
  `configharness pi` enables both harnesses instead of silently replacing the
  selection with the last one. New `--remove <h>...` and `--clear` flags
  disable harnesses. The first explicit command on a fresh install still
  starts from exactly the set you name; the implicit `opencode` default only
  applies while no settings file exists.

## [0.7.3] - 2026-08-15

### Fixed

- `saros-proxy status` now reports the installed port for the VBS autostart
  method. The status regex previously required `start--port` without a space,
  but the installer writes `start --port N` — the port was never shown.
- Config sync error messages no longer claim "restored from backup" when no
  backup existed.

### Changed

- CI: coverage thresholds raised to 95% (statements/branches/functions/lines);
  new security stage (gitleaks secret scan, `npm audit`, CodeQL analysis);
  docs-only changes skip CI; all GitHub Actions pinned to commit SHAs with
  dependabot keeping them current.
- Publish: tag/version consistency guard, npm provenance, packed-tarball
  smoke test before release.
- Removed dead circuit-breaker helpers (`reenableKey`, `isKeyDisabled`) from
  `proxy-logic.ts`.

### Security

- Dependency fixes for high-severity advisories (hono, nanoid, postcss) —
  `npm audit` now reports 0 vulnerabilities.

## [0.7.1] - 2026-08-15

### Added

- Multi-harness model sync: saros-proxy now syncs its provider + model config
  into the `pi` and `oh-my-pi` (`omp`) harnesses in addition to OpenCode.
  Opt-in per harness via `saros-proxy configharness [omp|ohmypi] [pi] [oc|opencode]`;
  the selection lives in `~/.config/saros/harnesses.json` (missing file defaults
  to `opencode`). `sync-models`/`sync-upstream` and daemon startup sync now
  target enabled harnesses only.
- Sync preserves every user field except `providers["saros-proxy"].models`,
  skips harnesses whose config file does not exist, backs up once before
  writing, and restores the file from backup if the write is invalid.
- Model lists are generated from the live upstream catalog enriched with
  models.dev metadata (falling back to bundled models when offline).

## [0.1.0] - 2026-06-06

### Added

- Initial release of Saros
- Multi-key rotation with round-robin distribution
- Automatic failover with circuit breaker pattern
- Usage-based key selection via dashboard scraping
- Streaming (SSE) pass-through with mid-stream error detection
- API key encryption at rest (AES-256-GCM + scrypt)
- Interactive CLI setup wizard with Firefox cookie extraction
- OpenCode client configuration integration
- Docker support with multi-stage builds
- Configurable CORS, rate limiting, and request timeouts
- Health endpoint with key status and circuit breaker state
- Graceful shutdown with active request draining
- Comprehensive test suite (130+ tests)

### Security

- API key masking in all logs
- SSRF prevention (HTTPS-only upstream)
- Path traversal protection
- Hop-by-hop header sanitization
- Non-root Docker user

[Unreleased]: https://github.com/vitorvilaca3011/saros-proxy/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/vitorvilaca3011/saros-proxy/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/vitorvilaca3011/saros-proxy/releases/tag/v0.8.0
