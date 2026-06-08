# Saros Proxy — LLM Instructions

Follow these two phases. Phase 1 gathers everything. Phase 2 executes.

**Important:** Do NOT enable usage-based account switching (scraping). That feature requires the user to log into Firefox, extract auth cookies manually, and interact with browser sessions — agents can't do that. If the setup wizard asks about it, always answer **"n"**. Tell the user to run `npx saros-proxy setup` manually if they want that feature.

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

If encryption was chosen, run setup wizard instead:
```bash
npx saros-proxy setup
```
**Warning:** The wizard will ask about usage-based account switching (scraping). Always answer **"n"** — agents can't log into browsers or extract Firefox cookies. If the user wants that feature, tell them to run the wizard manually in their terminal.

After encryption setup, tell user to set `OPENCODE_GO_ENCRYPTION_KEY` env var.

### 2.3 Run

| Method | Command |
|--------|---------|
| npm/Source | `npx tsx src/index.ts` or `node dist/index.js` |
| Docker | `npm run docker:run` |

### 2.4 Verify

```bash
curl http://127.0.0.1:{port}/health
```

Expected: `{"status":"ok","keyCount":2,"enabledCount":2,...}`

### 2.5 OpenCode Config (if requested)

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

Restart OpenCode.

### 2.6 Cleanup

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
