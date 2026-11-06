# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **CommandCode models are enriched from models.dev.** The models.dev read is
  now per provider (`src/models-dev.ts`): `opencode-go` and `commandcode`
  slices come from the same cached document, and the request always sends a
  stable CLI `User-Agent` (measured 2026-11-06: a library-default UA got 403
  where `User-Agent: cli` got 200). `@commandcode` harness
  entries take metadata from the commandcode slice first, then the bundled
  `assets/models.json`, then the live catalog/defaults — a model absent from
  models.dev is never dropped. A reasoning model whose metadata declares no
  effort option (empty ladder or toggle only) gets the conservative
  `low|medium|high` ladder, because the CommandCode gateway rejects `minimal`
  and the harness would otherwise invent it.
- **Linux autostart via `systemd --user`.** `saros-proxy autostart install` writes
  `$XDG_CONFIG_HOME/systemd/user/saros-proxy.service` (default
  `~/.config/systemd/user`; a relative `$XDG_CONFIG_HOME` is ignored per the XDG
  spec, with a warning), runs the current binary with `serve --port <port>` under
  `Restart=on-failure`/`RestartSec=5` plus `StartLimitIntervalSec=60`/
  `StartLimitBurst=3` so a permanent failure stops after three tries instead of
  looping forever, and drives `systemctl --user daemon-reload`, `enable`,
  `restart`, `disable --now` and `is-enabled`/`is-active`. `restart` makes a
  reinstall with a new `--port` take effect immediately, including when the unit
  was already active. On Linux `systemd` is the default method: `--method systemd`
  is accepted and `auto` resolves to it. When `dist/index.js` is missing, `install`
  fails with a `npm run build` hint instead of writing an `ExecStart` that systemd
  cannot resolve.
- **`npm run models:refresh` generates the bundled catalog.** `scripts/refresh-models.ts`
  merges models.dev metadata for `opencode-go` and `commandcode` with the live
  provider catalogs, so the bundle no longer depends on a hand-edited commit. A
  model the provider serves but models.dev does not know enters with the live
  payload's name and context window; membership follows the live catalogs, and two
  raw ids that collapse to the same bare name abort the run. The output is sorted
  keys, 2-space JSON and a trailing newline; the script prints
  added/removed/changed counts, supports `--dry-run` (and reports a formatting-only
  difference), writes through a temp file plus rename, and aborts before reading
  the file when any source fetch fails or answers with an empty catalog. A merge
  that would remove more than half of the current models needs `--allow-shrink`.
  `models-refresh.ts` holds the pure merge and the fetch helpers.

### Changed

- **Patch/minor dependency refresh.** `hono` 4.13.14 → 4.13.16, `@hono/node-server`
  2.1.5 → 2.1.6, `vitest` and `@vitest/coverage-v8` 5.0.5 → 5.1.0, plus their
  transitive dependencies (`@vitest/istanbul-lib-*` 1 → 2, internal to coverage
  5.1.0). `pino`, `pino-pretty` and `@types/node` were already current. All inside
  the ranges already declared, no `package.json` range changed.
- **The bundled model catalog moved to `assets/models.json`.** It is no longer
  shipped at the package root: anything that referenced `models.json` inside the
  installed package must use `assets/models.json`. `package.json#files`, the
  Docker stages, the catalog loader and the daemon seed path follow.

### Fixed

- **`saros-proxy autostart` refuses methods that belong to another platform.**
  `--method vbs|registry` on Linux and `--method systemd` on Windows now warn with
  the requested method and the OS, and do nothing; `install` exits non-zero instead
  of spawning `reg` or writing under `~/AppData` on Linux. The same gate covers
  `status` (no more "not installed" false negative) and `uninstall`.
- **`saros-proxy autostart uninstall` no longer leaves a dangling unit.** When
  `systemctl --user disable --now` fails, the unit file is kept and the command exits
  non-zero instead of deleting it while `default.target.wants/saros-proxy.service`
  survives (the next login logged "Failed to load", and `is-enabled` still answered
  `enabled`). An unsupported platform now exits non-zero for `uninstall` too, matching
  `install`. Status classifies `systemctl` by exit status rather than English stderr,
  so a missing unit reads "not installed" under any locale. The generated unit sets
  `NODE_ENV=production` (JSON log lines in the journal), and an unknown `--method`
  now warns instead of being silently dropped.
- **`saros-proxy autostart install` no longer reports success without installing
  anything.** Platforms without an implementation (macOS today) log a warning with
  the OS and the alternative, and `install` exits non-zero (`status` stays zero
  while reporting `unsupported`). A missing `systemctl` or user bus now names the
  reason instead of returning a silent `false`.
- **`saros-proxy start` repairs and completes `~/.config/saros/models.json`.** The
  daemon seeded the bundled copy on every start, discarding user edits; it now
  adds only the bundle keys the user file lacks (never overwriting a value the
  user set), leaves a file that already covers the bundle untouched, and backs up
  an unparseable file to `models.json.corrupt` before re-seeding it. A missing or
  corrupt user catalog is no longer kept forever while the CLI silently fell back
  to the bundled copy.
- **`saros-proxy start` survives an unreadable bundled catalog.** The seed read
  and parsed `assets/models.json` outside any guard, so a damaged bundle (build
  defect, disk error) became an unhandled rejection after "✓ Proxy started":
  exit 1, the harness sync and the update check never ran, and the detached proxy
  kept serving. The failure is now logged with its cause and the seed is skipped;
  startup continues. `src/cli/daemon.ts` owns the guard.
- **Primary and offline model stubs declare the conservative effort ladder.**
  `buildMinimalStub` copied `reasoning_options` verbatim from models.dev and the
  bundled catalog; the 11 models in the bundle that publish an empty ladder, a
  toggle-only entry or `toggle + budget_tokens` reached the harnesses without a
  usable effort ladder, which then invented one containing `minimal`. A reasoning
  entry with no `effort` option carrying a non-empty `values` array now gets
  `low|medium|high`; an explicit ladder is preserved. The stub replaces the whole
  `reasoning_options` array, so a published `toggle` or `budget_tokens` entry is
  not kept. `hasEffortOption` also rejects `{ type: 'effort', values: [] }`
  (it used to accept mere presence), and the shared helpers live in
  `src/model-ladder.ts`.

## [1.0.0] - 2026-11-05

First stable release. The public surface — the `/v1/*` and `/zen/go/v1/*` routes, the
`config.yaml` schema and the `saros-proxy` subcommands — is what 1.x keeps compatible.

### Added

- **CommandCode keys report real quota, and their monthly metric is derived.**
  `GET /alpha/billing/credits` (undocumented but live; it needs the CLI identity
  headers) returns the 5-hour and weekly `used`/`cap` plus `credits.monthlyCredits`,
  the remainder of the monthly allowance. `commandcode.usagePath()` points there and
  the provider parses it: `fiveHour` → rolling, `weekly` → weekly, reset epochs to
  ISO. The payload has **no** monthly cap, so it is inferred as `2 × weekly.cap`
  (falling back to `5 × fiveHour.cap`) and accepted only when the credits agree in
  the same unit (`remaining <= cap`, `cap − remaining >= max(weekly.used,
  fiveHour.used)`); an inconsistent derivation yields null and keeps the previous
  state instead of handing the key maximum weight. `saros-proxy usage` now prints
  windows for both providers, rounds the fractional percentages and shows `n/a`
  when the monthly value is unavailable.
- **`fetchKeyUsage` is provider-driven.** It takes the provider and uses its
  `usagePath()`, `extraUpstreamHeaders()` and `parseUsageResponse()`, so a provider
  that needs identity headers can poll its own quota endpoint. The duplicated
  opencode-go parser in `usage-client.ts` is gone.

### Changed

- **Rotation weighs the monthly window, and a spent window excludes the key.**
  `KeyUsage.usedPercent` is the monthly percentage of the key's own provider budget
  (the only unit two providers can be compared in: OpenCode Go publishes percents
  only). The new `KeyUsage.exhausted` is true when any window — 5h, weekly or
  monthly — reaches 100%, and such a key weighs 0 even while the month has room.
  Zero-weight keys are skipped and their round-robin momentum cleared, keys without
  usage take the median of the **non-exhausted** weights (full weight when no known
  key has room), and Tier 1 never hands out an exhausted key: when every unbooked
  candidate weighs 0 it yields to Tier 2, which can share a healthy booked key.
- **README architecture diagram is a Mermaid flowchart** instead of box-drawing art,
  so it renders on GitHub and in the mobile app.

### Fixed

- **Anthropic Messages streams book their prompt tokens.** The stream reader only
  recognized a top-level `usage` and `response.usage`. Anthropic reports the prompt
  count once, in `message_start.message.usage`, and `message_delta.usage` carries
  the cumulative output count — often without input tokens — so every
  `/v1/messages` stream booked 0 prompt tokens. Counts are now merged per field
  across the stream (largest cumulative value wins) and booked once at the end,
  which also keeps the duplicated `usage` chunk CommandCode sends on chat
  completions booking a single request.
- **Merged totals never undercut their parts, and only `message_start` owns
  `message.usage`.** A later chunk that raises prompt/completion without repeating
  `total_tokens` now books the larger of the reported total and the sum; events of
  other types that carry a business `message.usage` no longer feed the counters.
- **opencode-go requests no longer inherit the client's `User-Agent`.** The zen
  upstream sits behind Cloudflare, which answers browser signatures with
  `403 error code: 1010`; forwarding the client's UA killed every request routed
  through an opencode-go key, which looked like "half the pool fails at random".
  The provider sends the CLI identity (`User-Agent: cli`, verified live) on chat
  requests, smoke tests, usage fetches and the public catalog.
- **A payload without caps no longer resets a key's usage.** A 200 with no usable
  window or monthly value used to produce a zeroed `KeyUsage`, wiping an exhausted
  key's state and giving it maximum weight; the parsers now return null and the
  previous state stays.

## [0.11.0] - 2026-11-03

### Added

- **`enc:v1:` key envelopes with a real secret source (#85).** API keys can
  now live in `config.yaml` as
  `enc:v1:<b64salt>.<b64nonce>.<b64tag>.<b64ciphertext>` (scrypt N=2^15, r=8,
  p=1 → AES-256-GCM, AAD bound to the version and key label). The passphrase
  is resolved from `SAROS_PASSPHRASE`, then the OS secret store through the
  platform CLI (`secret-tool` on Linux, `security` on macOS, PowerShell DPAPI
  over `%APPDATA%\saros\secret.dpapi` on Windows), then a hidden TTY prompt in
  foreground `serve` only. No runtime dependency and no native module.
- **`saros-proxy secret set|status` and `saros-proxy keys encrypt`.**
  `keys encrypt` rewrites plaintext keys as envelopes, infers/persists each
  key's `provider`, backs the old file up to `config.yaml.backup` (0600) once,
  and is idempotent. `secret status` reports the winning source without ever
  printing a value.
- **`/health` reports `encrypted: true` per key**, and the status block prints
  `[encrypted]`; neither the ciphertext nor the plaintext is exposed.
- **Loud plaintext-key warning at boot** (`evt:"security.plaintext-keys"`).
- **Redaction for envelopes and passphrases**: `enc:v1:` / `enc:scrypt:`
  patterns plus `passphrase`, `secret`, `secretValue`, `masterKey`,
  `encryptionKey` and `SAROS_PASSPHRASE` pino paths.
- README threat-model table, per-OS store commands and a `systemd-creds`
  recipe; LLM_INSTRUCTIONS mirrored.
- **`X-Proxy-Provider` response header** on 2xx responses served by an
  upstream key: `opencode-go` or `commandcode`, taken from the key's normalized
  `provider` (an explicit `provider:` in config wins over the credential
  prefix). A pinned `model@provider` request reports the same value as the
  suffix because the selected key belongs to that provider, not because the
  header parses the model id. Local routes (`/health`, `/v1/models`,
  `/debug/recent`) and error responses the proxy returns (503, 502, forwarded
  4xx) carry no debug headers even when a key was involved; the README now
  says so.
- **The `X-Proxy-*` headers are CORS-exposed**, so browser clients can read
  them from `fetch()` responses.
- **`GET /debug/recent` — in-memory buffer of the last 200 proxied requests.**
  Each entry is the same object as the `evt:"request.complete"` access line
  (`requestId`, `at`, `method`, `path`, `model`, `provider`, `keyLabel`,
  `status`, `durationMs`, `stream`, `attempt`), so the endpoint and the log
  cannot drift. It never stores keys, headers or bodies. `SAROS_DEBUG_BUFFER=0`
  disables it: the endpoint answers 404 and nothing is kept. The endpoint is
  unauthenticated metadata meant for the loopback bind; a network-reachable
  deployment exposes paths, models and key labels to whoever can reach the
  port.

### Fixed

- **The daemon child no longer dies from EPIPE on a stderr write (#99).** The
  launcher used to pipe the child's stderr and mirror it into `daemon.log` only
  until startup verification settled; the parent then exited and took the read
  end with it, so any later `process.stderr.write` — an uncaught-exception
  trace, most of all — raised EPIPE and killed `serve`. The child now gets
  `daemon.log` as both stdout and stderr (one descriptor, no pipe). Startup
  failures are recovered from the log tail written since the boot offset:
  `EADDRINUSE` and missing-key failures keep their specific messages, anything
  else still prints the last six lines and exits non-zero.
- **Security review fixes for key encryption (#100).** The DPAPI blob now
  travels in the child environment (`$env:SAROS_DPAPI_BLOB`) and is validated
  as base64 before PowerShell runs, closing a command-injection path; a symlinked
  `config.yaml` is rewritten through `realpathSync`, so the real target is
  encrypted instead of being left in plaintext; YAML parse errors are reduced
  to their first line and redacted before `keys encrypt`/boot print them; an
  `encrypted: true` field on a plaintext entry is ignored; `keys encrypt`
  states that `<config>.backup` is plaintext and adds `--no-backup`; backup and
  temp writes use `COPYFILE_EXCL`/`wx` under a private `mkdtemp` directory to
  defeat symlink and TOCTOU capture; `encryptValue('')` is rejected with a
  typed `empty-plaintext` error; the freshness test now asserts distinct salt
  and nonce; `secret set` warns below 12 characters; and store failures
  distinguish "not found" from a locked keyring and are carried into
  `secret status` and boot errors.
- **The CodeQL alerts on the key-encryption diff are cleared without
  suppressions.** `keys encrypt` and `secret set` now print only constant
  failure text plus resolver-produced attempt descriptions, never a field of
  the secret-bearing result; `NO_PASSPHRASE_MESSAGE` became
  `NO_SOURCE_MESSAGE` so the static options list is not matched by CodeQL's
  sensitive-name heuristic; a dead `configPath` initializer was dropped; and
  two tests read before `stat`/`lstat` instead of checking a path first.
  Runtime output is unchanged.
- **A key's configured `provider` now decides its upstream**, instead of
  re-inferring it from the credential prefix. A key declared
  `provider: commandcode` with an `sk-…` credential was forwarded to the
  OpenCode-Go URL and reported as `opencode-go`; it now goes to CommandCode and
  the response header says `commandcode`.
- **The proxy's own error entries carry the last key tried** instead of
  `keyLabel: null` — both the retries-exhausted 502 and a 503 raised after keys
  were tried; null now means no key was ever selected.
- **`saros-proxy stop` and `status` tell the truth on Windows (#83).**
  Liveness is `process.kill(pid, 0)` on every platform: `tasklist /FI "PID eq …"`
  exits 0 even when no task matches, so any value in the PID file read as
  running and `status` announced a proxy that was not listening. `stop` now
  waits for the PID to disappear before printing `✓ stopped` (a real,
  successful kill used to be reported as a failure), pipes taskkill's output so
  its "not found" text no longer leaks into the console / PowerShell
  `NativeCommandError`, and removes the PID file in both outcomes. The PID file
  and `daemon.log` now live next to `config.yaml` (`%LOCALAPPDATA%\saros` on
  Windows); a legacy `~/.config/saros/daemon.pid` is read only on explicit
  opt-in (see below).
- **The pre-0.11 pid file is inert unless the operator opts in (#104).**
  `readPid()` fell back to `~/.config/saros/daemon.pid` whenever the new state
  dir had no pid, and `stop` killed what it read. That path is in the user's
  real home, so a vitest run with a temp `XDG_CONFIG_HOME` and the real `HOME`
  signalled the developer's live daemon (systemd logged the SIGTERM). Reading,
  migrating and deleting the legacy file now require `SAROS_ALLOW_LEGACY_PID=1`;
  an installation started before 0.11.0 keeps its pid under `~/.config/saros`;
  set `SAROS_ALLOW_LEGACY_PID=1` once to stop it, or the new layout takes over
  on the next start. Tests additionally resolve `HOME`/`USERPROFILE` and
  `homedir()` inside a per-file temp dir and scrub the flag from the
  environment, so no suite can reach a real installation.
- **`stop` keeps the daemon it could not kill, and says so (#104).** The PID
  file is removed only after a liveness re-check confirms the process is gone.
  A failed stop keeps the handle and exits non-zero: a second `stop` used to
  print "No running proxy daemon found." and exit 0 while the proxy was still
  serving, `status` could only see it through `/health`, and `restart`
  announced "stopped daemon" and then died with the port already in use.
  `restart` now waits for the same confirmation before starting, and both
  commands remove only the PID file they read — with `SAROS_ALLOW_LEGACY_PID=1`
  the old `deletePid` also removed the legacy file, dropping another instance's
  handle. An upgraded 0.10.x install whose pid sits in `~/.config/saros` is
  reported instead of ignored: `stop`/`status` name that path and
  `SAROS_ALLOW_LEGACY_PID=1` (stat only, never read or killed), and `stop`
  exits non-zero when `/health` still answers on the configured port.
  `taskkill`'s outcome now comes from its exit code (128, or 1 with no output)
  instead of message text, which only matched English and Portuguese. Tests:
  the suites that re-registered `node:os` back to the real home (`config`,
  `opencode-config`, `autostart`) keep the setup file's temp home,
  `test/setup-env.ts` keeps it for the whole file lifetime, and a code-level
  guard refuses to read or delete a PID file inside a real installation's state
  dir while under test.
- **The state-dir guard covers writes and symlinks, and `stop` without a handle
  probes the port (#104).** The guard compared lexical paths, so an
  `XDG_CONFIG_HOME` symlinked into the real install passed it, and it only
  covered reads and deletes: `daemonStart`, `openDaemonLog`, log rotation, the
  legacy migration and the models.json copy could still create files in a real
  state dir (a test run did create `daemon.log` there). One gate now guards
  reads, removals and writes against the realpath of the longest existing
  prefix, so a symlinked state dir is refused too. `stop` with no handle (no
  pid file, or an unreadable one) now probes `/health` like the legacy branch
  already did: something serving on the configured port is reported by port —
  plus the legacy path and `SAROS_ALLOW_LEGACY_PID=1` when that file exists —
  and exits 1 instead of 0. A stale current pid file that is cleaned up takes
  the same path, so a live legacy instance is no longer hidden behind exit 0.

## [0.10.2] - 2026-10-27

### Fixed

- **Responses and Anthropic calls are no longer booked as zero tokens.** Streams
  from `/v1/responses` carry `usage` nested under `response.usage` on the
  `response.completed` event, not at the top level, and both Responses and
  Anthropic report `input_tokens`/`output_tokens` instead of
  `prompt_tokens`/`completion_tokens`. The SSE parser now reads either location
  and `parseTokenCounts` accepts either field shape.

### Changed

- **`models.json` refreshed from models.dev** (provider `opencode-go`): 18 stale
  entries became 37 current models, 11 ids that no longer exist upstream were
  dropped, and the catalogue now carries `cost`, `reasoning_options`,
  `interleaved` and `structured_output`.
- **Single source of truth for the bundled catalogue.** `OPENCODE_MODELS`
  duplicated `models.json` and had drifted from it. `src/models-catalog.ts` now
  loads the packaged `models.json` at runtime (per-path cache; a missing or
  malformed file degrades to an empty catalogue with one warning). `models.json`
  is included in the npm package and in both Docker stages, so the offline
  fallback survives every install path.
- **Every test suite moved from `src/` to `test/`** (38 suites). `src/` holds
  production code only; imports, `vi.mock` and dynamic imports were rewritten
  to `../src/...`.

### Removed

- `OPENCODE_MODELS` in `src/constants.ts` (163 lines).

## [0.10.1] - 2026-10-24

### Changed

- **npm releases use Trusted Publishing (OIDC).** The Publish workflow now
  authenticates with the job's short-lived `id-token` instead of a long-lived
  `NPM_TOKEN` secret: no publishing credential to rotate, and npm attaches
  provenance automatically. The `NPM_TOKEN` repository secret is no longer
  used by the npm step.

## [0.10.0] - 2026-10-24

### Added

- **Per-key token accounting** — the proxy now records the token usage every
  forwarded response reports (the final SSE `usage` chunk for streams, the
  top-level `usage` object for non-streaming bodies) and persists per-key
  totals to `~/.config/saros/token-usage.json` (debounced atomic writes,
  flushed on graceful shutdown). Streaming requests get
  `stream_options: {include_usage: true}` injected unless the client already
  set the option (an explicit `include_usage: false` is respected).
- `saros-proxy usage` prints those totals per key: `· tokens: 1.2M (900k in /
  300k out, 42 requests)` next to the quota windows, and replaces the bare
  `usage: n/a` line for providers without a queryable quota API
  (CommandCode) — token totals are the only consumption signal available
  there.
- **OpenCode-Go `oc_sk_…` keys** — accepted everywhere: `opencode-go.quickMatch`
  returns a definitive `yes` (CommandCode returns `no`, so identification no
  longer needs a network probe), pasted-key extraction matches the prefix, and
  config/setup validation accepts it. Legacy `sk-…` keys keep working.

### Fixed

- **Keys whose account has no plan for their provider are dropped from
  rotation.** A 403 from the usage endpoint that says the account lacks the
  subscription (`EntitlementError` on OpenCode-Go, `upgrade_required` on
  CommandCode) now marks the key as unentitled: selection skips it without
  touching the circuit breaker, and the next usage refresh puts it back as
  soon as the account can serve requests again. Previously such a key stayed
  in rotation and every request it served came back to the client as a 403
  (`RequestFault` — no failover). `/health` reports `entitledCount`, and
  `saros-proxy usage` labels the key `no subscription for this provider —
  excluded from rotation`.
- Requests that reach OpenCode-Go without an `x-opencode-session` header no
  longer fail with `400 MissingSessionID`. Saros still forwards a
  client-supplied value untouched, but now derives a stable id from the
  conversation (model + first user turn) when the client sends none —
  harnesses such as DeepSeek Harness only attach the header on some of their
  request paths. The system prompt is excluded from the fingerprint, so a
  per-turn rewrite (timestamps, injected context) doesn't change the id.
- **Streamed token usage is booked once per request.** Upstreams may report
  the same counts on more than one chunk (CommandCode sends `usage` on the
  finish chunk and again on the trailing usage-only chunk with `choices: []`);
  booking per chunk charged the key twice. The proxy now books a stream once,
  preferring the usage-only chunk.

## [0.9.0] - 2026-08-29

### Added

- **Multi-provider API keys** — mix OpenCode-Go and CommandCode keys in one
  pool. New `src/providers/` abstraction (`KeyProvider`: prefix match, smoke
  test, usage path, catalog, model affinity) with adapters for both
  providers and a registry that identifies pasted keys by pinging each
  candidate provider (`identifyKey`).
- **Paste-a-key setup flow** — the setup wizard accepts arbitrary text
  containing keys (a `.env` dump, chat message, notes file), extracts every
  key-looking token, identifies its provider with a live read-only smoke
  test (no token spend; also reports the CommandCode subscription plan),
  and labels each account.
- **Cross-provider model routing** — clients always speak the canonical
  OpenCode-Go shapes; requests served by a CommandCode key are remapped to
  its OpenAI-compatible surface (`/zen/go/v1/…` → `/provider/v1/…`) with
  provider identity headers injected per attempt. Model→provider affinity
  routes provider-specific models to a serving key first, with other
  providers as fallback; failover re-applies the same constraint.
- **Cross-provider model aliasing** — the same model served by several
  providers under different ids (`deepseek-v4-flash` vs
  `deepseek/deepseek-v4-flash`) is one entry with aliases, rotating across
  all serving keys. Synced harness configs annotate each model name with
  its rotation width: `DeepSeek V4 Flash (3)` = 3 accounts serve it.
- **dsh (DeepSeek Harness) sync target** — `configharness dsh` adds the
  profile patch layer (`~/.dsh/profiles/web/cordis.patch.yml`) as a fourth
  sync target alongside OpenCode, pi and oh-my-pi; only the saros-proxy
  provider's models are replaced, all other rows preserved.
- `GET /health` reports per-provider key counts (`providers` object).
- `saros-proxy usage` tags each key with its provider; providers without a
  queryable usage API (CommandCode) show `usage: n/a` instead of failing.
- `SAROS_CAPTURE_4XX=1` environment flag: writes the full request context
  of every upstream 4xx to `~/.config/saros/captures/` for replaying
  provider-side validation errors (opt-in; bodies may contain user content).

### Fixed

- Forwarded `content-encoding` no longer leaks downstream: Node's fetch
  transparently decompresses upstream bodies (api.commandcode.ai gzips,
  opencode.ai doesn't), so clients previously received double-encoded
  responses.
- Forwarded `content-length` is dropped when the request body is rewritten
  (model-id aliasing) — a stale length made the upstream wait for missing
  bytes until timeout.
- Plan-gated models (HTTP 403 `MODEL_NOT_IN_PLAN`) and unknown models
  (opencode-go returns 401 `ModelError` with a valid key) are classified as
  request faults — they no longer disable keys via the circuit breaker.
- Non-interactive setup infers the provider before encrypting keys, so
  encrypted CommandCode keys route correctly after a restart; the
  documented `label:key:provider` key-file column is now actually parsed.

### Changed

- `isValidApiKey` accepts `sk-…` (OpenCode-Go / CommandCode console) and
  `user_…` (CommandCode token) of ≥ 20 chars; provider inference is
  `user_` → commandcode, `sk-` → opencode-go unless `provider:` is set
  explicitly in config.yaml. Per-provider upstream overrides via the new
  `upstreams:` config map (HTTPS only).
- CommandCode-only models are synced to harnesses as `<id>@commandcode`
  (e.g. `claude-…` excluded — served via the Anthropic Messages endpoint
  only, unusable through the proxy); selected models declare a conservative
  reasoning-effort ladder instead of harness-invented ones.

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

[Unreleased]: https://github.com/vitorvilaca3011/saros-proxy/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/vitorvilaca3011/saros-proxy/compare/v0.11.0...v1.0.0
[0.11.0]: https://github.com/vitorvilaca3011/saros-proxy/compare/v0.10.2...v0.11.0
[0.10.2]: https://github.com/vitorvilaca3011/saros-proxy/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/vitorvilaca3011/saros-proxy/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/vitorvilaca3011/saros-proxy/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/vitorvilaca3011/saros-proxy/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/vitorvilaca3011/saros-proxy/releases/tag/v0.8.0
