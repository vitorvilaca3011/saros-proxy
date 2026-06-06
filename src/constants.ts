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
export const DEFAULT_SCRAPE_INTERVAL_MS = 90_000;
export const MIN_SCRAPE_INTERVAL_MS = 10_000;
export const MAX_SCRAPE_INTERVAL_MS = 3_600_000;
export const MIN_KEY_LENGTH = 20;
export const API_KEY_PREFIX = 'sk-';
export const DEFAULT_UPSTREAM_URL = 'https://opencode.ai';
export const MAX_BODY_SIZE = 10 * 1024 * 1024;
export const MAX_RETRIES = 2;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 100;
export const FORCE_SHUTDOWN_TIMEOUT_MS = 5_000;
export const MAX_STREAMING_BUFFER = 10_000;
export const DEFAULT_USAGE_THRESHOLD = 50;
export const WORKSPACE_ID_REGEX = /^wrk_[A-Za-z0-9]+$/;

// OpenCode client model definitions for proxy provider configuration
// Source: https://opencode.ai/zen/go/v1/models (18 models as of 2026-06-06)
export const OPENCODE_MODELS: Record<string, unknown> = {
  // GLM series (~200K context)
  'glm-5': {
    id: 'glm-5',
    name: 'GLM-5',
    tool_call: true,
    limit: { context: 200000, output: 8192 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },
  'glm-5.1': {
    id: 'glm-5.1',
    name: 'GLM-5.1',
    tool_call: true,
    limit: { context: 200000, output: 8192 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },

  // Kimi series (~256K context)
  'kimi-k2.5': {
    id: 'kimi-k2.5',
    name: 'Kimi K2.5',
    tool_call: true,
    limit: { context: 256000, output: 8192 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },
  'kimi-k2.6': {
    id: 'kimi-k2.6',
    name: 'Kimi K2.6',
    tool_call: true,
    limit: { context: 256000, output: 8192 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },

  // DeepSeek V4 series
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    tool_call: true,
    limit: { context: 128000, output: 8192 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    tool_call: true,
    limit: { context: 128000, output: 8192 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },

  // MiMo series (200K context for v2)
  'mimo-v2.5': {
    id: 'mimo-v2.5',
    name: 'MiMo V2.5',
    tool_call: true,
    limit: { context: 128000, output: 8192 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },
  'mimo-v2.5-pro': {
    id: 'mimo-v2.5-pro',
    name: 'MiMo V2.5 Pro',
    tool_call: true,
    limit: { context: 128000, output: 8192 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },
  'mimo-v2-pro': {
    id: 'mimo-v2-pro',
    name: 'MiMo V2 Pro',
    tool_call: true,
    limit: { context: 200000, output: 8192 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },
  'mimo-v2-omni': {
    id: 'mimo-v2-omni',
    name: 'MiMo V2 Omni',
    tool_call: true,
    limit: { context: 200000, output: 8192 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },

  // MiniMax series (Anthropic-compatible API)
  'minimax-m3': {
    id: 'minimax-m3',
    name: 'MiniMax M3',
    tool_call: true,
    limit: { context: 128000, output: 8192 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },
  'minimax-m2.7': {
    id: 'minimax-m2.7',
    name: 'MiniMax M2.7',
    tool_call: true,
    limit: { context: 128000, output: 8192 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },
  'minimax-m2.5': {
    id: 'minimax-m2.5',
    name: 'MiniMax M2.5',
    tool_call: true,
    limit: { context: 128000, output: 8192 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },

  // Qwen series (1M context for 3.6/3.5 Plus)
  'qwen3.7-max': {
    id: 'qwen3.7-max',
    name: 'Qwen 3.7 Max',
    tool_call: true,
    limit: { context: 256000, output: 8192 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },
  'qwen3.7-plus': {
    id: 'qwen3.7-plus',
    name: 'Qwen 3.7 Plus',
    tool_call: true,
    limit: { context: 256000, output: 8192 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },
  'qwen3.6-plus': {
    id: 'qwen3.6-plus',
    name: 'Qwen 3.6 Plus',
    tool_call: true,
    limit: { context: 1000000, output: 65536 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },
  'qwen3.5-plus': {
    id: 'qwen3.5-plus',
    name: 'Qwen 3.5 Plus',
    tool_call: true,
    limit: { context: 1000000, output: 65536 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  },

  // HY3 Preview
  'hy3-preview': {
    id: 'hy3-preview',
    name: 'HY3 Preview',
    tool_call: false,
    limit: { context: 128000, output: 8192 },
    modalities: { input: ['text'], output: ['text'] },
  },
};
