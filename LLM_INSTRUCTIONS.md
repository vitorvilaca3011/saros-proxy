# Saros Proxy — LLM Instructions

Follow these two phases. Phase 1 gathers everything. Phase 2 executes.
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
      "question": "Which harness(es) do you use? Saros can sync its model catalogue into each one — pick all that apply.",
      "header": "Harnesses",
      "multiSelect": true,
      "options": [
        { "label": "OpenCode", "description": "~/.config/opencode/opencode.json (or .jsonc)" },
        { "label": "oh-my-pi (omp)", "description": "~/.omp/agent/models.yml" },
        { "label": "pi", "description": "~/.pi/agent/models.json" },
        { "label": "dsh (DeepSeek Harness)", "description": "~/.dsh/profiles/web/cordis.patch.yml" },
        { "label": "None", "description": "Skip harness config; I'll call the proxy myself" }
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
> commandcode user_your-commandcode-token
> ```
> Keys must start with `oc_sk_` (OpenCode-Go), `sk-` (OpenCode-Go **or** CommandCode) or `user_` (CommandCode), and be at least 20 characters. `user_` keys are always CommandCode; for CommandCode `sk-` console keys add the provider as a third column:
> ```
> cc-console sk-your-console-key commandcode
> ```

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

Read the keys file, then create `config.yaml`. Keys starting with `user_` are CommandCode (add `provider: commandcode`); `sk-` keys are OpenCode-Go unless the user said otherwise (add `provider: commandcode` for CommandCode console keys):

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
  # For a CommandCode key:
  # - label: {labelCC}
  #   key: user_...
  #   provider: commandcode
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
  --no-smoke-test

# 4. Set the env var permanently
$env:OPENCODE_GO_ENCRYPTION_KEY = Get-Content /tmp/encryption-key.txt
```

**Important:** Never use `--encryption-key` on the command line — it appears in `ps` output and shell history. Always use `--encryption-key-file`.

**Preferred after setup (enc:v1 envelope + OS store):**

```bash
saros-proxy keys encrypt    # rewrite plaintext keys as enc:v1:…; the .backup is plaintext (--no-backup skips it)
saros-proxy secret set      # store the passphrase in the OS store (Keychain/DPAPI/secret-tool)
saros-proxy secret status   # confirm which source wins; never prints the value
saros-proxy serve           # foreground fallback: prompts once if no source exists
```

Passphrase sources, first match wins: `SAROS_PASSPHRASE`, then the OS store
(`secret-tool` on Linux, `security` on macOS, DPAPI on Windows), then a hidden
TTY prompt in foreground `serve` only. A config with `enc:v1:` keys and no
source exits `1` with a message naming all three; a wrong passphrase also exits
`1` and never prints the key. For systemd use `systemd-creds` (see README
"API Key Encryption"). The legacy `enc:scrypt:…` + `OPENCODE_GO_ENCRYPTION_KEY`
path still decrypts with a warning.

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

**Note:** The daemon child runs with `NODE_ENV=production` (JSON logging). Its stdout and stderr are appended to `~/.config/saros/daemon.log` (the same descriptor for both, so no pipe is left without a reader once the launcher exits), which rotates at start (10 MB → `daemon.log.1`, five kept) and carries an `evt:"boot"` line (version, config path, port, key labels) — that is where to look when the daemon "starts" but nothing works; a startup failure is reported from the log tail this boot wrote. For pretty-printed logs, run in foreground mode with `NODE_ENV=development`.

2xx responses served by an upstream key carry `X-Proxy-Request-Id`, `X-Proxy-Key-Label` and `X-Proxy-Provider` (the key's configured provider: `opencode-go` or `commandcode`). For a pinned `model@provider` request the value equals the suffix because the serving key belongs to that provider, not because the header parses the model id. Every other route (`/health`, `/v1/models`, `/debug/recent`, 413/429) and every error response the proxy returns (503 no key, 502 retries exhausted, 502 bodyless stream, forwarded 4xx) carries none, even when a key was involved: correlate through `requestId`; `/debug/recent` still records the `keyLabel`.

Every request emits exactly one `evt:"request.complete"` line (requestId, at, path, model, provider, keyLabel, status, durationMs, stream, attempt); `key.state` explains a key leaving or returning to rotation. `GET /debug/recent` returns the same last 200 entries in memory, oldest first, and never contains keys, headers or bodies; it answers 404 when `SAROS_DEBUG_BUFFER=0`. It is unauthenticated metadata (paths, models, labels, status) intended for loopback — a network-bound deployment exposes those to anyone who can reach the port. `docs/logging.md` is the contract (events, levels, redaction) — read it before diagnosing a request from logs.

### 2.4 Verify

```bash
curl http://127.0.0.1:{port}/health
```

Expected: `{"status":"ok","keyCount":2,"enabledCount":2,...}`

For request-level forensics, `curl -s http://127.0.0.1:{port}/debug/recent` lists the last 200 proxied requests with `requestId`, `provider`, `keyLabel`, `status` and timing — correlate it with the `evt:"request.complete"` line carrying the same `requestId`.

### 2.5 Auto-Start on Login (if requested)

```bash
saros-proxy autostart install --port {port}
```

The proxy will start automatically on next login. Verify with:
```bash
saros-proxy autostart
```

### 2.6 Harness Config (per harness, if requested)

Saros exposes one OpenAI-compatible endpoint — `http://127.0.0.1:{port}/zen/go/v1` — and every supported harness needs the same two things: a `saros-proxy` provider pointing at it, and the model list Saros writes on sync.

```bash
# Enable one flag per harness the user picked (accepted: oc|opencode, omp|ohmypi, pi, dsh)
saros-proxy configharness oc
saros-proxy configharness        # show the current selection
saros-proxy sync-upstream        # pull the live model list into every selected harness
```

Map the Phase 1 answer to the flags, and pass them in one call when more than one applies
(`saros-proxy configharness oc omp`):

| Answer | Flag | Config file |
|---|---|---|
| OpenCode | `oc` | `~/.config/opencode/opencode.json` (or `.jsonc`) |
| oh-my-pi | `omp` | `~/.omp/agent/models.yml` |
| pi | `pi` | `~/.pi/agent/models.json` |
| dsh | `dsh` | `~/.dsh/profiles/web/cordis.patch.yml` |
| None | — | skip this section entirely, do not run `configharness` |

Only touch the harnesses the user named: `configharness` without flags shows the current selection, and running it with no
flags must not be used to "reset" anything.

`saros-proxy start` runs the same sync as `sync-upstream` on boot (live catalog, bundled models as the offline fallback), so a daemon install only needs `configharness`. **That sync never creates a harness config**: if the file below does not exist, ask the user to launch that harness once so it writes its own config, then sync. The exception is `saros-proxy setup`, which writes the OpenCode config path it is given — `opencode.jsonc` on new installs — and in non-interactive mode only updates a file that already exists.

#### OpenCode — `~/.config/opencode/opencode.json` (or `.jsonc`)

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

OpenCode can also discover models from `/v1/models`, but the synced list is what carries context/output limits and reasoning metadata.

#### oh-my-pi (`omp`) — `~/.omp/agent/models.yml`

```yaml
providers:
  saros-proxy:
    baseUrl: http://127.0.0.1:{port}/zen/go/v1
    apiKey: not-used
    api: openai-completions
    compat:
      supportsDeveloperRole: false
      maxTokensField: max_tokens
      supportsReasoningEffort: true
    models: []        # filled by `saros-proxy sync-upstream`
```

If the `saros-proxy` provider is missing, sync creates it with these values; existing fields win, except `compat.supportsReasoningEffort`, which Saros owns (a stale `false` makes the harness drop the wire parameter).

#### pi — `~/.pi/agent/models.json`

```json
{
  "providers": {
    "saros-proxy": {
      "name": "Saros",
      "baseUrl": "http://127.0.0.1:{port}/zen/go/v1",
      "apiKey": "not-used",
      "api": "openai-completions",
      "compat": {
        "supportsDeveloperRole": false,
        "maxTokensField": "max_tokens",
        "supportsReasoningEffort": true
      },
      "models": []
    }
  }
}
```

pi has no model discovery for custom providers — the synced `models` array is the only source.

#### DeepSeek Harness (`dsh`) — `~/.dsh/profiles/web/cordis.patch.yml`

dsh keeps providers in a patch layer, and Saros replaces **only** `row.config.providers["saros-proxy"].models` inside the `llm-pi-ai` row:

```yaml
- id: llm-pi-ai          # row must already exist
  config:
    providers:
      saros-proxy:       # provider must already exist; point its baseUrl at saros
        baseUrl: http://127.0.0.1:{port}/zen/go/v1
        models: []       # replaced on every sync — do not hand-edit
```

dsh regenerates `cordis.yml` at boot and keeps this patch file; the sync re-emits the patch's leading comments and replaces only `models`, so keep hand edits out of the `models` block (the rest of the file is round-tripped, not preserved byte for byte). If the `llm-pi-ai` row or the `saros-proxy` provider is missing, sync fails with that exact message instead of creating them.

#### Rules that apply to every harness

- Only `providers["saros-proxy"].models` is replaced; other providers and fields are preserved. Comments are **not**: OpenCode strips JSONC comments on rewrite, pi/omp drop them in the JSON/YAML round-trip, and dsh re-emits only the patch file's leading comments. A `<file>.backup` is written before the first change — dsh refreshes that backup on every sync instead.
- Static model lists are deliberate: no harness can rediscover reasoning/context/output metadata for a custom provider, and dsh rewrites dynamic config at boot.
- A harness whose config file is missing is skipped, never created.
- The selection lives in `~/.config/saros/harnesses.json`; `saros-proxy status` prints which harnesses are enabled.

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
| keys | — | `sk-` or `user_` prefix, min 20 chars | `OPENCODE_GO_KEYS` (comma-separated label:key) |
| encryption | — | `enc:v1` envelope (scrypt N=2^15 + AES-256-GCM) | `SAROS_PASSPHRASE`, OS store, TTY prompt; `OPENCODE_GO_ENCRYPTION_KEY` for legacy `enc:scrypt` |

---

## Reference: Multi-Provider Keys

Saros supports keys from multiple providers in one pool:

| Prefix | Provider | In config.yaml |
|--------|----------|----------------|
| `user_…` | CommandCode | `provider: commandcode` (optional, inferred) |
| `sk-…` | OpenCode-Go (default) or CommandCode console key | set `provider:` explicitly for CommandCode `sk-` keys |

Behavior worth telling the user:

- Mixed pools work transparently: requests always use the OpenCode-Go URL shapes; CommandCode-routed requests are remapped internally (`/zen/go/v1/…` → `/provider/v1/…`).
- CommandCode-only models (e.g. `claude-*`, vendor-prefixed ids) can appear in synced harness configs as `model@commandcode`.
- `GET /health` reports per-provider key counts (`providers`) and a per-key `keys` array: `label`, `provider`, `enabled`, `entitled`, `disabledByConfig`, `encrypted`, `consecutiveFailures`, `disabledAt`, `retryAfterMs`, `lastError` (`{status, reason, at}`), `usagePercent` (the monthly percentage of the key's provider budget). `encrypted: true` means the credential arrived as an `enc:v1:` envelope; the ciphertext is never returned. Reasons are `auth` (401), `quota`, `rate_limit` (429) and `server`. Never contains the credential.
- When every key is unusable the proxy answers `503` with the diagnosis instead of a bare message: `keys[]` (`reason`, `lastStatus`, `retryAfterMs`, `detail`), `retryAfterMs`, and `causes[]` — so the client can tell a revoked key from a quota wall or a bad `@provider` pin. The legacy `error` field is unchanged for compatibility.
- A key that leaves rotation is logged as `evt=key.state` (label, provider, reason, upstream status, cooldown) and comes back on the next success (`evt=key.state`, "Key back in rotation").
- `saros-proxy` (bare) prints each configured key with its state, e.g. `work: user…**** [commandcode] — disabled: auth (401), retry in 42s`; `saros-proxy status` prints the same block (`Keys: 1/2 enabled` plus one line per key) from the daemon's own `/health` report.
- OpenCode-Go requires a per-conversation session id (`x-opencode-session`). Saros forwards the client's value and derives a stable one when the client sends none, so harnesses that only attach it on some request paths keep working.
- `saros-proxy usage` shows the 5h/weekly/monthly percentages for both providers: OpenCode-Go from `GET /zen/go/v1/usage`, CommandCode from `GET /alpha/billing/credits`. CommandCode's monthly cap is inferred as 2 × `weekly.cap`, falling back to 5 × `fiveHour.cap`; the derivation is only accepted when the credits agree with it, and `Monthly: n/a` is printed when the payload has no usable monthly value. Rotation weighs the monthly percentage; a key with any window at 100% is excluded while another key has room. **Token totals** (recorded from each response's usage chunk) are shown on the same line.
- Keys can be retired without deleting them: `enabled: false` on a `keys[]` entry keeps it in config but out of rotation for good (never selected, never counted as a failure, not revived by a success or a cooldown). `/health` shows `disabledByConfig: true`, the 503/502 diagnosis reports `state: "disabled_by_config"`, and `saros-proxy status` prints `— disabled in config`.
- Keys whose account has no plan for their provider are excluded from rotation until a later usage refresh clears them (`/health` → `entitledCount`; `saros-proxy usage` prints `no subscription for this provider — excluded from rotation`).
- Key identification (which provider a pasted key belongs to) is done with cheap read-only pings: OpenCode-Go `GET /zen/go/v1/usage`, CommandCode `GET /alpha/billing/subscriptions` (also reports the plan). No tokens are spent.

---

## Reference: Docker

```yaml
environment:
  - NODE_ENV=production
  - PROXY_PORT=3000
  - PROXY_HOST=0.0.0.0
  - OPENCODE_GO_KEYS=label1:sk-xxx,label2:sk-yyy
  - SAROS_PASSPHRASE=your-passphrase   # for enc:v1 envelopes; no OS store in the container
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
| Encrypted keys but no passphrase | `saros-proxy secret set`, or set `SAROS_PASSPHRASE`, or run `saros-proxy serve` in a terminal; `saros-proxy secret status` shows which source is missing |
| Legacy `enc:scrypt` keys | Set `OPENCODE_GO_ENCRYPTION_KEY` (legacy) or replace with plaintext and run `saros-proxy keys encrypt` |

---

## Reference: Security

- HTTPS-only upstream (SSRF prevention)
- API key masking in logs; envelopes and passphrase fields redacted
- `enc:v1` envelopes at rest: scrypt (N=2^15) + AES-256-GCM, AAD-bound to the key label
- Passphrase from `SAROS_PASSPHRASE`, the OS store (`secret-tool`/`security`/DPAPI) or a foreground TTY prompt
- Honest limit: none of these stop malware running as the same user; they protect the file, backups and synced dotfiles (README "Threat model")
- CORS origin validation
- Rate limiting: 100 req/min per IP (hardcoded)
- Non-root Docker container
