import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../src/log-redact.js';

describe('redactSecrets', () => {
  it('masks provider key shapes inside an upstream error body', () => {
    const body = '{"error":"Incorrect API key provided: sk-live-abcdef123456"}';
    const out = redactSecrets(body);
    expect(out).toContain('[redacted-key]');
    expect(out).not.toContain('sk-live-abcdef123456');
  });

  it('masks oc_sk_ and user_ keys', () => {
    expect(redactSecrets('oc_sk_9f8e7d6c5b4a')).not.toContain('oc_sk_9f8e7d6c5b4a');
    expect(redactSecrets('user_cc_9876543210abc')).not.toContain('user_cc_9876543210abc');
  });

  it('masks bearer tokens in any casing', () => {
    const out = redactSecrets('Authorization: BEARER abcDEF123456');
    expect(out).toContain('Bearer [redacted]');
    expect(out).not.toContain('abcDEF123456');
  });

  it('leaves ordinary text untouched', () => {
    const body = '{"error":"quota exceeded for this billing period"}';
    expect(redactSecrets(body)).toBe(body);
  });
});
