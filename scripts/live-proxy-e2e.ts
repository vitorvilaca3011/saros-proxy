/**
 * live-proxy-e2e.ts — Manual live E2E: start the real proxy with a real
 * commandcode key, send a chat completion through it, verify the response.
 * NOT part of the test suite (real network + token spend of 1 token).
 *
 * Usage: CC_KEY=<key> npx tsx scripts/live-proxy-e2e.ts
 */
import { validateConfig } from '../src/config.js';
import { createProxyApp } from '../src/proxy.js';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';

const key = process.env.CC_KEY ?? '';
if (!key) {
  console.error('CC_KEY not set');
  process.exit(1);
}

// Config with one commandcode key (provider inferred from user_ prefix)
const cfg = validateConfig({
  port: 0,
  host: '127.0.0.1',
  keys: [{ label: 'live-cc', key }],
  upstreamBaseUrl: 'https://opencode.ai',
  requestTimeoutMs: 30_000,
  allowedOrigins: ['*'],
});
console.log('config keys:', cfg.keys.map((k) => ({ label: k.label, provider: k.provider })));

const app = createProxyApp(cfg);
const server: ServerType = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise<void>((resolve) => server.on('listening', resolve));
const addr = server.address();
if (!addr || typeof addr === 'string') throw new Error('no address');
const port = addr.port;
console.log('proxy listening on', port);

try {
  // Canonical saros route: client speaks /zen/go/v1/*; proxy remaps to
  // /provider/v1/* upstream for commandcode keys.
  const res = await fetch(`http://127.0.0.1:${port}/zen/go/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: "Reply with the word 'pong' and nothing else." }],
      stream: false,
      max_tokens: 512,
    }),
  });
  const body = await res.text();
  console.log('status:', res.status);
  console.log('x-proxy-key-label:', res.headers.get('x-proxy-key-label'));
  console.log('raw body:', body.slice(0, 500));
  let content = '';
  try {
    const parsed = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }>; error?: unknown };
    content = parsed.choices?.[0]?.message?.content ?? JSON.stringify(parsed).slice(0, 300);
  } catch {
    content = body.slice(0, 300);
  }
  console.log('response content:', content.slice(0, 120));
  const ok = res.status === 200 && /pong/i.test(content);
  console.log(ok ? 'LIVE PROXY E2E PASSED' : 'LIVE PROXY E2E FAILED');

  // --- Streaming check (SSE through the proxy) ---
  const sres = await fetch(`http://127.0.0.1:${port}/zen/go/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: "Reply with the word 'pong' and nothing else." }],
      stream: true,
      max_tokens: 512,
    }),
  });
  console.log('stream status:', sres.status, sres.headers.get('content-type'));
  let sawPong = false;
  let sawDone = false;
  let allChunks = '';
  if (sres.body) {
    const reader = sres.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      allChunks += chunk;
      if (chunk.includes('pong')) sawPong = true;
      if (chunk.includes('[DONE]')) sawDone = true;
    }
  }
  console.log('stream bytes:', allChunks.length);
  // Assemble reasoning+content across chunk boundaries and search there
  let assembled = '';
  for (const m of allChunks.matchAll(/"(?:reasoning|content)":"((?:[^"\\]|\\.)*)"/g)) {
    assembled += m[1];
  }
  sawPong = /pong/i.test(assembled);
  console.log('assembled text:', assembled.slice(0, 120));
  console.log('stream saw pong:', sawPong, '| saw [DONE]:', sawDone);
  const streamOk = sres.status === 200 && sawPong;
  console.log(streamOk ? 'LIVE STREAMING E2E PASSED' : 'LIVE STREAMING E2E FAILED');
  process.exit(ok && streamOk ? 0 : 1);
} finally {
  server.close();
  setTimeout(() => process.exit(0), 200).unref();
}
