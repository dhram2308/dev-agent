// ═══════════════════════════════════════════════════════════════
// useTimer — Timer hook with requestAnimationFrame and proper cleanup
// Replaces setInterval-based timers from html.js (heartbeatTimer, etc.)
// Uses requestAnimationFrame for smooth display, pauses when tab hidden
// ═══════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback, useRef } from 'react';
import { useVisibility } from './useVisibility';

/** Return type for the useTimer hook */
export interface UseTimerResult {
  /** Elapsed time in milliseconds */
  elapsed: number;
  /** Formatted elapsed time string (e.g., "2h 15m 30s" or "45s") */
  formatted: string;
  /** Whether the timer is currently running */
  isRunning: boolean;
  /** Start the timer. Optionally provide a start timestamp (epoch ms). */
  start: (startTime?: number) => void;
  /** Stop the timer (pause). Elapsed time is preserved. */
  stop: () => void;
  /** Reset the timer to zero and stop it. */
  reset: () => void;
}

/**
 * Format elapsed milliseconds into a human-readable string.
 * Examples: "2h 15m 30s", "5m 12s", "45s", "0s"
 */
function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  // Always show seconds, even if 0 (when no hours/minutes)
  if (parts.length === 0 || seconds > 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}

/**
 * Timer hook with requestAnimationFrame-based updates.
 *
 * Features:
 * - requestAnimationFrame for smooth display (not setInterval)
 * - Pauses when tab is hidden (uses useVisibility)
 * - Cleanup on unmount -- no leaked intervals
 * - Format helper: "2h 15m 30s" or "45s"
 *
 * @param initialStartTime - Optional epoch timestamp to start from
 */
export function useTimer(initialStartTime?: number): UseTimerResult {
  const { visible } = useVisibility();

  // Core state
  const [elapsed, setElapsed] = useState<number>(0);
  const [isRunning, setIsRunning] = useState<boolean>(false);

  // Refs for animation frame tracking
  const rafIdRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const accumulatedRef = useRef<number>(0);
  const lastTickRef = useRef<number>(0);

  // Cancel any pending animation frame
  const cancelRaf = useCallback(() => {
    if (rafIdRef.current !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafIdRef.current);
      }
      rafIdRef.current = null;
    }
  }, []);

  // The animation frame loop
  const tick = useCallback(() => {
    if (!startTimeRef.current) return;

    const now = performance.now();
    const delta = now - lastTickRef.current;
    lastTickRef.current = now;

    accumulatedRef.current += delta;
    setElapsed(accumulatedRef.current);

    rafIdRef.current = requestAnimationFrame(tick);
  }, []);

  // Start the RAF loop
  const startLoop = useCallback(() => {
    cancelRaf();
    lastTickRef.current = performance.now();
    rafIdRef.current = requestAnimationFrame(tick);
  }, [cancelRaf, tick]);

  // Public API: start
  const start = useCallback((startTime?: number) => {
    if (startTime !== undefined) {
      // Calculate elapsed from provided start time
      accumulatedRef.current = Math.max(0, Date.now() - startTime);
    }
    startTimeRef.current = performance.now();
    lastTickRef.current = performance.now();
    setIsRunning(true);
    setElapsed(accumulatedRef.current);
    startLoop();
  }, [startLoop]);

  // Public API: stop
  const stop = useCallback(() => {
    cancelRaf();
    setIsRunning(false);
    startTimeRef.current = null;
  }, [cancelRaf]);

  // Public API: reset
  const reset = useCallback(() => {
    cancelRaf();
    accumulatedRef.current = 0;
    startTimeRef.current = null;
    setIsRunning(false);
    setElapsed(0);
  }, [cancelRaf]);

  // Handle initial startTime
  useEffect(() => {
    if (initialStartTime !== undefined && initialStartTime > 0) {
      start(initialStartTime);
    }
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pause/resume when tab visibility changes
  useEffect(() => {
    if (!isRunning) return;

    if (visible) {
      // Resume: restart the RAF loop
      startLoop();
    } else {
      // Pause: stop RAF but keep accumulated time
      cancelRaf();
    }
  }, [visible, isRunning, startLoop, cancelRaf]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelRaf();
    };
  }, [cancelRaf]);

  return {
    elapsed,
    formatted: formatElapsed(elapsed),
    isRunning,
    start,
    stop,
    reset,
  };
}

export { formatElapsed };
export default useTimer;
