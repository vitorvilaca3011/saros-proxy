/**
 * cli-commands.test.ts — Integration tests for CLI subcommands.
 *
 * Tests the top-level dispatch in index.ts by mocking dependencies
 * and re-evaluating the module with different process.argv values.
 * Uses vi.resetModules() to force fresh module evaluation per test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock all dependencies of index.ts
// ---------------------------------------------------------------------------

const mockLoadConfig = vi.hoisted(() => vi.fn());
const mockSyncInAllHarnesses = vi.hoisted(() => vi.fn());
const mockReadHarnessSettings = vi.hoisted(() => vi.fn());
const mockWriteHarnessSettings = vi.hoisted(() => vi.fn());
const mockParseHarnessCommandArgs = vi.hoisted(() => vi.fn());
const mockUpdateHarnessSettings = vi.hoisted(() => vi.fn());
const mockGetModelsFromConfig = vi.hoisted(() => vi.fn());
const mockConfigDefaultPath = vi.hoisted(() => vi.fn(() => '/mock/config.yaml'));
const mockProbeModel = vi.hoisted(() => vi.fn());
const mockGetCachedProbe = vi.hoisted(() => vi.fn());
const mockSetCachedProbe = vi.hoisted(() => vi.fn());
const mockDaemonStart = vi.hoisted(() => vi.fn());
const mockDaemonStop = vi.hoisted(() => vi.fn());
const mockDaemonStatus = vi.hoisted(() => vi.fn());
const mockDaemonRestart = vi.hoisted(() => vi.fn());
const mockGetDaemonState = vi.hoisted(() => vi.fn());
const mockSyncModels = vi.hoisted(() => vi.fn());
const mockGetDefaultConfigPath = vi.hoisted(() => vi.fn(() => '/mock/opencode.json'));
const mockAutostartInstall = vi.hoisted(() => vi.fn());
const mockAutostartUninstall = vi.hoisted(() => vi.fn());
const mockAutostartStatus = vi.hoisted(() => vi.fn());
const mockCheckForUpdate = vi.hoisted(() => vi.fn());
const mockCreateProxyApp = vi.hoisted(() => vi.fn());
const mockStartScraper = vi.hoisted(() => vi.fn());
const mockStopScraper = vi.hoisted(() => vi.fn());

vi.mock('./config.js', () => ({
  loadConfig: mockLoadConfig,
  getDefaultConfigPath: mockConfigDefaultPath,
}));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  maskKey: vi.fn(),
}));
vi.mock('./cli/daemon.js', () => ({
  daemonStart: mockDaemonStart,
  daemonStop: mockDaemonStop,
  daemonStatus: mockDaemonStatus,
  daemonRestart: mockDaemonRestart,
  getDaemonState: mockGetDaemonState,
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
  getModelsFromOpencodeConfig: mockGetModelsFromConfig,
}));
vi.mock('./cli/harness-sync.js', () => ({
  syncModelsInAllHarnesses: mockSyncInAllHarnesses,
  readHarnessSettings: mockReadHarnessSettings,
  writeHarnessSettings: mockWriteHarnessSettings,
  parseHarnessCommandArgs: mockParseHarnessCommandArgs,
  updateHarnessSettings: mockUpdateHarnessSettings,
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
    mockProcessExit();
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
    mockProcessExit();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(0)');
  });

  it('-h also prints help and exits 0', async () => {
    process.argv = ['node', 'saros-proxy', '-h'];
    vi.resetModules();
    mockProcessExit();
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
    mockProcessExit();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(1)');
  });

  it('success path — calls syncModelsInAllHarnesses and exits 0', async () => {
    process.argv = ['node', 'saros-proxy', 'sync-upstream'];
    vi.resetModules();
    mockLoadConfig.mockReturnValue({} as any);
    mockSyncInAllHarnesses.mockResolvedValue([
      { harness: 'opencode', result: { success: true, path: '/mock/opencode.json' } },
    ]);
    mockProcessExit();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(0)');
    expect(mockSyncInAllHarnesses).toHaveBeenCalled();
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
    mockProcessExit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/No models found/i));
  });

  it('with model ID not in opencode.json — exits 1', async () => {
    process.argv = ['node', 'saros-proxy', 'probe', 'nonexistent-model'];
    vi.resetModules();
    mockLoadConfig.mockReturnValue({} as any);
    mockGetModelsFromConfig.mockReturnValue(['real-model']);
    mockProcessExit();
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
    mockProcessExit();

    await expect(import('./index.js')).rejects.toThrow('process.exit(0)');
    expect(mockDaemonRestart).toHaveBeenCalledWith(undefined, undefined);
  });

  it('restart with --port and --config — passes parsed args', async () => {
    process.argv = ['node', 'saros-proxy', 'restart', '--port', '4000', '--config', 'my.yaml'];
    vi.resetModules();
    mockDaemonRestart.mockImplementation(() => { throw new Error('process.exit(0)'); });
    mockProcessExit();

    await expect(import('./index.js')).rejects.toThrow('process.exit(0)');
    expect(mockDaemonRestart).toHaveBeenCalledWith(4000, 'my.yaml');
  });
});

describe('CLI: configharness subcommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('with no args — lists the current selection and exits 0', async () => {
    process.argv = ['node', 'saros-proxy', 'configharness'];
    vi.resetModules();
    mockReadHarnessSettings.mockReturnValue(['omp', 'pi']);
    mockProcessExit();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(0)');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Enabled harnesses: omp, pi'));
  });

  it('adds harnesses and prints the new selection — exits 0', async () => {
    process.argv = ['node', 'saros-proxy', 'configharness', 'omp', 'pi'];
    vi.resetModules();
    mockParseHarnessCommandArgs.mockReturnValue({
      add: ['omp', 'pi'],
      remove: [],
      clear: false,
      errors: [],
    });
    mockUpdateHarnessSettings.mockReturnValue(['omp', 'pi']);
    mockProcessExit();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(0)');
    expect(mockParseHarnessCommandArgs).toHaveBeenCalledWith(['omp', 'pi']);
    expect(mockUpdateHarnessSettings).toHaveBeenCalledWith({
      add: ['omp', 'pi'],
      remove: [],
      clear: false,
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Enabled harnesses: omp, pi'));
  });

  it('removes a harness via --remove — exits 0', async () => {
    process.argv = ['node', 'saros-proxy', 'configharness', '--remove', 'pi'];
    vi.resetModules();
    mockParseHarnessCommandArgs.mockReturnValue({
      add: [],
      remove: ['pi'],
      clear: false,
      errors: [],
    });
    mockUpdateHarnessSettings.mockReturnValue(['omp']);
    mockProcessExit();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(0)');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Enabled harnesses: omp'));
  });

  it('clears the selection via --clear — exits 0', async () => {
    process.argv = ['node', 'saros-proxy', 'configharness', '--clear'];
    vi.resetModules();
    mockParseHarnessCommandArgs.mockReturnValue({
      add: [],
      remove: [],
      clear: true,
      errors: [],
    });
    mockUpdateHarnessSettings.mockReturnValue([]);
    mockProcessExit();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(0)');
    expect(mockUpdateHarnessSettings).toHaveBeenCalledWith({ add: [], remove: [], clear: true });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('(none)'));
  });

  it('exits 1 on an unknown harness name', async () => {
    process.argv = ['node', 'saros-proxy', 'configharness', 'bogus'];
    vi.resetModules();
    mockParseHarnessCommandArgs.mockReturnValue({
      add: [],
      remove: [],
      clear: false,
      errors: ['bogus'],
    });
    mockProcessExit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockUpdateHarnessSettings.mockClear();

    await expect(import('./index.js')).rejects.toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown harness'));
    expect(mockUpdateHarnessSettings).not.toHaveBeenCalled();
  });

  it('exits 1 when --clear is combined with harness names', async () => {
    process.argv = ['node', 'saros-proxy', 'configharness', '--clear', 'omp'];
    vi.resetModules();
    mockParseHarnessCommandArgs.mockReturnValue({
      add: ['omp'],
      remove: [],
      clear: true,
      errors: [],
    });
    mockProcessExit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--clear'));
  });

  it('exits 1 when --remove has no names after it', async () => {
    process.argv = ['node', 'saros-proxy', 'configharness', '--remove'];
    vi.resetModules();
    mockParseHarnessCommandArgs.mockReturnValue({
      add: [],
      remove: [],
      clear: false,
      errors: [],
    });
    mockProcessExit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--remove'));
  });
});

describe('CLI: bare invocation (overview)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the overview and exits 0 without starting a server', async () => {
    process.argv = ['node', 'saros-proxy'];
    vi.resetModules();
    mockGetDaemonState.mockResolvedValue({
      running: true,
      pid: '1234',
      port: 3000,
      stalePid: false,
      health: { status: 'ok', enabledCount: 2, keyCount: 2 },
    });
    mockLoadConfig.mockReturnValue({
      keys: [{ label: 'github', key: 'sk-abcdefghijklmnopqrstuvwxyz123456' }],
    } as any);
    mockReadHarnessSettings.mockReturnValue(['omp', 'pi']);
    mockProcessExit();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(0)');
    const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('saros-proxy');
    expect(output).toContain('✓ running');
    expect(output).toContain('Harnesses: omp, pi');
    expect(output).toContain('API keys:');
    expect(mockGetDaemonState).toHaveBeenCalled();
  });

  it('shows not running when the probe finds nothing', async () => {
    process.argv = ['node', 'saros-proxy'];
    vi.resetModules();
    mockGetDaemonState.mockResolvedValue({
      running: false,
      pid: null,
      port: 3000,
      stalePid: false,
    });
    mockLoadConfig.mockReturnValue({ keys: [] } as any);
    mockReadHarnessSettings.mockReturnValue(['opencode']);
    mockProcessExit();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(import('./index.js')).rejects.toThrow('process.exit(0)');
    const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('✗ not running');
    expect(output).toContain('Harnesses: opencode');
  });
});
