/**
 * auto-start.ts — Hybrid "Plugin + Lazy Start" prototype.
 *
 * A small HTTP shim that listens on port 3000 and auto-starts the real
 * OpenCode-Go proxy on the first incoming request.
 *
 * Usage:
 *   tsx prototype/auto-start.ts
 *
 * OpenCode should be configured to connect to http://127.0.0.1:3000.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SHIM_PORT = 3000;        // Port OpenCode connects to (this shim)
const SHIM_HOST = '127.0.0.1';
const PROXY_PORT = 3001;       // Internal port for the real proxy
const PROXY_HOST = '127.0.0.1';
const PROXY_SCRIPT = 'src/index.ts';
const HEALTH_CHECK_INTERVAL = 500;  // ms between health checks
const HEALTH_CHECK_TIMEOUT = 10_000; // max wait for proxy to start

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Proxy child process management
// ---------------------------------------------------------------------------

let proxyChild: ChildProcess | null = null;

/**
 * Check if the real proxy is already running by hitting its /health endpoint.
 */
async function isProxyRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://${PROXY_HOST}:${PROXY_PORT}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start the real proxy as a child process.
 * Passes --port and --host so the proxy listens on our internal port.
 */
function startProxy(): ChildProcess {
  const scriptPath = existsSync('dist/index.js')
    ? 'dist/index.js'
    : PROXY_SCRIPT;
  const runner = scriptPath.endsWith('.ts') ? 'tsx' : 'node';

  console.log(`[shim] Starting proxy: ${runner} ${scriptPath} --port ${PROXY_PORT} --host ${PROXY_HOST}`);

  const child = spawn(runner, [
    scriptPath,
    '--port', String(PROXY_PORT),
    '--host', PROXY_HOST,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    shell: process.platform === 'win32',
  });

  child.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      console.log(`[proxy] ${line.trim()}`);
    }
  });

  child.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      console.error(`[proxy] ${line.trim()}`);
    }
  });

  child.on('exit', (code, signal) => {
    console.log(`[shim] Proxy exited (code: ${code}, signal: ${signal})`);
    proxyChild = null;

    // If the proxy crashes, exit the shim too — OpenCode will reconnect
    // and we'll restart fresh.
    if (code !== 0 && code !== null) {
      console.log('[shim] Proxy crashed — exiting shim. Restart shim to try again.');
      // Give a moment for any buffered output
      setTimeout(() => process.exit(1), 100);
    }
  });

  child.on('error', (err) => {
    console.error(`[shim] Failed to start proxy: ${err.message}`);
  });

  proxyChild = child;
  return child;
}

/**
 * Wait for the proxy to respond to health checks.
 */
async function waitForProxy(): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < HEALTH_CHECK_TIMEOUT) {
    if (await isProxyRunning()) {
      console.log(`[shim] Proxy ready after ${Date.now() - start}ms`);
      return true;
    }
    await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL));
  }
  console.log(`[shim] Proxy failed to start within ${HEALTH_CHECK_TIMEOUT}ms`);
  return false;
}

/**
 * Ensure the proxy is running. Starts it if needed.
 */
async function ensureProxyRunning(): Promise<boolean> {
  // Check fast-path: if we have a child process, assume it's running
  if (proxyChild && proxyChild.exitCode === null) {
    // Double-check with health endpoint
    if (await isProxyRunning()) return true;
    // Process exists but health endpoint failing — might be still starting
    return await waitForProxy();
  }

  // No child process or it exited — start fresh
  console.log('[shim] Proxy not running, starting...');
  const child = startProxy();

  const ready = await waitForProxy();
  if (!ready) {
    // Kill the child if it's still running but not responding
    if (child.exitCode === null) {
      child.kill();
    }
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main HTTP shim server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  console.log(`[shim] ${req.method} ${req.url}`);

  const running = await ensureProxyRunning();
  if (!running) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy failed to start' }));
    return;
  }

  // Forward the request to the real proxy
  const proxyReq = http.request(
    {
      hostname: PROXY_HOST,
      port: PROXY_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err) => {
    console.error(`[shim] Forward error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy forwarding failed' }));
    } else {
      res.destroy();
    }
  });

  req.pipe(proxyReq);
});

server.listen(SHIM_PORT, SHIM_HOST, () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  Auto-Start Shim                            ║`);
  console.log(`║  Listening on http://${SHIM_HOST}:${SHIM_PORT}              ║`);
  console.log(`║  Proxy will start automatically             ║`);
  console.log(`║  on the first incoming request.             ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function cleanup(signal: string): void {
  console.log(`\n[shim] Received ${signal}, shutting down...`);

  // Stop accepting new connections
  server.close(() => {
    console.log('[shim] Shim server closed');

    // Kill the proxy child if it exists
    if (proxyChild && proxyChild.exitCode === null) {
      console.log('[shim] Stopping proxy child process...');
      proxyChild.kill();
      // On Windows, kill the entire process tree
      if (process.platform === 'win32' && proxyChild.pid) {
        try {
          spawn('taskkill', ['/T', '/F', '/PID', String(proxyChild.pid)], {
            stdio: 'ignore',
          });
        } catch {
          // Best effort
        }
      }
    }

    process.exit(0);
  });

  // Force exit after 5s
  setTimeout(() => {
    console.error('[shim] Forced shutdown after timeout');
    process.exit(1);
  }, 5_000);
}

process.on('SIGINT', () => cleanup('SIGINT'));
process.on('SIGTERM', () => cleanup('SIGTERM'));
