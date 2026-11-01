# Logging

Saros logs structured JSON lines (pino). The point of the format is that a single line
answers "who served this, with which key, how did it end, and how long did it take" —
without reading the source.

## Where the lines go

| Mode | Destination | Format |
|---|---|---|
| `saros-proxy serve` (foreground) | stdout | pretty-printed unless `NODE_ENV=production` |
| `saros-proxy start` (daemon) | `~/.config/saros/daemon.log` | NDJSON, pretty-printing off |
| `saros-proxy start`, second stream | same file (stderr is appended too) | NDJSON |

- Level: `LOG_LEVEL` (default `info`). `debug` adds key selection and request forwarding.
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
| `upstream.error` | warn | upstream non-2xx | requestId, keyLabel, status, errorType, kind, durationMs, bodyPrefix (≤200 chars) |
| `upstream.timeout` | warn | request timed out | requestId, keyLabel, kind, timeoutMs |
| `upstream.network_error` | error | connection error | requestId, keyLabel, kind, err |
| `key.state` | info/warn | a key leaving or re-entering rotation | requestId, keyLabel, provider, enabled, reason (`auth`/`quota`/`rate_limit`/`server`), status, consecutiveFailures/cooldownMs |
| `request.no_keys` | warn | no key could be selected | requestId, attempt, kind, model, unavailable[{label,reason,status}] |
| `request.retries_exhausted` | error | every attempt failed | requestId, kind, err |
| `request.complete` | info | **once per request** | requestId, method, path, model, provider, keyLabel, status, durationMs, stream, attempt |

`request.complete` is the access log: success, upstream client error (4xx from the
provider), 503 (no usable key) and 502 (retries exhausted) are mutually exclusive paths, so
exactly one line lands per request. It is logged after the success handler produces the
downstream response — if that handler throws, the request retries and the retry logs its own
outcome.

`reason` on `key.state` is derived from the upstream verdict: `401 → auth`,
`429 → rate_limit`, 5xx carrying a quota/balance hint → `quota`, anything else 5xx →
`server`.

## What is never logged

- API keys: only `maskKey()` output (`sk-1...Rhvp`) — never the full value, not even a
  prefix/suffix pair beyond that.
- `authorization`, `cookie`, `set-cookie`, `x-api-key`, `apiKey`, `token`, `key` are
  censored by pino's `redact` (`[redacted]`), so an accidentally-passed header object
  cannot leak.
- Request/response bodies: never, by default. `SAROS_CAPTURE_4XX=1` writes failing 4xx
  requests to `~/.config/saros/captures/` for offline replay — opt-in, never on in
  production.

## Not covered yet

`catalog.refresh` (provider catalog warm-up result), `usage.refresh` (quota poll) and
`shutdown` (signal + port released) are still only visible through side effects. They are
tracked in #86; until then, the absence of a line does not mean the step did not run.
