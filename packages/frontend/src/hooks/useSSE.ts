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

/** Handler callbacks for SSE events */
export interface SSEHandlers {
  onLog?: (data: SSELogEvent) => void;
  onStatus?: (data: SSEStatusEvent) => void;
  onState?: (data: SSEStateEvent) => void;
  onPipelines?: (data: unknown[]) => void;
  onError?: (error: Event) => void;
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
      try {
        eventSourceRef.current.onopen = null;
        eventSourceRef.current.onerror = null;
        eventSourceRef.current.close();
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

    // Listen for "log" events
    es.addEventListener('log', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSELogEvent;
        handlersRef.current.onLog?.(data);
      } catch {
        // Malformed JSON -- skip
      }
    });

    // Listen for "status" events
    es.addEventListener('status', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEStatusEvent;
        handlersRef.current.onStatus?.(data);
      } catch {
        // Malformed JSON -- skip
      }
    });

    // Listen for "state" events
    es.addEventListener('state', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as SSEStateEvent;
        handlersRef.current.onState?.(data);
      } catch {
        // Malformed JSON -- skip
      }
    });

    // Listen for "pipelines" events (pipeline dashboard list)
    es.addEventListener('pipelines', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as unknown[];
        handlersRef.current.onPipelines?.(data);
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
