# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/vitorvilaca3011/saros-proxy/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vitorvilaca3011/saros-proxy/releases/tag/v0.1.0
