// ═══════════════════════════════════════════════════════════════
// useSSE — Server-Sent Events connection hook
// Port from html.js connectSSE() (lines 3644-3730)
// Adds auto-reconnect, exponential backoff, auth token, cleanup
// ═══════════════════════════════════════════════════════════════
import { useEffect, useRef, useState, useCallback } from 'react';
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
export function useSSE(url, handlers, token, enabled = true) {
    const [connectionState, setConnectionState] = useState('disconnected');
    // Refs to avoid stale closures
    const handlersRef = useRef(handlers);
    handlersRef.current = handlers;
    const eventSourceRef = useRef(null);
    const reconnectTimerRef = useRef(null);
    const retryDelayRef = useRef(INITIAL_RETRY_MS);
    const mountedRef = useRef(true);
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;
    /**
     * Track every `(eventName, handler)` pair registered via `addEventListener` on
     * the current EventSource. We iterate this list on close to remove each
     * listener before calling `.close()`, preventing listener accumulation across
     * reconnects (one reconnect attaches 5 new listeners; without tracking they'd
     * leak until the hook unmounts).
     */
    const listenersRef = useRef([]);
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
                    es.removeEventListener(event, handler);
                }
                listenersRef.current = [];
                es.onopen = null;
                es.onerror = null;
                es.close();
            }
            catch {
                // Ignore close errors
            }
            eventSourceRef.current = null;
        }
    }, []);
    // Connect to SSE
    const connect = useCallback(() => {
        if (!mountedRef.current || !enabledRef.current)
            return;
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
        const addTracked = (event, handler) => {
            es.addEventListener(event, handler);
            listenersRef.current.push({ event, handler });
        };
        // Listen for "log" events
        addTracked('log', (e) => {
            try {
                const data = JSON.parse(e.data);
                handlersRef.current.onLog?.(data);
            }
            catch {
                // Malformed JSON -- skip
            }
        });
        // Listen for "status" events
        addTracked('status', (e) => {
            try {
                const data = JSON.parse(e.data);
                handlersRef.current.onStatus?.(data);
            }
            catch {
                // Malformed JSON -- skip
            }
        });
        // Listen for "state" events
        addTracked('state', (e) => {
            try {
                const data = JSON.parse(e.data);
                handlersRef.current.onState?.(data);
            }
            catch {
                // Malformed JSON -- skip
            }
        });
        // Listen for "pipelines" events (pipeline dashboard list)
        addTracked('pipelines', (e) => {
            try {
                const data = JSON.parse(e.data);
                handlersRef.current.onPipelines?.(data);
            }
            catch {
                // Malformed JSON -- skip
            }
        });
        // Listen for "review" events (gate approve/reject/refine broadcasts) —
        // lets GateApproval close its modal without waiting for the trailing state
        // broadcast.
        addTracked('review', (e) => {
            try {
                const data = JSON.parse(e.data);
                handlersRef.current.onReview?.(data);
            }
            catch {
                // Malformed JSON -- skip
            }
        });
        // Listen for "connectorConnected" events
        addTracked('connectorConnected', (e) => {
            try {
                const data = JSON.parse(e.data);
                handlersRef.current.onConnectorConnected?.(data);
            }
            catch {
                // Malformed JSON -- skip
            }
        });
        // Listen for "connectorDisconnected" events
        addTracked('connectorDisconnected', (e) => {
            try {
                const data = JSON.parse(e.data);
                handlersRef.current.onConnectorDisconnected?.(data);
            }
            catch {
                // Malformed JSON -- skip
            }
        });
        // Listen for "connectorError" events
        addTracked('connectorError', (e) => {
            try {
                const data = JSON.parse(e.data);
                handlersRef.current.onConnectorError?.(data);
            }
            catch {
                // Malformed JSON -- skip
            }
        });
        // Listen for "authRequired" events
        addTracked('authRequired', (e) => {
            try {
                const data = JSON.parse(e.data);
                handlersRef.current.onAuthRequired?.(data);
            }
            catch {
                // Malformed JSON -- skip
            }
        });
        // Listen for "configChanged" events (hot-reload)
        addTracked('configChanged', (e) => {
            try {
                const data = JSON.parse(e.data);
                handlersRef.current.onConfigChanged?.(data);
            }
            catch {
                // Malformed JSON -- skip
            }
        });
        // Connection opened successfully
        es.onopen = () => {
            if (!mountedRef.current)
                return;
            setConnectionState('connected');
            // Reset backoff on successful connection
            retryDelayRef.current = INITIAL_RETRY_MS;
        };
        // Connection error -- schedule reconnect with backoff
        es.onerror = (error) => {
            if (!mountedRef.current)
                return;
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
            retryDelayRef.current = Math.min(retryDelayRef.current * BACKOFF_MULTIPLIER, MAX_RETRY_MS);
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
        }
        else {
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
