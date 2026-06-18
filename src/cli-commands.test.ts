/**
 * cli-commands.test.ts — Integration tests for CLI subcommands.
 *
 * Tests the top-level dispatch in index.ts by mocking dependencies
 * and re-evaluating the module with different process.argv values.
 * Uses vi.resetModules() to force fresh module evaluation per test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock all dependencies of index.ts
// ---------------------------------------------------------------------------

const mockLoadConfig = vi.hoisted(() => vi.fn());
const mockSyncUpstream = vi.hoisted(() => vi.fn());
const mockGetModelsFromConfig = vi.hoisted(() => vi.fn());
const mockProbeModel = vi.hoisted(() => vi.fn());
const mockGetCachedProbe = vi.hoisted(() => vi.fn());
const mockSetCachedProbe = vi.hoisted(() => vi.fn());
const mockDaemonStart = vi.hoisted(() => vi.fn());
const mockDaemonStop = vi.hoisted(() => vi.fn());
const mockDaemonStatus = vi.hoisted(() => vi.fn());
const mockDaemonRestart = vi.hoisted(() => vi.fn());
const mockSyncModels = vi.hoisted(() => vi.fn());
const mockGetDefaultConfigPath = vi.hoisted(() => vi.fn(() => '/mock/opencode.json'));
const mockAutostartInstall = vi.hoisted(() => vi.fn());
const mockAutostartUninstall = vi.hoisted(() => vi.fn());
const mockAutostartStatus = vi.hoisted(() => vi.fn());
const mockCheckForUpdate = vi.hoisted(() => vi.fn());
const mockCreateProxyApp = vi.hoisted(() => vi.fn());
const mockStartScraper = vi.hoisted(() => vi.fn());
const mockStopScraper = vi.hoisted(() => vi.fn());

vi.mock('./config.js', () => ({ loadConfig: mockLoadConfig }));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  maskKey: vi.fn(),
}));
vi.mock('./cli/daemon.js', () => ({
  daemonStart: mockDaemonStart,
  daemonStop: mockDaemonStop,
  daemonStatus: mockDaemonStatus,
  daemonRestart: mockDaemonRestart,
}));
vi.mock('./cli/opencode-config.js', () => ({
  syncModelsToOpencodeConfig: mockSyncModels,
  getDefaultOpencodeConfigPath: mockGetDefaultConfigPath,
}));
vi.mock('./cli/autostart.js', () => ({
  autostartInstall: mockAutostartInstall,
  autostartUninstall: mockAutostartUninstall,
  autostartStatus: mockAutostartStatus,
}));
vi.mock('./cli/update-check.js', () => ({
  checkForUpdate: mockCheckForUpdate,
}));
vi.mock('./models-sync.js', () => ({
  syncOpencodeModelsWithUpstream: mockSyncUpstream,
  getModelsFromOpencodeConfig: mockGetModelsFromConfig,
}));
vi.mock('./model-probe.js', () => ({
  probeModel: mockProbeModel,
}));
vi.mock('./probe-cache.js', () => ({
  getCachedProbe: mockGetCachedProbe,
  setCachedProbe: mockSetCachedProbe,
}));
vi.mock('./proxy.js', () => ({
  createProxyApp: mockCreateProxyApp,
}));
vi.mock('./scraper.js', () => ({
  startScraper: mockStartScraper,
  stopScraper: mockStopScraper,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProcessExit() {
  return vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null): never => {
    throw new Error(`process.exit(${code})`);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('printHelp', () => {
  it('is exported and prints help text', async () => {
    const { printHelp } = await import('./cli/help.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printHelp();
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('Usage:');
  });
});

describe('CLI: help subcommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('prints help and exits 0', async () => {
    process.argv = ['node', 'saros-proxy', 'help'];
    vi.resetModules();
    const exitSpy = mockProcessExit();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Top-level module code runs — should print help and exit(0)
    await expect(import('./index.js')).rejects.toThrow('process.exit(0)');

    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('Usage:');
  });

  it('--help also prints help and exits 0', async () => {
    process.argv = ['node', 'saros-proxy', '--help'];
    vi.resetModules();
    const exitSpy = mockProcessExit();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(0)');
  });

  it('-h also prints help and exits 0', async () => {
    process.argv = ['node', 'saros-proxy', '-h'];
    vi.resetModules();
    const exitSpy = mockProcessExit();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(0)');
  });
});

describe('CLI: sync-upstream subcommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('with config that fails to load — exits 1', async () => {
    process.argv = ['node', 'saros-proxy', 'sync-upstream'];
    vi.resetModules();
    mockLoadConfig.mockImplementation(() => { throw new Error('Config parse error'); });
    const exitSpy = mockProcessExit();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(1)');
  });

  it('success path — calls syncOpencodeModelsWithUpstream and exits 0', async () => {
    process.argv = ['node', 'saros-proxy', 'sync-upstream'];
    vi.resetModules();
    mockLoadConfig.mockReturnValue({} as any);
    mockSyncUpstream.mockResolvedValue({ success: true, path: '/mock/opencode.json' });
    const exitSpy = mockProcessExit();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(0)');
    expect(mockSyncUpstream).toHaveBeenCalled();
  });
});

describe('CLI: probe subcommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('with no models in opencode.json — exits 1 with message', async () => {
    process.argv = ['node', 'saros-proxy', 'probe'];
    vi.resetModules();
    mockLoadConfig.mockReturnValue({} as any);
    mockGetModelsFromConfig.mockReturnValue([]);
    const exitSpy = mockProcessExit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/No models found/i));
  });

  it('with model ID not in opencode.json — exits 1', async () => {
    process.argv = ['node', 'saros-proxy', 'probe', 'nonexistent-model'];
    vi.resetModules();
    mockLoadConfig.mockReturnValue({} as any);
    mockGetModelsFromConfig.mockReturnValue(['real-model']);
    const exitSpy = mockProcessExit();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(1)');
  });
});

describe('CLI: restart subcommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('restart with no args — calls daemonRestart with undefined, undefined', async () => {
    process.argv = ['node', 'saros-proxy', 'restart'];
    vi.resetModules();
    mockDaemonRestart.mockImplementation(() => { throw new Error('process.exit(0)'); });
    const exitSpy = mockProcessExit();

    await expect(import('./index.js')).rejects.toThrow('process.exit(0)');
    expect(mockDaemonRestart).toHaveBeenCalledWith(undefined, undefined);
  });

  it('restart with --port and --config — passes parsed args', async () => {
    process.argv = ['node', 'saros-proxy', 'restart', '--port', '4000', '--config', 'my.yaml'];
    vi.resetModules();
    mockDaemonRestart.mockImplementation(() => { throw new Error('process.exit(0)'); });
    const exitSpy = mockProcessExit();

    await expect(import('./index.js')).rejects.toThrow('process.exit(0)');
    expect(mockDaemonRestart).toHaveBeenCalledWith(4000, 'my.yaml');
  });
});
