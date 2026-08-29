# CommandCode API support for saros-proxy — Research Findings

> Research date: 2026-08-29. All endpoints were probed live (no API key needed to
> characterize the error contract). Sources: npm packages `opencommand-plugin`
> 0.0.29 (bundles a Go proxy that speaks the CommandCode protocol) and
> `@mars-sea/dsh-commandcode-provider` 0.9.1, plus live `curl` probing of
> `api.commandcode.ai` and comparison against `opencode.ai`.

## 1. What CommandCode is

CommandCode (commandcode.ai, CLI package `command-code`, latest 1.38.2) is a
coding-agent platform with its own subscription plans (individual-go / pro /
provider / max / ultra / teams-pro). API access is via tokens of the form
`user_...` — but **the platform also issues `sk-` keys** (created in the web
console), which matters for smoke-test classification (see §5).

## 2. Base URL and protocol

- Base URL: `https://api.commandcode.ai`
- The chat protocol is **NOT plain OpenAI** and **NOT Anthropic**. The official
  CLI hits `POST /alpha/generate` with a proprietary envelope. The bundled Go
  proxy in opencommand-plugin translates OpenAI `/v1/chat/completions` ⇄
  `/alpha/generate`.
- All requests should carry CLI-identity headers; the server gates on
  `X-CommandCode-Client-Version` (403 `upgrade_required` if missing/stale,
  minVersion 0.18.10):

```
User-Agent: CommandCodeCLI/<version>
X-Command-Code-Version: <version>
X-CLI-Environment: production
X-Project-Slug: command-code
X-CommandCode-Client: cli
X-CommandCode-Client-Version: <version>
X-CommandCode-CLI-Version: <version>
X-Command-Code-Client-Version: <version>
X-Command-Code-CLI-Version: <version>
x-cmd-zdr: 1        // optional, zero data retention
```

The version can be resolved live from `https://registry.npmjs.org/command-code/latest`.
Note: one header pair disagrees between sources (`X-Project-Slug`:
`command-code` in opencommand's `commandCodeClientHeaders()` vs
`COMMAND_CODE_PROJECT_SLUG` in the other). Needs one real key to confirm.

## 3. Endpoints (live-probed)

| Endpoint | Method | Auth behavior observed | Use in saros |
|---|---|---|---|
| `/provider/v1/models` | GET | **200 even with a bogus key** — unauthenticated catalog, OpenAI `{object:"list",data:[...]}` shape, ~65 models | model catalog merge (no key check possible) |
| `/alpha/billing/subscriptions` | GET | 401 `{"success":false,"error":{"code":"UNAUTHORIZED",...}}` with bogus key; returns `planId` for valid keys | **best smoke-test endpoint** (cheap GET, real 401) + plan detection |
| `/alpha/generate` | POST | With CLI headers + bogus `sk-` key: **400 BAD_REQUEST on body validation** (complains about `memory`, `params`, `config`) — i.e. auth passed. Without CLI headers: 403 `upgrade_required` | actual chat relay; also proves auth separately from body |
| `/v1/account/usage` | GET | 404 "not a registered API route" on api.commandcode.ai (it exists only on the local opencommand proxy) | not usable directly |
| `/v1/chat/completions` | POST | 404 on api.commandcode.ai (only the local proxy serves it) | not usable directly |
| root `/` | GET | 200 | — |

Error contract (different from opencode-go!):
- CommandCode 401 → `{"success":false,"error":{"code":"UNAUTHORIZED","status":401,"message":"...","docs":"..."}}`
- opencode-go 401 → `{"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}`

## 4. For comparison: opencode-go (current saros upstream)

- Base: `https://opencode.ai`, usage at `/zen/go/v1/usage`, 401 body shape above.
- Keys: `sk-` ≥ 20 chars (current `isValidApiKey`).

## 5. Smoke test / key classification design

Goal: user pastes any key into the TUI, saros identifies its provider by pinging.

**Collision warning: `sk-` is ambiguous.** Both opencode-go and CommandCode
issue `sk-` keys. Prefix alone is insufficient. The smoke test must be
empirical, per provider adapter:

| Test | opencode-go | CommandCode |
|---|---|---|
| `GET https://opencode.ai/zen/go/v1/usage` w/ Bearer | 401 AuthError → not this provider | (n/a) |
| `GET https://api.commandcode.ai/alpha/billing/subscriptions` w/ Bearer + CLI headers | (n/a) | 401 UNAUTHORIZED → not this provider; 200 + `planId` → **commandcode** |
| `user_` prefix shortcut | — | skip straight to CommandCode test |

Recommended decision tree in `identifyKey()`:
1. `key.startsWith('user_')` → try commandcode only.
2. else (`sk-` or unknown): run both probes in parallel; first definitive
   200 wins; 401 on both → unknown/invalid key; network error → retry/ambiguous.

A `401` is a *definitive negative* (cheap, no side effects). A `200` from
`/alpha/billing/subscriptions` with a `planId` is a *definitive positive* for
commandcode. For opencode-go a valid key returns 200 with the usage JSON.
Do NOT use `/alpha/generate` for smoke tests — with a valid key it would
consume tokens, and without the full protocol envelope the 400-vs-401 line is
fragile. Also do not rely on `/provider/v1/models` (no auth at all).

## 6. What relaying chat through saros would take

saros-proxy today is a transparent reverse proxy to opencode.ai with Bearer
swap. For CommandCode there are two options:

- **Option A (transparent relay, recommended first step):** route by key
  provider. When the selected key is a commandcode key, forward to
  `api.commandcode.ai`, inject the CLI-identity headers, and require the client
  (harness) to speak the `/alpha/generate` envelope — or expose the
  opencommand-style local `/v1/*` OpenAI surface and translate. The opencommand
  Go proxy already solves this translation; porting or borrowing its protocol
  translation is the main lift.
- **Option B (lean on opencommand-plugin):** treat the opencommand local proxy
  as upstream for commandcode keys. Least code, extra local dependency.

## 7. Modularity plan (fits current codebase)

Current pain points: `isValidApiKey` hardcodes `sk-`; `config.ts` filters env
keys by `sk-`; `USAGE_PATH`/usage-client is opencode-go-specific;
`proxy.ts` builds upstream URLs/headers opencode-go-specifically.

Proposal — new `src/providers/` module:

```ts
export interface KeyProvider {
  readonly id: 'opencode-go' | 'commandcode';        // extensible
  /** Cheap structural check, may be inconclusive (sk- collision). */
  quickMatch(key: string): 'yes' | 'no' | 'maybe';
  /** Definitive ping: 200 = valid, 401-class = invalid, null = inconclusive. */
  smokeTest(key: string): Promise<SmokeResult>;
  usagePath(): string;                                // '/zen/go/v1/usage' | '/alpha/billing/subscriptions'
  buildUpstreamHeaders(incoming: Headers, key: string): Headers;
  parseUsageResponse(body: string): KeyUsage | null;  // provider-specific shapes
}
```

- `src/providers/opencode-go.ts`, `src/providers/commandcode.ts`, registry in
  `src/providers/index.ts`.
- `validation.ts`: replace `isValidApiKey` with provider-pluggable check
  (min length 20 stays; prefix check moves into providers; `user_` accepted).
- `config.ts`: keys gain optional `provider` field; YAML `keys: [{label, key, provider?}]`;
  unknown provider → smoke test at setup time and persist result.
- TUI (setup.ts): new "paste keys" flow → extract keys from arbitrary pasted
  text (regex `(?:sk|user)_[A-Za-z0-9_-]{16,}` style), run `identifyKey()`
  across providers in parallel, show detected provider + plan, then save.
- usage-client: dispatch to `provider.parseUsageResponse`; commandcode usage
  comes from billing/subscriptions (plan gates models) — richer usage endpoint
  may require the Studio session-cookie route (out of scope for v1).

## 8. Open questions (need a real key to resolve)

1. Exact `X-Project-Slug` value (`command-code` vs `COMMAND_CODE_PROJECT_SLUG` const).
2. `/alpha/generate` full request envelope (`memory`, `params`, `config` fields) —
   only obtainable from the CLI source or protocol capture; opencommand's Go
   proxy implements it (`commandcode-protocol.json` in their repo).
3. Whether streaming responses on `/alpha/generate` are SSE or chunked JSON
   (binary strings show `text/event-stream` handling, likely SSE).
4. Rate-limit / quota headers shape for circuit-breaker classification.
5. Does CommandCode rate-limit the billing endpoint (smoke test frequency)?
