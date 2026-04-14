import type { PipelineState } from '@shared/types';
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
/**
 * Check if a process is alive by PID.
 */
export declare function isProcessAlive(pid: number | null | undefined): boolean;
/**
 * Find a free port in the given range using TCP bind test.
 */
export declare function findFreePort(start: number, end: number): Promise<number | null>;
/**
 * Health check the dev server -- HTTPS GET, ignore cert errors.
 */
export declare function healthCheck(port: number, timeoutMs?: number): Promise<boolean>;
/**
 * Kill a process by PID. Tries SIGTERM first, then SIGKILL after 5s.
 */
export declare function killProcess(pid: number | null | undefined): void;
/**
 * Start the nx serve dev server. Reuses existing if alive and healthy.
 *
 * @param clonePath - Path to .repo-cache
 * @param state - Pipeline state
 * @param deps - Injected dependencies
 * @returns Server info or null on failure
 */
export declare function startDevServer(clonePath: string, state: PipelineState, deps: DevServerDeps): Promise<DevServerResult | null>;
/**
 * Stop the dev server by PID from state.
 */
export declare function stopDevServer(state: PipelineState): void;
/**
 * Clean up orphan dev server on re-entry (e.g., after crash).
 */
export declare function cleanupOrphanDevServer(state: PipelineState): void;
