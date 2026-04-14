import type { ChildProcess } from 'child_process';
import type { Server } from 'http';
import type { Agent } from 'http';
/** State getter function type */
type GetStateFn = () => {
    stage: string;
    data: Record<string, unknown>;
} | null;
/** State save function type */
type SaveStateFn = (state: {
    stage: string;
    data: Record<string, unknown>;
}) => void;
/** SSE client getter function type */
type SseClientGetter = () => Array<{
    end: () => void;
}>;
/**
 * Register a child process for cleanup tracking.
 * Auto-removes on process exit.
 */
export declare function trackChildProcess(proc: ChildProcess, name?: string): ChildProcess;
/**
 * Untrack a child process.
 */
export declare function untrackChildProcess(proc: ChildProcess): void;
/**
 * Register HTTP agents for cleanup.
 */
export declare function registerHttpAgents(agents: Agent[]): void;
/**
 * Register the HTTP server for graceful close.
 */
export declare function registerHttpServer(server: Server): void;
/**
 * Register SSE client getter for cleanup.
 */
export declare function registerSseClientGetter(getter: SseClientGetter): void;
/**
 * Register state functions for checkpoint on shutdown.
 */
export declare function registerStateFunctions(getFn: GetStateFn, saveFn: SaveStateFn): void;
/**
 * Register lock file for cleanup.
 */
export declare function registerLockFile(lockPath: string): void;
/**
 * Register a shutdown hook (called in order on shutdown).
 * Hook signature: async () => void
 */
export declare function onShutdown(name: string, fn: () => Promise<void> | void): void;
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
export declare function shutdown(signal?: string, exitCode?: number): Promise<void>;
/**
 * Install graceful shutdown handlers.
 * Call once at startup, replaces any basic handlers.
 * Registers SIGTERM, SIGINT, uncaughtException, unhandledRejection.
 */
export declare function installShutdownHandlers(): void;
/**
 * Check if shutdown is in progress (stages can check this to abort early).
 */
export declare function isShuttingDown(): boolean;
/**
 * Check if shutdown completed (for testing/diagnostics).
 */
export declare function isShutdownComplete(): boolean;
export {};
