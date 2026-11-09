# Logging

Saros logs structured JSON lines (pino) wherever the output is read by a tool. In JSON
mode a single line answers "who served this, with which key, how did it end, and how long
did it take" — without reading the source. In the terminal the CLI renders one line per
record: icon, message, and only the public request fields as a gray tail.

## Where the lines go

| Mode | Destination | Format |
|---|---|---|
| `saros-proxy serve` (foreground) | stdout (info) / stderr (warn, error) | human-rendered; NDJSON with `SAROS_LOG_JSON=1`, or with `NODE_ENV=production` |
| Other CLI commands (`status`, `usage`, `keys`, …) | stdout (info) / stderr (warn, error) | human-rendered; NDJSON with `SAROS_LOG_JSON=1` |
| `saros-proxy start` (daemon) | `daemon.log` in the state dir (`~/.config/saros` on Linux/macOS, `%LOCALAPPDATA%\saros` on Windows) | NDJSON, never rendered for a terminal |
| `saros-proxy start`, second stream | same file, same descriptor as stdout (no pipe) | NDJSON |

- Mode: JSON is selected by `SAROS_LOG_JSON=1`, `SAROS_DAEMON=1`, or `NODE_ENV=production`
  **on the `serve` subcommand**. The daemon child and the systemd unit set those, and the
  Docker service runs `serve`, so `daemon.log`, the journal and `docker logs` stay
  parseable. Other commands stay human even when `NODE_ENV=production` is inherited —
  `docker compose exec proxy saros-proxy status` prints the report, not NDJSON.
- Human format: icon + message, continuation lines indented two spaces, control characters
  (ESC/OSC/BEL) stripped, followed by a gray tail with the public fields `status`,
  `keyLabel`, `provider`, `durationMs` (as `<n>ms`) and `requestId`, in that order and
  separated by ` · `; absent fields are omitted. Nothing else reaches the terminal, so the
  `Fields` column below describes the JSON record — use `SAROS_LOG_JSON=1` to see it.
- Level: `LOG_LEVEL` (default `info`). `debug` adds `key.selected`; per-attempt forwarding (`Forwarding request…`) is `info` because it is what a failed attempt needs in order to be reconstructible.
- The daemon log rotates **at start**: past 10 MB it becomes `daemon.log.1` and up to five
  files are kept. Rotation is deliberately not a runtime dependency.
- The daemon also writes a boot line before any traffic (`evt:"boot"`), so an empty
  `daemon.log` means the daemon never started.

## Events

| `evt` | Level | Emitted for | Fields |
|---|---|---|---|
| `boot` | info | every `serve` start | version, node, platform, configPath, port, host, keys[{label,provider}], bundledModels, logLevel |
| — (`Loaded config from …`) | info | config load | path, or a warning when falling back to `./config.yaml` |
| `key.selected` | debug | each attempt, before the upstream call | requestId, keyLabel, provider, attempt, pinned |
| `upstream.response` | info | upstream 2xx | requestId, keyLabel, provider, status, durationMs, stream |
| `upstream.error` | warn | upstream non-2xx | requestId, keyLabel, status, errorType, kind, durationMs, bodyPrefix (≤200 chars, redacted). The streaming branch carries status/kind/durationMs only — no body, no errorType |
| `upstream.timeout` | warn | request timed out | requestId, keyLabel, kind, timeoutMs |
| `upstream.network_error` | error | connection error | requestId, keyLabel, kind, err |
| `key.state` | info/warn | a key leaving or re-entering rotation | requestId, keyLabel, provider, enabled, reason (`auth`/`quota`/`rate_limit`/`server`), status, consecutiveFailures/cooldownMs |
| `request.no_keys` | warn | no key could be selected | requestId, attempt, kind, modelId, retryAfterMs, unavailable[{label,reason,status}] |
| `request.retries_exhausted` | error | every attempt failed | requestId, kind, err |
| `request.complete` | info | **once per proxied request** (not `/health`, `/v1/models`, `/debug/recent`, 413 or a middleware 429) | requestId, at, method, path, model, provider, keyLabel, status, durationMs, stream, attempt |

`request.complete` is the access log: success, upstream client error (4xx from the
provider), 503 (no usable key) and 502 (retries exhausted) are mutually exclusive paths, so
exactly one line lands per request. It is logged after the success handler produces the
downstream response, and `status` is the status the client received — a 2xx upstream whose
stream body is missing becomes a downstream 502 and is logged as 502.
`model` is the raw model id from the request body (`model@provider` keeps its suffix here,
it is stripped only on the way upstream). If the success handler throws, the request retries
and the retry logs its own outcome.

`at` is the timestamp when the downstream response was produced, and `durationMs` the time
from request entry to that instant. For a stream that is when the response headers were
produced, not the end of the stream: a stream that breaks mid-flight stays recorded as the
2xx it started as. The exact same entry object is pushed to the
in-memory buffer behind `GET /debug/recent` (last 200 requests, oldest first), so the
endpoint and the access log cannot drift: whatever a line says, the buffer entry says.
The buffer never stores keys, headers or bodies — `keyLabel` is the public label.
`SAROS_DEBUG_BUFFER=0` removes the buffer entirely: the endpoint answers 404 and no
entry is kept. The endpoint is unauthenticated and metadata-only (paths, models, labels,
status, timing — never keys, headers or bodies): it is meant for the loopback bind, and a
network-reachable deployment exposes those fields to anyone who can reach the port.
`provider` is the configured provider of the key that last attempted the request (`null`
when no key could be selected); for a pinned `model@provider` request it equals the suffix
because the serving key belongs to that provider, not because the suffix is copied.
`keyLabel` is the serving key, or the last key tried when the proxy answers 502
or a 503 raised after keys were tried; it is `null` only when no key was ever
selected.

`reason` on `key.state` is derived from the upstream verdict: `401 → auth`,
`429 → rate_limit`, 5xx carrying a quota/balance hint → `quota`, anything else 5xx →
`server`.

## What is never logged

- API keys: only `maskKey()` output (`sk-1...Rhvp`) — never the full value, not even a
  prefix/suffix pair beyond that.
- `authorization`, `cookie`, `set-cookie`, `x-api-key`, `apiKey`, `token`, `key` are
  censored by pino's `redact` (`[redacted]`), so an accidentally-passed header object
  cannot leak.
- Request bodies: never. Response bodies: never in full. The exception is diagnostic and
  bounded: `upstream.error` carries the first 200 characters of a non-2xx upstream body,
  and `SAROS_CAPTURE_4XX=1` writes failing 4xx requests (bodies included) to
  `~/.config/saros/captures/` for offline replay — opt-in, never on in production. Both
  paths run `redactSecrets` (or are opt-in files), because a provider may echo the
  submitted key back in its error message.

## Not covered yet

`catalog.refresh` (provider catalog warm-up result), `usage.refresh` (quota poll) and
`shutdown` (signal + port released) are still only visible through side effects. They are
tracked in #86; until then, the absence of a line does not mean the step did not run.
