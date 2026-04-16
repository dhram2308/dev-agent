/**
 * graceful-shutdown.ts — Graceful Shutdown Chain
 *
 * Converted from lib/graceful-shutdown.js (zero functional changes).
 *
 * Solves problems #8, #9:
 * - SIGTERM -> stop accepting new work -> checkpoint current stage
 *   -> save state -> kill children (SIGTERM with 5s grace, then SIGKILL)
 *   -> close SSE connections -> close HTTP server -> exit
 * - Handles both run-agent.js and server.js contexts
 * - Tracks all child processes for cleanup
 * - Prevents double-shutdown
 */

import fs from "fs";
import path from "path";

// Hub file not yet converted — use require
const { logInfo, logWarn, logErr, closeLogStream } = require("./logging") as {
  logInfo: (msg: string) => void;
  logWarn: (msg: string) => void;
  logErr: (msg: string) => void;
  closeLogStream: () => void;
};

import type { ChildProcess } from "child_process";
import type * as http from "http";
import type * as https from "https";

// ── Shutdown state ──────────────────────────────────────────────────

let _shutdownInProgress = false;
let _shutdownComplete = false;

// Registry of tracked child processes
interface TrackedProcess {
  proc: ChildProcess;
  name: string;
  startedAt: number;
}

const _childProcesses = new Map<number, TrackedProcess>(); // pid -> { proc, name, startedAt }

// Registered shutdown hooks (called in order)
interface ShutdownHook {
  name: string;
  fn: () => Promise<void> | void;
}

const _shutdownHooks: ShutdownHook[] = [];

// HTTP agents to destroy
let _httpAgents: Array<{ destroy: () => void }> = [];

// HTTP server reference (for server.js)
let _httpServer: http.Server | https.Server | null = null;

// SSE clients to close (for server.js)
let _sseClientGetter: (() => Array<{ end: () => void }>) | null = null;

// State save function and getter
let _saveStateFn: ((state: any) => void) | null = null;
let _getStateFn: (() => any) | null = null;

// Lock file path
let _lockFile: string | null = null;

// ── Registration functions ──────────────────────────────────────────

/**
 * Register a child process for cleanup tracking.
 */
function trackChildProcess(proc: ChildProcess, name: string = "child"): ChildProcess | undefined {
  if (!proc || !proc.pid) return;
  _childProcesses.set(proc.pid, {
    proc,
    name,
    startedAt: Date.now(),
  });

  // Auto-remove on exit
  proc.on("close", () => {
    if (proc.pid) _childProcesses.delete(proc.pid);
  });
  proc.on("exit", () => {
    if (proc.pid) _childProcesses.delete(proc.pid);
  });

  return proc;
}

/**
 * Untrack a child process.
 */
function untrackChildProcess(proc: ChildProcess): void {
  if (proc && proc.pid) {
    _childProcesses.delete(proc.pid);
  }
}

/**
 * Register HTTP agents for cleanup.
 */
function registerHttpAgents(agents: Array<{ destroy: () => void }>): void {
  _httpAgents = agents;
}

/**
 * Register the HTTP server for graceful close.
 */
function registerHttpServer(server: http.Server | https.Server): void {
  _httpServer = server;
}

/**
 * Register SSE client getter for cleanup.
 */
function registerSseClientGetter(getter: () => Array<{ end: () => void }>): void {
  _sseClientGetter = getter;
}

/**
 * Register state functions for checkpoint on shutdown.
 */
function registerStateFunctions(getFn: () => any, saveFn: (state: any) => void): void {
  _getStateFn = getFn;
  _saveStateFn = saveFn;
}

/**
 * Register lock file for cleanup.
 */
function registerLockFile(lockPath: string): void {
  _lockFile = lockPath;
}

/**
 * Register a shutdown hook (called in order on shutdown).
 * Hook signature: async () => void
 */
function onShutdown(name: string, hookFn: () => Promise<void> | void): void {
  _shutdownHooks.push({ name, fn: hookFn });
}

// ── Core shutdown sequence ──────────────────────────────────────────

/**
 * Execute the full graceful shutdown chain.
 *
 * Phase 1: Stop accepting new work
 * Phase 2: Save state checkpoint
 * Phase 3: Kill child processes (SIGTERM -> 5s -> SIGKILL)
 * Phase 4: Close SSE connections
 * Phase 5: Close HTTP server
 * Phase 6: Run registered hooks
 * Phase 7: Clean up resources (agents, streams, locks)
 * Phase 8: Exit
 */
async function shutdown(signal: string = "SIGTERM", exitCode: number = 0): Promise<void> {
  // Prevent double-shutdown
  if (_shutdownInProgress) {
    logWarn(`[Shutdown] Already in progress — ignoring duplicate ${signal}`);
    return;
  }
  _shutdownInProgress = true;

  const shutdownStart = Date.now();
  logInfo(`[Shutdown] Received ${signal} — beginning graceful shutdown`);

  // Force-exit after 30 seconds regardless
  const forceExitTimer = setTimeout(() => {
    logErr("[Shutdown] Force exit after 30s timeout");
    process.exit(exitCode || 1);
  }, 30_000);
  if (forceExitTimer.unref) forceExitTimer.unref();

  try {
    // Phase 1: Stop accepting new work (server context)
    if (_httpServer) {
      logInfo("[Shutdown] Phase 1: Stopping HTTP server from accepting new connections");
      try {
        _httpServer.close();
      } catch (e: any) {
        logWarn(`[Shutdown] Server close error: ${e.message}`);
      }
    }

    // Phase 2: Save state checkpoint
    logInfo("[Shutdown] Phase 2: Saving state checkpoint");
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
          logInfo(`[Shutdown] State saved at stage "${state.stage}"`);
        }
      }
    } catch (e: any) {
      logWarn(`[Shutdown] State save failed: ${e.message}`);
    }

    // Phase 3: Kill child processes (SIGTERM -> wait 5s -> SIGKILL)
    logInfo(`[Shutdown] Phase 3: Terminating ${_childProcesses.size} child process(es)`);
    if (_childProcesses.size > 0) {
      // Send SIGTERM to all children
      for (const [pid, entry] of _childProcesses) {
        try {
          logInfo(`[Shutdown]   Sending SIGTERM to ${entry.name} (PID ${pid})`);
          // Try process group first, then individual
          try { process.kill(-pid, "SIGTERM"); } catch (e1: any) {
            try { entry.proc.kill("SIGTERM"); } catch (e2: any) { logWarn(`[Shutdown] SIGTERM fallback failed for ${entry.name}: ${e2.message}`); }
          }
        } catch (e: any) {
          logWarn(`[Shutdown]   Could not SIGTERM ${entry.name} (PID ${pid}): ${e.message}`);
        }
      }

      // Wait up to 5 seconds for graceful termination
      await _sleep(5_000);

      // SIGKILL any survivors
      for (const [pid, entry] of _childProcesses) {
        try {
          // Check if still alive
          process.kill(pid, 0);
          logWarn(`[Shutdown]   ${entry.name} (PID ${pid}) still alive — sending SIGKILL`);
          try { process.kill(-pid, "SIGKILL"); } catch (e1: any) {
            try { entry.proc.kill("SIGKILL"); } catch (e2: any) { logWarn(`[Shutdown] SIGKILL fallback failed for ${entry.name}: ${e2.message}`); }
          }
        } catch {
          // Process already dead — good
        }
      }
      _childProcesses.clear();
    }

    // Phase 4: Close SSE connections
    if (_sseClientGetter) {
      logInfo("[Shutdown] Phase 4: Closing SSE connections");
      try {
        const clients = _sseClientGetter();
        for (const client of clients) {
          try { client.end(); } catch (e: any) { logWarn("[Shutdown] SSE client close error: " + e.message); }
        }
      } catch (e: any) {
        logWarn(`[Shutdown] SSE cleanup error: ${e.message}`);
      }
    }

    // Phase 5: Close HTTP server (wait for in-flight requests)
    if (_httpServer) {
      logInfo("[Shutdown] Phase 5: Waiting for in-flight requests");
      await new Promise<void>((resolve) => {
        // Give existing connections 5s to finish
        const serverTimer = setTimeout(resolve, 5_000);
        if (serverTimer.unref) serverTimer.unref();
      });
    }

    // Phase 6: Run registered hooks
    logInfo(`[Shutdown] Phase 6: Running ${_shutdownHooks.length} shutdown hook(s)`);
    for (const hook of _shutdownHooks) {
      try {
        await hook.fn();
      } catch (e: any) {
        logWarn(`[Shutdown] Hook "${hook.name}" failed: ${e.message}`);
      }
    }

    const elapsed = Date.now() - shutdownStart;
    logInfo(`[Shutdown] Graceful shutdown complete in ${elapsed}ms`);

  } catch (e: any) {
    logErr(`[Shutdown] Error during shutdown: ${e.message}`);
  } finally {
    // Phase 7: Clean up resources — MUST run even if earlier phases throw
    try {
      // Destroy HTTP agents
      for (const agent of _httpAgents) {
        try { agent.destroy(); } catch (e: any) { console.warn("[Shutdown] HTTP agent destroy error:", e.message); }
      }
      // Remove lock file
      if (_lockFile) {
        try {
          if (fs.existsSync(_lockFile)) fs.unlinkSync(_lockFile);
        } catch (e: any) { console.warn("[Shutdown] Lock file cleanup error:", e.message); }
      }
      // Close log stream (last — so earlier phases can still log)
      try { closeLogStream(); } catch (e: any) { console.warn("[Shutdown] Log stream close error:", e.message); }
    } catch (e: any) { console.warn("[Shutdown] Phase 7 cleanup error:", e.message); }

    clearTimeout(forceExitTimer);
    _shutdownComplete = true;
    process.exit(exitCode);
  }
}

// ── Setup signal handlers ───────────────────────────────────────────

/**
 * Install graceful shutdown handlers.
 * Call once at startup, replaces the basic handlers from cleanup.js.
 */
function installShutdownHandlers(): void {
  // Remove existing handlers to avoid double-fire
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");

  process.on("SIGTERM", () => shutdown("SIGTERM", 0));
  process.on("SIGINT", () => shutdown("SIGINT", 0));

  // Install uncaughtException/unhandledRejection handlers that use the chain
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");

  process.on("uncaughtException", (err: Error) => {
    logErr(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
    // Save crash info to state before shutdown
    try {
      if (_getStateFn && _saveStateFn) {
        const state = _getStateFn();
        if (state) {
          state.data._crash = {
            message: err.message,
            stack: err.stack,
            ts: new Date().toISOString(),
            type: "uncaughtException",
          };
          _saveStateFn(state);
        }
      }
    } catch (e: any) { console.warn("[Shutdown] Failed to save crash info:", e.message); }
    shutdown("uncaughtException", 1);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : "";
    logErr(`UNHANDLED REJECTION: ${msg}`);
    try {
      if (_getStateFn && _saveStateFn) {
        const state = _getStateFn();
        if (state) {
          state.data._crash = {
            message: msg,
            stack,
            ts: new Date().toISOString(),
            type: "unhandledRejection",
          };
          _saveStateFn(state);
        }
      }
    } catch (e: any) { console.warn("[Shutdown] Failed to save rejection info:", e.message); }
    shutdown("unhandledRejection", 1);
  });

  logInfo("[Shutdown] Graceful shutdown handlers installed");
}

/**
 * Check if shutdown is in progress (stages can check this to abort early).
 */
function isShuttingDown(): boolean {
  return _shutdownInProgress;
}

function _sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

export {
  trackChildProcess,
  untrackChildProcess,
  registerHttpAgents,
  registerHttpServer,
  registerSseClientGetter,
  registerStateFunctions,
  registerLockFile,
  onShutdown,
  shutdown,
  installShutdownHandlers,
  isShuttingDown,
};
