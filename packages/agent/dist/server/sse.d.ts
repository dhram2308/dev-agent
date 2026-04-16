import type { ServerResponse, IncomingMessage } from 'http';
import type { SseLogEntry, SseStats } from '@mi/shared';
declare const MAX_CLIENTS_TOTAL = 20;
declare const MAX_CLIENTS_PER_SESSION = 5;
declare const RETRY_MS = 3000;
interface RegisterResult {
    ok: boolean;
    error?: string;
    clientId?: string;
}
/**
 * Register a new SSE client connection.
 * Handles: auth validation, connection limits, LRU eviction,
 * replay from Last-Event-ID, keepalive, backpressure.
 */
declare function registerClient(res: ServerResponse, request: IncomingMessage, url: URL, apiToken: string): RegisterResult;
/**
 * Broadcast an event to ALL connected SSE clients.
 * Assigns a monotonic message ID and stores in replay buffer.
 */
declare function broadcast(event: string, data: unknown): void;
/**
 * Add a log entry and broadcast to all SSE clients.
 */
declare function addLog(line: string, type?: string, ticket?: string | null): void;
declare function getLogBuffer(): SseLogEntry[];
declare function setLogBuffer(buf: SseLogEntry[]): void;
/**
 * Clear a ticket's per-ticket log buffer.
 */
declare function clearTicketLogs(ticket: string): void;
/**
 * Get per-ticket log buffers (for API endpoint).
 */
declare function getLogBuffers(): Record<string, SseLogEntry[]>;
declare function getGlobalLogBuffer(): SseLogEntry[];
declare function getSseClients(): ServerResponse[];
declare function addSseClient(): void;
declare function removeSseClient(res: ServerResponse): void;
/**
 * Get current SSE connection stats for health/debug endpoints.
 */
declare function getSSEStats(): SseStats;
export { broadcast, addLog, getLogBuffer, setLogBuffer, getLogBuffers, getGlobalLogBuffer, clearTicketLogs, getSseClients, addSseClient, removeSseClient, registerClient, getSSEStats, MAX_CLIENTS_TOTAL, MAX_CLIENTS_PER_SESSION, RETRY_MS, };
//# sourceMappingURL=sse.d.ts.map