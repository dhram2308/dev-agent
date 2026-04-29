// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — SSE (Server-Sent Events) Type Definitions
// ═══════════════════════════════════════════════════════════════

/**
 * SSE event types broadcast by the server.
 */
export type SseEventType =
  | 'log'
  | 'status'
  | 'state'
  | 'approval'
  | 'error'
  | 'codegen:live'
  | 'codegen:live-stop';

/**
 * A single SSE message with event type and data.
 */
export interface SseMessage {
  /** Monotonic message ID for ordering and replay */
  id: number;

  /** SSE event name */
  event: SseEventType | string;

  /** JSON-serialized data payload */
  data: string;
}

/**
 * Log entry stored in the SSE log buffer and broadcast to clients.
 */
export interface SseLogEntry {
  /** Unix timestamp in milliseconds */
  ts: number;

  /** The log line content (already redacted) */
  line: string;

  /** Source stream type */
  type: 'stdout' | 'stderr' | 'system';

  /** Associated ticket ID (null for global/system messages) */
  ticket: string | null;

  /** Log level (when broadcast from logging system) */
  level?: string;

  /** Correlation ID from the logging system */
  cid?: string;
}

/**
 * Connected SSE client information.
 */
export interface ClientInfo {
  /** Unique client identifier */
  id: string;

  /** The HTTP response object (opaque at type level) */
  res: unknown;

  /** Auth token for this connection session */
  sessionToken: string;

  /** Timestamp of last write activity (for LRU eviction) */
  lastActivity: number;

  /** Whether backpressure has paused writes to this client */
  paused: boolean;

  /** Messages queued while client is backpressured */
  pendingQueue: string[];
}

/**
 * SSE system status broadcast to clients.
 */
export interface SseStatus {
  /** Whether any agent is currently running */
  running: boolean;

  /** List of active agent ticket IDs */
  activeAgents?: string[];

  /** Exit code of the last completed agent (if applicable) */
  code?: number;

  /** Ticket associated with the status update */
  ticket?: string;
}

/**
 * SSE connection statistics for health/debug endpoints.
 */
export interface SseStats {
  /** Number of currently connected clients */
  totalClients: number;

  /** Maximum allowed total clients */
  maxClients: number;

  /** Maximum allowed clients per session token */
  maxPerSession: number;

  /** Number of unique session tokens */
  totalSessions: number;

  /** Number of messages in the replay buffer */
  replayBufferSize: number;

  /** Maximum replay buffer capacity */
  replayBufferMax: number;

  /** Next message ID to be assigned */
  nextMessageId: number;

  /** Number of entries in the merged log buffer */
  logBufferSize: number;
}

/**
 * Configuration for the SSE event hub.
 */
export interface EventHubConfig {
  /** Keepalive interval in milliseconds */
  keepaliveIntervalMs: number;

  /** Maximum total SSE connections */
  maxClientsTotal: number;

  /** Maximum connections per session token */
  maxClientsPerSession: number;

  /** Size of the circular replay buffer */
  replayBufferSize: number;

  /** Client reconnect delay in milliseconds */
  retryMs: number;

  /** Maximum log entries kept in memory */
  maxLog: number;
}
