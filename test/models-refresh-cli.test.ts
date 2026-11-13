/**
 * models-refresh-cli.test.ts — Exit-code contract of scripts/refresh-models.ts.
 *
 * The refresh itself is injected, so these tests never touch the network or
 * the real catalog. They pin the `--check` gate: drift exits 1, formatting-only
 * and up-to-date exit 0, conflicting flags exit 2, and a fetch failure stays a
 * failure instead of being reported as "up to date".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRefreshCli } from '../scripts/refresh-models.js';
import type {
  CatalogDrift,
  ModelCatalogRefreshResult,
  RefreshIo,
  RefreshOptions,
} from '../src/models-refresh.js';

const NO_DRIFT: CatalogDrift = {
  changed: false,
  formattingOnly: false,
  bytesChanged: false,
  added: [],
  removed: [],
  changedModels: [],
  nextContent: '{}\n',
};

function refreshResult(overrides: Partial<ModelCatalogRefreshResult> = {}): ModelCatalogRefreshResult {
  return {
    models: { alpha: { id: 'alpha' } },
    added: [],
    removed: [],
    changed: [],
    previousContent: null,
    nextContent: NO_DRIFT.nextContent,
    written: false,
    formattingOnly: false,
    drift: NO_DRIFT,
    ...overrides,
  };
}

type RefreshRunner = (
  io: RefreshIo,
  fetchers?: unknown,
  options?: RefreshOptions,
) => Promise<ModelCatalogRefreshResult>;

function runner(result: ModelCatalogRefreshResult) {
  return vi.fn<RefreshRunner>(async () => result);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('refresh-models CLI', () => {
  it('rejects --check with --dry-run before fetching or writing', async () => {
    const refresh = runner(refreshResult());
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await runRefreshCli(['--check', '--dry-run'], refresh);

    expect(code).toBe(2);
    expect(refresh).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/--check and --dry-run are different intents/),
    );
  });

  it('exits 1 when --check sees drift and runs as a dry run', async () => {
    const drift: CatalogDrift = {
      ...NO_DRIFT,
      changed: true,
      bytesChanged: true,
      added: ['beta'],
    };
    const refresh = runner(refreshResult({ added: ['beta'], drift }));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runRefreshCli(['--check'], refresh);

    expect(code).toBe(1);
    expect(refresh).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      { dryRun: true, allowShrink: false },
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/catalog is out of date/),
    );
  });

  it('exits 0 when --check sees a formatting-only difference', async () => {
    const drift: CatalogDrift = { ...NO_DRIFT, formattingOnly: true, bytesChanged: true };
    const refresh = runner(refreshResult({ formattingOnly: true, drift }));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runRefreshCli(['--check'], refresh);

    expect(code).toBe(0);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/only formatting would change/),
    );
  });

  it('exits 0 when --check finds the catalog up to date', async () => {
    const refresh = runner(refreshResult());
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runRefreshCli(['--check'], refresh);

    expect(code).toBe(0);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/assets\/models\.json is up to date/),
    );
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringMatching(/only formatting would change/),
    );
  });

  it('exits 1 when the fetch fails instead of claiming the catalog is current', async () => {
    const refresh = vi.fn<RefreshRunner>(async () => {
      throw new Error('models.dev returned HTTP 403');
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await runRefreshCli(['--check'], refresh);

    expect(code).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/HTTP 403; assets\/models\.json left untouched/),
    );
  });

  it('writes on a normal run and reports the outcome', async () => {
    const refresh = runner(refreshResult({
      written: true,
      drift: { ...NO_DRIFT, changed: true, bytesChanged: true, added: ['alpha'] },
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await runRefreshCli([], refresh);

    expect(code).toBe(0);
    expect(refresh).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      { dryRun: false, allowShrink: false },
    );
    expect(console.log).toHaveBeenCalledWith('wrote assets/models.json');
  });
});
