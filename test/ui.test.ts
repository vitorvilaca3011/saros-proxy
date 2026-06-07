import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SetupConfig } from '../src/cli/setup.js';

// ---------------------------------------------------------------------------
// Mock @clack/prompts
// ---------------------------------------------------------------------------
// vi.mock is hoisted to top of file, so mock factories must use vi.hoisted.

const { mockLog, mockNote, mockOutro } = vi.hoisted(() => ({
  mockLog: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
  },
  mockNote: vi.fn(),
  mockOutro: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: mockOutro,
  log: mockLog,
  note: mockNote,
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  text: vi.fn(),
  confirm: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
  isCancel: vi.fn((value) => value === Symbol.for('clack:cancel')),
}));

import {
  info,
  success,
  warn,
  error,
  step,
  panel,
  printConfigSummary,
  printNextSteps,
  listWorkspaces,
  assertNotCancelled,
} from '../src/cli/ui.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ui.ts', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('status wrappers', () => {
    it('info calls log.info with blue chalk', () => {
      info('test message');
      expect(mockLog.info).toHaveBeenCalledTimes(1);
      expect(mockLog.info.mock.calls[0][0]).toContain('test message');
    });

    it('success calls log.success with green chalk', () => {
      success('success message');
      expect(mockLog.success).toHaveBeenCalledTimes(1);
      expect(mockLog.success.mock.calls[0][0]).toContain('success message');
    });

    it('warn calls log.warn with yellow chalk', () => {
      warn('warning message');
      expect(mockLog.warn).toHaveBeenCalledTimes(1);
      expect(mockLog.warn.mock.calls[0][0]).toContain('warning message');
    });

    it('error calls log.error with red chalk', () => {
      error('error message');
      expect(mockLog.error).toHaveBeenCalledTimes(1);
      expect(mockLog.error.mock.calls[0][0]).toContain('error message');
    });

    it('step calls log.step with cyan chalk', () => {
      step('step title');
      expect(mockLog.step).toHaveBeenCalledTimes(1);
      expect(mockLog.step.mock.calls[0][0]).toContain('step title');
    });
  });

  describe('panel', () => {
    it('calls note with title and body', () => {
      panel('My Title', 'My Body');
      expect(mockNote).toHaveBeenCalledWith('My Body', 'My Title');
    });
  });

  describe('printConfigSummary', () => {
    const baseConfig: SetupConfig = {
      port: 3000,
      upstreamBaseUrl: 'https://api.opencode.ai',
      keys: [{ label: 'key-1', key: 'sk-test12345678901234567890' }],
    };

    it('prints basic config without encryption or scraping', () => {
      printConfigSummary(baseConfig, false, false);
      expect(mockNote).toHaveBeenCalledTimes(1);
      const content = mockNote.mock.calls[0][0] as string;
      expect(content).toContain('3000');
      expect(content).toContain('https://api.opencode.ai');
      expect(content).toContain('key-1');
      expect(content).not.toContain('Encryption');
      expect(content).not.toContain('Scraping');
    });

    it('prints encryption line when encryptionEnabled=true', () => {
      printConfigSummary(baseConfig, true, false);
      const content = mockNote.mock.calls[0][0] as string;
      expect(content).toContain('AES-256-GCM');
      expect(content).not.toContain('sk-test');
    });

    it('prints env warning when encryptionEnabled=true and envSaved=false', () => {
      printConfigSummary(baseConfig, true, false);
      expect(mockLog.warn).toHaveBeenCalledWith('Your API keys are encrypted.');
      expect(consoleSpy).toHaveBeenCalled();
      const consoleOutput = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(' ');
      expect(consoleOutput).toContain('OPENCODE_GO_ENCRYPTION_KEY');
    });

    it('does not print env warning when envSaved=true', () => {
      printConfigSummary(baseConfig, true, true);
      expect(mockLog.warn).not.toHaveBeenCalledWith('Your API keys are encrypted.');
    });

    it('prints scraping accounts when present', () => {
      const configWithScraping: SetupConfig = {
        ...baseConfig,
        scrapingAccounts: [
          { workspaceId: 'wrk_abc123', authCookie: 'cookie1' },
        ],
        scrapingThreshold: 75,
        scrapingIntervalMs: 120_000,
      };
      printConfigSummary(configWithScraping, false, false);
      const content = mockNote.mock.calls[0][0] as string;
      expect(content).toContain('Scraping accounts');
      expect(content).toContain('75%');
      expect(content).toContain('120s');
    });

    it('uses defaults for scraping when not specified', () => {
      const configWithScraping: SetupConfig = {
        ...baseConfig,
        scrapingAccounts: [
          { workspaceId: 'wrk_abc123', authCookie: 'cookie1' },
        ],
      };
      printConfigSummary(configWithScraping, false, false);
      const content = mockNote.mock.calls[0][0] as string;
      expect(content).toContain('50%');
      expect(content).toContain('90s');
    });
  });

  describe('printNextSteps', () => {
    it('prints next steps with correct port', () => {
      printNextSteps(8080);
      expect(mockLog.step).toHaveBeenCalledWith('Next Steps');
      const output = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(output).toContain('8080');
      expect(output).toContain('npm run dev');
      expect(output).toContain('/health');
      expect(output).toContain('saros-proxy');
    });
  });

  describe('listWorkspaces', () => {
    it('prints workspace list with URLs', () => {
      listWorkspaces(['wrk_abc123', 'wrk_def456']);
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('Workspaces found')
      );
      const output = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(output).toContain('wrk_abc123');
      expect(output).toContain('wrk_def456');
      expect(output).toContain('https://opencode.ai/workspace/wrk_abc123/go');
    });
  });

  describe('assertNotCancelled', () => {
    it('returns value when not cancelled', () => {
      const result = assertNotCancelled('my-value');
      expect(result).toBe('my-value');
      expect(mockOutro).not.toHaveBeenCalled();
    });

    it('calls outro and exits when cancelled', () => {
      const cancelSymbol = Symbol.for('clack:cancel');
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      expect(() => assertNotCancelled(cancelSymbol)).toThrow('process.exit called');
      expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
      mockExit.mockRestore();
    });
  });
});
