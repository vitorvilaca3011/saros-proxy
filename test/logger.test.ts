import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { maskKey } from '../src/logger.js';

// ---------------------------------------------------------------------------
// Mock pino so the mode decision is observable: createLogger() either passes a
// destination stream (human CLI mode) or leaves pino on its NDJSON stdout
// destination (daemon / production / SAROS_LOG_JSON=1). Logging is mocked, so
// these tests assert the options pino actually received, then drive the
// destination with a real NDJSON line.
// ---------------------------------------------------------------------------

vi.mock('pino', () => {
  const pino = vi.fn(
    (opts?: { level?: string }, stream?: { write: (line: string) => void }) => ({
      level: opts?.level ?? 'info',
      stream,
    }),
  );
  return { default: pino };
});

interface PinoCall {
  opts: { level?: string; redact?: { paths: string[]; censor: string } };
  destination?: { write: (line: string) => void };
}

/** Latest pino factory call — options plus the optional destination stream. */
async function latestPinoCall(): Promise<PinoCall> {
  const pinoMock = (await import('pino')).default as unknown as {
    mock: { calls: Array<[PinoCall['opts'], PinoCall['destination']?]> };
  };
  const [opts, destination] = pinoMock.mock.calls.at(-1)!;
  return { opts, destination };
}

// Dynamic import is the seam: createLogger() reads the environment at module
// evaluation time, so each case needs a fresh module graph (vi.resetModules).
async function importLogger() {
  vi.resetModules();
  return import('../src/logger.js');
}

function clearLogEnv(): void {
  delete process.env.NODE_ENV;
  delete process.env.SAROS_DAEMON;
  delete process.env.SAROS_LOG_JSON;
  delete process.env.LOG_LEVEL;
}

describe('maskKey', () => {
  it('returns **** for empty string', () => {
    expect(maskKey('')).toBe('****');
  });

  it('returns **** for short keys (< 4 chars)', () => {
    expect(maskKey('abc')).toBe('****');
  });

  it('masks sk- prefix keys', () => {
    expect(maskKey('sk-1mycDCRMaA8onfQmsRhvp')).toBe('sk-1...Rhvp');
  });

  it('masks key- prefix keys', () => {
    expect(maskKey('key-abcdefghijklmnop')).toBe('key-...mnop');
  });

  it('masks api- prefix keys', () => {
    expect(maskKey('api-abcdefghijklmnop')).toBe('api-...mnop');
  });

  it('masks token- prefix keys', () => {
    expect(maskKey('token-abcdefghijklmnop')).toBe('toke...mnop');
  });

  it('masks long keys without prefix (> 20 chars)', () => {
    expect(maskKey('abcdefghijklmnopqrstuv')).toBe('abcd...stuv');
  });

  it('shows short secret keys (<=12 chars) with **** suffix', () => {
    expect(maskKey('sk-12345678')).toBe('sk-1****');
  });

  it('does not mask short non-secret strings', () => {
    expect(maskKey('hello')).toBe('hello');
  });

  it('handles exactly 4 char keys', () => {
    expect(maskKey('sk-a')).toBe('sk-a****');
  });
});

describe('logger creation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    clearLogEnv();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('respects LOG_LEVEL env var', async () => {
    process.env.LOG_LEVEL = 'debug';
    const { logger } = await importLogger();
    expect(logger.level).toBe('debug');
    expect((await latestPinoCall()).opts.level).toBe('debug');
  });

  it('redacts credentials at the logger, not only at the call sites', async () => {
    process.env.NODE_ENV = 'production';
    const { LOG_REDACT_PATHS } = await importLogger();
    expect(LOG_REDACT_PATHS).toEqual(
      expect.arrayContaining(['authorization', 'cookie', 'x-api-key', 'apiKey']),
    );

    const { opts } = await latestPinoCall();
    expect(opts.redact?.censor).toBe('[redacted]');
    expect(opts.redact?.paths).toEqual([...LOG_REDACT_PATHS]);
  });

  it('uses default log level when LOG_LEVEL not set', async () => {
    process.env.NODE_ENV = 'production';
    const { logger } = await importLogger();
    expect(logger.level).toBe('info');
  });

  it.each([
    ['SAROS_DAEMON=1', { SAROS_DAEMON: '1' }],
    ['NODE_ENV=production', { NODE_ENV: 'production' }],
    ['SAROS_LOG_JSON=1', { SAROS_LOG_JSON: '1' }],
  ])('keeps NDJSON mode (no destination stream) for %s', async (_name, env) => {
    Object.assign(process.env, env);
    await importLogger();
    const { destination } = await latestPinoCall();
    expect(destination).toBeUndefined();
  });

  it('installs an in-process destination by default (human CLI mode)', async () => {
    await importLogger();
    const { destination } = await latestPinoCall();
    expect(destination).toBeDefined();
    expect(typeof destination!.write).toBe('function');
  });

  it('renders info records to stdout through the destination', async () => {
    await importLogger();
    const { destination } = await latestPinoCall();
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    destination!.write('{"level":30,"msg":"Loaded config from /tmp/c.yaml"}\n');

    expect(outSpy).toHaveBeenCalledWith(
      expect.stringContaining('Loaded config from /tmp/c.yaml'),
    );
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('sends warn records to stderr through the destination', async () => {
    await importLogger();
    const { destination } = await latestPinoCall();
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    destination!.write('{"level":40,"msg":"plaintext keys"}\n');

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('⚠'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('plaintext keys'));
    expect(outSpy).not.toHaveBeenCalled();
  });

  it('passes a line that is not NDJSON through untouched', async () => {
    await importLogger();
    const { destination } = await latestPinoCall();
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    destination!.write('not json at all\n');

    expect(outSpy).toHaveBeenCalledWith('not json at all\n');
  });
});
