/**
 * constants.ts — Shared configuration constants for the proxy.
 *
 * All magic numbers and default values used across the codebase
 * are centralized here to avoid duplication and improve maintainability.
 */

export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MIN_KEY_LENGTH = 20;
export const API_KEY_PREFIX = 'sk-';
/** OpenCode console keys minted after the 2026-10 rotation (provider-exclusive). */
export const OPENCODE_GO_KEY_PREFIX = 'oc_sk_';
export const DEFAULT_UPSTREAM_URL = 'https://opencode.ai';
// Multi-provider upstreams (overridable via config `upstreams:` map).
// Chat route prefixes live on the provider adapters (chatBasePath).
export const DEFAULT_UPSTREAM_OPENCODE_GO = DEFAULT_UPSTREAM_URL;
export const DEFAULT_UPSTREAM_COMMANDCODE = 'https://api.commandcode.ai';
export const MAX_BODY_SIZE = 10 * 1024 * 1024;
export const MAX_RETRIES = 2;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 100;
export const FORCE_SHUTDOWN_TIMEOUT_MS = 5_000;
export const MAX_STREAMING_BUFFER = 10_000;
export const MODELS_FETCH_TIMEOUT_MS = 5_000;
export const MODELS_WARM_BUFFER_MS = 60_000;

// Per-key usage tracking (upstream usage API + weighted rotation)
export const USAGE_REFRESH_TTL_MS = 60_000; // min interval between upstream refreshes
export const USAGE_FETCH_TIMEOUT_MS = 10_000;
export const USAGE_PATH = '/zen/go/v1/usage';

// Model request counters (persisted for `saros-proxy usage`)
export const MODEL_STATS_SAVE_DEBOUNCE_MS = 5_000;

// Per-key token counters (persisted for `saros-proxy usage`)
export const TOKEN_USAGE_SAVE_DEBOUNCE_MS = 5_000;

// models.dev canonical metadata
export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const MODELS_DEV_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const MODELS_DEV_TIMEOUT_MS = 10_000;
export const MODELS_DEV_PROVIDER_ID = 'opencode-go';
export const MODELS_DEV_SAFE_FIELDS = [
  'id', 'name', 'tool_call', 'reasoning', 'limit',
  'modalities', 'cost', 'reasoning_options',
  'interleaved', 'structured_output',
] as const;

// Probe cache & request constants
export const PROBE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const PROBE_REQUEST_TIMEOUT_MS = 30_000;
export const PROBE_LIVENESS_PROMPT = "Reply with the word 'pong' and nothing else.";
export const PROBE_REASONING_PROMPT = 'What is 2+2? Think step by step.';
export const PROBE_TOOL_CALLING_PROMPT = 'What is the weather in Paris?';

// Daemon auto-sync timeout (how long to wait for upstream sync before exiting)
export const DAEMON_SYNC_TIMEOUT_MS = 30_000;
