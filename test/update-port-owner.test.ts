/**
 * update-port-owner.test.ts — `update` follows the port from the config file.
 *
 * Unlike update-command.test.ts, the daemon module is NOT mocked here: the
 * real `getDaemonState` resolves the port from a YAML config, and only the
 * process-owner/probe adapters are injected. This is the regression test for
 * a hardcoded 3000 — both the owner lookup and the release probe must use
 * the port the config declares.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runUpdateCommand, type UpdateDependencies } from '../src/cli/update.js';

let tempDir = '';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (tempDir !== '') rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('update against a configured port', () => {
  it('probes and kills the port from the config file, not a hardcoded 3000', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'saros-update-port-'));
    const configPath = join(tempDir, 'config.yaml');
    writeFileSync(
      configPath,
      'port: 4545\nkeys:\n  - label: test\n    key: sk-port-owner-config-key-0001\n',
      'utf-8',
    );
    // The real getDaemonState probes /health there: an unmanaged proxy answers.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ status: 'ok' }) })),
    );

    const ownerLookups: number[] = [];
    const killedPids: number[] = [];
    const probes: number[] = [];
    const starts: Array<Record<string, unknown>> = [];
    let phase: 'serving' | 'released' | 'restarted' = 'serving';

    const deps: Partial<UpdateDependencies> = {
      currentVersion: '1.1.2',
      fetchLatestVersion: async () => '1.1.3',
      isTTY: false,
      exec: (command, args) =>
        command === 'npm' && args[0] === 'root' ? '/usr/lib/node_modules' : '',
      packageRoot: '/usr/lib/node_modules/saros-proxy',
      readInstalledVersion: () => '1.1.3',
      systemdActive: () => false,
      findPortOwner: (port) => {
        ownerLookups.push(port);
        return phase === 'released'
          ? null
          : {
              pid: 4711,
              command: 'node /srv/orphan/dist/index.js serve',
              starttime: '987654',
            };
      },
      killPortOwner: (pid) => {
        killedPids.push(pid);
        phase = 'released';
      },
      probeHealth: async (port) => {
        probes.push(port);
        return {
          ok: true,
          body: { status: 'ok', version: phase === 'restarted' ? '1.1.3' : '1.1.2' },
        };
      },
      daemonStop: async () => {
        throw new Error('daemonStop must not run: nothing managed owns the port');
      },
      daemonStart: async (options) => {
        phase = 'restarted';
        starts.push({ ...options });
      },
      daemonLogPath: join(tempDir, 'daemon.log'),
      sleep: async () => {},
      healthAttempts: 2,
      healthDelayMs: 1,
      platform: 'linux',
    };

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    });

    const code = await runUpdateCommand(['--yes', '--config', configPath], deps);

    expect(code).toBe(0);
    // Discovery, revalidation before the signal, then the release poll.
    expect(ownerLookups).toEqual([4545, 4545, 4545]);
    expect(killedPids).toEqual([4711]);
    // Only the updated proxy's /health: release is measured on the listener.
    expect(probes).toEqual([4545]);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toEqual({
      configPath,
      entryPoint: join('/usr/lib/node_modules', 'saros-proxy', 'dist', 'index.js'),
    });
    // No --port override: the restarted daemon must re-read the same config.
    expect(starts[0].port).toBeUndefined();
    expect(output.join('\n')).toContain('Sent SIGTERM to PID 4711');
    expect(output.join('\n')).toContain('restarted the proxy on port 4545');
  });
});
