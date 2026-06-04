# OpenCode-Go Multi-Account Proxy

A lightweight, production-ready HTTP proxy for the OpenCode-Go API with **multi-key rotation**, **circuit-breaker failover**, **streaming pass-through**, and **security hardening**.

Manage multiple OpenCode-Go API keys behind a single endpoint. When one key is rate-limited, revoked, or returns server errors, the proxy automatically fails over to the next healthy key — with zero downtime.

---

## Features

- **Multi-key rotation** — Round-robin distribution across API keys.
- **Automatic failover** — Retry failed requests with the next available key.
- **Circuit breaker** — Disable failing keys after a configurable threshold, then lazily re-enable them after a cooldown period.
- **Streaming support** — SSE pass-through with mid-stream error detection.
- **Request timeout** — Configurable timeout with graceful 504 response.
- **Graceful shutdown** — Drains active requests before exiting.
- **Security hardening** — API key masking in logs, SSRF prevention (HTTPS-only upstream), configurable CORS, host binding validation.
- **Config validation** — CLI args, YAML file, and environment variables with sensible defaults.
- **Health endpoint** — `GET /health` returns key status, active requests, and circuit-breaker state.
- **No database** — Stateless proxy, zero external dependencies beyond Node.js.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Client / OpenCode                  │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐         │
│  │ Request 1 │   │ Request 2 │   │ Request 3 │  ...  │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘         │
└───────┼──────────────┼──────────────┼────────────────┘
        │              │              │
        ▼              ▼              ▼
┌──────────────────────────────────────────────────────┐
│               OpenCode-Go Proxy (:3000)               │
│                                                       │
│  ┌─────────────┐   ┌────────────┐   ┌─────────────┐  │
│  │ Key Selector│──▶│ Circuit    │──▶│ Request     │  │
│  │ Round-robin │   │ Breaker    │   │ Forwarder   │  │
│  │ + Failover  │   │ Threshold  │   │ + Timeout   │  │
│  └─────────────┘   │ + Cooldown │   └──────┬──────┘  │
│                    └────────────┘          │         │
│  ┌─────────────────────────────────────────┘         │
│  │  ┌─────────────────────┐                          │
│  └──▶ Streaming Detector  │  SSE passthrough         │
│     └─────────────────────┘                          │
└──────────────────────┬───────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
   ┌──────────┐ ┌──────────┐ ┌──────────┐
   │ Key A    │ │ Key B    │ │ Key C    │
   │ sk-abc…  │ │ sk-def…  │ │ sk-ghi…  │
   └────┬─────┘ └────┬─────┘ └────┬─────┘
        │            │            │
        ▼            ▼            ▼
   ┌───────────────────────────────────────┐
   │        OpenCode-Go API (upstream)     │
   │        https://opencode.ai            │
   └───────────────────────────────────────┘
```

---

## Installation

### From npm (when published)

```bash
npm install -g opencode-go-proxy
```

### From source

```bash
git clone https://github.com/opencode-go/proxy.git
cd proxy
npm install
npm run build
```

> **Requirements**: Node.js >= 20.0.0

---

## Quick Start

### 1. Create a configuration file

```yaml
# config.yaml
port: 3000
host: 127.0.0.1
upstreamBaseUrl: https://opencode.ai
keys:
  - label: primary
    key: sk-your-primary-key-here-12345678
  - label: secondary
    key: sk-your-secondary-key-here-87654321
circuitBreakerThreshold: 3
circuitBreakerCooldownMs: 60000
requestTimeoutMs: 30000
```

### 2. Run the proxy

```bash
# Using tsx (development)
npx tsx src/index.ts

# Using built JavaScript
node dist/index.js
```

### 3. Test it

```bash
curl http://127.0.0.1:3000/health

# Query models
curl http://127.0.0.1:3000/zen/go/v1/models

# Chat completion
curl http://127.0.0.1:3000/zen/go/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello"}]}'
```

---

## Configuration Reference

All configuration options can be set via YAML file (`config.yaml`), environment variables, or CLI flags. Priority order: CLI > YAML > env vars > defaults.

### YAML / Environment Variables

| Option | CLI Flag | Env Variable | Default | Description |
|---|---|---|---|---|
| `port` | `--port` | `PROXY_PORT` | `3000` | Listening port (1–65535) |
| `host` | `--host` | `PROXY_HOST` | `127.0.0.1` | Bind address |
| `upstreamBaseUrl` | — | `UPSTREAM_BASE_URL` | `https://opencode.ai` | Upstream API base URL (HTTPS only) |
| `circuitBreakerThreshold` | — | `CIRCUIT_BREAKER_THRESHOLD` | `3` | Consecutive failures before disabling a key (1–10) |
| `circuitBreakerCooldownMs` | — | `CIRCUIT_BREAKER_COOLDOWN_MS` | `60000` | Cooldown in ms before re-enabling a key (1000–3600000) |
| `requestTimeoutMs` | — | `REQUEST_TIMEOUT_MS` | `30000` | Upstream request timeout in ms (1000–300000) |
| `allowedOrigins` | — | — | `["http://localhost:*", "http://127.0.0.1:*"]` | CORS allowed origins (use `[]` to allow all) |
| `keys` | — | `OPENCODE_GO_KEYS` | — | Array of `{label, key}` objects or comma-separated env format |
| `config` | `--config` | — | `config.yaml` | Path to YAML config file |

### API Key Format

Keys must start with `sk-` and be at least 20 characters.

**YAML:**
```yaml
keys:
  - label: my-account
    key: sk-your-key-here...
```

**Environment variable:**
```bash
OPENCODE_GO_KEYS="account1:sk-xxx,account2:sk-yyy"
```

### CLI Flags

```bash
tsx src/index.ts --config my-config.yaml --port 4000 --host 0.0.0.0
```

---

## Usage Examples

### Basic: Run with YAML config

```bash
# Create config.yaml (see Quick Start), then:
npx tsx src/index.ts
```

### Advanced: Run with environment variables only

```bash
export PROXY_PORT=4000
export PROXY_HOST=127.0.0.1
export OPENCODE_GO_KEYS="home:sk-abc123...,work:sk-def456..."
export CIRCUIT_BREAKER_THRESHOLD=5
export CIRCUIT_BREAKER_COOLDOWN_MS=120000
export REQUEST_TIMEOUT_MS=45000
export LOG_LEVEL=debug
export NODE_ENV=development

npx tsx src/index.ts
```

### Custom config path

```bash
npx tsx src/index.ts --config /etc/opencode-proxy/config.yaml
```

### Run as a background service (Linux)

```bash
nohup npx tsx src/index.ts > proxy.log 2>&1 &
```

---

## OpenCode Integration

Configure OpenCode to use the proxy as its API endpoint:

```yaml
# In your OpenCode configuration (e.g. ~/.config/opencode/config.yaml)
api:
  baseUrl: http://127.0.0.1:3000  # Point to the proxy
  # Do NOT set an API key here — the proxy handles key selection
```

All requests from OpenCode to `*/zen/go/v1/*` will be forwarded through the proxy with automatic key management.

---

## Troubleshooting

### Check proxy health

```bash
curl http://127.0.0.1:3000/health
```

Returns JSON with key counts, active requests, and circuit-breaker state.

### View logs

```bash
# Development (pretty-printed, colorized)
NODE_ENV=development npx tsx src/index.ts

# Production (structured JSON)
NODE_ENV=production npx tsx src/index.ts
```

### Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `No valid API keys configured` | Missing or invalid keys | Check `keys` in config.yaml or `OPENCODE_GO_KEYS` env var |
| `ECONNREFUSED` on startup | Port already in use | Change `port` or kill the existing process |
| `504 Gateway Timeout` | Upstream request exceeded timeout | Increase `requestTimeoutMs` or check upstream latency |
| `All API keys are temporarily unavailable` | All keys disabled by circuit breaker | Wait for cooldown or check upstream status |
| `CORS violation` | Client origin not in `allowedOrigins` | Add the origin to `allowedOrigins` in config |

---

## Development

### Run tests

```bash
# Unit tests
npm test

# E2E tests (requires network)
npx vitest run test/e2e.test.ts

# Watch mode
npm test -- --watch
```

### Type check

```bash
npm run lint
```

### Build

```bash
npm run build
```

Output goes to `dist/`.

### Project structure

```
src/
  index.ts          — Entry point, server startup, graceful shutdown
  proxy.ts          — Hono HTTP app, routing, streaming, failover
  proxy-logic.ts    — Pure logic: key selection, circuit breaker, error classification
  proxy-logic.test.ts — Unit tests for proxy logic
  config.ts         — Configuration loading from YAML, env vars, CLI
  logger.ts         — Structured logging with Pino + key masking
test/
  e2e.test.ts       — End-to-end tests with mock upstream
```

### Contributing

1. Fork the repository.
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit changes: `git commit -am 'Add my feature'`
4. Push: `git push origin feat/my-feature`
5. Open a pull request.

---

## License

[MIT](LICENSE) © 2026 OpenCode-Go Proxy Contributors
