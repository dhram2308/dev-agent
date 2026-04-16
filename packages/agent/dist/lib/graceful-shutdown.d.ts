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
import type { ChildProcess } from "child_process";
import type * as http from "http";
import type * as https from "https";
/**
 * Register a child process for cleanup tracking.
 */
declare function trackChildProcess(proc: ChildProcess, name?: string): ChildProcess | undefined;
/**
 * Untrack a child process.
 */
declare function untrackChildProcess(proc: ChildProcess): void;
/**
 * Register HTTP agents for cleanup.
 */
declare function registerHttpAgents(agents: Array<{
    destroy: () => void;
}>): void;
/**
 * Register the HTTP server for graceful close.
 */
declare function registerHttpServer(server: http.Server | https.Server): void;
/**
 * Register SSE client getter for cleanup.
 */
declare function registerSseClientGetter(getter: () => Array<{
    end: () => void;
}>): void;
/**
 * Register state functions for checkpoint on shutdown.
 */
declare function registerStateFunctions(getFn: () => any, saveFn: (state: any) => void): void;
/**
 * Register lock file for cleanup.
 */
declare function registerLockFile(lockPath: string): void;
/**
 * Register a shutdown hook (called in order on shutdown).
 * Hook signature: async () => void
 */
declare function onShutdown(name: string, hookFn: () => Promise<void> | void): void;
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
declare function shutdown(signal?: string, exitCode?: number): Promise<void>;
/**
 * Install graceful shutdown handlers.
 * Call once at startup, replaces the basic handlers from cleanup.js.
 */
declare function installShutdownHandlers(): void;
/**
 * Check if shutdown is in progress (stages can check this to abort early).
 */
declare function isShuttingDown(): boolean;
export { trackChildProcess, untrackChildProcess, registerHttpAgents, registerHttpServer, registerSseClientGetter, registerStateFunctions, registerLockFile, onShutdown, shutdown, installShutdownHandlers, isShuttingDown, };
//# sourceMappingURL=graceful-shutdown.d.ts.map