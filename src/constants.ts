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
  // GLM series (Z.AI/Zhipu - 200K context, 128K output, text-only)
  'glm-5': {
    id: 'glm-5',
    name: 'GLM-5',
    tool_call: true,
    reasoning: true,
    limit: { context: 200000, output: 131072 },
    modalities: { input: ['text'], output: ['text'] },
    variants: {
      none: { thinking: { type: 'disabled' } },
      default: { thinking: { type: 'enabled' } },
    },
  },
  'glm-5.1': {
    id: 'glm-5.1',
    name: 'GLM-5.1',
    tool_call: true,
    reasoning: true,
    limit: { context: 200000, output: 131072 },
    modalities: { input: ['text'], output: ['text'] },
    variants: {
      none: { thinking: { type: 'disabled' } },
      default: { thinking: { type: 'enabled' } },
    },
  },

  // Kimi series (Moonshot - 256K context, dynamic output up to 256K)
  'kimi-k2.5': {
    id: 'kimi-k2.5',
    name: 'Kimi K2.5',
    tool_call: true,
    reasoning: true,
    limit: { context: 256000, output: 256000 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: {
      none: { thinking: { type: 'disabled' } },
      default: { thinking: { type: 'enabled' } },
    },
  },
  'kimi-k2.6': {
    id: 'kimi-k2.6',
    name: 'Kimi K2.6',
    tool_call: true,
    reasoning: true,
    limit: { context: 256000, output: 256000 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: {
      none: { thinking: { type: 'disabled' } },
      default: { thinking: { type: 'enabled' } },
    },
  },

  // DeepSeek V4 series (1M context, 384K output, text-only)
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    tool_call: true,
    reasoning: true,
    limit: { context: 1000000, output: 384000 },
    modalities: { input: ['text'], output: ['text'] },
    variants: {
      none: { thinking: { type: 'disabled' } },
      high: { thinking: { type: 'enabled' }, reasoningEffort: 'high' },
      max: { thinking: { type: 'enabled' }, reasoningEffort: 'max' },
    },
  },
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    tool_call: true,
    reasoning: true,
    limit: { context: 1000000, output: 384000 },
    modalities: { input: ['text'], output: ['text'] },
    variants: {
      none: { thinking: { type: 'disabled' } },
      high: { thinking: { type: 'enabled' }, reasoningEffort: 'high' },
      max: { thinking: { type: 'enabled' }, reasoningEffort: 'max' },
    },
  },

  // MiMo series (Xiaomi - 1M context except V2 Omni 256K)
  'mimo-v2.5': {
    id: 'mimo-v2.5',
    name: 'MiMo V2.5',
    tool_call: true,
    reasoning: true,
    limit: { context: 1000000, output: 128000 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: {
      none: { thinking: { type: 'disabled' } },
      default: { thinking: { type: 'enabled' } },
    },
  },
  'mimo-v2.5-pro': {
    id: 'mimo-v2.5-pro',
    name: 'MiMo V2.5 Pro',
    tool_call: true,
    reasoning: true,
    limit: { context: 1000000, output: 128000 },
    modalities: { input: ['text'], output: ['text'] },
    variants: {
      none: { thinking: { type: 'disabled' } },
      default: { thinking: { type: 'enabled' } },
    },
  },
  'mimo-v2-pro': {
    id: 'mimo-v2-pro',
    name: 'MiMo V2 Pro',
    tool_call: true,
    reasoning: true,
    limit: { context: 1000000, output: 128000 },
    modalities: { input: ['text'], output: ['text'] },
    variants: {
      none: { thinking: { type: 'disabled' } },
      default: { thinking: { type: 'enabled' } },
    },
  },
  'mimo-v2-omni': {
    id: 'mimo-v2-omni',
    name: 'MiMo V2 Omni',
    tool_call: true,
    reasoning: true,
    limit: { context: 256000, output: 128000 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: {
      none: { thinking: { type: 'disabled' } },
      default: { thinking: { type: 'enabled' } },
    },
  },

  // MiniMax series (1M context for M3, 200K for M2.x)
  'minimax-m3': {
    id: 'minimax-m3',
    name: 'MiniMax M3',
    tool_call: true,
    reasoning: true,
    limit: { context: 1000000, output: 524288 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: {
      none: { thinking: { type: 'disabled' } },
      default: { thinking: { type: 'adaptive' } },
    },
  },
  'minimax-m2.7': {
    id: 'minimax-m2.7',
    name: 'MiniMax M2.7',
    tool_call: true,
    reasoning: true,
    limit: { context: 200000, output: 200000 },
    modalities: { input: ['text'], output: ['text'] },
  },
  'minimax-m2.5': {
    id: 'minimax-m2.5',
    name: 'MiniMax M2.5',
    tool_call: true,
    reasoning: true,
    limit: { context: 200000, output: 200000 },
    modalities: { input: ['text'], output: ['text'] },
  },

  // Qwen series (Alibaba - all 1M context, 64K output)
  'qwen3.7-max': {
    id: 'qwen3.7-max',
    name: 'Qwen 3.7 Max',
    tool_call: true,
    reasoning: true,
    limit: { context: 1000000, output: 65536 },
    modalities: { input: ['text'], output: ['text'] },
    variants: {
      none: { enable_thinking: false },
      default: { enable_thinking: true, thinking_budget: 256000 },
    },
  },
  'qwen3.7-plus': {
    id: 'qwen3.7-plus',
    name: 'Qwen 3.7 Plus',
    tool_call: true,
    reasoning: true,
    limit: { context: 1000000, output: 65536 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: {
      none: { enable_thinking: false },
      default: { enable_thinking: true, thinking_budget: 80000 },
    },
  },
  'qwen3.6-plus': {
    id: 'qwen3.6-plus',
    name: 'Qwen 3.6 Plus',
    tool_call: true,
    reasoning: true,
    limit: { context: 1000000, output: 65536 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: {
      none: { enable_thinking: false },
      default: { enable_thinking: true, thinking_budget: 80000 },
    },
  },
  'qwen3.5-plus': {
    id: 'qwen3.5-plus',
    name: 'Qwen 3.5 Plus',
    tool_call: true,
    reasoning: true,
    limit: { context: 1000000, output: 65536 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: {
      none: { enable_thinking: false },
      default: { enable_thinking: true, thinking_budget: 80000 },
    },
  },

  // HY3 Preview (Tencent - 256K context, 128K output)
  'hy3-preview': {
    id: 'hy3-preview',
    name: 'HY3 Preview',
    tool_call: true,
    reasoning: true,
    limit: { context: 262144, output: 131072 },
    modalities: { input: ['text'], output: ['text'] },
    variants: {
      no_think: { chat_template_kwargs: { reasoning_effort: 'no_think' } },
      low: { chat_template_kwargs: { reasoning_effort: 'low' } },
      high: { chat_template_kwargs: { reasoning_effort: 'high' } },
    },
  },
};
