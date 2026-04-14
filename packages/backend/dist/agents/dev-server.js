"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.isProcessAlive = isProcessAlive;
exports.findFreePort = findFreePort;
exports.healthCheck = healthCheck;
exports.killProcess = killProcess;
exports.startDevServer = startDevServer;
exports.stopDevServer = stopDevServer;
exports.cleanupOrphanDevServer = cleanupOrphanDevServer;
const net = __importStar(require("net"));
const https = __importStar(require("https"));
const child_process_1 = require("child_process");
const logger_1 = require("../lib/logger");
// ── Utility functions ───────────────────────────────────────────────
/**
 * Check if a process is alive by PID.
 */
function isProcessAlive(pid) {
    if (!pid)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Find a free port in the given range using TCP bind test.
 */
async function findFreePort(start, end) {
    for (let port = start; port <= end; port++) {
        const free = await new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => {
                try {
                    server.close();
                }
                catch { /* ignore */ }
                resolve(false);
            });
            server.once('listening', () => {
                server.close(() => resolve(true));
            });
            server.listen(port, '127.0.0.1');
        });
        if (free)
            return port;
    }
    return null;
}
/**
 * Health check the dev server -- HTTPS GET, ignore cert errors.
 */
function healthCheck(port, timeoutMs = 5000) {
    return new Promise((resolve) => {
        let settled = false;
        const settle = (v) => {
            if (!settled) {
                settled = true;
                resolve(v);
            }
        };
        const req = https.get(`https://localhost:${port}/`, { rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
            res.on('error', () => settle(false));
            res.resume(); // drain
            settle(res.statusCode !== undefined && res.statusCode < 500);
        });
        req.on('error', () => settle(false));
        req.on('timeout', () => { req.destroy(); settle(false); });
    });
}
/**
 * Kill a process by PID. Tries SIGTERM first, then SIGKILL after 5s.
 */
function killProcess(pid) {
    if (!pid)
        return;
    try {
        process.kill(pid, 0); // Check if alive
    }
    catch {
        return; // Already dead
    }
    try {
        process.kill(-pid, 'SIGTERM'); // Kill process group
    }
    catch {
        try {
            process.kill(pid, 'SIGTERM');
        }
        catch { /* fallback */ }
    }
    // SIGKILL escalation with tracked timer
    const killTimer = setTimeout(() => {
        try {
            process.kill(-pid, 'SIGKILL');
        }
        catch { /* ignore */ }
        try {
            process.kill(pid, 'SIGKILL');
        }
        catch { /* ignore */ }
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
async function startDevServer(clonePath, state, deps) {
    const data = state.data;
    // Check for existing dev server
    const existingPid = data._nx_serve_pid;
    const existingPort = data._nx_serve_port;
    if (existingPid && existingPort && isProcessAlive(existingPid)) {
        const healthy = await healthCheck(existingPort);
        if (healthy) {
            (0, logger_1.logOk)(`Phase 0: Reusing dev server on port ${existingPort} (PID ${existingPid})`);
            data._dev_server_ready = true;
            deps.save(state);
            return { port: existingPort, pid: existingPid };
        }
        (0, logger_1.logWarn)(`Phase 0: Existing dev server (PID ${existingPid}) unhealthy -- restarting`);
        killProcess(existingPid);
    }
    else if (existingPid) {
        (0, logger_1.logInfo)('Phase 0: Previous dev server dead -- starting fresh');
    }
    // Find a free port
    const port = await findFreePort(deps.portRangeStart, deps.portRangeEnd);
    if (!port) {
        (0, logger_1.logErr)(`Phase 0: No free port in ${deps.portRangeStart}-${deps.portRangeEnd}`);
        data._dev_server_ready = false;
        deps.save(state);
        return null;
    }
    (0, logger_1.logInfo)(`Phase 0: Starting nx serve enterprise on port ${port}...`);
    // Spawn nx serve
    const proc = (0, child_process_1.spawn)('npx', ['nx', 'serve', 'enterprise', '--port', String(port)], {
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
    proc.stderr?.on('data', (d) => {
        stderrBuf += d.toString();
        if (stderrBuf.length > 2000)
            stderrBuf = stderrBuf.slice(-1000);
    });
    proc.stdout?.on('data', () => { });
    // Poll for health
    const startTime = Date.now();
    const pollInterval = 2000;
    let ready = false;
    while (Date.now() - startTime < deps.nxServeTimeout) {
        await new Promise((r) => setTimeout(r, pollInterval));
        if (!isProcessAlive(proc.pid ?? 0)) {
            (0, logger_1.logErr)(`Phase 0: nx serve exited prematurely. stderr: ${stderrBuf.substring(0, 300)}`);
            break;
        }
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if (elapsed % 10 === 0) {
            (0, logger_1.logInfo)(`Phase 0: Waiting for dev server... ${elapsed}s`);
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
        (0, logger_1.logOk)(`Phase 0: Dev server ready on port ${port} (${elapsed}s)`);
        return { port, pid: proc.pid };
    }
    // Timeout or crash -- try once more with a new port
    (0, logger_1.logWarn)('Phase 0: Dev server did not respond -- retrying with new port');
    killProcess(proc.pid ?? null);
    const retryPort = await findFreePort(port + 1, deps.portRangeEnd);
    if (!retryPort) {
        (0, logger_1.logErr)('Phase 0: No free port for retry');
        data._dev_server_ready = false;
        deps.save(state);
        return null;
    }
    const retryProc = (0, child_process_1.spawn)('npx', ['nx', 'serve', 'enterprise', '--port', String(retryPort)], {
        cwd: clonePath,
        stdio: 'pipe',
        detached: true,
        env: { ...process.env, NODE_OPTIONS: '--max_old_space_size=4096' },
    });
    retryProc.unref();
    retryProc.stdout?.on('data', () => { });
    retryProc.stderr?.on('data', () => { });
    data._nx_serve_pid = retryProc.pid;
    data._nx_serve_port = retryPort;
    deps.save(state);
    const retryStart = Date.now();
    while (Date.now() - retryStart < deps.nxServeTimeout) {
        await new Promise((r) => setTimeout(r, pollInterval));
        if (!isProcessAlive(retryProc.pid ?? 0))
            break;
        const ok = await healthCheck(retryPort);
        if (ok) {
            data._dev_server_ready = true;
            deps.save(state);
            const elapsed = ((Date.now() - retryStart) / 1000).toFixed(1);
            (0, logger_1.logOk)(`Phase 0: Dev server ready on port ${retryPort} (retry, ${elapsed}s)`);
            return { port: retryPort, pid: retryProc.pid };
        }
    }
    killProcess(retryProc.pid ?? null);
    (0, logger_1.logErr)('Phase 0: Dev server failed after retry');
    data._dev_server_ready = false;
    data._nx_serve_pid = null;
    data._nx_serve_port = null;
    deps.save(state);
    return null;
}
/**
 * Stop the dev server by PID from state.
 */
function stopDevServer(state) {
    const data = state.data;
    const pid = data._nx_serve_pid;
    if (pid && isProcessAlive(pid)) {
        (0, logger_1.logInfo)(`Stopping dev server (PID ${pid})...`);
        killProcess(pid);
        (0, logger_1.logOk)('Dev server stopped');
    }
    data._nx_serve_pid = null;
    data._nx_serve_port = null;
    data._dev_server_ready = false;
}
/**
 * Clean up orphan dev server on re-entry (e.g., after crash).
 */
function cleanupOrphanDevServer(state) {
    const data = state.data;
    const pid = data._nx_serve_pid;
    if (!pid)
        return;
    if (isProcessAlive(pid)) {
        (0, logger_1.logWarn)(`Orphan dev server detected (PID ${pid}) -- killing`);
        killProcess(pid);
    }
    data._nx_serve_pid = null;
    data._nx_serve_port = null;
    data._dev_server_ready = false;
}
//# sourceMappingURL=dev-server.js.map