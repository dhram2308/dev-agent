// ═══════════════════════════════════════════════════════════════
// useSSE — Server-Sent Events connection hook
// Port from html.js connectSSE() (lines 3644-3730)
// Adds auto-reconnect, exponential backoff, auth token, cleanup
// ═══════════════════════════════════════════════════════════════

import { useEffect, useRef, useState, useCallback } from 'react';

/** SSE connection states */
export type SSEConnectionState = 'disconnected' | 'connected' | 'error';

/** Parsed SSE event data — matches the server's event types */
export interface SSELogEvent {
  ticket?: string | null;
  line?: string;
  level?: string;
  timestamp?: string;
  message?: string;
  [key: string]: unknown;
}

export interface SSEStatusEvent {
  ticket?: string;
  running: boolean;
  stage?: string;
  [key: string]: unknown;
}

export interface SSEStateEvent {
  ticket?: string;
  stage?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SSEReviewEvent {
  ticket: string;
  gate: string;
  action: 'approved' | 'rejected' | 'refined' | string;
  feedback?: string;
  instructions?: string;
  [key: string]: unknown;
}

export interface SSEAgentProgressEvent {
  ticket: string;
  team: string;
  agent: string;
  phase: 'start' | 'complete' | 'failed';
  ts: number;
  startedAt: number;
  required: boolean;
  durationMs?: number;
  outputChars?: number;
  promptChars?: number;
  timeoutMs?: number;
  maxTurns?: number | null;
  errorMessage?: string;
  [key: string]: unknown;
}

/** Handler callbacks for SSE events */
export interface SSEHandlers {
  onLog?: (data: SSELogEvent) => void;
  onStatus?: (data: SSEStatusEvent) => void;
  onState?: (data: SSEStateEvent) => void;
  onPipelines?: (data: unknown[]) => void;
  onReview?: (data: SSEReviewEvent) => void;
  onError?: (error: Event) => void;
  onConnectorConnected?: (data: { provider: string; [key: string]: unknown }) => void;
  onConnectorDisconnected?: (data: { provider: string; [key: string]: unknown }) => void;
  onConnectorError?: (data: { provider: string; error?: string; [key: string]: unknown }) => void;
  onAuthRequired?: (data: { provider: string; reason?: string; [key: string]: unknown }) => void;
  onConfigChanged?: (data: { changes: Record<string, string> }) => void;
  onCodegenLive?: (data: import('@mi/shared').CodegenLivePayload) => void;
  onCodegenLiveStop?: (data: import('@mi/shared').CodegenLiveStopPayload) => void;
  onAgentProgress?: (data: SSEAgentProgressEvent) => void;
}

/** Return type for the useSSE hook */
export interface UseSSEResult {
  /** Current connection state */
  connectionState: SSEConnectionState;
  /** Manually reconnect (resets backoff) */
  reconnect: () => void;
  /** Manually disconnect */
  disconnect: () => void;
}

/** Backoff configuration */
const INITIAL_RETRY_MS = 3_000;
const MAX_RETRY_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

/**
 * SSE connection hook with auto-reconnect and exponential backoff.
 *
 * Features:
 * - EventSource with auto-reconnect (3s initial retry)
 * - Connection state tracking (connected/disconnected/error)
 * - Parses SSE events: "log", "status", "state" event types
 * - Auth token via query param (?token=xxx) -- EventSource can't set headers
 * - Cleanup on unmount (close EventSource)
 * - Exponential backoff on repeated failures (3s, 6s, 12s, max 30s)
 * - Reset backoff on successful connection
 *
 * Ported from html.js connectSSE() (lines 3644-3730).
 *
 * @param url - SSE endpoint URL (e.g., "/api/logs")
 * @param handlers - Callbacks for different event types
 * @param token - Optional auth token appended as ?token=xxx
 * @param enabled - Whether SSE should be active (default true, set false for non-leader tabs)
 */
export function useSSE(
  url: string,
  handlers: SSEHandlers,
  token?: string,
  enabled: boolean = true
): UseSSEResult {
  const [connectionState, setConnectionState] = useState<SSEConnectionState>('disconnected');

  // Refs to avoid stale closures
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef<number>(INITIAL_RETRY_MS);
  const mountedRef = useRef<boolean>(true);
  const enabledRef = useRef<boolean>(enabled);
  enabledRef.current = enabled;

  /**
   * Track every `(eventName, handler)` pair registered via `addEventListener` on
   * the current EventSource. We iterate this list on close to remove each
   * listener before calling `.close()`, preventing listener accumulation across
   * reconnects (one reconnect attaches 5 new listeners; without tracking they'd
   * leak until the hook unmounts).
   */
  const listenersRef = useRef<Array<{ event: string; handler: (e: MessageEvent) => void }>>([]);

  // Clear any pending reconnect timer
  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  // Close existing EventSource and clean up listeners
  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      const es = eventSourceRef.current;
      try {
        // Detach every named listener we attached in connect()
        for (const { event, handler } of listenersRef.current) {
          es.removeEventListener(event, handler as EventListener);
        }
        listenersRef.current = [];
        es.onopen = null;
        es.onerror = null;
        es.close();
      } catch {
        // Ignore close errors
      }
      eventSourceRef.current = null;
    }
  }, []);

  // Connect to SSE
  const connect = useCallback(() => {
    if (!mountedRef.current || !enabledRef.current) return;

    // Close previous connection
    closeEventSource();
    clearReconnectTimer();

    // Build URL with auth token
    let fullUrl = url;
    if (token) {
      const separator = url.includes('?') ? '&' : '?';
      fullUrl = `${url}${separator}token=${encodeURIComponent(token)}`;
    }

    const es = new EventSource(fullUrl);
    eventSourceRef.current = es;

    // Register a named listener AND record the pair so closeEventSource() can
    // detach it — prevents accumulation across reconnects.
    const addTracked = (event: string, handler: (e: MessageEvent) => void): void => {
      es.addEventListener(event, handler as EventListener);
      listenersRef.current.push({ event, handler });
    };

    // Listen for "log" events
    addTracked('log', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSELogEvent;
        handlersRef.current.onLog?.(data);
      } catch {
        // Malformed JSON -- skip
      }
    });

    // Listen for "status" events
    addTracked('status', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEStatusEvent;
        handlersRef.current.onStatus?.(data);
      } catch {
        // Malformed JSON -- skip
      }
    });

    // Listen for "state" events
    addTracked('state', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEStateEvent;
        handlersRef.current.onState?.(data);
      } catch {
        // Malformed JSON -- skip
      }
    });

    // Listen for "pipelines" events (pipeline dashboard list)
    addTracked('pipelines', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as unknown[];
        handlersRef.current.onPipelines?.(data);
      } catch {
        // Malformed JSON -- skip
      }
    });

    // Listen for "review" events (gate approve/reject/refine broadcasts) —
    // lets GateApproval close its modal without waiting for the trailing state
    // broadcast.
    addTracked('review', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEReviewEvent;
        handlersRef.current.onReview?.(data);
      } catch {
        // Malformed JSON -- skip
      }
    });

    // Listen for "connectorConnected" events
    addTracked('connectorConnected', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { provider: string; [key: string]: unknown };
        handlersRef.current.onConnectorConnected?.(data);
      } catch {
        // Malformed JSON -- skip
      }
    });

    // Listen for "connectorDisconnected" events
    addTracked('connectorDisconnected', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { provider: string; [key: string]: unknown };
        handlersRef.current.onConnectorDisconnected?.(data);
      } catch {
        // Malformed JSON -- skip
      }
    });

    // Listen for "connectorError" events
    addTracked('connectorError', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { provider: string; error?: string; [key: string]: unknown };
        handlersRef.current.onConnectorError?.(data);
      } catch {
        // Malformed JSON -- skip
      }
    });

    // Listen for "authRequired" events
    addTracked('authRequired', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { provider: string; reason?: string; [key: string]: unknown };
        handlersRef.current.onAuthRequired?.(data);
      } catch {
        // Malformed JSON -- skip
      }
    });

    // Listen for "configChanged" events (hot-reload)
    addTracked('configChanged', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { changes: Record<string, string> };
        handlersRef.current.onConfigChanged?.(data);
      } catch {
        // Malformed JSON -- skip
      }
    });

    // Listen for "codegen:live" events (live-diff ticks from agents-team
    // poller during stageGenerateCode).
    addTracked('codegen:live', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as import('@mi/shared').CodegenLivePayload;
        handlersRef.current.onCodegenLive?.(data);
      } catch {
        // Malformed JSON -- skip
      }
    });

    // Listen for "codegen:live-stop" events (emitted in finally block of
    // runAgentsTeam once the team run completes).
    addTracked('codegen:live-stop', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as import('@mi/shared').CodegenLiveStopPayload;
        handlersRef.current.onCodegenLiveStop?.(data);
      } catch {
        // Malformed JSON -- skip
      }
    });

    addTracked('agent:progress', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEAgentProgressEvent;
        handlersRef.current.onAgentProgress?.(data);
      } catch {
        // Malformed JSON -- skip
      }
    });

    // Connection opened successfully
    es.onopen = () => {
      if (!mountedRef.current) return;
      setConnectionState('connected');
      // Reset backoff on successful connection
      retryDelayRef.current = INITIAL_RETRY_MS;
    };

    // Connection error -- schedule reconnect with backoff
    es.onerror = (error: Event) => {
      if (!mountedRef.current) return;
      setConnectionState('error');

      handlersRef.current.onError?.(error);

      // Schedule reconnect with exponential backoff
      const delay = retryDelayRef.current;
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current && enabledRef.current) {
          connect();
        }
      }, delay);

      // Increase backoff for next failure: 3s -> 6s -> 12s -> 24s -> 30s (capped)
      retryDelayRef.current = Math.min(
        retryDelayRef.current * BACKOFF_MULTIPLIER,
        MAX_RETRY_MS
      );
    };
  }, [url, token, closeEventSource, clearReconnectTimer]);

  // Disconnect completely
  const disconnect = useCallback(() => {
    clearReconnectTimer();
    closeEventSource();
    if (mountedRef.current) {
      setConnectionState('disconnected');
    }
  }, [clearReconnectTimer, closeEventSource]);

  // Manual reconnect (resets backoff)
  const reconnect = useCallback(() => {
    retryDelayRef.current = INITIAL_RETRY_MS;
    connect();
  }, [connect]);

  // Auto-connect on mount (or when enabled/url/token changes)
  useEffect(() => {
    if (enabled) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      // Cleanup: stop everything without setting state
      clearReconnectTimer();
      closeEventSource();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, url, token]);

  // Track mount state
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearReconnectTimer();
      closeEventSource();
    };
  }, [clearReconnectTimer, closeEventSource]);

  return {
    connectionState,
    reconnect,
    disconnect,
  };
}

export default useSSE;
