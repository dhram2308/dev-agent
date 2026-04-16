import { ChildProcess } from 'child_process';
import type { AgentStartResult, AgentStopResult, ProcessHealthCheck, StageDataMap } from '@mi/shared';
type SseLike = {
    addLog: (line: string, type: string, ticket: string) => void;
    broadcast: (event: string, data: any) => void;
    clearTicketLogs: (ticket: string) => void;
};
export declare function setSseModule(mod: SseLike): void;
interface TokenManagerLike {
    getAccessTokenSync(provider: string): string | null;
    refresh(provider: string): Promise<unknown>;
}
/** Inject the TokenManager so agent-process can fetch fresh tokens before spawn */
export declare function setTokenManager(tm: TokenManagerLike): void;
/**
 * Clear any pending auth-timeout timer for a ticket.
 */
declare function clearAuthTimeout(ticket: string): void;
/**
 * Get the set of tickets currently waiting for auth re-authorization.
 * Useful for the resume path: if a connector reconnects, check if any
 * ticket was waiting on that provider.
 */
declare function getAuthWaitingTickets(): Record<string, {
    provider: string;
}>;
declare function startAgent(ticket: string): AgentStartResult;
declare function stopAgent(ticket?: string | null): AgentStopResult;
declare function checkProcessHealth(ticket: string): ProcessHealthCheck;
declare function cleanOrphanedLocks(): void;
declare const STAGE_DATA_MAP: StageDataMap;
declare function cleanOrphanedWorktreesOnStartup(): void;
declare function getAgentProcs(): Record<string, ChildProcess>;
export { startAgent, stopAgent, checkProcessHealth, cleanOrphanedLocks, cleanOrphanedWorktreesOnStartup, getAgentProcs, getAuthWaitingTickets, clearAuthTimeout, STAGE_DATA_MAP, };
//# sourceMappingURL=agent-process.d.ts.map