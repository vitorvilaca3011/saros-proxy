/**
 * usage-switching.ts — Prototype for usage-based account switching
 *
 * QUESTION: Does token-based usage tracking with threshold switching feel right
 * for multi-account rotation? How should time windows (5h rolling/weekly/monthly) work?
 *
 * KEY FINDINGS FROM REAL API TESTING (June 4, 2026):
 * - OpenCode Go limits: $12/5h rolling, $30/weekly, $60/monthly
 * - Non-streaming: ✅ Full usage object (prompt_tokens, completion_tokens, total_tokens, cost)
 * - Streaming: ❌ NO usage chunk, even with stream_options.include_usage=true
 * - Streaming: ✅ Cost chunk at end: {"choices":[],"cost":"0"} (but always "0" within Go sub)
 * - Error on quota exhaustion: HTTP 429, error.type="GoUsageLimitError"
 *
 * IMPLICATION: We can only track usage for non-streaming requests.
 * For streaming, we'd need to estimate tokens from content or accept that
 * streaming usage won't count toward the threshold.
 *
 * Run with: npm run proto:usage
 */

/* ═══════════════════════════════════════════════════════════════════════
   PURE LOGIC MODULE — no I/O, no console, portable
   ═══════════════════════════════════════════════════════════════════════ */

export interface UsageWindow {
  used: number; // USD spent in this window
  limit: number; // USD limit for this window
  windowStart: number; // timestamp when window started
}

export interface KeyUsage {
  label: string;
  key: string;
  enabled: boolean;
  rolling5h: UsageWindow; // 5-hour rolling window ($12 limit)
  weekly: UsageWindow;
  monthly: UsageWindow;
  totalTokens: number; // lifetime tokens (for debugging)
  totalUsd: number; // lifetime USD (for debugging)
}

export interface UsageConfig {
  rolling5hLimit: number;
  weeklyLimit: number;
  monthlyLimit: number;
  switchThreshold: number; // 0.0-1.0, switch at this % of limit
  costPer1kTokens: number; // USD per 1k tokens (simplified average)
  rolling5hWindowMs: number;
  weeklyWindowMs: number;
  monthlyWindowMs: number;
}

export interface UsageState {
  keys: KeyUsage[];
  currentIndex: number;
  config: UsageConfig;
  now: number; // injectable clock for testing
}

const DEFAULT_CONFIG: UsageConfig = {
  rolling5hLimit: 12,
  weeklyLimit: 30,
  monthlyLimit: 60,
  switchThreshold: 0.5, // switch at 50%
  costPer1kTokens: 0.0136, // ~$0.0136 per 1k tokens (GLM-5.1 estimate)
  rolling5hWindowMs: 5 * 60 * 60 * 1000, // 5h ROLLING
  weeklyWindowMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  monthlyWindowMs: 30 * 24 * 60 * 60 * 1000, // 30 days
};

export function createUsageState(
  keys: Array<{ label: string; key: string }>,
  config: Partial<UsageConfig> = {},
): UsageState {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();
  return {
    keys: keys.map((k) => ({
      label: k.label,
      key: k.key,
      enabled: true,
      rolling5h: { used: 0, limit: cfg.rolling5hLimit, windowStart: now },
      weekly: { used: 0, limit: cfg.weeklyLimit, windowStart: now },
      monthly: { used: 0, limit: cfg.monthlyLimit, windowStart: now },
      totalTokens: 0,
      totalUsd: 0,
    })),
    currentIndex: 0,
    config: cfg,
    now,
  };
}

/**
 * Check if a window has expired and reset it if so.
 */
function maybeResetWindow(
  win: UsageWindow,
  windowMs: number,
  limit: number,
  now: number,
): void {
  if (now - win.windowStart >= windowMs) {
    win.used = 0;
    win.windowStart = now;
    win.limit = limit;
  }
}

/**
 * Reset all expired windows for a key.
 */
function resetExpiredWindows(key: KeyUsage, config: UsageConfig, now: number): void {
  maybeResetWindow(key.rolling5h, config.rolling5hWindowMs, config.rolling5hLimit, now);
  maybeResetWindow(key.weekly, config.weeklyWindowMs, config.weeklyLimit, now);
  maybeResetWindow(key.monthly, config.monthlyWindowMs, config.monthlyLimit, now);
}

/**
 * Check if a key has exceeded the switch threshold on any window.
 * Returns true if the key should be switched away from.
 */
export function isKeyOverThreshold(key: KeyUsage, config: UsageConfig): boolean {
  const threshold = config.switchThreshold;
  const rolling5hPct = key.rolling5h.used / key.rolling5h.limit;
  const weeklyPct = key.weekly.used / key.weekly.limit;
  const monthlyPct = key.monthly.used / key.monthly.limit;
  return rolling5hPct >= threshold || weeklyPct >= threshold || monthlyPct >= threshold;
}

/**
 * Select the next available key (not over threshold, enabled).
 * Returns null if all keys are over threshold or disabled.
 */
export function selectNextKey(state: UsageState): KeyUsage | null {
  const n = state.keys.length;
  if (n === 0) return null;

  // Reset expired windows for all keys first
  for (const key of state.keys) {
    resetExpiredWindows(key, state.config, state.now);
  }

  // Find next key not over threshold
  for (let i = 0; i < n; i++) {
    const idx = (state.currentIndex + i) % n;
    const key = state.keys[idx];
    if (key.enabled && !isKeyOverThreshold(key, state.config)) {
      state.currentIndex = (idx + 1) % n;
      return key;
    }
  }

  return null; // all keys over threshold or disabled
}

/**
 * Record token usage for a key after a request completes.
 * Converts tokens to USD and adds to all windows.
 */
export function recordUsage(
  state: UsageState,
  keyLabel: string,
  promptTokens: number,
  completionTokens: number,
): void {
  const key = state.keys.find((k) => k.label === keyLabel);
  if (!key) return;

  const totalTokens = promptTokens + completionTokens;
  const usd = (totalTokens / 1000) * state.config.costPer1kTokens;

  key.rolling5h.used += usd;
  key.weekly.used += usd;
  key.monthly.used += usd;
  key.totalTokens += totalTokens;
  key.totalUsd += usd;
}

/**
 * Get the usage percentage for a key (max of all windows).
 */
export function getKeyUsagePct(key: KeyUsage): number {
  const rolling5hPct = key.rolling5h.used / key.rolling5h.limit;
  const weeklyPct = key.weekly.used / key.weekly.limit;
  const monthlyPct = key.monthly.used / key.monthly.limit;
  return Math.max(rolling5hPct, weeklyPct, monthlyPct);
}

/**
 * Advance the clock (for testing window resets).
 */
export function advanceClock(state: UsageState, ms: number): void {
  state.now += ms;
}

/* ═══════════════════════════════════════════════════════════════════════
   TUI SHELL — interactive terminal app
   ═══════════════════════════════════════════════════════════════════════ */

const ANSI = {
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  CYAN: '\x1b[36m',
  RESET: '\x1b[0m',
  CLEAR: '\x1b[2J\x1b[H',
} as const;

const W = 70;
const IW = W - 2;

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function cl(text: string): string {
  const pad = IW - visibleLen(text);
  if (pad < 0) {
    const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
    return '║' + plain.slice(0, IW) + '║';
  }
  return '║' + text + ' '.repeat(pad) + '║';
}

function topBorder(): string {
  return '╔' + '═'.repeat(IW) + '╗';
}
function bottomBorder(): string {
  return '╚' + '═'.repeat(IW) + '╝';
}
function sepBorder(): string {
  return '╠' + '═'.repeat(IW) + '╣';
}
function emptyLine(): string {
  return '║' + ' '.repeat(IW) + '║';
}

function maskKey(key: string): string {
  if (key.length <= 8) return key;
  return key.slice(0, 4) + '...' + key.slice(-4);
}

function formatUsd(usd: number): string {
  return '$' + usd.toFixed(2);
}

function formatPct(pct: number): string {
  return (pct * 100).toFixed(1) + '%';
}

function progressBar(pct: number, width: number = 20): string {
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const color = pct >= 0.8 ? ANSI.RED : pct >= 0.5 ? ANSI.YELLOW : ANSI.GREEN;
  return color + bar + ANSI.RESET;
}

interface RenderState {
  state: UsageState;
  currentKeyLabel: string | null;
  statusLine: string;
}

function renderFrame(rs: RenderState): void {
  const { state, currentKeyLabel, statusLine } = rs;
  const lines: string[] = [ANSI.CLEAR];

  // Header
  lines.push(topBorder());
  lines.push(cl('  ' + ANSI.BOLD + 'Usage-Based Account Switching Prototype' + ANSI.RESET));
  lines.push(sepBorder());
  lines.push(emptyLine());

  // Config
  lines.push(cl(
    '  ' + ANSI.BOLD + 'Config:' + ANSI.RESET +
    '  5h Rolling=' + formatUsd(state.config.rolling5hLimit) +
    '  Weekly=' + formatUsd(state.config.weeklyLimit) +
    '  Monthly=' + formatUsd(state.config.monthlyLimit),
  ));
  lines.push(cl(
    '  ' + ANSI.BOLD + 'Switch at:' + ANSI.RESET +
    ' ' + formatPct(state.config.switchThreshold) +
    '  Cost/1k tokens: $' + state.config.costPer1kTokens.toFixed(4),
  ));
  lines.push(emptyLine());

  // Keys
  lines.push(cl('  ' + ANSI.BOLD + 'Keys:' + ANSI.RESET));
  lines.push(cl('  ' + ANSI.DIM + '─'.repeat(IW - 4) + ANSI.RESET));

  for (let i = 0; i < state.keys.length; i++) {
    const k = state.keys[i];
    const isCurrent = currentKeyLabel === k.label;
    const indicator = isCurrent ? '❯ ' : '  ';
    const pct = getKeyUsagePct(k);
    const overThreshold = isKeyOverThreshold(k, state.config);

    // Key name
    const nameStyle = overThreshold ? ANSI.RED : ANSI.GREEN;
    lines.push(cl(
      '  ' + indicator + nameStyle + '[' + i + '] ' + k.label + ANSI.RESET +
      '  ' + ANSI.DIM + maskKey(k.key) + ANSI.RESET,
    ));

    // Usage bars
    const rolling5hPct = k.rolling5h.used / k.rolling5h.limit;
    const weeklyPct = k.weekly.used / k.weekly.limit;
    const monthlyPct = k.monthly.used / k.monthly.limit;

    lines.push(cl(
      '      5h Roll:   ' + progressBar(rolling5hPct) +
      ' ' + formatUsd(k.rolling5h.used) + '/' + formatUsd(k.rolling5h.limit) +
      ' (' + formatPct(rolling5hPct) + ')',
    ));
    lines.push(cl(
      '      Weekly:  ' + progressBar(weeklyPct) +
      ' ' + formatUsd(k.weekly.used) + '/' + formatUsd(k.weekly.limit) +
      ' (' + formatPct(weeklyPct) + ')',
    ));
    lines.push(cl(
      '      Monthly: ' + progressBar(monthlyPct) +
      ' ' + formatUsd(k.monthly.used) + '/' + formatUsd(k.monthly.limit) +
      ' (' + formatPct(monthlyPct) + ')',
    ));

    // Totals
    lines.push(cl(
      '      ' + ANSI.DIM +
      'Total: ' + k.totalTokens.toLocaleString() + ' tokens, ' +
      formatUsd(k.totalUsd) + ANSI.RESET,
    ));

    if (i < state.keys.length - 1) {
      lines.push(cl('  ' + ANSI.DIM + '─'.repeat(IW - 4) + ANSI.RESET));
    }
  }

  lines.push(emptyLine());

  // Status
  if (statusLine) {
    lines.push(cl('  ' + ANSI.YELLOW + statusLine + ANSI.RESET));
    lines.push(emptyLine());
  }

  // Actions
  lines.push(cl(
    '  ' + ANSI.BOLD + '[s]' + ANSI.RESET + ' Select next  ' +
    ANSI.BOLD + '[u]' + ANSI.RESET + ' Simulate usage  ' +
    ANSI.BOLD + '[r]' + ANSI.RESET + ' Reset key',
  ));
  lines.push(cl(
    '  ' + ANSI.BOLD + '[t]' + ANSI.RESET + ' Advance 1h  ' +
    ANSI.BOLD + '[d]' + ANSI.RESET + ' Advance 5h  ' +
    ANSI.BOLD + '[q]' + ANSI.RESET + ' Quit',
  ));

  lines.push(bottomBorder());

  process.stdout.write(lines.join('\n'));
}

function findKey(state: UsageState, label: string | null): KeyUsage | null {
  if (!label) return null;
  return state.keys.find((k) => k.label === label) ?? null;
}

async function main(): Promise<void> {
  // Demo keys (hardcoded for prototype)
  const keys = [
    { label: 'account1', key: 'sk-abc123def456ghi789' },
    { label: 'account2', key: 'sk-xyz987uvw654rst321' },
    { label: 'account3', key: 'sk-mno111pqr222stu333' },
  ];

  const state = createUsageState(keys, {
    switchThreshold: 0.5, // switch at 50%
    costPer1kTokens: 0.0136,
  });

  const rs: RenderState = {
    state,
    currentKeyLabel: null,
    statusLine: 'Press [s] to select next key, [u] to simulate usage, [q] to quit.',
  };

  // Setup terminal
  if (!process.stdin.isTTY) {
    console.error('Error: stdin is not a TTY');
    process.exit(1);
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.on('SIGINT', () => {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\x1b[?25h');
    console.log();
    process.exit(0);
  });

  renderFrame(rs);

  for await (const chunk of process.stdin) {
    const buf = chunk as Buffer;
    const byte = buf[0];

    switch (byte) {
      case 0x03: // Ctrl+C
      case 0x71: // q
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\x1b[?25h\n');
        process.exit(0);
        break;

      case 0x73: { // s - select next
        const key = selectNextKey(state);
        if (key) {
          rs.currentKeyLabel = key.label;
          rs.statusLine = 'Selected: ' + key.label;
        } else {
          rs.currentKeyLabel = null;
          rs.statusLine = ANSI.RED + 'All keys over threshold or disabled!' + ANSI.RESET;
        }
        break;
      }

      case 0x75: { // u - simulate usage
        const key = findKey(state, rs.currentKeyLabel);
        if (!key) {
          rs.statusLine = 'No key selected — press [s] first.';
          break;
        }
        // Simulate a request with random token count (500-2000 tokens)
        const promptTokens = 500 + Math.floor(Math.random() * 1000);
        const completionTokens = 200 + Math.floor(Math.random() * 800);
        recordUsage(state, key.label, promptTokens, completionTokens);
        const totalTokens = promptTokens + completionTokens;
        const usd = (totalTokens / 1000) * state.config.costPer1kTokens;
        rs.statusLine =
          'Recorded ' + totalTokens + ' tokens (' +
          formatUsd(usd) + ') for ' + key.label;
        if (isKeyOverThreshold(key, state.config)) {
          rs.statusLine += ANSI.YELLOW + ' (now over threshold!)' + ANSI.RESET;
        }
        break;
      }

      case 0x72: { // r - reset key
        const key = findKey(state, rs.currentKeyLabel);
        if (!key) {
          rs.statusLine = 'No key selected — press [s] first.';
          break;
        }
        key.rolling5h.used = 0;
        key.weekly.used = 0;
        key.monthly.used = 0;
        rs.statusLine = 'Reset usage for ' + key.label;
        break;
      }

      case 0x74: // t - advance 1 hour
        advanceClock(state, 60 * 60 * 1000);
        rs.statusLine = 'Advanced clock by 1 hour';
        break;

      case 0x64: // d - advance 5 hours (resets rolling window)
        advanceClock(state, 5 * 60 * 60 * 1000);
        rs.statusLine = 'Advanced clock by 5 hours (5h rolling window reset)';
        break;

      case 0x64: // d - advance 1 day
        advanceClock(state, 24 * 60 * 60 * 1000);
        rs.statusLine = 'Advanced clock by 1 day (rolling5h window reset)';
        break;

      default:
        continue;
    }

    renderFrame(rs);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
