// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — SSE Connection Bridge Hook
// Connects the useSSE hook to the Zustand pipeline store
// ═══════════════════════════════════════════════════════════════

import { useMemo, useEffect, useRef } from 'react';
import { useSSE, type SSEHandlers, type SSELogEvent, type SSEStateEvent } from './useSSE';
import { usePipelineStore } from '../store/pipeline';
import { getApiToken } from '../lib/api';
import type { LogEntry, LogLevel, PipelineState, PipelineSummary, StageName } from '../types';

/** Unique log ID counter */
let logIdCounter = 0;
function nextLogId(): string {
  return `log_${Date.now()}_${++logIdCounter}`;
}

/**
 * Bridge hook: connects the generic useSSE hook to the Zustand store.
 * Dispatches SSE events (log, state, status) to the pipeline store.
 */
export function useSSEConnection(): void {
  const token = getApiToken();

  // Build handlers that dispatch to the store
  const handlers: SSEHandlers = useMemo(() => ({
    onLog: (data: SSELogEvent) => {
      const entry: LogEntry = {
        id: nextLogId(),
        timestamp: data.timestamp ? new Date(data.timestamp).getTime() : Date.now(),
        level: (data.level ?? 'info') as LogLevel,
        message: data.message ?? data.line ?? '',
        source: data.source as string | undefined,
        ticket: (data.ticket ?? undefined) as string | undefined,
      };
      usePipelineStore.getState().addLog(entry);
    },

    onState: (data: SSEStateEvent) => {
      // Map SSE state event to PipelineState
      if (data.stage && data.ticket) {
        const pipelineState: PipelineState = {
          ticket: data.ticket,
          stage: data.stage as StageName,
          data: (data.data ?? {}) as PipelineState['data'],
        };
        usePipelineStore.getState().updateState(pipelineState);
      }
    },

    onStatus: (data) => {
      // Status events tell us if the agent is running
      if (data.ticket) {
        const store = usePipelineStore.getState();
        const tickets = store.tickets;
        const existing = tickets.get(data.ticket);
        if (existing) {
          const next = new Map(tickets);
          next.set(data.ticket, {
            ...existing,
            isRunning: data.running,
            stage: (data.stage as StageName) ?? existing.stage,
          });
          // Direct state set via internal update
          usePipelineStore.setState({ tickets: next });
        }
      }
    },

    onPipelines: (data: unknown[]) => {
      usePipelineStore.getState().setPipelines(data as PipelineSummary[]);
    },

    onError: () => {
      usePipelineStore.getState().setSseConnected(false);
    },
  }), []);

  // Use the SSE hook - it manages connection lifecycle
  const { connectionState } = useSSE('/events', handlers, token || undefined);

  // Sync connection state to store (in useEffect to avoid setting state during render)
  useEffect(() => {
    const isConnected = connectionState === 'connected';
    const store = usePipelineStore.getState();
    if (store.sseConnected !== isConnected) {
      store.setSseConnected(isConnected);
    }
    if (isConnected) {
      store.setLastHeartbeat(Date.now());
    }
  }, [connectionState]);

  // Fetch pipeline list on mount and poll every 30s as safety net
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    // Initial fetch
    usePipelineStore.getState().fetchPipelines();

    // Fallback poll every 30 seconds
    pollRef.current = setInterval(() => {
      usePipelineStore.getState().fetchPipelines();
    }, 30_000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);
}
