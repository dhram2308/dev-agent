"use strict";

const net = require("net");
const https = require("https");
const { spawn } = require("child_process");
const { cfg, NX_SERVE_TIMEOUT, NX_SERVE_PORT_RANGE_START, NX_SERVE_PORT_RANGE_END } = require("../../lib/config");
const { logInfo, logOk, logWarn, logErr } = require("../../lib/logging");
const { save } = require("../../lib/state");

/**
 * Check if a process is alive by PID.
 */
function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a free port in the given range using TCP connect test.
 */
async function findFreePort(start, end) {
  for (let port = start; port <= end; port++) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => {
        try { server.close(); } catch { /* ignore */ }
        resolve(false);
      });
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  return null;
}

/**
 * Health check the dev server — HTTPS GET, ignore cert errors.
 */
function healthCheck(port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = https.get(
      `https://localhost:${port}/`,
      { rejectUnauthorized: false, timeout: timeoutMs },
      (res) => {
        res.on("error", () => settle(false));
        res.resume(); // drain
        settle(res.statusCode < 500);
      },
    );
    req.on("error", () => settle(false));
    req.on("timeout", () => { req.destroy(); settle(false); });
  });
}

/**
 * Start the nx serve dev server. Reuses existing if alive and healthy.
 *
 * @param {string} clonePath - Path to .repo-cache
 * @param {object} state - Pipeline state
 * @returns {Promise<{port: number, pid: number}|null>} Server info or null on failure
 */
async function startDevServer(clonePath, state) {
  // Check for existing dev server
  const existingPid = state.data._nx_serve_pid;
  const existingPort = state.data._nx_serve_port;

  if (existingPid && existingPort && isProcessAlive(existingPid)) {
    const healthy = await healthCheck(existingPort);
    if (healthy) {
      logOk(`Phase 0: Reusing dev server on port ${existingPort} (PID ${existingPid})`);
      state.data._dev_server_ready = true;
      save(state);
      return { port: existingPort, pid: existingPid };
    }
    logWarn(`Phase 0: Existing dev server (PID ${existingPid}) unhealthy — restarting`);
    killProcess(existingPid);
  } else if (existingPid) {
    // PID in state but process dead — clean up
    logInfo("Phase 0: Previous dev server dead — starting fresh");
  }

  // Find a free port
  const port = await findFreePort(NX_SERVE_PORT_RANGE_START, NX_SERVE_PORT_RANGE_END);
  if (!port) {
    logErr(`Phase 0: No free port in ${NX_SERVE_PORT_RANGE_START}-${NX_SERVE_PORT_RANGE_END}`);
    state.data._dev_server_ready = false;
    save(state);
    return null;
  }

  logInfo(`Phase 0: Starting nx serve enterprise on port ${port}…`);

  // Spawn nx serve
  const proc = spawn("npx", ["nx", "serve", "enterprise", "--port", String(port)], {
    cwd: clonePath,
    stdio: "pipe",
    detached: true,
    env: { ...process.env, NODE_OPTIONS: "--max_old_space_size=4096" },
  });

  // Store PID immediately (for orphan cleanup on crash)
  state.data._nx_serve_pid = proc.pid;
  state.data._nx_serve_port = port;
  save(state);

  // Don't let the parent process wait for this child
  proc.unref();

  // Capture stderr for diagnostics
  let stderrBuf = "";
  proc.stderr.on("data", (d) => { stderrBuf += d.toString(); if (stderrBuf.length > 2000) stderrBuf = stderrBuf.slice(-1000); });
  proc.stdout.on("data", () => {}); // drain stdout

  // Poll for health
  const startTime = Date.now();
  const pollInterval = 2000;
  let ready = false;

  while (Date.now() - startTime < NX_SERVE_TIMEOUT) {
    await new Promise((r) => setTimeout(r, pollInterval));

    if (!isProcessAlive(proc.pid)) {
      logErr(`Phase 0: nx serve exited prematurely. stderr: ${stderrBuf.substring(0, 300)}`);
      break;
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed % 10 === 0) {
      logInfo(`Phase 0: Waiting for dev server… ${elapsed}s`);
    }

    const ok = await healthCheck(port);
    if (ok) {
      ready = true;
      break;
    }
  }

  if (ready) {
    state.data._dev_server_ready = true;
    save(state);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logOk(`Phase 0: Dev server ready on port ${port} (${elapsed}s)`);
    return { port, pid: proc.pid };
  }

  // Timeout or crash — try once more with a new port
  logWarn("Phase 0: Dev server didn't respond — retrying with new port");
  killProcess(proc.pid);

  const retryPort = await findFreePort(port + 1, NX_SERVE_PORT_RANGE_END);
  if (!retryPort) {
    logErr("Phase 0: No free port for retry");
    state.data._dev_server_ready = false;
    save(state);
    return null;
  }

  const retryProc = spawn("npx", ["nx", "serve", "enterprise", "--port", String(retryPort)], {
    cwd: clonePath,
    stdio: "pipe",
    detached: true,
    env: { ...process.env, NODE_OPTIONS: "--max_old_space_size=4096" },
  });
  retryProc.unref();
  retryProc.stdout.on("data", () => {});
  retryProc.stderr.on("data", () => {});

  state.data._nx_serve_pid = retryProc.pid;
  state.data._nx_serve_port = retryPort;
  save(state);

  const retryStart = Date.now();
  while (Date.now() - retryStart < NX_SERVE_TIMEOUT) {
    await new Promise((r) => setTimeout(r, pollInterval));
    if (!isProcessAlive(retryProc.pid)) break;
    const ok = await healthCheck(retryPort);
    if (ok) {
      state.data._dev_server_ready = true;
      save(state);
      const elapsed = ((Date.now() - retryStart) / 1000).toFixed(1);
      logOk(`Phase 0: Dev server ready on port ${retryPort} (retry, ${elapsed}s)`);
      return { port: retryPort, pid: retryProc.pid };
    }
  }

  killProcess(retryProc.pid);
  logErr("Phase 0: Dev server failed after retry");
  state.data._dev_server_ready = false;
  state.data._nx_serve_pid = null;
  state.data._nx_serve_port = null;
  save(state);
  return null;
}

/**
 * Stop the dev server by PID from state.
 */
function stopDevServer(state) {
  const pid = state.data._nx_serve_pid;
  if (pid && isProcessAlive(pid)) {
    logInfo(`Stopping dev server (PID ${pid})…`);
    killProcess(pid);
    logOk("Dev server stopped");
  }
  state.data._nx_serve_pid = null;
  state.data._nx_serve_port = null;
  state.data._dev_server_ready = false;
}

/**
 * Kill a process by PID. Tries SIGTERM first, then SIGKILL after 5s.
 */
function killProcess(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 0); // Check if alive
  } catch { return; } // Already dead
  try {
    process.kill(-pid, "SIGTERM"); // Kill process group
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch {} // Fallback: kill just the process
  }
  // SIGKILL escalation with tracked timer
  const killTimer = setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
  }, 5000);
  killTimer.unref(); // Don't prevent Node exit
}

/**
 * Clean up orphan dev server on re-entry (e.g., after crash).
 */
function cleanupOrphanDevServer(state) {
  const pid = state.data._nx_serve_pid;
  if (!pid) return;

  if (isProcessAlive(pid)) {
    logWarn(`Orphan dev server detected (PID ${pid}) — killing`);
    killProcess(pid);
  }
  state.data._nx_serve_pid = null;
  state.data._nx_serve_port = null;
  state.data._dev_server_ready = false;
  try { save(state); } catch { /* best effort */ }
}

module.exports = {
  isProcessAlive,
  findFreePort,
  healthCheck,
  startDevServer,
  stopDevServer,
  killProcess,
  cleanupOrphanDevServer,
};
