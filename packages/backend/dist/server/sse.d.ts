import type { ServerResponse, IncomingMessage } from 'http';
declare const MAX_CLIENTS_TOTAL = 20;
declare const MAX_CLIENTS_PER_SESSION = 5;
declare const REPLAY_BUFFER_SIZE = 100;
declare const RETRY_MS = 3000;
declare const MAX_LOG = 2000;
declare const MAX_REPLAY_MSG_SIZE = 65536;
declare const MAX_PENDING_QUEUE = 200;
/** SSE client connection info */
export interface ClientInfo {
    /** Unique client identifier */
    id: string;
    /** HTTP response stream */
    res: ServerResponse;
    /** Auth token for this connection */
    sessionToken: string;
    /** Timestamp of last write activity (for LRU) */
    lastActivity: number;
    /** Whether backpressure has paused this client */
    paused: boolean;
    /** Messages queued while paused */
    pendingQueue: string[];
}
/** Log entry for SSE broadcast */
export interface LogEntry {
    ts: number;
    line: string;
    type: string;
    ticket: string | null;
}
/** SSE stats for diagnostics */
export interface SSEStats {
    totalClients: number;
    maxClients: number;
    maxPerSession: number;
    totalSessions: number;
    replayBufferSize: number;
    replayBufferMax: number;
    nextMessageId: number;
    logBufferSize: number;
}
/** Register client result */
export interface RegisterResult {
    ok: boolean;
    error?: string;
    clientId?: string;
}
/**
 * Register a new SSE client connection.
 * Handles: auth validation, connection limits, LRU eviction,
 * replay from Last-Event-ID, keepalive, backpressure.
 */
export declare function registerClient(res: ServerResponse, request: IncomingMessage, url: URL, apiToken: string): RegisterResult;
/**
 * Remove a client by ID -- close connection and clean up.
 */
export declare function removeClient(clientId: string): void;
/**
 * Broadcast an event to ALL connected SSE clients.
 * Assigns a monotonic message ID and stores in replay buffer.
 */
export declare function broadcast(event: string, data: unknown): void;
/**
 * Add a log entry and broadcast to all SSE clients.
 */
export declare function addLog(line: string, type?: string, ticket?: string | null): void;
/**
 * Get the merged log buffer (backward compat).
 */
export declare function getLogBuffer(): LogEntry[];
/**
 * Replace the merged log buffer (backward compat).
 */
export declare function setLogBuffer(buf: LogEntry[]): void;
/**
 * Get per-ticket log buffers (for API endpoint).
 */
export declare function getLogBuffers(): Record<string, LogEntry[]>;
/**
 * Get the global log buffer (system messages without ticket).
 */
export declare function getGlobalLogBuffer(): LogEntry[];
/**
 * Clear a ticket's per-ticket log buffer.
 */
export declare function clearTicketLogs(ticket: string): void;
/**
 * Get all SSE clients as an array of ServerResponse objects.
 * Used by graceful-shutdown for cleanup.
 */
export declare function getSseClients(): ServerResponse[];
/**
 * No-op: clients are now added via registerClient().
 * Kept for backward compatibility.
 */
export declare function addSseClient(): void;
/**
 * Remove an SSE client by its response object.
 */
export declare function removeSseClient(res: ServerResponse): void;
type AgentProcsGetter = () => Record<string, unknown>;
/**
 * Register a function that returns the agent processes map.
 * Called by http-server.ts on startup to break the circular dependency.
 */
export declare function setAgentProcsGetter(fn: AgentProcsGetter): void;
/**
 * Broadcast a pipeline state change to all SSE clients.
 * Called by the http-server state poller when a ticket's stage changes.
 */
export declare function broadcastStateChange(ticket: string, stage: string, data: Record<string, unknown>, seq?: number): void;
/**
 * Broadcast the current pipeline list to all SSE clients.
 * Uses late-bound agentProcs getter and state-manager's cached list.
 */
export declare function broadcastPipelineList(): void;
/**
 * Get current SSE connection stats for health/debug endpoints.
 * T2.23: Returns only aggregate counts, not session token values (prevents token leak).
 */
export declare function getSSEStats(): SSEStats;
export { MAX_CLIENTS_TOTAL, MAX_CLIENTS_PER_SESSION, RETRY_MS, REPLAY_BUFFER_SIZE, MAX_LOG, MAX_REPLAY_MSG_SIZE, MAX_PENDING_QUEUE, };
