# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
