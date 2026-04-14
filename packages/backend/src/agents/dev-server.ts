// =====================================================================
// MI Dev Agent -- Dev Server Management (TypeScript port)
// =====================================================================
// Manages the nx serve dev server for browser-based verification.
//
// Features:
//   - Free port detection in configurable range
//   - HTTPS health check (ignores cert errors)
//   - Reuse existing dev server if alive and healthy
//   - Retry with new port on failure
//   - Process group termination (SIGTERM -> SIGKILL)
//   - Orphan cleanup on re-entry after crash
//
// Ported from: stages/generate-code/dev-server.js
// =====================================================================

import * as net from 'net';
import * as https from 'https';
import { spawn } from 'child_process';
import type { PipelineState } from '@shared/types';
import { logInfo, logOk, logWarn, logErr } from '../lib/logger';

// ── Types ────────────────────────────────────────────────────────────

/** Dev server result */
export interface DevServerResult {
  port: number;
  pid: number;
}

/** Dependencies for dev server management */
export interface DevServerDeps {
  /** nx serve timeout */
  nxServeTimeout: number;
  /** Port range */
  portRangeStart: number;
  portRangeEnd: number;
  /** Save state */
  save: (state: PipelineState) => void;
}

// ── Utility functions ───────────────────────────────────────────────

/**
 * Check if a process is alive by PID.
 */
export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a free port in the given range using TCP bind test.
 */
export async function findFreePort(start: number, end: number): Promise<number | null> {
  for (let port = start; port <= end; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => {
        try { server.close(); } catch { /* ignore */ }
        resolve(false);
      });
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  return null;
}

/**
 * Health check the dev server -- HTTPS GET, ignore cert errors.
 */
export function healthCheck(port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: boolean): void => {
      if (!settled) { settled = true; resolve(v); }
    };

    const req = https.get(
      `https://localhost:${port}/`,
      { rejectUnauthorized: false, timeout: timeoutMs },
      (res) => {
        res.on('error', () => settle(false));
        res.resume(); // drain
        settle(res.statusCode !== undefined && res.statusCode < 500);
      },
    );
    req.on('error', () => settle(false));
    req.on('timeout', () => { req.destroy(); settle(false); });
  });
}

/**
 * Kill a process by PID. Tries SIGTERM first, then SIGKILL after 5s.
 */
export function killProcess(pid: number | null | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, 0); // Check if alive
  } catch {
    return; // Already dead
  }
  try {
    process.kill(-pid, 'SIGTERM'); // Kill process group
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* fallback */ }
  }
  // SIGKILL escalation with tracked timer
  const killTimer = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }, 5000);
  killTimer.unref(); // Don't prevent Node exit
}

// ── Main functions ──────────────────────────────────────────────────

/**
 * Start the nx serve dev server. Reuses existing if alive and healthy.
 *
 * @param clonePath - Path to .repo-cache
 * @param state - Pipeline state
 * @param deps - Injected dependencies
 * @returns Server info or null on failure
 */
export async function startDevServer(
  clonePath: string,
  state: PipelineState,
  deps: DevServerDeps,
): Promise<DevServerResult | null> {
  const data = state.data as Record<string, unknown>;

  // Check for existing dev server
  const existingPid = data._nx_serve_pid as number | undefined;
  const existingPort = data._nx_serve_port as number | undefined;

  if (existingPid && existingPort && isProcessAlive(existingPid)) {
    const healthy = await healthCheck(existingPort);
    if (healthy) {
      logOk(`Phase 0: Reusing dev server on port ${existingPort} (PID ${existingPid})`);
      data._dev_server_ready = true;
      deps.save(state);
      return { port: existingPort, pid: existingPid };
    }
    logWarn(`Phase 0: Existing dev server (PID ${existingPid}) unhealthy -- restarting`);
    killProcess(existingPid);
  } else if (existingPid) {
    logInfo('Phase 0: Previous dev server dead -- starting fresh');
  }

  // Find a free port
  const port = await findFreePort(deps.portRangeStart, deps.portRangeEnd);
  if (!port) {
    logErr(`Phase 0: No free port in ${deps.portRangeStart}-${deps.portRangeEnd}`);
    data._dev_server_ready = false;
    deps.save(state);
    return null;
  }

  logInfo(`Phase 0: Starting nx serve enterprise on port ${port}...`);

  // Spawn nx serve
  const proc = spawn('npx', ['nx', 'serve', 'enterprise', '--port', String(port)], {
    cwd: clonePath,
    stdio: 'pipe',
    detached: true,
    env: { ...process.env, NODE_OPTIONS: '--max_old_space_size=4096' },
  });

  // Store PID immediately (for orphan cleanup on crash)
  data._nx_serve_pid = proc.pid;
  data._nx_serve_port = port;
  deps.save(state);

  // Don't let the parent process wait for this child
  proc.unref();

  // Capture stderr for diagnostics
  let stderrBuf = '';
  proc.stderr?.on('data', (d: Buffer) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 2000) stderrBuf = stderrBuf.slice(-1000);
  });
  proc.stdout?.on('data', () => { /* drain stdout */ });

  // Poll for health
  const startTime = Date.now();
  const pollInterval = 2000;
  let ready = false;

  while (Date.now() - startTime < deps.nxServeTimeout) {
    await new Promise<void>((r) => setTimeout(r, pollInterval));

    if (!isProcessAlive(proc.pid ?? 0)) {
      logErr(`Phase 0: nx serve exited prematurely. stderr: ${stderrBuf.substring(0, 300)}`);
      break;
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed % 10 === 0) {
      logInfo(`Phase 0: Waiting for dev server... ${elapsed}s`);
    }

    const ok = await healthCheck(port);
    if (ok) {
      ready = true;
      break;
    }
  }

  if (ready) {
    data._dev_server_ready = true;
    deps.save(state);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logOk(`Phase 0: Dev server ready on port ${port} (${elapsed}s)`);
    return { port, pid: proc.pid! };
  }

  // Timeout or crash -- try once more with a new port
  logWarn('Phase 0: Dev server did not respond -- retrying with new port');
  killProcess(proc.pid ?? null);

  const retryPort = await findFreePort(port + 1, deps.portRangeEnd);
  if (!retryPort) {
    logErr('Phase 0: No free port for retry');
    data._dev_server_ready = false;
    deps.save(state);
    return null;
  }

  const retryProc = spawn('npx', ['nx', 'serve', 'enterprise', '--port', String(retryPort)], {
    cwd: clonePath,
    stdio: 'pipe',
    detached: true,
    env: { ...process.env, NODE_OPTIONS: '--max_old_space_size=4096' },
  });
  retryProc.unref();
  retryProc.stdout?.on('data', () => { /* drain */ });
  retryProc.stderr?.on('data', () => { /* drain */ });

  data._nx_serve_pid = retryProc.pid;
  data._nx_serve_port = retryPort;
  deps.save(state);

  const retryStart = Date.now();
  while (Date.now() - retryStart < deps.nxServeTimeout) {
    await new Promise<void>((r) => setTimeout(r, pollInterval));
    if (!isProcessAlive(retryProc.pid ?? 0)) break;
    const ok = await healthCheck(retryPort);
    if (ok) {
      data._dev_server_ready = true;
      deps.save(state);
      const elapsed = ((Date.now() - retryStart) / 1000).toFixed(1);
      logOk(`Phase 0: Dev server ready on port ${retryPort} (retry, ${elapsed}s)`);
      return { port: retryPort, pid: retryProc.pid! };
    }
  }

  killProcess(retryProc.pid ?? null);
  logErr('Phase 0: Dev server failed after retry');
  data._dev_server_ready = false;
  data._nx_serve_pid = null;
  data._nx_serve_port = null;
  deps.save(state);
  return null;
}

/**
 * Stop the dev server by PID from state.
 */
export function stopDevServer(state: PipelineState): void {
  const data = state.data as Record<string, unknown>;
  const pid = data._nx_serve_pid as number | undefined;
  if (pid && isProcessAlive(pid)) {
    logInfo(`Stopping dev server (PID ${pid})...`);
    killProcess(pid);
    logOk('Dev server stopped');
  }
  data._nx_serve_pid = null;
  data._nx_serve_port = null;
  data._dev_server_ready = false;
}

/**
 * Clean up orphan dev server on re-entry (e.g., after crash).
 */
export function cleanupOrphanDevServer(state: PipelineState): void {
  const data = state.data as Record<string, unknown>;
  const pid = data._nx_serve_pid as number | undefined;
  if (!pid) return;

  if (isProcessAlive(pid)) {
    logWarn(`Orphan dev server detected (PID ${pid}) -- killing`);
    killProcess(pid);
  }
  data._nx_serve_pid = null;
  data._nx_serve_port = null;
  data._dev_server_ready = false;
}
