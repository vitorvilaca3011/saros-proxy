/**
 * live-model.e2e.test.ts — Optional live E2E against the REAL upstream API
 * with a real model running.
 *
 * Skipped unless explicitly enabled:
 *
 *   SAROS_LIVE_E2E=1 \
 *   SAROS_LIVE_API_KEY=sk-... \
 *   [SAROS_LIVE_SECOND_KEY=sk-...] \
 *   [SAROS_LIVE_MODEL=ox-alpha-free] \
 *   [SAROS_LIVE_UPSTREAM=https://opencode.ai] \
 *   npx vitest run test/live-model.e2e.test.ts
 *
 * Never runs in CI (no secret configured) and never runs as part of the
 * default suite. Costs exactly one tiny model call when executed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENABLED = process.env.SAROS_LIVE_E2E === '1' && !!process.env.SAROS_LIVE_API_KEY;
const MODEL = process.env.SAROS_LIVE_MODEL ?? 'ox-alpha-free';
const UPSTREAM = process.env.SAROS_LIVE_UPSTREAM ?? 'https://opencode.ai';

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: 'ignore', windowsHide: true });
    } catch { /* already gone */ }
  } else {
    child.kill('SIGKILL');
  }
}

async function removeTempDir(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

describe.skipIf(!ENABLED)('live model e2e (real upstream)', () => {
  let workDir: string;
  let logPath: string;
  let child: ChildProcess | undefined;
  let port: number;

  beforeAll(async () => {
    if (!existsSync(join(REPO_ROOT, 'dist', 'index.js'))) {
      throw new Error('dist/index.js missing — run via `npm run test:model-e2e` first');
    }
    workDir = mkdtempSync(join(tmpdir(), 'saros-live-e2e-'));
    mkdirSync(join(workDir, 'home', '.config'), { recursive: true });
    logPath = join(workDir, 'proxy.log');

    port = 31077;
    const keys = [{ label: 'live-1', key: process.env.SAROS_LIVE_API_KEY! }];
    if (process.env.SAROS_LIVE_SECOND_KEY) {
      keys.push({ label: 'live-2', key: process.env.SAROS_LIVE_SECOND_KEY });
    }
    writeFileSync(join(workDir, 'config.yaml'), stringifyYaml({
      port,
      host: '127.0.0.1',
      upstreamBaseUrl: UPSTREAM,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 5_000,
      requestTimeoutMs: 60_000,
      allowedOrigins: ['http://localhost:*'],
      keys,
    }), 'utf-8');

    const out = openSync(logPath, 'a');
    child = spawn(process.execPath, [
      join(REPO_ROOT, 'dist', 'index.js'), 'serve', '--config', join(workDir, 'config.yaml'),
    ], {
      cwd: REPO_ROOT,
      stdio: ['ignore', out, out],
      env: { ...process.env, XDG_CONFIG_HOME: join(workDir, 'home', '.config') },
      windowsHide: true,
    });

    // Wait for readiness before the paid request.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if ((await res.json() as { status?: string }).status === 'ok') return;
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`proxy not healthy; log:\n${readFileSync(logPath, 'utf-8')}`);
  }, 60_000);

  afterAll(async () => {
    if (child) killProcessTree(child);
    await removeTempDir(workDir);
  });

  it(`completes a real ${MODEL} call through the proxy`, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 200,
      }),
    });
    if (res.status !== 200) {
      throw new Error(`status ${res.status}; proxy log:\n${readFileSync(logPath, 'utf-8')}`);
    }
    expect(res.headers.get('x-proxy-key-label')).toBeTruthy();

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    expect(data.choices?.[0]?.finish_reason).toBe('stop');
    expect((data.choices?.[0]?.message?.content ?? '').toLowerCase()).toContain('ok');
  }, 120_000);
});
