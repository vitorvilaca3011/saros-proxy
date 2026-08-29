# Saros

[![CI](https://github.com/vitorvilaca3011/saros-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/vitorvilaca3011/saros-proxy/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/saros-proxy.svg)](https://www.npmjs.com/package/saros-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2022.0.0-brightgreen.svg)](https://nodejs.org/)

Saros — like the eclipse cycle, this proxy predicts exhaustion and rotates accounts before they run out. Built for the OpenCode-Go API, now multi-provider.

Manage multiple API keys behind a single endpoint — OpenCode-Go **and** CommandCode keys can live in the same pool. When one key gets rate-limited, revoked, or returns server errors, the proxy automatically fails over to the next healthy key — zero downtime.

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
- [Multi-Harness Integration (pi & oh-my-pi)](#multi-harness-integration-pi--oh-my-pi)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Security](#security)
- [License](#license)

---

## Features

- **Multi-provider keys** — Mix OpenCode-Go (`sk-…`) and CommandCode (`user_…` / `sk-…`) keys in one pool.
- **Paste-a-key setup** — Drop any text containing keys into the setup wizard; Saros extracts them and identifies the provider by pinging each provider's API (smoke test).
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

Here's how Saros picks which API key to use:

#### Usage-Weighted Rotation

Saros polls the upstream usage API for each key (5h / weekly / monthly windows)
and weights rotation by **remaining** quota. If key X is 30% used and key Y is
70% used, 10 requests are distributed 7 → X and 3 → Y — proportional balancing,
not hard cutoffs, so neither key absorbs the full load when the other runs low.

- Refreshed in the background every 60s (stale data keeps working).
- Without usage data, falls back to even round-robin.

#### Circuit Breaker

Keys that return auth/quota errors (`401`, quota `4xx/5xx`) enter a cooldown
and are lazily re-enabled after it expires. Timeouts and connection errors do
**not** disable keys — they are shared-upstream failures, so Saros keeps
cycling instead of locking up with "all keys unavailable".

#### Concurrent Request Safety

Saros tracks which keys are currently in use. A key handling a streaming request won't get assigned another one until it finishes. No double-booking.

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
2. Offer a **paste-a-key mode**: drop any text containing your keys (a `.env` dump, chat message, notes file) — Saros extracts every key and identifies its provider with a live smoke test, showing the detected provider and plan
3. Ask for your API keys manually if you prefer (typed input also auto-detects `user_` CommandCode tokens)
4. Generate `config.yaml` automatically
5. Run a smoke test to verify everything works
6. Configure opencode.json with provider settings and model definitions

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
  - label: commandcode
    key: user_your-commandcode-token-here
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
| `keys` | — | `OPENCODE_GO_KEYS` | — | Array of `{label, key, provider?}` |
| `upstreams` | — | — | provider defaults | Per-provider upstream URL overrides (HTTPS only) |
| `config` | `--config` | — | `config.yaml` | Path to YAML config |

### API Key Format

Saros accepts keys from multiple providers. A key must be at least 20 characters and match one of these formats:

| Prefix | Provider | Notes |
|---|---|---|
| `sk-…` | OpenCode-Go or CommandCode | `sk-` is shared by both providers; Saros infers OpenCode-Go unless an explicit `provider` is set |
| `user_…` | CommandCode | Always detected as CommandCode |

**YAML:**
```yaml
keys:
  - label: my-account
    key: sk-your-key-here...            # opencode-go (default inference)
  - label: cc-account
    key: user_your-token-here...        # commandcode (inferred from prefix)
  - label: cc-console-key
    key: sk-your-console-key-here...    # ambiguous prefix → set provider explicitly
    provider: commandcode
```

The `provider` field is optional — it wins over prefix inference and is required only when a CommandCode `sk-` console key must be distinguished from an OpenCode-Go key. When keys are encrypted at rest (prefix hidden), the provider from setup time is persisted alongside.

**Per-provider upstream override (optional):**

```yaml
upstreams:
  commandcode: https://api.commandcode.ai   # default
  opencode-go: https://opencode.ai          # default
```

**Environment variable:**
```bash
OPENCODE_GO_KEYS="account1:sk-xxx,cc:user_yyy"
```

#### How multi-provider routing works

- Clients always speak the canonical OpenCode-Go shapes (`/zen/go/v1/...` or the `/v1/...` alias).
- When a request is served by a CommandCode key, Saros remaps the route to CommandCode's OpenAI-compatible surface (`/provider/v1/...`) and injects the provider's identity headers — transparent to the client.
- Models uniquely named by a provider (e.g. `claude-*` or vendor-prefixed ids on CommandCode) are routed to a key of that provider first; other providers remain as fallback.
- Synced harness configs may list provider-specific models as `model@commandcode`; the suffix selects the provider and is stripped before forwarding.
- The `/health` endpoint reports per-provider key counts under `providers`.
- Usage-based weighted rotation applies to providers with a queryable usage API (OpenCode-Go). CommandCode keys participate in rotation without usage data.

#### Smoke test (key identification)

`identifyKey` verifies a key by pinging each candidate provider with a cheap, read-only request (no token spend): OpenCode-Go `GET /zen/go/v1/usage`, CommandCode `GET /alpha/billing/subscriptions` (which also reports the subscription plan). `200` = valid, `401/403` = rejected, network error = inconclusive. The setup wizard uses this to label pasted keys; you can run it yourself:

```bash
CC_KEY=user_your-token npx tsx scripts/live-identify-check.ts
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
# Show the overview (running state, harnesses, API keys, config path)
saros-proxy

# Start the daemon (background)
saros-proxy start --port 3000

# Check status
saros-proxy status

# Stop it
saros-proxy stop

# Add harnesses to the model-sync selection (omp|ohmypi, pi, oc|opencode)
saros-proxy configharness omp pi oc

# Remove a harness, or disable sync entirely
saros-proxy configharness --remove pi
saros-proxy configharness --clear

# List the current harness selection
saros-proxy configharness

# Probe model capabilities (liveness, reasoning, tool calling)
saros-proxy probe [model-id]

# Probe all models
saros-proxy probe

# Show per-key quota usage and most-used models
saros-proxy usage

# Install autostart (Windows: VBS script or Registry)
saros-proxy autostart install [--port <port>] [--method vbs|registry|auto]

# Uninstall autostart
saros-proxy autostart uninstall [--method vbs|registry|auto]

# Check autostart status
saros-proxy autostart status [--method vbs|registry|auto]
```

The `start` command automatically syncs model definitions to all enabled harnesses (see [Multi-Harness Integration](#multi-harness-integration-pi--oh-my-pi)).

### Model Sync Commands

Saros keeps your harness configs in sync with the upstream API. Which harnesses are synced is opt-in via the harness selection (see [Multi-Harness Integration](#multi-harness-integration-pi--oh-my-pi)).

```bash
# List which harnesses are enabled for model sync
saros-proxy configharness

# Add oh-my-pi, pi, and OpenCode to the sync selection (additive)
saros-proxy configharness omp pi oc

# Remove a harness, or disable sync entirely
saros-proxy configharness --remove pi
saros-proxy configharness --clear

# Sync the live model list from upstream into all enabled harnesses
saros-proxy sync-upstream

# Probe model capabilities
saros-proxy probe [model-id]

# Probe all configured models
saros-proxy probe

# Show per-key quota usage and most-used models
saros-proxy usage
```
`sync-upstream` fetches the live model list from upstream and writes it to each enabled harness, with metadata from models.dev.
It only touches `providers["saros-proxy"].models` in the target configs and skips harnesses whose config file does not exist.
`probe` tests each model's liveness, reasoning, and tool-calling capabilities via the proxy.

**Daemon config path:** By default the daemon looks for `config.yaml` at:
- Linux/macOS: `~/.config/saros/config.yaml`
- Windows: `%LOCALAPPDATA%\saros\config.yaml`

Override with `--config`:
```bash
saros-proxy start --port 3000 --config /path/to/config.yaml
```

The PID file is stored at `~/.config/saros/daemon.pid`. The child process runs with `NODE_ENV=production` (JSON logging), and its stderr is appended to `~/.config/saros/daemon.log`.

`saros-proxy status` checks the PID file first, then falls back to an os-agnostic `GET /health` port probe — so it reports the truth even when the proxy was started outside the daemon (manually, via autostart, or in another session) and no PID file exists. It also prints the enabled harnesses (`configharness` selection). `saros-proxy start` refuses to start a second instance when the configured port is already serving.

Bare `saros-proxy` (no subcommand) prints the same overview without starting anything: running state, harnesses, masked API keys, and config path. To run the proxy in the foreground (e.g. for development or in a container), use `saros-proxy serve [--port <port>] [--config <path>]` — the daemon child and the Docker entrypoint run `serve` under the hood.

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

## Multi-Harness Integration (pi & oh-my-pi)

Besides OpenCode, Saros can keep its provider + model config in sync for the `pi` and `oh-my-pi` (`omp`) harnesses. Both belong to the pi-coding-agent family but use different config files:

| Harness | Config file | Format |
|---|---|---|
| OpenCode | `~/.config/opencode/opencode.json[.jsonc]` | JSON/JSONC |
| pi | `~/.pi/agent/models.json` | JSON |
| oh-my-pi (`omp`) | `~/.omp/agent/models.yml` | YAML |

Sync is opt-in per harness, configured with the `configharness` command. The selection is stored in `~/.config/saros/harnesses.json`:

```bash
# Add omp + pi + opencode to the sync selection (additive)
saros-proxy configharness omp pi oc

# Remove a harness, or disable sync entirely
saros-proxy configharness --remove pi
saros-proxy configharness --clear

# See the current selection
saros-proxy configharness

# Accepted names: omp | ohmypi, pi, oc | opencode
```

`configharness` is additive: each command adds the named harnesses to the current selection (running `configharness omp` then `configharness pi` enables both). Use `--remove <h>...` to disable specific harnesses or `--clear` to disable sync for every harness.

Behavior:

- If `harnesses.json` does not exist, only OpenCode is synced (the default).
- An explicit empty selection (`{"harnesses":[]}`) disables sync entirely.
- Sync never creates a harness config: harnesses whose config file is missing are skipped.
- Only `providers["saros-proxy"].models` is replaced; all other providers, fields, and settings are preserved, and a `<file>.backup` is created before the first write.

The model list written to each harness comes from the live upstream catalog enriched with models.dev metadata (falling back to bundled models when offline), so pi/omp stay current alongside OpenCode.

> **Why a static model list?** Both harnesses use a static `models` list on purpose. `pi` has no `/v1/models` discovery for custom providers, and `oh-my-pi`'s discovery cannot recover reasoning/context/output metadata for OpenCode-Go model IDs — dynamic discovery would silently break thinking-level (`:max`/`:high`) role configs in `~/.omp/agent/config.yml`.

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
  index.ts              — Entry point, CLI dispatch, server startup
  proxy.ts              — Hono app, routing, streaming, failover
  proxy-logic.ts        — Pure logic: key selection, circuit breaker
  config.ts             — Config loading from YAML, env vars, CLI
  constants.ts          — All defaults and configuration values
  logger.ts             — Structured logging with Pino + key masking
  providers/            — Multi-provider key abstraction (KeyProvider, adapters, identifyKey)
  models-fetcher.ts     — Upstream model list fetching + caching
  models-sync.ts        — Auto-sync models from upstream to opencode config
  cli/
    setup.ts            — Interactive setup wizard
    daemon.ts           — Background process management
    opencode-config.ts  — opencode.json read/write/sync
    harness-models.ts   — Canonical model map + pi/omp shape transform
    harness-sync.ts     — Harness selection settings + multi-harness sync
    omp-config.ts       — oh-my-pi models.yml read/write/sync
    pi-config.ts        — pi models.json read/write/sync
    autostart.ts        — Windows/Linux autostart install/uninstall
    ui.ts               — CLI UI abstraction (@clack/prompts wrapper)
    help.ts             — Help text
    update-check.ts     — Version update check
test/
  e2e.test.ts           — End-to-end tests with mock upstream
  cli-setup.test.ts     — CLI setup wizard tests
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
