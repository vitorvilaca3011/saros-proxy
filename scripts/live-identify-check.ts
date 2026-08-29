/**
 * live-identify-check.ts — Manual live validation of the key-identification
 * pipeline with a real key. NOT part of the test suite (hits real APIs).
 *
 * Usage: CC_KEY=<key> npx tsx scripts/live-identify-check.ts
 */
import { identifyKey, extractKeys } from '../src/providers/index.js';

const key = process.env.CC_KEY ?? '';
if (!key) {
  console.error('CC_KEY not set');
  process.exit(1);
}
console.log('key prefix:', key.slice(0, 5), 'length:', key.length);

// 1. Extraction from pasted text
const extracted = extractKeys('my key is ' + key + ' keep it safe');
console.log('extracted from pasted text:', extracted.length === 1 ? 'OK' : 'FAIL');

// 2. Full identification with real network probes
const t0 = Date.now();
const id = await identifyKey(key);
console.log('identifyKey:', JSON.stringify({ provider: id.provider, confidence: id.confidence }));
for (const a of id.attempts) {
  console.log('  attempt ' + a.provider + ': ' + a.status + (a.detail ? ' (' + a.detail + ')' : ''));
}
console.log('elapsed:', Date.now() - t0, 'ms');

// 3. Negative control: bogus key must be invalid
const neg = await identifyKey('user_boguskeynotreal1234567890abcdef');
console.log('negative control:', neg.confidence);

const ok = id.provider === 'commandcode' && id.confidence === 'verified' && neg.confidence === 'invalid';
console.log(ok ? 'LIVE CHECK PASSED' : 'LIVE CHECK FAILED');
process.exit(ok ? 0 : 1);
