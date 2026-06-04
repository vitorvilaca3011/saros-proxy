/**
 * proxy-logic.ts — Pure logic module for Multi-Account OpenCode-Go Proxy
 *
 * No I/O, no console.log, no HTTP — completely portable and testable.
 */

export interface ApiKey {
  label: string;
  key: string;
  enabled: boolean;
  consecutiveFailures: number;
  lastUsed: number | null;
}

export interface ProxyState {
  keys: ApiKey[];
  currentIndex: number;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
}

/**
 * Initialize ProxyState from an array of key pairs.
 */
export function createProxyState(
  keys: Array<{ label: string; key: string }>,
): ProxyState {
  return {
    keys: keys.map((k) => ({
      label: k.label,
      key: k.key,
      enabled: true,
      consecutiveFailures: 0,
      lastUsed: null,
    })),
    currentIndex: 0,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 60_000,
  };
}

/**
 * Round-robin: pick the next enabled key.
 * Skips keys that have hit the circuit-breaker threshold.
 * Returns null when all keys are disabled.
 */
export function selectNextKey(state: ProxyState): ApiKey | null {
  const n = state.keys.length;
  if (n === 0) return null;

  for (let i = 0; i < n; i++) {
    const idx = (state.currentIndex + i) % n;
    const key = state.keys[idx];
    if (key.enabled && key.consecutiveFailures < state.circuitBreakerThreshold) {
      // Advance past the selected key for next call
      state.currentIndex = (idx + 1) % n;
      key.lastUsed = Date.now();
      return key;
    }
  }

  return null; // all keys are disabled
}

/**
 * Mark a key as failed. Increments consecutiveFailures; if the threshold
 * is hit, the key is automatically disabled.
 */
export function markKeyFailed(state: ProxyState, keyLabel: string): void {
  const key = state.keys.find((k) => k.label === keyLabel);
  if (!key) return;
  key.consecutiveFailures++;
  if (key.consecutiveFailures >= state.circuitBreakerThreshold) {
    key.enabled = false;
  }
}

/**
 * Mark a key as succeeded. Resets consecutive failures to 0.
 */
export function markKeySucceeded(state: ProxyState, keyLabel: string): void {
  const key = state.keys.find((k) => k.label === keyLabel);
  if (!key) return;
  key.consecutiveFailures = 0;
}

/**
 * Check whether a key is currently disabled.
 * Returns true if the key does not exist, is explicitly disabled, or
 * has reached the circuit-breaker threshold.
 */
export function isKeyDisabled(state: ProxyState, keyLabel: string): boolean {
  const key = state.keys.find((k) => k.label === keyLabel);
  if (!key) return true;
  return !key.enabled || key.consecutiveFailures >= state.circuitBreakerThreshold;
}

/**
 * Re-enable a disabled key and reset its consecutive failures.
 */
export function reenableKey(state: ProxyState, keyLabel: string): void {
  const key = state.keys.find((k) => k.label === keyLabel);
  if (!key) return;
  key.enabled = true;
  key.consecutiveFailures = 0;
}

/**
 * Return a plain-text state summary (no ANSI codes).
 */
export function getStateSummary(state: ProxyState): string {
  const lines: string[] = [
    `Proxy State Summary`,
    `Current Index: ${state.currentIndex}`,
    `Circuit Breaker: ${state.circuitBreakerThreshold} failures / ${state.circuitBreakerCooldownMs}ms cooldown`,
    `Keys:`,
  ];
  for (const k of state.keys) {
    const status = k.enabled ? 'enabled' : 'disabled';
    const last = k.lastUsed ? new Date(k.lastUsed).toISOString() : 'never';
    const idx = state.keys.indexOf(k);
    lines.push(
      `  [${idx}] ${k.label} (${status}) failures=${k.consecutiveFailures} last=${last}`,
    );
  }
  return lines.join('\n');
}
