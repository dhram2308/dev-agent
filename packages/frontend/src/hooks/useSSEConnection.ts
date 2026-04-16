// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — SSE Connection Bridge Hook
// Connects the useSSE hook to the Zustand pipeline store
// ═══════════════════════════════════════════════════════════════

import { useMemo, useEffect, useRef } from 'react';
import { useSSE, type SSEHandlers, type SSELogEvent, type SSEStateEvent, type SSEReviewEvent } from './useSSE';
import { useLeaderElection } from './useLeaderElection';
import { usePipelineStore } from '../store/pipeline';
import { useSettingsStore, type OAuthStatusInfo } from '../store/settings';
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

  // Only the leader tab opens the SSE connection; follower tabs rely on
  // the /api/pipelines fallback poll (below) to stay roughly in sync and
  // avoid piling up duplicate SSE streams on the server.
  const { isLeader } = useLeaderElection();

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
      if (!data.ticket) return;
      const store = usePipelineStore.getState();
      const tickets = store.tickets;
      const existing = tickets.get(data.ticket);
      const next = new Map(tickets);
      if (existing) {
        next.set(data.ticket, {
          ...existing,
          isRunning: data.running,
          stage: (data.stage as StageName) ?? existing.stage,
        });
      } else {
        // New ticket (e.g., started in another tab) — seed an entry
        // so we don't drop updates until the next /api/pipelines poll.
        next.set(data.ticket, {
          ticket: data.ticket,
          state: null,
          isRunning: data.running,
          stage: (data.stage as StageName) ?? 'fetch_ticket',
          stageStartedAt: null,
          pipelineStartedAt: null,
          logs: [],
          error: null,
          gateWaiting: null,
        });
      }
      usePipelineStore.setState({ tickets: next });
    },

    onPipelines: (data: unknown[]) => {
      usePipelineStore.getState().setPipelines(data as PipelineSummary[]);
    },

    onReview: (data: SSEReviewEvent) => {
      // Backend broadcasts { gate, action, ticket, feedback?, instructions? }
      // on every approve/reject/refine. Invalidate the active gate so the
      // modal closes immediately — the trailing `state` event refreshes the
      // rest of the pipeline.
      if (!data.ticket || !data.gate) return;
      usePipelineStore.getState().handleReviewEvent({
        ticket: data.ticket,
        gate: data.gate,
        action: data.action,
        feedback: data.feedback,
        instructions: data.instructions,
      });
    },

    onError: () => {
      usePipelineStore.getState().setSseConnected(false);
    },

    onConnectorConnected: (data) => {
      if (!data.provider) return;
      // Update settings store OAuth status
      const info: OAuthStatusInfo = {
        oauthStatus: 'CONNECTED',
        expiresAt: (data.expiresAt as number) ?? null,
        metadata: (data.metadata as { email?: string }) ?? undefined,
      };
      useSettingsStore.getState().updateOAuthStatus(data.provider, info);
      // Dispatch custom event for AuthRequiredBanner auto-dismiss
      window.dispatchEvent(
        new CustomEvent('mi:connector-connected', { detail: { provider: data.provider } }),
      );
    },

    onConnectorDisconnected: (data) => {
      if (!data.provider) return;
      useSettingsStore.getState().removeOAuthStatus(data.provider);
    },

    onConnectorError: (data) => {
      if (!data.provider) return;
      // Dispatch a custom event that ToastProvider can pick up
      window.dispatchEvent(
        new CustomEvent('mi:connector-error', {
          detail: { provider: data.provider, error: data.error ?? 'Connection error' },
        }),
      );
    },

    onAuthRequired: (data) => {
      if (!data.provider) return;
      // Update settings store to RE_AUTH_REQUIRED
      const info: OAuthStatusInfo = {
        oauthStatus: 'RE_AUTH_REQUIRED',
        metadata: undefined,
      };
      useSettingsStore.getState().updateOAuthStatus(data.provider, info);
      // Dispatch custom event for AuthRequiredBanner
      window.dispatchEvent(
        new CustomEvent('mi:auth-required', {
          detail: { provider: data.provider, reason: data.reason },
        }),
      );
    },

    onConfigChanged: (data) => {
      if (!data.changes) return;
      // Dispatch custom event so settings page and other components can react
      window.dispatchEvent(
        new CustomEvent('mi:config-changed', { detail: data.changes }),
      );
    },
  }), []);

  // Use the SSE hook - it manages connection lifecycle.
  // `enabled` is gated on leadership: only one tab holds the EventSource.
  const { connectionState } = useSSE('/api/logs', handlers, token || undefined, isLeader);

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

  // Fetch pipeline list on mount and poll every 30s as safety net.
  // After each fetch, sync per-ticket stage from pipeline summaries
  // so the UI updates even when SSE state events are missing.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const fetchAndSync = async () => {
      await usePipelineStore.getState().fetchPipelines();
      usePipelineStore.getState().syncStageFromPipelines();
    };

    // Initial fetch
    fetchAndSync();

    // Fallback poll every 30 seconds
    pollRef.current = setInterval(fetchAndSync, 30_000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);
}
