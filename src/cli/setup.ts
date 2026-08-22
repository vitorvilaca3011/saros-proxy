#!/usr/bin/env node

/**
 * setup.ts — Interactive CLI setup wizard for Saros.
 *
 * Usage:
 *   npx tsx src/cli/setup.ts
 *   npm run setup
 *
 * Prompts for configuration values, writes config.yaml, and runs a quick
 * smoke test to verify the proxy starts and responds to health checks.
 */

import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { stringify as stringifyYaml } from 'yaml';
import { spawn, exec, execFileSync, type ChildProcess } from 'node:child_process';
import { resolve as pathResolve, join as pathJoin, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { encryptKey } from '../key-encryption.js';
import {
  getDefaultOpencodeConfigPath,
  updateOpencodeConfig,
  generateManualConfigSnippet,
} from './opencode-config.js';
import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_UPSTREAM_URL,
  DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../constants.js';
import { isValidPort, isValidApiKey, isValidHttpsUrl, isValidPositiveInt } from '../validation.js';
import { getDefaultConfigPath } from '../config.js';
import * as ui from './ui.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = pathResolve(fileURLToPath(import.meta.url), '..', '..', '..');

// ---------------------------------------------------------------------------
// Non-interactive setup options
// ---------------------------------------------------------------------------

export interface SetupOptions {
  /** Skip all prompts — requires --keys or --keys-file */
  nonInteractive?: boolean;
  /** Proxy listen port */
  port?: number;
  /** Upstream API base URL */
  upstream?: string;
  /** Comma-separated label:key pairs */
  keys?: string;
  /** Path to keys file (one per line: label:key) */
  keysFile?: string;
  /** Master encryption key (prefer --encryption-key-file for security) */
  encryptionKey?: string;
  /** Path to file containing encryption key */
  encryptionKeyFile?: string;
  /** Skip encryption entirely */
  noEncryption?: boolean;
  /** Skip proxy smoke test */
  noSmokeTest?: boolean;
  /** Skip opencode.json configuration */
  noOpencodeConfig?: boolean;
  /** Path to opencode.json */
  opencodeConfig?: string;
  /** Output config.yaml path (directory) */
  configDir?: string;
  /** Minimal output for agent parsing */
  quiet?: boolean;
  /** Legacy: config directory (for backward compatibility) */
  legacyConfigDir?: string;
  /** Legacy: skip smoke test (for backward compatibility) */
  legacySkipSmokeTest?: boolean;
}

/** Parse CLI arguments for non-interactive setup. */
export function parseSetupArgs(argv: string[] = process.argv.slice(2)): SetupOptions {
  const opts: SetupOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) break;

    switch (arg) {
      case '--non-interactive':
        opts.nonInteractive = true;
        break;
      case '--port':
        opts.port = Number.parseInt(argv[++i] ?? '', 10);
        break;
      case '--upstream':
        opts.upstream = argv[++i];
        break;
      case '--keys':
        opts.keys = argv[++i];
        break;
      case '--keys-file':
        opts.keysFile = argv[++i];
        break;
      case '--encryption-key':
        opts.encryptionKey = argv[++i];
        break;
      case '--encryption-key-file':
        opts.encryptionKeyFile = argv[++i];
        break;
      case '--no-encryption':
        opts.noEncryption = true;
        break;
      case '--no-smoke-test':
        opts.noSmokeTest = true;
        break;
      case '--no-opencode-config':
        opts.noOpencodeConfig = true;
        break;
      case '--opencode-config':
        opts.opencodeConfig = argv[++i];
        break;
      case '--config':
        opts.configDir = argv[++i];
        break;
      case '--quiet':
        opts.quiet = true;
        break;
    }
  }

  return opts;
}

/** Parse keys from comma-separated label:key pairs. */
export function parseKeysFromArgs(keysStr: string): Array<{ label: string; key: string }> {
  if (!keysStr.trim()) return [];
  return keysStr.split(',').map((pair) => {
    const trimmed = pair.trim();
    const [label, ...rest] = trimmed.split(':');
    const key = rest.join(':');
    return { label: label ?? '', key };
  });
}

/** Parse keys from file (one per line: label:key). */
export function parseKeysFromFile(filePath: string): Array<{ label: string; key: string }> {
  const content = readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [label, ...rest] = line.split(':');
      const key = rest.join(':');
      return { label: label ?? '', key };
    });
}

interface ValidationError {
  field: string;
  message: string;
}

/** Validate non-interactive args. Returns array of errors (empty = valid). */
export function validateNonInteractiveArgs(opts: SetupOptions): ValidationError[] {
  const errors: ValidationError[] = [];

  // Keys are required
  if (!opts.keys && !opts.keysFile) {
    errors.push({ field: 'keys', message: 'Either --keys or --keys-file is required in non-interactive mode' });
  }

  // Encryption: must specify one or the other
  if (opts.encryptionKey && opts.noEncryption) {
    errors.push({ field: 'encryption', message: 'Cannot use both --encryption-key and --no-encryption' });
  }
  if (!opts.encryptionKey && !opts.encryptionKeyFile && !opts.noEncryption) {
    errors.push({ field: 'encryption', message: 'Must specify --encryption-key, --encryption-key-file, or --no-encryption' });
  }

  // Port validation
  if (opts.port !== undefined && !isValidPort(String(opts.port))) {
    errors.push({ field: 'port', message: 'Port must be a number between 1 and 65535' });
  }

  // Upstream validation
  if (opts.upstream && !isValidHttpsUrl(opts.upstream)) {
    errors.push({ field: 'upstream', message: 'Upstream must be a valid HTTPS URL' });
  }

  // Encryption key length
  if (opts.encryptionKey && opts.encryptionKey.length < 16) {
    errors.push({ field: 'encryptionKey', message: 'Encryption key must be at least 16 characters' });
  }

  // Validate keys
  if (opts.keys) {
    const keys = parseKeysFromArgs(opts.keys);
    for (const k of keys) {
      if (!k.label) errors.push({ field: 'keys', message: 'Key label cannot be empty' });
      if (!isValidApiKey(k.key)) {
        errors.push({ field: 'keys', message: `Key "${k.label}" must start with "sk-" and be at least 20 characters` });
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Environment variable persistence
// ---------------------------------------------------------------------------

/** Try to save an environment variable persistently so the user doesn't
 *  have to export it manually each time.
 *
 *  - Windows: `setx <name> <value>` (user-level, persists across reboots)
 *  - Linux/macOS: append `export <name>=<value>` to ~/.bashrc or ~/.zshrc
 *
 *  Returns true on success, false on failure (non-fatal).
 */
function saveEnvVar(name: string, value: string): boolean {
  try {
    if (process.platform === 'win32') {
      // Use execFileSync to avoid shell injection (setx PATH "foo & calc & ")
      execFileSync('setx', [name, value], { windowsHide: true, timeout: 5000 });
      return true;
    }

    // Linux/macOS — append to shell profile
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return false;

    const profilePaths = [
      pathJoin(home, '.zshrc'),
      pathJoin(home, '.bashrc'),
      pathJoin(home, '.bash_profile'),
      pathJoin(home, '.profile'),
    ];

    const existing = profilePaths.find((p) => existsSync(p));
    const targetPath = existing || profilePaths[0];

    // Escape single quotes for shell profile: 'foo' -> '"'"'  (breaks out of single quotes, inserts literal ', resumes)
    const escaped = value.replaceAll("'", String.raw`'\''`);
    const line = `\nexport ${name}='${escaped}'\n`;

    // Avoid adding duplicates — anchored to line start
    let content = '';
    try {
      content = readFileSync(targetPath, 'utf-8');
    } catch {
      // File doesn't exist yet — start from empty
    }
    if (new RegExp(`^export ${name}=`, 'm').test(content)) return false;

    writeFileSync(targetPath, content + line, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
export interface SetupConfig {
  port: number;
  upstreamBaseUrl: string;
  keys: Array<{ label: string; key: string }>;
}

export function generateYaml(cfg: SetupConfig, encryptionEnabled = false): string {
  const config: Record<string, unknown> = {
    port: cfg.port,
    host: DEFAULT_HOST,
    upstreamBaseUrl: cfg.upstreamBaseUrl,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],
    keys: cfg.keys,
  };

  let yaml = stringifyYaml(config);
  if (encryptionEnabled) {
    yaml = `# [!] API keys are encrypted with AES-256-GCM\n# Set OPENCODE_GO_ENCRYPTION_KEY environment variable to start the proxy\n\n${yaml}`;
  }
  return yaml;
}

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

/** Kill a process and all its children (cross-platform, non-blocking). */
function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;

  if (process.platform === 'win32') {
    exec(`taskkill /T /F /PID ${child.pid}`, { windowsHide: true }, () => {});
  } else {
    child.kill('SIGKILL');
  }
}

export async function testProxy(port: number, timeoutMs = 20_000, cwd = PACKAGE_ROOT, encryptionKey?: string, configPath?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Resolve the entry point relative to the package root
    const entryPoint = pathResolve(PACKAGE_ROOT, 'src', 'index.ts');

    // Use single-command form with shell:true to avoid DEP0190 deprecation
    // (Node.js deprecates passing both shell:true and separate args)
    const configFlag = configPath ? ` --config "${configPath}"` : '';
    const cmd = `npx tsx "${entryPoint}" serve --port ${port}${configFlag}`;
    const child: ChildProcess = spawn(cmd, [], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      detached: false, // killProcessTree() handles cleanup on both platforms
      env: {
        ...process.env,
        LOG_LEVEL: 'silent',
        NODE_ENV: 'production',
        ...(encryptionKey ? { OPENCODE_GO_ENCRYPTION_KEY: encryptionKey } : {}),
      },
    });

    let started = false;
    let timedOut = false;
    let resolved = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      if (!resolved) {
        resolved = true;
        reject(new Error('Proxy did not start within the allotted time.'));
      }
    }, timeoutMs);

    // Collect stderr for error reporting
    let stderrBuf = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });
    }

    // Poll the health endpoint until we get a response
    const pollId = setInterval(async () => {
      if (timedOut) {
        clearInterval(pollId);
        return;
      }

      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          // Parse JSON first — don't mark as started until we confirm it's our proxy
          const data = await res.json();

          started = true;
          clearTimeout(timer);
          clearInterval(pollId);

          ui.success(`Health check returned status "${data.status}"`);
          ui.success(`${data.enabledCount}/${data.keyCount} API key(s) enabled`);
          if (data.disabledCount > 0) {
            ui.warn(`${data.disabledCount} key(s) disabled (check API key validity)`);
          }

          // Kill the child and wait for it to exit before resolving
          killProcessTree(child);
          child.once('exit', () => {
            if (!resolved) {
              resolved = true;
              resolve();
            }
          });
          // Fallback: if exit doesn't fire within 2s, resolve anyway
          setTimeout(() => {
            if (!resolved) {
              resolved = true;
              resolve();
            }
          }, 2000);
        }
      } catch {
        // Server not ready yet — keep polling
      }
    }, 400);

    child.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(pollId);
      if (!started && !resolved) {
        resolved = true;
        reject(new Error(`Failed to start proxy process: ${err.message}`));
      }
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      clearInterval(pollId);

      // If child exits before we detected it as started, that's a failure
      // (on Windows with shell:true, exit code may be 0 even when proxy failed)
      if (!started && !resolved) {
        resolved = true;
        let hint: string;
        if (stderrBuf.includes('EADDRINUSE')) {
          hint = `Port ${port} is already in use. Choose a different port.`;
        } else if (stderrBuf.includes('No valid API keys')) {
          hint = 'No valid API keys found. Ensure keys start with "sk-" and are at least 20 characters.';
        } else {
          const stderrSuffix = stderrBuf ? `\n  Stderr: ${stderrBuf.slice(0, 500)}` : '';
          hint = `Proxy exited with code ${code}${stderrSuffix}`;
        }
        reject(new Error(hint));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Backup existing config
// ---------------------------------------------------------------------------

export function backupExistingConfig(configDir = dirname(getDefaultConfigPath())): boolean {
  const configPath = pathResolve(configDir, 'config.yaml');
  if (!existsSync(configPath)) return false;

  const backupPath = pathResolve(configDir, 'config.yaml.backup');
  try {
    const content = readFileSync(configPath, 'utf-8');
    writeFileSync(backupPath, content, { encoding: 'utf-8', mode: 0o600 });
    ui.info('Existing config.yaml backed up to config.yaml.backup');
    return true;
  } catch (err) {
    ui.warn(`Could not create backup: ${err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

interface ServerConfig {
  port: number;
  upstreamBaseUrl: string;
}

interface EncryptionConfig {
  encryptionKey: string | undefined;
  envSaved: boolean;
}

async function promptServerConfig(): Promise<ServerConfig> {
  const portStr = ui.assertNotCancelled(await ui.text({
    message: 'Proxy port',
    placeholder: String(DEFAULT_PORT),
    validate: (v) => {
      if (v && !isValidPort(v)) return 'Port must be a number between 1 and 65535.';
    },
  }));
  const port = Number.parseInt(portStr || String(DEFAULT_PORT), 10);

  const upstreamBaseUrl = ui.assertNotCancelled(await ui.text({
    message: 'Upstream API base URL',
    placeholder: DEFAULT_UPSTREAM_URL,
    validate: (v) => {
      if (v && !isValidHttpsUrl(v)) return 'Must be a valid HTTPS URL (e.g. https://opencode.ai).';
    },
  })) || DEFAULT_UPSTREAM_URL;

  return { port, upstreamBaseUrl };
}

async function promptAccountCount(): Promise<number> {
  const numAccountsStr = ui.assertNotCancelled(await ui.text({
    message: 'Number of accounts',
    placeholder: '2',
    validate: (v) => {
      if (v && !isValidPositiveInt(v, 1, 100)) return 'Must be a number between 1 and 100.';
    },
  }));
  return Number.parseInt(numAccountsStr || '2', 10);
}

async function promptEncryption(): Promise<EncryptionConfig> {
  const encryptKeys = ui.assertNotCancelled(await ui.confirm({
    message: 'Encrypt API keys? (recommended for security)',
    initialValue: true,
  }));

  if (!encryptKeys) {
    return { encryptionKey: undefined, envSaved: false };
  }

  const encryptionKey = ui.assertNotCancelled(await ui.password({
    message: 'Master encryption key (min 16 characters)',
    validate: (v) => {
      if (!v || v.length < 16) return 'Encryption key must be at least 16 characters long';
    },
  }));
  ui.success('All API keys will be encrypted with AES-256-GCM');

  const saveEnv = ui.assertNotCancelled(await ui.confirm({
    message: 'Save OPENCODE_GO_ENCRYPTION_KEY to your environment?',
    initialValue: true,
  }));

  let envSaved = false;
  if (saveEnv) {
    if (saveEnvVar('OPENCODE_GO_ENCRYPTION_KEY', encryptionKey)) {
      ui.success('OPENCODE_GO_ENCRYPTION_KEY saved');
      envSaved = true;
    } else {
      ui.warn('Could not save to environment. Set it manually:');
      ui.info(`    export OPENCODE_GO_ENCRYPTION_KEY="${encryptionKey}"`);
    }
  }
  return { encryptionKey, envSaved };
}

async function collectAccountCredentials(opts: {
  numAccounts: number;
  encryptionKey: string | undefined;
}): Promise<Array<{ label: string; key: string }>> {
  const keys: Array<{ label: string; key: string }> = [];

  for (let i = 0; i < opts.numAccounts; i++) {
    ui.step(`Account ${i + 1} of ${opts.numAccounts}`);

    const label = await promptAccountLabel(i, opts.numAccounts);
    const key = await promptAccountApiKey();
    const finalKey = opts.encryptionKey ? encryptKey(key, opts.encryptionKey) : key;
    keys.push({ label, key: finalKey });
    ui.success(`"${label}" API key configured`);
  }

  return keys;
}

async function promptAccountLabel(index: number, total: number): Promise<string> {
  const placeholder = `account${index + 1}`;
  const label = ui.assertNotCancelled(await ui.text({
    message: 'Label for this account',
    placeholder,
    validate: (v) => {
      if (v === '') return 'This field is required.';
    },
  }));
  return label || placeholder;
}

async function promptAccountApiKey(): Promise<string> {
  return ui.assertNotCancelled(await ui.password({
    message: 'API key',
    validate: (v) => {
      if (!v || !isValidApiKey(v)) return 'API key must start with "sk-" and be at least 20 characters long.';
    },
  }));
}

async function writeConfigFile(cfg: SetupConfig, configDir: string, encryptionEnabled: boolean): Promise<string> {
  const yaml = generateYaml(cfg, encryptionEnabled);
  backupExistingConfig(configDir);
  mkdirSync(configDir, { recursive: true });
  const configPath = pathResolve(configDir, 'config.yaml');
  writeFileSync(configPath, yaml, { encoding: 'utf-8', mode: 0o600 });
  ui.success(`config.yaml written to ${configPath}`);
  return configPath;
}

async function runSmokeTestIfEnabled(opts: {
  port: number;
  configDir: string;
  encryptionKey: string | undefined;
  configPath: string;
  skipSmokeTest: boolean;
}): Promise<void> {
  if (opts.skipSmokeTest) return;
  ui.info(`Starting proxy smoke test on port ${opts.port}...`);
  try {
    await testProxy(opts.port, 20_000, opts.configDir, opts.encryptionKey, opts.configPath);
    ui.success('Smoke test passed — proxy is working correctly');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ui.warn(`Smoke test warning: ${message}`);
    ui.info('The config.yaml has been saved. You can troubleshoot by running:');
    ui.info('    $ npm run dev');
  }
}

async function configureOpencodeClient(port: number): Promise<void> {
  const defaultOpencodePath = getDefaultOpencodeConfigPath();
  const opencodeExists = existsSync(defaultOpencodePath);
  let opencodePath: string | undefined;

  if (opencodeExists) {
    opencodePath = defaultOpencodePath;
  } else {
    ui.info(`Default OpenCode config not found at ${defaultOpencodePath}`);
    const customPath = ui.assertNotCancelled(await ui.text({
      message: 'Path to opencode.json/.jsonc (or press Enter to skip)',
      placeholder: 'Press Enter to skip',
      validate: () => undefined,
    }));
    if (customPath?.trim()) {
      opencodePath = customPath.trim();
    }
  }

  if (!opencodePath) {
    ui.info('Skipped OpenCode configuration. Add this to your opencode.json/.jsonc manually:');
    console.log(chalk.dim(generateManualConfigSnippet(port)));
    return;
  }

  ui.info(`Found OpenCode config at ${opencodePath}`);
  const shouldConfigure = ui.assertNotCancelled(await ui.confirm({
    message: 'Configure opencode.json/.jsonc to use this proxy?',
    initialValue: true,
  }));

  if (shouldConfigure) {
    const result = updateOpencodeConfig(port, { configPath: opencodePath });
    if (result.success) {
      if (result.created) {
        ui.success(`Created opencode config at ${result.path}`);
      } else {
        ui.success(`Updated opencode config at ${result.path}`);
        ui.info('A backup was saved to opencode config.backup');
      }
      ui.info('If OpenCode is running, restart it to pick up the changes');
    } else {
      ui.warn(`Could not update opencode config: ${result.error}`);
      ui.info('You can manually add this to your opencode.json/.jsonc:');
      console.log(chalk.dim(generateManualConfigSnippet(port)));
    }
  } else {
    ui.info('Skipped automatic configuration. Add this to your opencode.json/.jsonc manually:');
    console.log(chalk.dim(generateManualConfigSnippet(port)));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function setup(configDir?: string, skipSmokeTest?: boolean): Promise<void> {
  // Parse CLI args for non-interactive mode
  const cliOpts = parseSetupArgs();

  // Merge legacy args with CLI opts
  const opts: SetupOptions = {
    ...cliOpts,
    legacyConfigDir: configDir,
    legacySkipSmokeTest: skipSmokeTest,
  };

  // Resolve effective options
  const effectiveConfigDir = opts.configDir ?? opts.legacyConfigDir ?? dirname(getDefaultConfigPath());
  const effectiveSkipSmokeTest = opts.noSmokeTest ?? opts.legacySkipSmokeTest ?? false;

  // -----------------------------------------------------------------------
  // Non-interactive path
  // -----------------------------------------------------------------------
  if (opts.nonInteractive) {
    // Validate args
    const errors = validateNonInteractiveArgs(opts);
    if (errors.length > 0) {
      for (const e of errors) {
        console.error(`Error: ${e.field} — ${e.message}`);
      }
      process.exit(1);
    }

    // Parse keys
    let keys: Array<{ label: string; key: string }>;
    if (opts.keysFile) {
      keys = parseKeysFromFile(opts.keysFile);
    } else {
      keys = parseKeysFromArgs(opts.keys!);
    }

    // Resolve encryption key
    let encryptionKey: string | undefined;
    if (opts.encryptionKeyFile) {
      encryptionKey = readFileSync(opts.encryptionKeyFile, 'utf-8').trim();
    } else if (opts.encryptionKey) {
      encryptionKey = opts.encryptionKey;
    }

    // Encrypt keys if needed
    const finalKeys = encryptionKey
      ? keys.map((k) => ({ ...k, key: encryptKey(k.key, encryptionKey!) }))
      : keys;

    const cfg: SetupConfig = {
      port: opts.port ?? DEFAULT_PORT,
      upstreamBaseUrl: opts.upstream ?? DEFAULT_UPSTREAM_URL,
      keys: finalKeys,
    };

    // Write config
    const configPath = await writeConfigFile(cfg, effectiveConfigDir, encryptionKey !== undefined);

    // Smoke test (unless skipped)
    if (!effectiveSkipSmokeTest) {
      await runSmokeTestIfEnabled({
        port: cfg.port,
        configDir: effectiveConfigDir,
        encryptionKey,
        configPath,
        skipSmokeTest: false,
      });
    }

    // OpenCode config (unless skipped)
    if (!opts.noOpencodeConfig) {
      const opencodePath = opts.opencodeConfig ?? getDefaultOpencodeConfigPath();
      if (existsSync(opencodePath)) {
        const result = updateOpencodeConfig(cfg.port, { configPath: opencodePath });
        if (result.success) {
          if (!opts.quiet) console.log(`OpenCode config updated: ${result.path}`);
        }
      }
    }

    // Output
    if (opts.quiet) {
      console.log(configPath);
    } else {
      console.log(`Config written to ${configPath}`);
    }

    return;
  }

  // -----------------------------------------------------------------------
  // Interactive path (default)
  // -----------------------------------------------------------------------
  ui.intro('Saros — Setup');

  ui.step('Server Configuration');
  const { port, upstreamBaseUrl } = await promptServerConfig();

  const numAccounts = await promptAccountCount();
  const { encryptionKey, envSaved } = await promptEncryption();

  const keys = await collectAccountCredentials({
    numAccounts,
    encryptionKey,
  });

  const cfg: SetupConfig = {
    port,
    upstreamBaseUrl,
    keys,
  };

  const configPath = await writeConfigFile(cfg, effectiveConfigDir, encryptionKey !== undefined);

  await runSmokeTestIfEnabled({
    port,
    configDir: effectiveConfigDir,
    encryptionKey,
    configPath,
    skipSmokeTest: effectiveSkipSmokeTest,
  });

  ui.step('OpenCode Client Configuration');
  await configureOpencodeClient(port);

  ui.printConfigSummary(cfg, encryptionKey !== undefined, envSaved);
  ui.printNextSteps(cfg.port);
  ui.outro('Setup complete');
}

// ---------------------------------------------------------------------------
// Entry point when run directly
// ---------------------------------------------------------------------------

// Only run if this is the main module
const isMain =
  process.argv[1] &&
  (pathResolve(process.argv[1]) === pathResolve(fileURLToPath(import.meta.url)) ||
    process.argv[1].endsWith('setup.ts'));

if (isMain) {
  try {
    await setup();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ui.outro(chalk.red(`Setup failed: ${message}`));
    process.exit(1);
  }
}
