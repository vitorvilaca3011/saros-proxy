/**
 * prototype.ts — Interactive TUI for the Multi-Account OpenCode-Go Proxy
 *
 * Loads keys from api_keys.txt, initialises ProxyState, and provides a
 * keyboard-driven UI to rotate keys, simulate failures, run a real API
 * test, and inspect state.
 *
 * Run with: npm run prototype
 */

import { readFileSync } from 'node:fs';
import {
  createProxyState,
  selectNextKey,
  markKeyFailed,
  markKeySucceeded,
  reenableKey,
  isKeyDisabled,
  type ProxyState,
  type ApiKey,
} from './proxy-logic.js';

/* ── ANSI escape helpers ───────────────────────────────────────────── */

const ANSI = {
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  RESET: '\x1b[0m',
  CLEAR: '\x1b[2J\x1b[H',
} as const;

/* ── Frame geometry ────────────────────────────────────────────────── */

const W = 58; // total frame width (including border chars)
const IW = W - 2; // inner width between ║ characters  (56)
const BOX_CW = 50; // content width inside inner │ … │ box

/** Mask an API key: show first 4 and last 4 characters only. */
function maskKey(key: string): string {
  if (key.length <= 8) return key;
  return key.slice(0, 4) + '...' + key.slice(-4);
}

/** Measure visible length of a string (ignoring ANSI codes). */
function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Right-pad a string (which may contain ANSI codes) to a given visible width. */
function padTo(s: string, width: number): string {
  const len = visibleLen(s);
  if (len >= width) return s;
  return s + ' '.repeat(width - len);
}

/** Build a content line: ║ + text (padded to IW) + ║ */
function cl(text: string): string {
  const pad = IW - visibleLen(text);
  if (pad < 0) {
    // Truncate visible part if somehow too long
    const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
    return '║' + plain.slice(0, IW) + '║';
  }
  return '║' + text + ' '.repeat(pad) + '║';
}

/* ── Frame parts ───────────────────────────────────────────────────── */

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

/** Frame-level helper for inner-box top/sep/bottom lines. */
function boxLine(ch: string): string {
  return cl('  ' + ch + '─'.repeat(BOX_CW) + ch + '  ');
}
function boxTop(): string {
  return boxLine('┌');
}
function boxSep(): string {
  return boxLine('├');
}
function boxBottom(): string {
  return boxLine('└');
}

/** Build a content line inside the key box: ║  │content│  ║ */
function boxContentLine(content: string): string {
  return cl('  │' + padTo(content, BOX_CW) + '│  ');
}

/* ── Status / helpers ──────────────────────────────────────────────── */

/** Find the first disabled key (if any). */
function firstDisabledKey(state: ProxyState): ApiKey | undefined {
  return state.keys.find((k) => !k.enabled);
}

/** Find a key by label safely. */
function findKey(state: ProxyState, label: string | null): ApiKey | undefined {
  if (!label) return undefined;
  return state.keys.find((k) => k.label === label);
}

/* ── Render ────────────────────────────────────────────────────────── */

interface RenderState {
  state: ProxyState;
  currentKeyLabel: string | null;
  statusLine: string;
}

function renderFrame(rs: RenderState): void {
  const { state, currentKeyLabel, statusLine } = rs;
  const lines: string[] = [ANSI.CLEAR];

  // ── Header ────────────────────────────────────────────────
  lines.push(topBorder());
  lines.push(cl('  ' + ANSI.BOLD + 'OpenCode-Go Proxy Prototype' + ANSI.RESET + '  '));
  lines.push(sepBorder());
  lines.push(emptyLine());

  // ── Config info ───────────────────────────────────────────
  lines.push(cl(
    '  ' + ANSI.BOLD + 'Current Index:' + ANSI.RESET +
    ' ' + state.currentIndex,
  ));
  lines.push(cl(
    '  ' + ANSI.BOLD + 'Circuit Breaker:' + ANSI.RESET +
    ' ' + state.circuitBreakerThreshold + ' failures / ' +
    (state.circuitBreakerCooldownMs / 1000) + 's cooldown',
  ));
  lines.push(emptyLine());

  // ── Key box ───────────────────────────────────────────────
  lines.push(cl('  ' + ANSI.BOLD + 'Keys:' + ANSI.RESET + '  '));
  lines.push(boxTop());

  for (let i = 0; i < state.keys.length; i++) {
    const k = state.keys[i];

    // Separator between keys
    if (i > 0) {
      lines.push(boxSep());
    }

    const isCurrent = currentKeyLabel === k.label;
    const indicator = isCurrent ? '❯ ' : '  ';

    // Line 1: key name
    const labelStyle = k.enabled ? ANSI.GREEN : ANSI.RED;
    const nameContent = padTo(
      indicator + labelStyle + '[' + i + '] ' + k.label + ANSI.RESET,
      BOX_CW,
    );
    lines.push(boxContentLine(nameContent));

    // Line 2: masked key
    const keyContent = padTo(
      '    ' + ANSI.DIM + 'Key: ' + maskKey(k.key) + ' (masked)' + ANSI.RESET,
      BOX_CW,
    );
    lines.push(boxContentLine(keyContent));

    // Line 3: status
    const checkStyle = k.enabled ? ANSI.GREEN : ANSI.RED;
    const lastUsedRaw = k.lastUsed
      ? new Date(k.lastUsed).toLocaleTimeString()
      : 'never';
    const lastUsedStyled = k.lastUsed ? lastUsedRaw : ANSI.DIM + 'never' + ANSI.RESET;
    const statusContent = padTo(
      '    ' +
        checkStyle + 'Enabled: ' + (k.enabled ? '✓' : '✗') + ANSI.RESET +
        '  ' + ANSI.BOLD + 'Failures:' + ANSI.RESET + ' ' + k.consecutiveFailures +
        '  ' + ANSI.BOLD + 'Last Used:' + ANSI.RESET + ' ' + lastUsedStyled,
      BOX_CW,
    );
    lines.push(boxContentLine(statusContent));
  }

  lines.push(boxBottom());
  lines.push(emptyLine());

  // ── Status line ───────────────────────────────────────────
  if (statusLine) {
    lines.push(cl('  ' + ANSI.YELLOW + statusLine + ANSI.RESET + '  '));
    lines.push(emptyLine());
  }

  // ── Action bar ────────────────────────────────────────────
  lines.push(cl(
    '  ' + ANSI.BOLD + '[s]' + ANSI.RESET + ' Select next  ' +
    ANSI.BOLD + '[f]' + ANSI.RESET + ' Fail  ' +
    ANSI.BOLD + '[o]' + ANSI.RESET + ' OK  ' +
    ANSI.BOLD + '[r]' + ANSI.RESET + ' Re-enable  ',
  ));
  lines.push(cl(
    '  ' + ANSI.BOLD + '[t]' + ANSI.RESET + ' Test API  ' +
    ANSI.BOLD + '[q]' + ANSI.RESET + ' Quit' +
    '                                      ',
  ));

  // ── Footer ────────────────────────────────────────────────
  lines.push(bottomBorder());

  process.stdout.write(lines.join('\n'));
}

/* ── Key handlers ──────────────────────────────────────────────────── */

async function handleS(
  rs: RenderState,
): Promise<void> {
  const key = selectNextKey(rs.state);
  if (key) {
    rs.currentKeyLabel = key.label;
    rs.statusLine = 'Selected key: ' + rs.currentKeyLabel;
  } else {
    rs.currentKeyLabel = null;
    rs.statusLine = ANSI.RED + 'No enabled keys available!' + ANSI.RESET;
  }
}

function handleF(rs: RenderState): void {
  const key = findKey(rs.state, rs.currentKeyLabel);
  if (!key) {
    rs.statusLine = 'No key selected — press [s] first.';
    return;
  }
  markKeyFailed(rs.state, key.label);
  if (!key.enabled) {
    rs.statusLine =
      'Key "' + key.label + '" failed — ' +
      'circuit breaker OPEN after ' + rs.state.circuitBreakerThreshold + ' failures.';
  } else {
    rs.statusLine =
      'Key "' + key.label + '" failed (' +
      key.consecutiveFailures + '/' + rs.state.circuitBreakerThreshold + ').';
  }
}

function handleO(rs: RenderState): void {
  const key = findKey(rs.state, rs.currentKeyLabel);
  if (!key) {
    rs.statusLine = 'No key selected — press [s] first.';
    return;
  }
  markKeySucceeded(rs.state, key.label);
  rs.statusLine = 'Key "' + key.label + '" succeeded — failures reset to 0.';
}

function handleR(rs: RenderState): void {
  const disabled = firstDisabledKey(rs.state);
  if (!disabled) {
    rs.statusLine = 'No disabled keys to re-enable.';
    return;
  }
  reenableKey(rs.state, disabled.label);
  rs.statusLine =
    'Re-enabled key "' + disabled.label + '".';
}

async function handleT(rs: RenderState): Promise<void> {
  // Auto-select a key if none is currently selected
  let key = findKey(rs.state, rs.currentKeyLabel);
  if (!key || isKeyDisabled(rs.state, key.label)) {
    const next = selectNextKey(rs.state);
    if (!next) {
      rs.statusLine = 'Cannot test — ' + ANSI.RED + 'all keys disabled.' + ANSI.RESET;
      return;
    }
    rs.currentKeyLabel = next.label;
    key = next;
  }

  rs.statusLine = 'Testing API with key "' + key.label + '"…';
  renderFrame(rs); // Show "Testing…" before blocking

  try {
    const response = await fetch(
      'https://opencode.ai/zen/go/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + key.key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'glm-5',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
        }),
      },
    );

    const body = await response.text();
    const preview = body.length > 100 ? body.slice(0, 100) + '…' : body;

    if (response.ok) {
      markKeySucceeded(rs.state, key.label);
      rs.statusLine =
        ANSI.GREEN + 'API OK [' + response.status + ']' + ANSI.RESET +
        ' — ' + preview;
    } else {
      markKeyFailed(rs.state, key.label);
      const color = response.status === 429 || response.status >= 500
        ? ANSI.RED
        : ANSI.YELLOW;
      rs.statusLine =
        color + 'API ' + response.status + ANSI.RESET +
        ' — ' + preview;
    }
  } catch (err: unknown) {
    markKeyFailed(rs.state, key.label);
    const msg = err instanceof Error ? err.message : String(err);
    rs.statusLine = ANSI.RED + 'API Error:' + ANSI.RESET + ' ' + msg;
  }
}

function handleQ(rs: RenderState): void {
  rs.statusLine = 'Quitting…';
  renderFrame(rs);
  cleanup();
  process.exit(0);
}

/* ── Lifecycle ─────────────────────────────────────────────────────── */

function cleanup(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
  process.stdout.write('\x1b[?25h'); // show cursor
  console.log(); // newline after last frame
}

function setupRawStdin(): void {
  if (!process.stdin.isTTY) {
    console.error('Error: stdin is not a TTY — this prototype requires an interactive terminal.');
    process.exit(1);
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
}

/* ── Load keys ─────────────────────────────────────────────────────── */

interface KeyEntry {
  label: string;
  key: string;
}

function loadKeys(filePath: string): KeyEntry[] {
  let raw = '';
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    console.error('Error: could not read ' + filePath);
    process.exit(1);
  }

  const entries: KeyEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sepIndex = trimmed.indexOf(' - ');
    if (sepIndex === -1) continue;
    const label = trimmed.slice(0, sepIndex).trim();
    const key = trimmed.slice(sepIndex + 3).trim();
    if (label && key) {
      entries.push({ label, key });
    }
  }

  if (entries.length === 0) {
    console.error('Error: no valid API keys found in ' + filePath);
    console.error('Expected format per line: label - sk-...');
    process.exit(1);
  }

  return entries;
}

/* ── Main ──────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  // Load and initialise
  const keys = loadKeys('api_keys.txt');
  const state = createProxyState(keys);
  const rs: RenderState = {
    state,
    currentKeyLabel: null,
    statusLine: 'Press [s] to select a key, [t] to test the API, [q] to quit.',
  };

  // Set up terminal
  setupRawStdin();
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  // Render initial frame
  renderFrame(rs);

  // Dispatch keystrokes
  for await (const chunk of process.stdin) {
    const buf = chunk as Buffer;
    const byte = buf[0];

    switch (byte) {
      case 0x03: // Ctrl+C
        handleQ(rs);
        break;
      case 0x71: // q
        handleQ(rs);
        break;
      case 0x73: // s
        await handleS(rs);
        break;
      case 0x66: // f
        handleF(rs);
        break;
      case 0x6f: // o
        handleO(rs);
        break;
      case 0x72: // r
        handleR(rs);
        break;
      case 0x74: // t
        await handleT(rs);
        break;
      default:
        // Ignore unknown keys
        continue;
    }

    renderFrame(rs);
  }
}

main().catch((err) => {
  cleanup();
  console.error('Fatal error:', err);
  process.exit(1);
});
