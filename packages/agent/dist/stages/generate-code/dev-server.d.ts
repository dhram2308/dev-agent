import type { PipelineState } from '@mi/shared';
declare function isProcessAlive(pid: number | null | undefined): boolean;
declare function findFreePort(start: number, end: number): Promise<number | null>;
declare function healthCheck(port: number, timeoutMs?: number): Promise<boolean>;
declare function startDevServer(clonePath: string, state: PipelineState): Promise<{
    port: number;
    pid: number;
} | null>;
declare function stopDevServer(state: PipelineState): void;
declare function killProcess(pid: number | null | undefined): void;
declare function cleanupOrphanDevServer(state: PipelineState): void;
export { isProcessAlive, findFreePort, healthCheck, startDevServer, stopDevServer, killProcess, cleanupOrphanDevServer, };
//# sourceMappingURL=dev-server.d.ts.map