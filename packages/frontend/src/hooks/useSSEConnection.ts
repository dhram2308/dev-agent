// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — SSE Connection Bridge Hook
// Connects the useSSE hook to the Zustand pipeline store
// ═══════════════════════════════════════════════════════════════

import { useMemo, useEffect, useRef } from 'react';
import { useSSE, type SSEHandlers, type SSELogEvent, type SSEStateEvent, type SSEReviewEvent } from './useSSE';
import { useLeaderElection } from './useLeaderElection';
import { usePipelineStore } from '../store/pipeline';
import { useSettingsStore, type OAuthStatusInfo } from '../store/settings';
import { useCodegenLiveStore } from '../store/codegenLive';
import { useAgentProgressStore } from '../store/agentProgress';
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

    onCodegenLive: (data) => {
      if (!data?.ticket) return;
      useCodegenLiveStore.getState().setLive(data.ticket, {
        team: data.team,
        activeAgents: data.activeAgents ?? [],
        changes: data.changes ?? [],
        original_files: data.original_files ?? {},
        ts: data.ts,
      });
    },

    onCodegenLiveStop: (data) => {
      if (!data?.ticket) return;
      useCodegenLiveStore.getState().markStale(data.ticket);
    },

    onAgentProgress: (data) => {
      if (!data?.ticket || !data?.agent || !data?.phase) return;
      useAgentProgressStore.getState().applyEvent(data);
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

  // Watch pipeline-store transitions to:
  //   (a) Clear a live entry when a ticket leaves `generate_code` — once
  //       we hit `gate_code_review` the frozen `/api/review` data becomes
  //       authoritative and the live snapshot is obsolete.
  //   (b) Hydrate the live entry exactly once when the active ticket
  //       changes to one currently in `generate_code` that has no entry
  //       yet (e.g. the user opens the UI mid-codegen).
  useEffect(() => {
    // Seed the previous-stage map from the current store snapshot so the
    // first subscribe fire doesn't treat every existing ticket as a
    // transition. We still hydrate below for the active ticket.
    const prevStages = new Map<string, StageName>();
    {
      const initial = usePipelineStore.getState();
      for (const [ticket, ts] of initial.tickets) {
        prevStages.set(ticket, ts.stage);
      }
      // Initial hydration pass for the currently-active ticket.
      const active = initial.activeTicket;
      if (active) {
        const ae = initial.tickets.get(active);
        const liveMap = useCodegenLiveStore.getState().liveByTicket;
        if (ae?.stage === 'generate_code' && !liveMap.has(active)) {
          useCodegenLiveStore.getState().hydrateFromSnapshot(active);
        }
      }
    }

    const unsubscribe = usePipelineStore.subscribe((state) => {
      // (a) Detect `generate_code` → later stage transitions.
      for (const [ticket, entry] of state.tickets) {
        const prev = prevStages.get(ticket);
        if (prev === 'generate_code' && entry.stage !== 'generate_code') {
          useCodegenLiveStore.getState().clearLive(ticket);
        }
        prevStages.set(ticket, entry.stage);
      }
      // Forget tickets that were removed from the store so we don't
      // grow the map indefinitely.
      for (const ticket of Array.from(prevStages.keys())) {
        if (!state.tickets.has(ticket)) {
          prevStages.delete(ticket);
        }
      }

      // (b) Hydrate on active-ticket change when that ticket is in
      // `generate_code` with no live entry yet.
      const active = state.activeTicket;
      if (active) {
        const activeEntry = state.tickets.get(active);
        const liveMap = useCodegenLiveStore.getState().liveByTicket;
        if (activeEntry?.stage === 'generate_code' && !liveMap.has(active)) {
          useCodegenLiveStore.getState().hydrateFromSnapshot(active);
        }
      }
    });

    return unsubscribe;
  }, []);
}
