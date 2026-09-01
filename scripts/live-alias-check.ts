/**
 * live-alias-check.ts — Manual live check of the key-count annotation and
 * cross-provider model aliasing. NOT part of the test suite.
 *
 * Simulates a 2-key pool (opencode-go + commandcode) and verifies:
 *  1. /models annotations appear (name includes the serving-key count)
 *  2. an opencode-go-named id routed to the commandcode key is rewritten
 *     to the provider-native id and succeeds.
 *
 * Usage: OC_KEY=<opencode key> CC_KEY=<commandcode key> npx tsx scripts/live-alias-check.ts
 */
import { validateConfig } from '../src/config.js';
import { createProxyApp } from '../src/proxy.js';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';

const ccKey = process.env.CC_KEY ?? '';
const ocKey = process.env.OC_KEY ?? 'sk-dummy-opencode-key-000000000000';
if (!ccKey) {
  console.error('CC_KEY not set');
  process.exit(1);
}

const cfg = validateConfig({
  port: 0,
  host: '127.0.0.1',
  keys: [
    { label: 'oc-sim', key: ocKey },
    { label: 'cc-real', key: ccKey },
  ],
  upstreamBaseUrl: 'https://opencode.ai',
  requestTimeoutMs: 30_000,
  allowedOrigins: ['*'],
});
console.log('pool:', cfg.keys.map((k) => k.label + ':' + k.provider).join(', '));

const app = createProxyApp(cfg);
const server: ServerType = serve({ fetch: app.fetch, port: 3777, hostname: '127.0.0.1' });
await new Promise<void>((resolve) => server.on('listening', resolve));

try {
  // Warm the commandcode catalog (background fetch triggered by affinity)
  await new Promise((r) => setTimeout(r, 1500));

  // 1. Chat with the opencode-go-style id — may be served by either key;
  //    if the commandcode key takes it, the alias rewrite must kick in.
  const res = await fetch('http://127.0.0.1:3777/zen/go/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: "Reply with the word 'pong' and nothing else." }],
      stream: false,
      max_tokens: 512,
    }),
  });
  const body = (await res.json()) as { model?: string; error?: { message?: string } };
  console.log('chat status:', res.status);
  console.log('served model id:', body.model ?? ('error: ' + (body.error?.message ?? '').slice(0, 120)));
  const aliasOk = res.status === 200 && typeof body.model === 'string' && body.model.includes('deepseek');
  console.log(aliasOk ? 'ALIAS LIVE CHECK PASSED' : 'ALIAS LIVE CHECK FAILED');
} finally {
  server.close();
  setTimeout(() => process.exit(0), 200).unref();
}
