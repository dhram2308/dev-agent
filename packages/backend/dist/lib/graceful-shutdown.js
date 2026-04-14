"use strict";
// =====================================================================
// MI Dev Agent -- Graceful Shutdown Chain (TypeScript port)
// =====================================================================
// Solves problems #8, #9:
// - SIGTERM -> stop accepting new work -> checkpoint current stage
//   -> save state -> kill children (SIGTERM with 5s grace, then SIGKILL)
//   -> close SSE connections -> close HTTP server -> exit
// - Handles both run-agent and server contexts
// - Tracks all child processes for cleanup
// - Prevents double-shutdown
//
// Ported from: lib/graceful-shutdown.js
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
exports.trackChildProcess = trackChildProcess;
exports.untrackChildProcess = untrackChildProcess;
exports.registerHttpAgents = registerHttpAgents;
exports.registerHttpServer = registerHttpServer;
exports.registerSseClientGetter = registerSseClientGetter;
exports.registerStateFunctions = registerStateFunctions;
exports.registerLockFile = registerLockFile;
exports.onShutdown = onShutdown;
exports.shutdown = shutdown;
exports.installShutdownHandlers = installShutdownHandlers;
exports.isShuttingDown = isShuttingDown;
exports.isShutdownComplete = isShutdownComplete;
const fs = __importStar(require("fs"));
const logger_1 = require("./logger");
// ── Shutdown state ──────────────────────────────────────────────────
let _shutdownInProgress = false;
let _shutdownComplete = false;
/** Registry of tracked child processes: pid -> TrackedChild */
const _childProcesses = new Map();
/** Registered shutdown hooks (called in order) */
const _shutdownHooks = [];
/** HTTP agents to destroy */
let _httpAgents = [];
/** HTTP server reference (for server context) */
let _httpServer = null;
/** SSE client getter for cleanup (for server context) */
let _sseClientGetter = null;
/** State save function and getter */
let _saveStateFn = null;
let _getStateFn = null;
/** Lock file path for cleanup */
let _lockFile = null;
// ── Registration functions ──────────────────────────────────────────
/**
 * Register a child process for cleanup tracking.
 * Auto-removes on process exit.
 */
function trackChildProcess(proc, name = 'child') {
    if (!proc || !proc.pid)
        return proc;
    _childProcesses.set(proc.pid, {
        proc,
        name,
        startedAt: Date.now(),
    });
    // Auto-remove on exit
    proc.on('close', () => {
        if (proc.pid)
            _childProcesses.delete(proc.pid);
    });
    proc.on('exit', () => {
        if (proc.pid)
            _childProcesses.delete(proc.pid);
    });
    return proc;
}
/**
 * Untrack a child process.
 */
function untrackChildProcess(proc) {
    if (proc && proc.pid) {
        _childProcesses.delete(proc.pid);
    }
}
/**
 * Register HTTP agents for cleanup.
 */
function registerHttpAgents(agents) {
    _httpAgents = agents;
}
/**
 * Register the HTTP server for graceful close.
 */
function registerHttpServer(server) {
    _httpServer = server;
}
/**
 * Register SSE client getter for cleanup.
 */
function registerSseClientGetter(getter) {
    _sseClientGetter = getter;
}
/**
 * Register state functions for checkpoint on shutdown.
 */
function registerStateFunctions(getFn, saveFn) {
    _getStateFn = getFn;
    _saveStateFn = saveFn;
}
/**
 * Register lock file for cleanup.
 */
function registerLockFile(lockPath) {
    _lockFile = lockPath;
}
/**
 * Register a shutdown hook (called in order on shutdown).
 * Hook signature: async () => void
 */
function onShutdown(name, fn) {
    _shutdownHooks.push({ name, fn });
}
// ── Core shutdown sequence ──────────────────────────────────────────
/**
 * Execute the full graceful shutdown chain.
 *
 * Phase 1: Stop accepting new work (close HTTP server for new connections)
 * Phase 2: Save state checkpoint
 * Phase 3: Kill child processes (SIGTERM -> 5s -> SIGKILL)
 * Phase 4: Close SSE connections
 * Phase 5: Close HTTP server (wait for in-flight requests)
 * Phase 6: Run registered hooks
 * Phase 7: Clean up resources (agents, streams, locks)
 * Phase 8: Exit
 */
async function shutdown(signal = 'SIGTERM', exitCode = 0) {
    // Prevent double-shutdown
    if (_shutdownInProgress) {
        (0, logger_1.logWarn)(`[Shutdown] Already in progress -- ignoring duplicate ${signal}`);
        return;
    }
    _shutdownInProgress = true;
    const shutdownStart = Date.now();
    (0, logger_1.logInfo)(`[Shutdown] Received ${signal} -- beginning graceful shutdown`);
    // Force-exit after 30 seconds regardless
    const forceExitTimer = setTimeout(() => {
        (0, logger_1.logErr)('[Shutdown] Force exit after 30s timeout');
        process.exit(exitCode || 1);
    }, 30_000);
    if (forceExitTimer.unref)
        forceExitTimer.unref();
    try {
        // Phase 1: Stop accepting new work (server context)
        if (_httpServer) {
            (0, logger_1.logInfo)('[Shutdown] Phase 1: Stopping HTTP server from accepting new connections');
            try {
                _httpServer.close();
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                (0, logger_1.logWarn)(`[Shutdown] Server close error: ${msg}`);
            }
        }
        // Phase 2: Save state checkpoint
        (0, logger_1.logInfo)('[Shutdown] Phase 2: Saving state checkpoint');
        try {
            if (_getStateFn && _saveStateFn) {
                const state = _getStateFn();
                if (state) {
                    state.data._shutdown = {
                        signal,
                        ts: new Date().toISOString(),
                        pid: process.pid,
                        stage: state.stage,
                        uptime: process.uptime(),
                    };
                    _saveStateFn(state);
                    (0, logger_1.logInfo)(`[Shutdown] State saved at stage "${state.stage}"`);
                }
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            (0, logger_1.logWarn)(`[Shutdown] State save failed: ${msg}`);
        }
        // Phase 3: Kill child processes (SIGTERM -> wait 5s -> SIGKILL)
        (0, logger_1.logInfo)(`[Shutdown] Phase 3: Terminating ${_childProcesses.size} child process(es)`);
        if (_childProcesses.size > 0) {
            // Send SIGTERM to all children
            for (const [pid, entry] of _childProcesses) {
                try {
                    (0, logger_1.logInfo)(`[Shutdown]   Sending SIGTERM to ${entry.name} (PID ${pid})`);
                    // Try process group first, then individual
                    try {
                        process.kill(-pid, 'SIGTERM');
                    }
                    catch {
                        try {
                            entry.proc.kill('SIGTERM');
                        }
                        catch (e2) {
                            const msg = e2 instanceof Error ? e2.message : String(e2);
                            (0, logger_1.logWarn)(`[Shutdown] SIGTERM fallback failed for ${entry.name}: ${msg}`);
                        }
                    }
                }
                catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    (0, logger_1.logWarn)(`[Shutdown]   Could not SIGTERM ${entry.name} (PID ${pid}): ${msg}`);
                }
            }
            // Wait up to 5 seconds for graceful termination
            await _sleep(5_000);
            // SIGKILL any survivors
            for (const [pid, entry] of _childProcesses) {
                try {
                    // Check if still alive
                    process.kill(pid, 0);
                    (0, logger_1.logWarn)(`[Shutdown]   ${entry.name} (PID ${pid}) still alive -- sending SIGKILL`);
                    try {
                        process.kill(-pid, 'SIGKILL');
                    }
                    catch {
                        try {
                            entry.proc.kill('SIGKILL');
                        }
                        catch (e2) {
                            const msg = e2 instanceof Error ? e2.message : String(e2);
                            (0, logger_1.logWarn)(`[Shutdown] SIGKILL fallback failed for ${entry.name}: ${msg}`);
                        }
                    }
                }
                catch {
                    // Process already dead -- good
                }
            }
            _childProcesses.clear();
        }
        // Phase 4: Close SSE connections
        if (_sseClientGetter) {
            (0, logger_1.logInfo)('[Shutdown] Phase 4: Closing SSE connections');
            try {
                const clients = _sseClientGetter();
                for (const client of clients) {
                    try {
                        client.end();
                    }
                    catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        (0, logger_1.logWarn)('[Shutdown] SSE client close error: ' + msg);
                    }
                }
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                (0, logger_1.logWarn)(`[Shutdown] SSE cleanup error: ${msg}`);
            }
        }
        // Phase 5: Close HTTP server (wait for in-flight requests)
        if (_httpServer) {
            (0, logger_1.logInfo)('[Shutdown] Phase 5: Waiting for in-flight requests');
            await new Promise((resolve) => {
                // Give existing connections 5s to finish
                const serverTimer = setTimeout(resolve, 5_000);
                if (serverTimer.unref)
                    serverTimer.unref();
            });
        }
        // Phase 6: Run registered hooks
        (0, logger_1.logInfo)(`[Shutdown] Phase 6: Running ${_shutdownHooks.length} shutdown hook(s)`);
        for (const hook of _shutdownHooks) {
            try {
                await hook.fn();
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                (0, logger_1.logWarn)(`[Shutdown] Hook "${hook.name}" failed: ${msg}`);
            }
        }
        const elapsed = Date.now() - shutdownStart;
        (0, logger_1.logInfo)(`[Shutdown] Graceful shutdown complete in ${elapsed}ms`);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        (0, logger_1.logErr)(`[Shutdown] Error during shutdown: ${msg}`);
    }
    finally {
        // Phase 7: Clean up resources -- MUST run even if earlier phases throw
        try {
            // Destroy HTTP agents
            for (const agent of _httpAgents) {
                try {
                    agent.destroy();
                }
                catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    console.warn('[Shutdown] HTTP agent destroy error:', msg);
                }
            }
            // Remove lock file
            if (_lockFile) {
                try {
                    if (fs.existsSync(_lockFile))
                        fs.unlinkSync(_lockFile);
                }
                catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    console.warn('[Shutdown] Lock file cleanup error:', msg);
                }
            }
            // Close log stream (last -- so earlier phases can still log)
            try {
                await (0, logger_1.closeLogStream)();
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.warn('[Shutdown] Log stream close error:', msg);
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn('[Shutdown] Phase 7 cleanup error:', msg);
        }
        clearTimeout(forceExitTimer);
        _shutdownComplete = true;
        process.exit(exitCode);
    }
}
// ── Setup signal handlers ───────────────────────────────────────────
/**
 * Install graceful shutdown handlers.
 * Call once at startup, replaces any basic handlers.
 * Registers SIGTERM, SIGINT, uncaughtException, unhandledRejection.
 */
function installShutdownHandlers() {
    // Remove existing handlers to avoid double-fire
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.on('SIGTERM', () => shutdown('SIGTERM', 0));
    process.on('SIGINT', () => shutdown('SIGINT', 0));
    // Install uncaughtException/unhandledRejection handlers that use the chain
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    process.on('uncaughtException', (err) => {
        (0, logger_1.logErr)(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
        // Save crash info to state before shutdown
        try {
            if (_getStateFn && _saveStateFn) {
                const state = _getStateFn();
                if (state) {
                    state.data._crash = {
                        message: err.message,
                        stack: err.stack,
                        ts: new Date().toISOString(),
                        type: 'uncaughtException',
                    };
                    _saveStateFn(state);
                }
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn('[Shutdown] Failed to save crash info:', msg);
        }
        shutdown('uncaughtException', 1);
    });
    process.on('unhandledRejection', (reason) => {
        const msg = reason instanceof Error ? reason.message : String(reason);
        const stack = reason instanceof Error ? reason.stack : '';
        (0, logger_1.logErr)(`UNHANDLED REJECTION: ${msg}`);
        try {
            if (_getStateFn && _saveStateFn) {
                const state = _getStateFn();
                if (state) {
                    state.data._crash = {
                        message: msg,
                        stack,
                        ts: new Date().toISOString(),
                        type: 'unhandledRejection',
                    };
                    _saveStateFn(state);
                }
            }
        }
        catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            console.warn('[Shutdown] Failed to save rejection info:', errMsg);
        }
        shutdown('unhandledRejection', 1);
    });
    (0, logger_1.logInfo)('[Shutdown] Graceful shutdown handlers installed');
}
/**
 * Check if shutdown is in progress (stages can check this to abort early).
 */
function isShuttingDown() {
    return _shutdownInProgress;
}
/**
 * Check if shutdown completed (for testing/diagnostics).
 */
function isShutdownComplete() {
    return _shutdownComplete;
}
// ── Helpers ─────────────────────────────────────────────────────────
function _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
//# sourceMappingURL=graceful-shutdown.js.map