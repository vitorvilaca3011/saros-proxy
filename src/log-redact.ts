/**
 * log-redact.ts — Strip credential-shaped substrings from text that is about to
 * be logged or echoed back to a client.
 *
 * Upstream error bodies are the risk: OpenAI-style APIs answer a bad key with
 * "Incorrect API key provided: sk-abc…", which would put a working key into
 * `daemon.log` (now a durable file) or into a 503 body. Redaction is pattern
 * based and deliberately conservative — it can only remove, never add.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Bearer tokens in any casing.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer [redacted]'],
  // Provider key shapes used by saros: sk-…, oc_sk_…, user_… .
  [/\b(?:sk-|oc_sk_|user_)[A-Za-z0-9._-]{4,}/g, '[redacted-key]'],
];

/** Mask credential-looking substrings in a free-form string. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
