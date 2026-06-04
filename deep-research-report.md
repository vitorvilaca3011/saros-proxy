# Feasibility of a Multi-Account Proxy  
Building a local proxy/router to juggle multiple OpenCode-Go accounts *is* technically possible, but it introduces complexity and trade‐offs. OpenCode-Go uses a fairly standard API model (more on that below), so in principle a proxy can accept requests from the OpenCode client and forward them to different accounts transparently. The proxy would supply the correct API key for each account and route calls based on policies (model, quota, etc.). This avoids modifying OpenCode itself, so upgrades and compatibility issues are minimized. The downside is that the proxy must re-implement much of OpenCode’s behavior (endpoints, streaming, error handling) and carefully manage state (especially across streaming responses). In short, a proxy is feasible and has the advantage of decoupling from OpenCode’s codebase, but it must faithfully mimic OpenCode-Go’s API, handle errors smartly, and manage multiple keys securely. We will explore whether those requirements can be met in practice. 

# Authentication Mechanisms  
OpenCode-Go authentication is **solely based on an API key** (the same key used for the Zen subscription). When you subscribe via OpenCode Zen, you get an `OPENCODE_API_KEY` which is then used for all Go-model requests. There are no separate OAuth or refresh tokens involved – the API key is the *only* credential OpenCode client sends. The key is typically sent in the HTTP `Authorization` header (e.g. `Authorization: Bearer <OPENCODE_API_KEY>`). In addition to the key, the CLI may include custom headers like `x-opencode-directory` (the current working directory) and `x-opencode-agent-name` (the client/agent name) for telemetry or debugging, but these are not required for authentication. The backend itself treats each request as stateless and keyed only by the API key. There is no separate session or user ID passed beyond that. In summary:  
- **Primary credential:** a single API key (no additional tokens or cookies needed).  
- **Headers:** besides `Authorization`, the client sets its own `User-Agent` and possibly `X-OpenCode-*` headers, but these carry only metadata (not required for auth).  
- **Multiple keys:** Technically you can store multiple API keys and swap among them. The OpenCode CLI by default only uses one key per provider, but a proxy can hold many keys and choose which to use per request.

Because it’s just key-based, a proxy can present a unified endpoint to OpenCode while internally cycling through keys. There is no complicated handshake or device registration to bypass. The main subtlety is that OpenCode expects the **provider slug** to match the endpoint (e.g. `opencode-go/kimi-k2.5` vs `opencode/kimi-k2.5`), but this is part of the URL path rather than an auth factor. In practice, the API key identifies the workspace/account (often encoded in the key), and the proxy merely swaps keys as needed – it does not maintain server-side sessions for the user.

# OpenCode-Go API Behavior  
OpenCode-Go’s API is largely **OpenAI-compatible** for chat models and **Anthropic-compatible** for Claude-style models. The Go subscription exposes endpoints under `https://opencode.ai/zen/go/v1/`. For example:  
- `POST /zen/go/v1/chat/completions` accepts OpenAI-style chat requests (with a JSON body containing `model`, `messages`, etc.). This is the endpoint for most Go chat models (e.g. GLM, Kimi).  
- `POST /zen/go/v1/messages` accepts Anthropic-style requests for models like MiniMax (M2.5, M2.7). These use the Claude/Anthropic “messages” format.  
- `GET /zen/go/v1/models` (and related endpoints) list available models in the Go catalog. 

Internal request formats mirror those standard APIs: JSON chat payloads with user/system roles for OpenAI-style models, and Anthropics with `prompt` or `messages` array for Claude-style. Because the proxy must route by model, it needs to parse the `model` field and choose an account or endpoint accordingly. The models supported include (but are not necessarily limited to) GLM-5, GLM-5.1, Kimi K2.5, Kimi K2.6, MiMo V2.x (coding LLMs), and Claude-based MiniMax M2.5/M2.7, possibly Qwen-3.7, DeepSeek V4, etc. Some models stream responses (OpenAI chat models use SSE streaming of tokens), and the proxy must handle that too. In summary:  
- **Endpoints:** Essentially `/chat/completions` for OpenAI‐style, `/messages` for Anthropic‐style, plus `/models`.  
- **Formats:** JSON chat messages (OpenAI protocol) or JSON prompt/messages (Anthropic).  
- **Model routing:** The `model` parameter (e.g. `opencode-go/glm-5.1`) indicates which model and provider to use; the proxy can route based on model name and account mapping.  

A key point: the OpenCode Go service is designed so that “any OpenAI-compatible client” can use it by simply changing the base URL and providing the key. Users have in fact done this with third-party tools. This suggests the proxy can expose exactly the same interface – making OpenCode think it’s talking to the normal Go endpoint.  

# Quota and Limit Detection  
One of the hardest parts is reliably detecting when an account is out of quota. From community reports and issue logs, we know OpenCode-Go returns HTTP errors when usage is exhausted: typically **HTTP 429** (Too Many Requests) or sometimes **HTTP 500** with a JSON error stating “insufficient balance” or account suspension. For example, users have seen messages like *“Your account … is suspended due to insufficient balance”* when a subscription runs out. The JSON payload often contains an error code (e.g. `api_error: insufficient balance (1008)`). Rate limits (short-term throttling) also result in 429 responses (often with a message about “excessive requests”). Temporary throttling (too many requests in seconds) and permanent denial (no active subscription) might look similar at first glance, but the messages differ:  
- **429 Too Many Requests:** Used for both rate limits and quota limits. The body might say “Please try again later” for rate limits, or “insufficient balance” for quota.  
- **500 Internal Error (Balance):** Some reports mention a 500 status with an “insufficient balance” error code.  
- **403 Forbidden:** We haven’t seen official evidence of 403 for quota (it’s usually 429/500), but an invalid or revoked key would be 403 or 401.  
- **Error format:** Likely JSON with an `error` field (e.g. `{"error": {"message": "insufficient balance", "type":"...", "code":1008}}`). Exact schema isn’t public, but it follows OpenAI/Anthropic style. 

No documentation gives a clean list of codes, so the proxy must be prepared to interpret 429 or 500 responses. A robust approach is pattern-matching: if the HTTP status is 429 *and* the message mentions “balance” or “quota”, treat that as account exhaustion. If 429 with a message about rate limits (“Too many requests”), it’s probably a transient throttle. The proxy should also watch for anything like HTTP 503 or 520 which might indicate upstream unavailability, not necessarily quota – in those cases it might retry or fail differently.

**Examples:** (from community bug reports)  
- On hitting the monthly token limit, responses include “insufficient balance” and a 429 status.  
- For rate limits, one can get “You are sending requests too quickly” with 429.  
- Permanent absence (no paid plan) can show “no resource package; please recharge.”  

In practice, the proxy will see an HTTP error and a payload string. It should parse for keywords (“insufficient”, “balance”, “throttle”) and decide: exhausted (switch accounts), or retry (rate-limited, backoff), or give up (fatal error). Without authoritative docs, this requires some heuristic. But the key is that account *A* is down when it clearly hit a quota, so the proxy can mark it as temporarily exhausted and try account *B*.  

# Failover Architecture  
Automatic failover is doable but delicate. The sequence would be: client sends request to proxy → proxy selects Account A and sends request → if response is successful, return to client; if response indicates quota or error, proxy catches it and retries the **same request** with Account B. A simple failover chain (A → B → C) is possible.  

**Is this safe?** Generally yes for pure generation requests (they are idempotent in the sense of not causing side effects beyond return text). However, risks include:  
- **Duplicate output:** If Account A managed to stream some tokens before failing, and then Account B also generates, the client could see two partial streams concatenated or confused.  
- **Out-of-order or partial results:** The client has already seen some tokens from A, then abruptly sees B’s output, which might not align.  
- **Side effects:** The only side effect is computing cost. There’s no “action” the model takes (no write to DB, no charges beyond token usage). So it’s largely safe except for duplicated cost.  

To mitigate risks, the proxy should:  
- Retry **only once** (or a few times) on a given request to avoid storms.  
- If streaming, ideally **stop streaming from A** before switching to B. In practice, if A fails mid-stream, the proxy should close A’s stream and start B’s stream from scratch. The client will then get the full answer from B only (and any partial from A will be lost). This is a limitation the user must see – either an error or a partial reply.  
- Mark accounts as unavailable when a definitive quota error occurs. For example, if Account A returns “insufficient balance,” the proxy should disable A for the rest of this session or until a cooldown. If the error was a transient rate limit, just retry after a brief pause instead of switching account.  
- Use a circuit-breaker pattern: after N consecutive failures on an account, mark it down for some cool-down period to avoid hammering it.  

**Best practices:** This is analogous to multi-API-key gateways or load balancers. Typically one would implement a retry policy (e.g. up to 1 failover retry), and exponential backoff for rate-limits. The proxy could keep track of usage per key and preemptively route heavy requests to accounts with more remaining quota. In summary: failover *can* be done, but must handle partial streams and differentiate error types; it’s safe as long as duplicate generation (with extra cost) is acceptable and partial outputs are resolved. 

# Streaming Response Handling  
This is the trickiest part. If a model is set to stream its output (token-by-token), and an account hits a limit **mid-stream**, the connection will break and the client sees incomplete text. Can the proxy “resume” on another account? In general, **no**. LLM generation is stateful in the prompt, and when an account hits a limit, the model state is lost. The proxy would have to resend the original prompt (the entire conversation) to another account to continue, but that means the user might see duplicate or misaligned content. For example:  
1. Account A generates tokens and sends “Hello, how are” then stops.  
2. The proxy notices exhaustion and retries with Account B from the *beginning* of generation. B will likely output “Hello, how are” again (or something similar) followed by the rest. The client could end up with “Hello, how areHello, how are you doing? I’m fine.” – clearly broken.  

Recommendations:  
- The proxy **cannot seamlessly continue a partial stream** on another account. The safest approach is to abort A’s stream as soon as it fails and then either restart on B (losing what A produced), or return an error to the client.  
- It’s better to design the system to *not* expect seamless continuation. In practice, the client (OpenCode) would need to realize the answer is incomplete and re-query if needed. But since OpenCode is not aware of the proxy logic, the proxy might choose to buffer nothing and just send what each account gives.  
- User-visible problem: The user might see a partial answer or duplicated content. The best fix is to have a clean handoff: after A’s error, immediately begin streaming B’s output from the start. The user then sees (duplicated part) plus continuing answer. This is awkward but at least yields a full answer. There’s no way to “pick up where A left off” because the LLM has no memory of that partial run.  

In summary, streaming failover is *not* fully transparent. The user might see a glitch or repeated text. A recommendation is to **retry the full request quietly** on another account if streaming breaks – essentially giving the user the full answer from one account (the second one) but at the cost of what the first account produced. This may look like duplicate content. The alternative is to fail loudly (error). Neither is perfect, but a proxy solution should at least attempt to restart the stream from another account. 

# Session Continuity  
OpenCode itself holds conversation history on the *client side*, not on OpenCode-Go servers. Every completion request includes the full prompt and past messages (OpenCode constructs these). Thus, from the server’s perspective, each API call is independent. Switching the backend account or even the provider mid-session is almost invisible to OpenCode. The only thing OpenCode “sees” is that it’s talking to some Go-compatible endpoint; it has no knowledge of accounts or keys after authentication. 

Therefore:  
- **Conversation state:** Local to the client. The proxy switching accounts does not lose history, because that history is sent anew with each request.  
- **Account switching transparency:** OpenCode will not notice if request #10 used Key A and request #11 used Key B, as long as both keys have access to the requested model. The model ID (`opencode-go/<model>`) remains the same; only the key changed. In principle, this is transparent. The only caveat is if one account were somehow limited to certain models (unlikely – a Go subscription gives access to all its Go models). If each account had a different set of allowed models, the proxy would need to pick an account that supports the chosen model. But typically all Go subscribers see the same catalog. 

In short, yes, account switching at the proxy should be **transparent to OpenCode’s conversation**. The user’s conversation continues uninterrupted (apart from streaming hiccups) because each API call still represents the same logical chat session. 

# Routing Strategies  
Several routing policies could be implemented in the proxy:

- **Static Model-to-Account Mapping:** Assign certain models permanently to certain accounts. *E.g.*: Account A always handles GLM and Kimi, Account B always handles MiMo and MiniMax. This is simple but inflexible – if Account A exhausts GLM usage, it won’t fail over unless the proxy has an exception. It also can under-utilize capacity if models aren’t evenly used.

- **Priority Failover:** Always try Account A first for any request; on failure try B, then C. This ensures the “best” account (maybe the one with most quota or lowest latency) is used whenever possible. The downside is Account A will run out first, then B, etc. But it’s easy to implement.

- **Round Robin:** Distribute requests evenly across accounts (A→B→C→A→…). This balances load and might utilize quotas more evenly. It risks occasionally sending a request to an already exhausted account if checks are not done, but a quick health check per account can mitigate that.

- **Weighted Routing:** Like Round Robin but with weights. If Account A has double the remaining quota of B, send twice as many requests to A. Weights could be static (based on subscription age or token package) or dynamic (based on remaining credits if the proxy tracks that).

- **Least Recently Used / Random:** Pick the account that hasn’t been used in the longest time or a random one. This spreads usage somewhat but without awareness of actual quotas.

- **Usage-Aware (Quota-Based):** Estimate remaining quota for each account (this is tricky since OpenCode does not publish remaining tokens). One could monitor usage on the proxy (sum of tokens sent). Then route new requests to the account with more estimated budget. This is optimal but requires the proxy to track usage metrics. Also, token cost depends on prompt+response length, which the proxy can track.

**Realistically implementable:** Priority failover and Round Robin are easiest. Static mapping is simple but rigid. Weighted routing is doable if we decide static weights or simple load measure. Fully dynamic, usage-aware routing is ideal but complex (and error-prone if usage accounting is off). For an MVP, a combination of Round Robin with skip-over-on-failure (or fixed priority) is a good start. More sophisticated quota tracking can come later.

# Security Considerations  
Storing and handling multiple API keys locally raises some security questions:

- **Storage:** The keys should be stored securely. Options include:  
  - **Environment variables:** The user could put keys in a `.env` file or shell variables. This avoids writing them into code or logs. The proxy can read `$OPENCODE_GO_KEY_A`, etc.  
  - **Encrypted config file:** The proxy could store keys in a file (e.g. JSON or YAML) that is itself encrypted or protected by OS permissions. For example, `~/.config/multi-go-proxy/keys.enc`. On startup, the proxy asks for a decryption passphrase. This is more secure but adds user friction.  
  - **Keychain/OS vault:** On macOS/Windows/Linux, one could integrate with a system keychain or vault. More work but safer.  

  In any case, the proxy should avoid logging keys or exposing them. If environment variables are used, they should be marked *protected* (the proxy should unset them from any subprocess environment after reading). If in a file, it should have restrictive permissions (chmod 600) and no backups or inadvertent sharing.

- **Compromise risk:** If the proxy or machine is compromised, all keys are at risk (they must be in memory to function). This is similar to any local CLI that holds API keys. The user must trust their local machine and the proxy software. If the proxy runs as a separate process, minimize its privileges (run as unprivileged user).

- **Accidental leakage:** The proxy should ensure that when it forwards a request, only the `Authorization` header changes, and it must not leak one account’s key to another request. Logs should mask keys (“****”). If saving transcripts or errors, it should scrub keys from any dump. Because the same model endpoints are used, the only thing differentiating accounts is the header.

- **Proxy compromise:** If an attacker controls the proxy, they can misuse all accounts’ keys. The architecture should consider minimizing network access of the proxy (e.g. binding only to localhost, requiring firewall rules). OpenCode config must point to `http://localhost:port` to prevent external use. 

- **Internal token separation:** A good practice is to label each key in config and make them clearly separated (e.g. `AccountA_Key`, `AccountB_Key`), rather than storing them in one combined structure. This way, an error in code is less likely to confuse them.

In summary, treat the proxy as sensitive as the keys themselves. Encrypt or restrict key storage, avoid logs of secrets, and run the proxy locally. 

# OpenCode Compatibility  
We must configure OpenCode to talk to the local proxy instead of the real Go endpoint. Fortunately, OpenCode supports custom providers. Options include:  

- **Custom Provider/Base URL:** In OpenCode’s config or via `/connect`, the user can specify a custom API base URL. One can set the Go provider’s base URL to `http://localhost:<port>/zen/go`. Then OpenCode will send requests to `localhost` instead of `opencode.ai`. (Some clients allow an env var like `OPENCODE_BASE_URL` or similar.) If not directly supported, the proxy can use host tricks (like editing `/etc/hosts` to make `opencode.ai` resolve to 127.0.0.1, but that’s a hack.) Ideally, the proxy is simply bound to `localhost:<port>` and OpenCode’s provider config is updated to use that URL.  

- **OpenAI-Compatible Interface:** Because the proxy speaks OpenAI/Anthropic protocols, it might be possible to configure OpenCode’s *OpenAI* provider (if it has one) to point at the proxy, if OpenCode CLI allows selecting an OpenAI provider by URL. More straightforward is a “generic endpoint” provider. The OpenCode docs mention a “Custom Provider” option for any OpenAI-compatible API. The user can create a new provider with type “openai” (or similar) and set its URL to the proxy. Then using that provider will route through the proxy.  

- **Localhost Support:** Yes, OpenCode can target localhost. It doesn’t have built-in restrictions. You simply tell it the base URL. In many CLI tools, that is allowed. If necessary, environment variables or config files (like `~/.config/opencode.jsonc`) can include an entry like:  
  ```json
  "providers": {
    "multigo": {
      "type": "custom",
      "api_base_url": "http://127.0.0.1:5000/zen/go/v1",
      "api_key": ""
    }
  }
  ```  
  where the proxy listens on port 5000.  

- **No special plugin needed:** Unlike a browser or IDE where proxies can be tricky, a CLI-based OpenCode is flexible. As long as the proxy replicates the expected endpoints exactly, OpenCode should not need any code changes. The one wrinkle is that OpenCode’s UI (TUI or desktop) might cache model lists from the provider. It will show the same models (they come from `GET /models`). If the proxy handles that route properly, the UI will remain unchanged.  

In practice, users have already used OpenCode Go keys with third-party clients by simply using the endpoints given in documentation. This means integration is straightforward: set the OpenCode-Go provider’s endpoint to the proxy’s address. No code modifications to OpenCode are required, just configuration.

# Existing Projects and Prior Art  
While we didn’t find an off-the-shelf proxy exactly for OpenCode-Go, there are related efforts:  

- **Claude-Code Proxy (oc-go-cc):** There is an open-source CLI proxy (by user *samueltuyizere*) called **oc-go-cc** that lets Claude Code use an OpenCode Go or Zen subscription. It sits between Claude Code and the OpenCode endpoints. This shows it is possible to bridge protocols locally.

- **Rosetta-LLM Proxy:** A project called **rosetta-llm** (open-sourced via Reddit post) is a “multi-format LLM proxy” that can act as a gateway for different models and seems to target OpenCode / Claude-like use cases. It suggests people have built proxies for multi-model access, though it’s community-driven, not official.

- **codex-pool (GitHub):** For OpenAI and Anthropic APIs, someone built **codex-pool**, a multi-key proxy/gateway. It balances requests among multiple API keys (though focused on coding LLMs generally). It demonstrates the viability of the concept for similar APIs (even if not specific to OpenCode).

- **OpenCode-LMM-Proxy (KochC):** There is a repository named **opencode-llm-proxy** (GitHub) – ironically a plugin – which creates a local HTTP server to translate between OpenAI/Anthropic formats and any provider. It’s a plugin, but the idea is similar. (We can’t inspect it now, but it confirms that others have pursued the idea of a local translation layer.)

These projects indicate that the idea of a local multi-account or multi-protocol proxy is not unprecedented. The existence of Claude Code and Copilot CLI workarounds (BYOK setups) also shows the community is adapting tools to use OpenCode-Go accounts. None of these are official, but they prove it can be done with some engineering effort.

# Plugin vs Proxy: A Comparison  
**A) OpenCode Plugin Approach:**  
- *Complexity:* Writing a plugin (or modifying OpenCode source) to handle multiple accounts would involve diving into OpenCode’s codebase. OpenCode is written (we believe) in a compiled language (Rust?) and has its own plugin system. A multi-key feature is not trivial; it would need to hook into the request logic, manage multiple keys, and handle failover. This is a fairly complex change to a maintained project.  
- *Reliability:* A plugin could be made reliable if properly developed, but every OpenCode update might break it unless upstream adopts the changes. It would essentially become a fork or custom plugin that must track OpenCode’s releases.  
- *Maintenance:* High. The plugin developer must update it for every new version of OpenCode and ensure compatibility. End-users would need to install it themselves (there’s no central plugin repo yet).  
- *Upgrade Compatibility:* Potentially brittle. Core OpenCode changes to providers or request flow could break the plugin’s assumptions.  
- *User Experience:* A plugin could be seamless (integrated into OpenCode settings) and invisible to the user. But installing it might be non-trivial. It might not be officially supported.  
- *Security:* Keys would still need to be stored by the plugin. But as part of OpenCode’s process, it could integrate with OpenCode’s key storage. Less exposure since no extra process runs.  
- *Long-term viability:* Depends on OpenCode’s willingness to incorporate such a feature. As an unofficial solution, it’s fragile.

**B) Local Proxy/Router Approach:**  
- *Complexity:* The proxy must reimplement the network protocol for OpenCode-Go. This is not trivial but is isolated from OpenCode’s internals. We need to support forwarding requests, handling streams, failover logic, and serving the exact endpoints. However, it does not require changing OpenCode itself.  
- *Reliability:* If well-tested, a proxy can be very reliable. It stands outside of OpenCode, so it doesn’t break when OpenCode updates (as long as the external API remains stable).  
- *Maintenance:* Moderate. The proxy is a separate project and only needs to update if OpenCode-Go’s API changes. OpenCode-Go is relatively stable, so updates would be infrequent. Also, the proxy code is likely simpler (just HTTP forwarding).  
- *Upgrade Compatibility:* Good. Upgrading OpenCode is a non-issue (the proxy just sees API calls). Upgrading the proxy might be needed only when upstream changes.  
- *User Experience:* Requires configuration (pointing to localhost), but once set, it can be transparent. Potential quirks with streaming aside, usage would feel like a regular single account.  
- *Security:* Keys are stored by the proxy. This adds an extra attack surface: if the proxy is compromised, keys could be stolen. But if the proxy is tightly scoped (only listens on localhost, minimal permissions), this risk is manageable.  
- *Long-term viability:* Better. A proxy is generally language- and platform-agnostic and can be open-sourced or forked by others. It doesn’t depend on OpenCode’s internal APIs.

**Conclusion:** The proxy approach is preferable. It avoids hacking into OpenCode, is easier to maintain independently, and leverages standard HTTP interfaces. The main challenges (streaming, error handling) are difficult in both models, but at least a proxy confines them to one place. A plugin might integrate more tightly but at great cost and fragility. Given that the user asked for a proxy solution specifically, and we find no showstopper, it appears to be the better architecture.

# Recommended Architecture (MVP)  
For an initial Minimal Viable Product, focus on the core requirements: handling multiple keys, basic routing by model, and simple failover. **Components:**  
1. **Local HTTP Server:** A lightweight server (e.g. Node.js/Express, Python/FastAPI, or Go/Chi) listening on `localhost:PORT`. It exposes endpoints identical to OpenCode-Go: e.g. `/zen/go/v1/chat/completions` and `/zen/go/v1/messages` (it can proxy `/models` too).  
2. **API Key Store:** Configuration or environment to load multiple API keys (e.g. `API_KEY_A`, `API_KEY_B`, `API_KEY_C`). Possibly an array of keys. Also allow labeling (like “Account A, B, C”).  
3. **Request Router:** Logic that receives an incoming HTTP request, parses the model name from JSON, and decides which account (key) to use. For MVP, a simple round-robin or priority scheme is fine.  
4. **Proxy Logic:** The server forwards the HTTP request to `https://opencode.ai/zen/go/v1/...` with the chosen key and all other headers/body intact (except change `Authorization`). It should forward response headers, status, and body back to OpenCode client.  
5. **Failover Mechanism:** If the upstream response is a quota error (429/500 with “insufficient” etc.), the proxy should catch this, switch to another key, and retry the *entire request*. Limit retries to 1 or 2. If all keys fail, return the last error.  
6. **Streaming Support:** For streaming endpoints, the server should use a streaming HTTP client and pipe chunks through. On failure, it should close the first stream and open a second. This is complex, so MVP might skip streaming or fall back to non-streaming (some clients allow disabling stream). But since OpenCode likely uses streaming, initial support is needed: e.g. using Server-Sent Events or HTTP chunking. The proxy code needs to handle that stream and split properly.  

**Technology Stack:**  
- **Language:** Go or Node.js are good choices for HTTP proxying with streaming. Go has excellent concurrency and streaming, Node has many libraries too. Python with asyncio could work but streaming might be trickier.  
- **Libraries:** Use an HTTP client that supports streaming (e.g. `axios`/`got` in Node, or Go’s `http.Client`).  
- **Configuration:** A simple JSON or YAML file for keys and settings, or environment variables for quick MVP.  
- **Deployment:** It runs locally on the developer’s machine (no remote hosting needed). The proxy should auto-retry with backoff on transient network issues.

**High-Level Diagram:** (imagine a diagram here)  
```  
[OpenCode CLI] -> [Local Proxy (round-robin + key store)] -> [OpenCode-Go API (multiple accounts behind scenes)]  
                                      |-> Key A
                                      |-> Key B
                                      |-> Key C  
```

**Roadmap:**  
1. **Proof-of-Concept:** Hardcode two API keys. Proxy only `/chat/completions`. Implement round-robin or simple failover. Test with a simple curl or OpenCode pointed to proxy. Ensure basic functionality.  
2. **Key Configuration:** Add config file or env support for N keys.  
3. **Error Handling:** Implement detection of “balance” errors and retry logic.  
4. **Streaming:** Add SSE/chunk piping. Test with a streaming client.  
5. **Model-Aware Routing:** Allow mapping model names to preferred keys or accounts. Possibly via config (e.g. GLM -> key1, MiniMax -> key2).  
6. **UI Integration:** Provide instructions for users to configure OpenCode to use the proxy (edit config or use `/connect` with a custom provider).  
7. **Polishing & Security:** Mask logs, add verbose mode, secure default settings (bind only to localhost, require config file on first run, etc.).  

**Estimated Difficulty:** Moderate. The basic proxy is straightforward HTTP forwarding, but correct streaming and failover logic is nuanced. A small team or experienced developer could build an MVP in a couple of weeks. More time would be spent on robust error parsing and reliable streaming.  

# Step-by-Step Implementation Roadmap  
1. **Choose Platform & Setup:** Pick a language (e.g. Node.js). Scaffold a simple HTTP server.  
2. **Forwarding Logic:** Implement an endpoint that forwards requests to `opencode.ai/zen/go/v1/*`. Ensure headers and body are proxied.  
3. **Key Management:** Read multiple API keys from a config (e.g. JSON file) or environment. Start with a fixed number of keys for testing.  
4. **Basic Routing:** Implement round-robin selection of keys for each incoming request.  
5. **Test with Curl:** Use `curl -H "Authorization: Bearer KEY"` against proxy, ensure it responds like the real API.  
6. **OpenCode Integration:** Configure OpenCode CLI to use proxy (e.g. in `opencode.jsonc` or via `/connect Other`). Verify OpenCode can complete queries through proxy.  
7. **Error Detection:** Inspect error responses (simulate by exhausting a test key or by using a known-invalid key). Write code to detect 429/500 and specific text (e.g. search `"insufficient"`, `"balance"`).  
8. **Failover Retry:** On error detection, retry the same request with the next key. Limit to one retry per account.  
9. **Testing Failover:** Use two accounts: exhaust one (via heavy use or mock), verify proxy switches to the second without breaking OpenCode.  
10. **Streaming Support:** Modify the HTTP client to stream responses back to the original caller. For Node, use `request` or `fetch` with event-stream. On error mid-stream, abort and retry second key. Test with known streaming request (e.g. ask for a long code completion).  
11. **Configuration & UX:** Add CLI arguments or config file support (e.g. `proxy --config keys.json --port 5000`). Document how to set up OpenCode to use it.  
12. **Security Hardening:** Ensure the server listens only on localhost (not on 0.0.0.0 by default). Do not log keys. Optionally, implement encryption of the config file.  
13. **Logging & Metrics:** Add clear logs of which key is used per request and any failovers. Possibly expose a status endpoint (e.g. `/status`) that shows keys health.  
14. **Beta Testing:** Try with actual OpenCode usage scenarios (code completion, multi-turn chat). Note any issues (e.g. conversation breaks, model mismatches) and refine.  
15. **Future Work:** Enhance routing (e.g. weight by usage), add a web UI to manage keys, support additional endpoints (`/embeddings` if needed), etc.

Each step should be validated before proceeding. By focusing on one piece at a time, the proxy can gradually grow from a simple forwarder to a robust multi-account router, achieving the goal of seamless continuation for heavy OpenCode-Go users.