# Saros

[![CI](https://github.com/vitorvilaca3011/saros-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/vitorvilaca3011/saros-proxy/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/saros-proxy.svg)](https://www.npmjs.com/package/saros-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2022.0.0-brightgreen.svg)](https://nodejs.org/)

Saros — like the eclipse cycle, this proxy predicts exhaustion and rotates accounts before they run out. Built for the OpenCode-Go API.

Manage multiple OpenCode-Go API keys behind a single endpoint. When one key gets rate-limited, revoked, or returns server errors, the proxy automatically fails over to the next healthy key — zero downtime.

---

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
  - [Prompt Install](#prompt-installfor-the-lazy-ones)
  - [Quick Install (npm)](#quick-install-npm)
  - [From Source](#from-source)
  - [Docker](#docker)
  - [Setup Wizard](#setup-wizard)
- [Configuration Reference](#configuration-reference)
- [Usage Examples](#usage-examples)
- [OpenCode Integration](#opencode-integration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Security](#security)
- [License](#license)

---

## Features

- **Multi-key rotation** — Round-robin across all your API keys.
- **Auto failover** — Retry failed requests with the next healthy key.
- **Circuit breaker** — Disable flaky keys after a configurable threshold, then lazily re-enable them after cooldown.
- **Streaming support** — SSE passthrough with mid-stream error detection.
- **Request timeout** — Configurable timeout with a clean 504 response.
- **Graceful shutdown** — Drains active requests before exiting (no dropped connections).
- **Security hardening** — API key masking in logs, SSRF prevention (HTTPS-only upstream), configurable CORS, host binding validation.
- **Config validation** — CLI args, YAML file, or environment variables with sensible defaults.
- **Health endpoint** — `GET /health` shows key status, active requests, and circuit-breaker state.
- **No database** — Stateless proxy, zero external dependencies beyond Node.js.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Your App / OpenCode                     │
│                                                             │
│   ┌──────────┐   ┌──────────┐   ┌──────────┐                │
│   │ Request 1│   │ Request 2│   │ Request 3│    ...         │
│   └────┬─────┘   └────┬─────┘   └────┬─────┘                │
└────────┼──────────────┼──────────────┼──────────────────────┘
         │              │              │
         └──────────────┼──────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                       Saros (:3000)                         │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ Key Selector │─▶│   Circuit    │─▶│   Request   │       │
│  │ Round-Robin  │  │   Breaker    │  │   Forwarder  │       │
│  │ + Failover   │  │ Threshold +  │  │ + Timeout +  │       │
│  │              │  │   Cooldown   │  │     SSE      │       │
│  └──────────────┘  └──────────────┘  └──────┬───────┘       │
└─────────────────────────────────────────────┼───────────────┘
                                              │
                                  ┌───────────┼───────────┐
                                  ▼           ▼           ▼
                           ┌──────────┐ ┌──────────┐ ┌──────────┐
                           │  Key A   │ │  Key B   │ │  Key C   │
                           │ sk-abc…  │ │ sk-def…  │ │ sk-ghi…  │
                           └────┬─────┘ └────┬─────┘ └────┬─────┘
                                │            │            │
                                └────────────┼────────────┘
                                             ▼
                                ┌──────────────────────────┐
                                │    OpenCode-Go API       │
                                │    https://opencode.ai   │
                                └──────────────────────────┘
```

### How Request Distribution Works

Here's how Saros picks which API key to use — it runs on two levels:

#### Layer 1: Round-Robin (always on)

Every new request cycles to the next key in order:

```
Request 1 → Key A
Request 2 → Key B
Request 3 → Key C
Request 4 → Key A (wraps around)
```

Even distribution by default. Got 2 accounts? Odd requests go to account 1, even to account 2. Simple.

#### Layer 2: Usage-Based Gating (optional)

If you enable dashboard scraping, Saros checks each account's quota before picking a key:

- Usage **≥ threshold** (default 70%) → that key gets skipped
- **All** keys over threshold → falls back to the lowest-usage key
- No usage data available → pure round-robin, no change

| Scenario | Behavior |
|---|---|
| Scraping off | Pure round-robin across all keys |
| Scraping on + data available | Round-robin, skipping over-quota accounts |
| Scraping on + no data | Falls back to pure round-robin |

#### Concurrent Request Safety

Saros tracks which keys are currently in use. A key handling a streaming request won't get assigned another one until it finishes. No double-booking.

---

## Installation

### Prompt Install(for the lazy ones)

Don't feel like reading through everything? Copy this prompt and paste it to your AI assistant. It'll read [`LLM_INSTRUCTIONS.md`](LLM_INSTRUCTIONS.md) and guide you through setup — no keys shared in chat.

```
Install Saros Proxy for my opencode. (https://github.com/vitorvilaca3011/saros-proxy)
Follow the instructions on LLM_INSTRUCTIONS.md.
```

---

### Quick Install (npm)

```bash
npm install -g saros-proxy
```

### From Source

```bash
git clone https://github.com/vitorvilaca3011/saros-proxy.git
cd proxy
npm install
npm run build
```

> **Requirements:** Node.js >= 22.0.0

---

### Docker

Run in a clean Linux container without installing Node.js locally.

#### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (Compose v2)

#### Quick start

```bash
# 1. Create config.yaml from the example (edit with your keys)
cp config.example.yaml config.yaml

# 2. Build the image
npm run docker:build

# 3. Start the proxy
npm run docker:run
```

The proxy is now at `http://127.0.0.1:3000`.

#### Run tests in Docker

```bash
npm run docker:test
```

#### Manual Docker commands

```bash
# Build
docker compose build proxy

# Run in foreground
docker compose up proxy

# Run in background (detached)
docker compose up -d proxy

# View logs
docker compose logs -f proxy

# Stop
docker compose down

# Run tests
docker compose run --rm test
```

#### Configuration with Docker

Mount a custom `config.yaml` or use environment variables:

```bash
# Using env vars (no config.yaml needed)
docker compose run --rm -e OPENCODE_GO_KEYS="home:sk-xxx,work:sk-yyy" proxy

# Or edit docker-compose.yml to set env vars, then:
docker compose up proxy
```

---

### Setup Wizard

The easiest way to get going:

```bash
# If installed globally
saros-proxy setup

# Or with npx
npx saros-proxy setup
```

The wizard will:
1. Ask for your proxy port (default: 3000)
2. Ask for your API keys (name + key)
3. Generate `config.yaml` automatically
4. Run a smoke test to verify everything works

Want to run manually instead? Skip the wizard and just create a `config.yaml`:

```yaml
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

Then run:

```bash
# Development (hot reload)
npx tsx src/index.ts

# Production (built)
node dist/index.js
```

Test that it's alive:

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

---

## Configuration Reference

Every option can be set via YAML (`config.yaml`), environment variables, or CLI flags. Priority: CLI > YAML > env vars > defaults.

### Options

| Option | CLI Flag | Env Variable | Default | Notes |
|---|---|---|---|---|
| `port` | `--port` | `PROXY_PORT` | `3000` | 1–65535 |
| `host` | `--host` | `PROXY_HOST` | `127.0.0.1` | Bind address |
| `upstreamBaseUrl` | — | `UPSTREAM_BASE_URL` | `https://opencode.ai` | HTTPS only |
| `circuitBreakerThreshold` | — | `CIRCUIT_BREAKER_THRESHOLD` | `3` | Consecutive fails before disabling (1–10) |
| `circuitBreakerCooldownMs` | — | `CIRCUIT_BREAKER_COOLDOWN_MS` | `60000` | Cooldown before re-enabling (1000–3600000) |
| `requestTimeoutMs` | — | `REQUEST_TIMEOUT_MS` | `30000` | Upstream timeout (1000–300000) |
| `allowedOrigins` | — | — | `["http://localhost:*", "http://127.0.0.1:*"]` | CORS origins (`[]` = allow all) |
| `keys` | — | `OPENCODE_GO_KEYS` | — | Array of `{label, key}` |
| `config` | `--config` | — | `config.yaml` | Path to YAML config |

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

### API Key Encryption

Keys can be encrypted at rest using AES-256-GCM with scrypt key derivation. Encrypted keys look like `enc:scrypt:...` in `config.yaml` and get decrypted at startup using the `OPENCODE_GO_ENCRYPTION_KEY` environment variable.

**Setup with encryption:**
```bash
npm run setup
# Choose to encrypt keys and enter a master key (min 16 chars)
```

**Running with encrypted keys:**
```bash
export OPENCODE_GO_ENCRYPTION_KEY="your-master-key"
npx tsx src/index.ts
```

**Docker with encrypted keys:**
```yaml
# docker-compose.yml
environment:
  - OPENCODE_GO_ENCRYPTION_KEY=your-master-key
```

**Notes:**
- Encrypted keys use AES-256-GCM with scrypt KDF (N=16384, r=8, p=1)
- Each key has its own random salt and IV
- Plaintext keys (`sk-...`) still work — backward compatible
- `OPENCODE_GO_KEYS` env var is always plaintext (for CI/CD)
- If keys are encrypted but no `OPENCODE_GO_ENCRYPTION_KEY` is set, startup fails with a clear error

### CLI Flags

```bash
tsx src/index.ts --config my-config.yaml --port 4000 --host 0.0.0.0
```

---

## Usage Examples

### Basic: YAML config

```bash
# Create config.yaml, then:
npx tsx src/index.ts
```

### Advanced: Environment variables only

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
npx tsx src/index.ts --config /etc/saros/config.yaml
```

### Run as background daemon (all platforms)

The proxy ships with a built-in daemon. Once installed globally (`npm install -g saros-proxy`):

```bash
# Start the daemon (background)
saros-proxy start --port 3000

# Check status
saros-proxy status

# Stop it
saros-proxy stop

# Sync models from src/constants.ts to opencode.json
saros-proxy sync-models
```

The `start` command automatically syncs model definitions to `~/.config/opencode/opencode.json`.

**Daemon config path:** By default the daemon looks for `config.yaml` at:
- Linux/macOS: `~/.config/saros/config.yaml`
- Windows: `%LOCALAPPDATA%\saros\config.yaml`

Override with `--config`:
```bash
saros-proxy start --port 3000 --config /path/to/config.yaml
```

The PID file is stored at `~/.config/saros/daemon.pid`. The child process runs with `NODE_ENV=production` (JSON logging).

---

## OpenCode Integration

Configure OpenCode to route API requests through the proxy. Edit your OpenCode config file at `~/.config/opencode/opencode.json` (global) or `opencode.json` in your project root:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "saros-proxy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Saros",
      "options": {
        "baseURL": "http://127.0.0.1:3000/zen/go/v1",
        "apiKey": "not-used"
      },
      "models": {
        "glm-5": { "name": "GLM-5" },
        "kimi-k2.5": { "name": "Kimi K2.5" },
        "qwen3.7-plus": { "name": "Qwen 3.7 Plus" }
      }
    }
  }
}
```

**Key points:**
- `baseURL` must end at `/v1` — OpenCode appends route paths internally
- `apiKey` can be anything — the proxy handles real key selection
- Model IDs must match what upstream expects (e.g., `glm-5`, not `opencode-go/glm-5`)
- Restart OpenCode after editing the config

**Alternative: Environment variable substitution**

```jsonc
{
  "provider": {
    "saros-proxy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Saros",
      "options": {
        "baseURL": "{env:OPENCODE_PROXY_URL}",
        "apiKey": "{env:OPENCODE_PROXY_KEY}"
      }
    }
  }
}
```

Then set: `export OPENCODE_PROXY_URL=http://127.0.0.1:3000/zen/go/v1`

**Using the proxy in OpenCode:**

Select the proxy provider in OpenCode's model picker, or set it as default:

```jsonc
{
  "provider": { /* ... as above ... */ },
  "model": "saros-proxy/glm-5"
}
```

---

## Troubleshooting

### Check proxy health

```bash
curl http://127.0.0.1:3000/health
```

Returns JSON with key counts, active requests, and circuit-breaker state.

### View logs

```bash
# Dev mode (pretty-printed, colorized)
NODE_ENV=development npx tsx src/index.ts

# Production (structured JSON)
NODE_ENV=production npx tsx src/index.ts
```

### See which key served a request

Saros adds two debug headers to every response:

| Header | Example | What it is |
|---|---|---|
| `X-Proxy-Key-Label` | `primary` | Which key was used |
| `X-Proxy-Request-Id` | `550e8400-e29b-41d4-a716-446655440000` | Unique ID for log correlation |

```bash
curl -s -D - http://127.0.0.1:3000/zen/go/v1/models | grep -i x-proxy
# X-Proxy-Key-Label: primary
# X-Proxy-Request-Id: 550e8400-e29b-41d4-a716-446655440000
```

### Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `No valid API keys configured` | Missing or bad keys | Check `keys` in config.yaml or `OPENCODE_GO_KEYS` |
| `ECONNREFUSED` on startup | Port already in use | Change port or kill the existing process |
| `504 Gateway Timeout` | Upstream too slow | Increase `requestTimeoutMs` |
| `All API keys are temporarily unavailable` | All keys disabled by circuit breaker | Wait for cooldown or check upstream status |
| CORS error | Client origin not allowed | Add it to `allowedOrigins` in config |

---

## Development

### Run tests

```bash
# All tests
npm test

# Just E2E (needs network)
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
  proxy.ts          — Hono app, routing, streaming, failover
  proxy-logic.ts    — Pure logic: key selection, circuit breaker, error classification
  proxy-logic.test.ts — Unit tests for proxy logic
  config.ts         — Config loading from YAML, env vars, CLI
  logger.ts         — Structured logging with Pino + key masking
  cli/
    setup.ts        — Interactive setup wizard
test/
  e2e.test.ts       — End-to-end tests with mock upstream
```

### Contributing

1. Fork the repo.
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit: `git commit -am 'Add my feature'`
4. Push: `git push origin feat/my-feature`
5. Open a pull request.

---

## Security

For vulnerability reporting, see [SECURITY.md](SECURITY.md).

---

## License

[MIT](LICENSE) © 2026 Saros Contributors
