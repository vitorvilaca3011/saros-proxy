# Saros Proxy — LLM Instructions

Follow these two phases. Phase 1 gathers everything. Phase 2 executes.

**Important:** Do NOT enable usage-based account switching (scraping). If the setup wizard asks about it, always answer **"n"**. Use the non-interactive setup with `--no-scraping` flag instead — agents can't extract Firefox cookies.

---

## Phase 1: Gather User Preferences

Use the `question` tool to ask the user all of these **at once** (batch into one or two calls max). Don't ask for API keys in chat — have them save to a file.

```json
{
  "questions": [
    {
      "question": "What OS are you on?",
      "header": "Operating System",
      "options": [
        { "label": "Windows", "description": "" },
        { "label": "macOS", "description": "" },
        { "label": "Linux", "description": "" }
      ]
    },
    {
      "question": "How do you want to install Saros?",
      "header": "Install Method",
      "options": [
        { "label": "npm (Recommended)", "description": "npm install -g saros-proxy" },
        { "label": "Docker", "description": "No Node.js needed" },
        { "label": "From source", "description": "git clone + npm install" }
      ]
    },
    {
      "question": "How many API keys do you have?",
      "header": "Account Count",
      "options": [
        { "label": "2", "description": "" },
        { "label": "3", "description": "" },
        { "label": "5+", "description": "" }
      ]
    },
    {
      "question": "Where are your API keys saved? I'll read them from there. (Don't paste keys in chat)",
      "header": "Key File Path",
      "options": [
        { "label": "api_keys.txt", "description": "One key per line: label sk-your-key" },
        { "label": "Not saved yet", "description": "I'll tell you where to save them" }
      ]
    },
    {
      "question": "What port should the proxy listen on?",
      "header": "Port",
      "options": [
        { "label": "3000 (Default)", "description": "Standard port" },
        { "label": "4000", "description": "" },
        { "label": "8080", "description": "" }
      ]
    },
    {
      "question": "Do you want to encrypt API keys at rest? (Recommended)",
      "header": "Key Encryption",
      "options": [
        { "label": "Yes (Recommended)", "description": "AES-256-GCM encryption" },
        { "label": "No", "description": "Plaintext in config.yaml" }
      ]
    },
    {
      "question": "Do you want to connect Saros to OpenCode after setup?",
      "header": "OpenCode Integration",
      "options": [
        { "label": "Yes", "description": "Auto-configure opencode.json" },
        { "label": "No", "description": "Skip OpenCode config" }
      ]
    },
    {
      "question": "How should the proxy run?",
      "header": "Run Mode",
      "options": [
        { "label": "Foreground", "description": "npx saros-proxy (stays in terminal)" },
        { "label": "Background daemon", "description": "saros-proxy start (detached process)" }
      ]
    },
    {
      "question": "Start proxy automatically on login?",
      "header": "Auto-Start",
      "options": [
        { "label": "Yes", "description": "Install auto-start entry" },
        { "label": "No", "description": "I'll start it manually" }
      ]
    }
  ]
}
```

If the user answers "Not saved yet" for keys, tell them:
> Save your API keys to a file (e.g., `api_keys.txt`), one per line in this format:
> ```
> primary sk-your-first-key-here
> secondary sk-your-second-key-here
> ```
> Keys must start with `sk-` and be at least 20 characters.

Then ask for the file path before proceeding.

---

## Phase 2: Execute Setup

Once you have all the info, execute in order:

### 2.1 Install

| Method | Command |
|--------|---------|
| npm | `npm install -g saros-proxy` |
| Docker | `npm run docker:build` |
| Source | `git clone https://github.com/vitorvilaca3011/saros-proxy.git && cd proxy && npm install && npm run build` |

### 2.2 Read Keys & Generate Config

Read the keys file, then create `config.yaml`:

```yaml
port: {port}
host: 127.0.0.1
upstreamBaseUrl: https://opencode.ai
circuitBreakerThreshold: 3
circuitBreakerCooldownMs: 60000
requestTimeoutMs: 30000
allowedOrigins:
  - "http://localhost:*"
  - "http://127.0.0.1:*"
keys:
  - label: {label1}
    key: {key1}
  - label: {label2}
    key: {key2}
```

If encryption was chosen, use the non-interactive setup with `--encryption-key-file`:

```bash
# 1. Save the encryption key to a file
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > /tmp/encryption-key.txt

# 2. Create keys file (one per line: label:key)
@"
primary:sk-your-first-key-here
secondary:sk-your-second-key-here
"@ | Set-Content keys.txt -Encoding UTF8

# 3. Run non-interactive setup
saros-proxy setup --non-interactive \
  --port {port} \
  --keys-file keys.txt \
  --encryption-key-file /tmp/encryption-key.txt \
  --no-scraping \
  --no-smoke-test

# 4. Set the env var permanently
$env:OPENCODE_GO_ENCRYPTION_KEY = Get-Content /tmp/encryption-key.txt
```

**Important:** Never use `--encryption-key` on the command line — it appears in `ps` output and shell history. Always use `--encryption-key-file`.

If encryption was NOT chosen:
```yaml
port: {port}
host: 127.0.0.1
upstreamBaseUrl: https://opencode.ai
circuitBreakerThreshold: 3
circuitBreakerCooldownMs: 60000
requestTimeoutMs: 30000
allowedOrigins:
  - "http://localhost:*"
  - "http://127.0.0.1:*"
keys:
  - label: {label1}
    key: {key1}
  - label: {label2}
    key: {key2}
```

### 2.3 Run

| Mode | Method | Command |
|------|--------|---------|
| Foreground | npm/Source | `npx saros-proxy` or `node dist/index.js` |
| Foreground | Docker | `npm run docker:run` |
| Background daemon | npm global | `saros-proxy start --port {port}` |
| Background daemon | stop | `saros-proxy stop` |
| Background daemon | status | `saros-proxy status` |

**Note:** The daemon child runs with `NODE_ENV=production` (JSON logging). For pretty-printed logs, run in foreground mode with `NODE_ENV=development`.

### 2.4 Verify

```bash
curl http://127.0.0.1:{port}/health
```

Expected: `{"status":"ok","keyCount":2,"enabledCount":2,...}`

### 2.5 Auto-Start on Login (if requested)

```bash
saros-proxy autostart install --port {port}
```

The proxy will start automatically on next login. Verify with:
```bash
saros-proxy autostart
```

### 2.6 OpenCode Config (if requested)

Add to `~/.config/opencode/opencode.json`:
```json
{
  "provider": {
    "saros-proxy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Saros",
      "options": {
        "baseURL": "http://127.0.0.1:{port}/zen/go/v1",
        "apiKey": "not-used"
      }
    }
  }
}
```

Models are discovered automatically from the proxy's `/v1/models` endpoint — no need to list them in opencode.json.

### 2.7 Cleanup

Remind user to delete the keys file:
```bash
rm {keys-file-path}
```

---

## Reference: Config Options

| Option | Default | Range | Env Var |
|--------|---------|-------|---------|
| port | 3000 | 1–65535 | `PROXY_PORT` |
| host | 127.0.0.1 | — | `PROXY_HOST` |
| upstreamBaseUrl | https://opencode.ai | HTTPS only | `UPSTREAM_BASE_URL` |
| circuitBreakerThreshold | 3 | 1–10 | `CIRCUIT_BREAKER_THRESHOLD` |
| circuitBreakerCooldownMs | 60000 | 1000–3600000 | `CIRCUIT_BREAKER_COOLDOWN_MS` |
| requestTimeoutMs | 30000 | 1000–300000 | `REQUEST_TIMEOUT_MS` |
| allowedOrigins | localhost only | — | — |
| keys | — | sk- prefix, min 20 chars | `OPENCODE_GO_KEYS` (comma-separated label:key) |
| encryption | — | AES-256-GCM | `OPENCODE_GO_ENCRYPTION_KEY` |

---

## Reference: Docker

```yaml
environment:
  - NODE_ENV=production
  - PROXY_PORT=3000
  - PROXY_HOST=0.0.0.0
  - OPENCODE_GO_KEYS=label1:sk-xxx,label2:sk-yyy
  - OPENCODE_GO_ENCRYPTION_KEY=your-master-key
```

Volume: `./config.yaml:/app/config.yaml:ro`
Health check: built-in, `/health` every 30s
Runs as non-root `appuser`

---

## Reference: Troubleshooting

| Symptom | Fix |
|---------|-----|
| `No valid API keys` | Check keys in config or `OPENCODE_GO_KEYS` |
| Port in use | Change port or kill process |
| `504 Gateway Timeout` | Increase `requestTimeoutMs` |
| All keys unavailable | Wait for circuit breaker cooldown |
| CORS error | Add origin to `allowedOrigins` |
| Encrypted keys but no key env | Set `OPENCODE_GO_ENCRYPTION_KEY` |

---

## Reference: Security

- HTTPS-only upstream (SSRF prevention)
- API key masking in logs
- CORS origin validation
- Rate limiting: 100 req/min per IP (hardcoded)
- AES-256-GCM encryption for keys at rest
- Non-root Docker container
