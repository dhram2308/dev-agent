// ═══════════════════════════════════════════════════════════════
// usePolling — Fallback polling hook with visibility-aware pausing
// Replaces the setInterval/clearInterval patterns in html.js
// (pollState, fetchReview, pollAllTickets — lines 6239-6241)
// ═══════════════════════════════════════════════════════════════
import { useEffect, useRef, useCallback } from 'react';
import { useVisibility } from './useVisibility';
/** Backoff configuration for error retry */
const INITIAL_ERROR_DELAY_MS = 5_000;
const MAX_ERROR_DELAY_MS = 60_000;
const ERROR_BACKOFF_MULTIPLIER = 2;
/**
 * Fallback polling hook for when SSE is unavailable.
 *
 * Features:
 * - Fetch with auth header
 * - Configurable interval (default 5000ms)
 * - Enable/disable toggle
 * - Pause when tab is hidden (integrates with useVisibility)
 * - Cleanup on unmount
 * - Error retry with backoff
 *
 * Replaces the scattered setInterval/clearInterval patterns from html.js
 * (pollState every 5s, fetchReview every 10s, pollAllTickets every 5s).
 *
 * @param url - Endpoint URL to poll
 * @param intervalMs - Polling interval in milliseconds (default 5000)
 * @param opts - Configuration options
 */
export function usePolling(url, intervalMs = 5000, opts) {
    const { enabled = true, onData, onError, token, pauseOnHidden = true, fetchImmediately = true, } = opts ?? {};
    const { visible } = useVisibility();
    // Refs to avoid stale closures in intervals
    const onDataRef = useRef(onData);
    onDataRef.current = onData;
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;
    const tokenRef = useRef(token);
    tokenRef.current = token;
    const intervalRef = useRef(null);
    const errorDelayRef = useRef(INITIAL_ERROR_DELAY_MS);
    const errorTimerRef = useRef(null);
    const mountedRef = useRef(true);
    const fetchingRef = useRef(false);
    // Core fetch function
    const doFetch = useCallback(async () => {
        if (fetchingRef.current || !mountedRef.current)
            return;
        fetchingRef.current = true;
        try {
            const headers = {
                'Accept': 'application/json',
            };
            if (tokenRef.current) {
                headers['X-Api-Token'] = tokenRef.current;
            }
            const response = await fetch(url, { headers });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const data = await response.json();
            if (mountedRef.current) {
                onDataRef.current?.(data);
                // Reset error backoff on success
                errorDelayRef.current = INITIAL_ERROR_DELAY_MS;
            }
        }
        catch (err) {
            if (mountedRef.current) {
                const error = err instanceof Error ? err : new Error(String(err));
                onErrorRef.current?.(error);
                // Schedule retry with backoff (only if no interval is running)
                if (!intervalRef.current) {
                    errorTimerRef.current = setTimeout(() => {
                        if (mountedRef.current) {
                            doFetch();
                        }
                    }, errorDelayRef.current);
                    errorDelayRef.current = Math.min(errorDelayRef.current * ERROR_BACKOFF_MULTIPLIER, MAX_ERROR_DELAY_MS);
                }
            }
        }
        finally {
            fetchingRef.current = false;
        }
    }, [url]);
    // Clear all timers
    const clearTimers = useCallback(() => {
        if (intervalRef.current !== null) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
        if (errorTimerRef.current !== null) {
            clearTimeout(errorTimerRef.current);
            errorTimerRef.current = null;
        }
    }, []);
    // Start polling interval
    const startPolling = useCallback(() => {
        clearTimers();
        intervalRef.current = setInterval(() => {
            doFetch();
        }, intervalMs);
    }, [clearTimers, doFetch, intervalMs]);
    // Effect: manage polling lifecycle
    useEffect(() => {
        if (!enabled) {
            clearTimers();
            return;
        }
        const shouldPause = pauseOnHidden && !visible;
        if (shouldPause) {
            clearTimers();
        }
        else {
            // Fetch immediately when becoming visible or on mount
            if (fetchImmediately) {
                doFetch();
            }
            startPolling();
        }
        return () => {
            clearTimers();
        };
    }, [enabled, visible, pauseOnHidden, fetchImmediately, doFetch, startPolling, clearTimers]);
    // Track mount state for cleanup
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            clearTimers();
        };
    }, [clearTimers]);
    // Public: trigger immediate poll
    const pollNow = useCallback(() => {
        doFetch();
    }, [doFetch]);
    return { pollNow };
}
export default usePolling;
