// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Zustand Pipeline Store
// Manages multi-ticket state, SSE connection, logs, and actions
// ═══════════════════════════════════════════════════════════════

import { create } from 'zustand';
import type {
  StageName,
  PipelineState,
  PipelineTicketState,
  PipelineSummary,
  LogEntry,
  ReviewData,
} from '../types';
import * as api from '../lib/api';

// ── Constants ──────────────────────────────────────────────────

/** Maximum number of log entries to keep in memory per ticket */
const MAX_LOG_ENTRIES = 5000;

/** Stuck detection threshold in milliseconds (10 minutes) */
const STUCK_THRESHOLD_MS = 10 * 60 * 1000;

// ── Store Interface ────────────────────────────────────────────

export interface PipelineStore {
  // Multi-ticket state
  tickets: Map<string, PipelineTicketState>;
  activeTicket: string | null;

  // Pipeline dashboard list (from /api/pipelines)
  pipelines: PipelineSummary[];

  // Global state
  sseConnected: boolean;
  sseRetryCount: number;
  lastHeartbeat: number | null;

  // Review data for the active ticket
  reviewData: ReviewData | null;

  // ── Computed getters (via selectors) ──
  // Use selectors like useActiveTicketState() below

  // ── Actions ──
  setActiveTicket: (ticket: string | null) => void;
  addTicket: (ticket: string) => void;
  removeTicket: (ticket: string) => void;

  // Pipeline dashboard
  setPipelines: (pipelines: PipelineSummary[]) => void;
  fetchPipelines: () => Promise<void>;

  // Agent control
  startAgent: (ticket: string, mode?: 'resume' | 'fresh') => Promise<void>;
  stopAgent: (ticket?: string) => Promise<void>;
  resetAgent: (ticket?: string) => Promise<void>;
  deletePipeline: (ticket: string) => Promise<void>;

  // Gate actions
  approveGate: (ticket: string, gate: string) => Promise<void>;
  rejectGate: (ticket: string, gate: string, reason: string) => Promise<void>;

  // State updates (from SSE or polling)
  updateState: (state: PipelineState) => void;
  updateReviewData: (data: ReviewData | null) => void;
  addLog: (entry: LogEntry) => void;
  addLogBatch: (entries: LogEntry[]) => void;

  // SSE connection
  setSseConnected: (connected: boolean) => void;
  setSseRetryCount: (count: number) => void;
  setLastHeartbeat: (ts: number) => void;

  // Error handling
  setError: (ticket: string, error: string | null) => void;
  clearError: (ticket: string) => void;
}

// ── Helper: create default ticket state ────────────────────────

function createTicketState(ticket: string): PipelineTicketState {
  return {
    ticket,
    state: null,
    isRunning: false,
    stage: 'fetch_ticket',
    stageStartedAt: null,
    pipelineStartedAt: null,
    logs: [],
    error: null,
    gateWaiting: null,
  };
}

// ── Helper: detect gate waiting ────────────────────────────────

function detectGateWaiting(state: PipelineState): StageName | null {
  const stage = state.stage;
  const data = state.data;

  if (stage === 'explore_plan' && data.explore_plan) {
    // Plan is ready, waiting for approval
    if (!data._ui_approve_gate) return 'explore_plan';
  }
  if (stage === 'gate_code_review' && !data._ui_approve_gate) {
    return 'gate_code_review';
  }
  if (stage === 'gate_preprod_approval' && !data._ui_approve_preprod) {
    return 'gate_preprod_approval';
  }
  if (stage === 'gate_dual_approval' && !data._ui_approve_dual) {
    return 'gate_dual_approval';
  }
  return null;
}

// ── Store ──────────────────────────────────────────────────────

export const usePipelineStore = create<PipelineStore>((set, get) => ({
  tickets: new Map(),
  activeTicket: null,
  pipelines: [],
  sseConnected: false,
  sseRetryCount: 0,
  lastHeartbeat: null,
  reviewData: null,

  setActiveTicket: (ticket) => {
    set({ activeTicket: ticket, reviewData: null });
  },

  addTicket: (ticket) => {
    const { tickets } = get();
    if (tickets.has(ticket)) return;
    const next = new Map(tickets);
    next.set(ticket, createTicketState(ticket));
    set({ tickets: next, activeTicket: ticket });
  },

  removeTicket: (ticket) => {
    const { tickets, activeTicket } = get();
    const next = new Map(tickets);
    next.delete(ticket);
    const newActive = activeTicket === ticket
      ? (next.size > 0 ? next.keys().next().value ?? null : null)
      : activeTicket;
    set({ tickets: next, activeTicket: newActive });
  },

  // ── Pipeline dashboard ──

  setPipelines: (pipelines) => {
    set({ pipelines });
  },

  fetchPipelines: async () => {
    try {
      const result = await api.getPipelines();
      if (result.ok) {
        set({ pipelines: result.pipelines });
      }
    } catch {
      // Non-fatal: SSE will provide updates
    }
  },

  // ── Agent control ──

  startAgent: async (ticket, mode) => {
    const { tickets } = get();
    // Ensure ticket exists in store
    if (!tickets.has(ticket)) {
      get().addTicket(ticket);
    }

    try {
      await api.startAgent(ticket, mode);

      // Update the ticket state to running
      const next = new Map(get().tickets);
      const ts = next.get(ticket);
      if (ts) {
        next.set(ticket, {
          ...ts,
          isRunning: true,
          pipelineStartedAt: Date.now(),
          stageStartedAt: Date.now(),
          error: null,
          logs: [],
        });
      }
      set({ tickets: next, activeTicket: ticket });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      get().setError(ticket, message);
    }
  },

  stopAgent: async (ticket) => {
    try {
      await api.stopAgent(ticket);

      if (ticket) {
        const next = new Map(get().tickets);
        const ts = next.get(ticket);
        if (ts) {
          next.set(ticket, { ...ts, isRunning: false });
        }
        set({ tickets: next });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const t = ticket ?? get().activeTicket;
      if (t) get().setError(t, message);
    }
  },

  resetAgent: async (ticket) => {
    try {
      await api.resetAgent(ticket);

      if (ticket) {
        const next = new Map(get().tickets);
        next.set(ticket, createTicketState(ticket));
        set({ tickets: next, reviewData: null });
      } else {
        set({ tickets: new Map(), activeTicket: null, reviewData: null });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const t = ticket ?? get().activeTicket;
      if (t) get().setError(t, message);
    }
  },

  deletePipeline: async (ticket) => {
    try {
      await api.deletePipeline(ticket);
      get().removeTicket(ticket);
      // pipelines list will update via SSE broadcast
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      get().setError(ticket, message);
    }
  },

  // ── Gate actions ──

  approveGate: async (ticket, gate) => {
    try {
      await api.approveGate(ticket, gate);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      get().setError(ticket, message);
    }
  },

  rejectGate: async (ticket, gate, reason) => {
    try {
      await api.rejectGate(ticket, gate, reason);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      get().setError(ticket, message);
    }
  },

  // ── State updates ──

  updateState: (pipelineState) => {
    const ticket = pipelineState.ticket;
    if (!ticket) return;

    const next = new Map(get().tickets);
    const existing = next.get(ticket) ?? createTicketState(ticket);

    const isRunning = pipelineState.stage !== 'done' && (
      pipelineState.stage !== 'fetch_ticket' ||
      pipelineState.data._pipeline_start != null
    );

    const stageChanged = existing.stage !== pipelineState.stage;

    next.set(ticket, {
      ...existing,
      state: pipelineState,
      stage: pipelineState.stage,
      isRunning,
      stageStartedAt: stageChanged ? Date.now() : existing.stageStartedAt,
      pipelineStartedAt: pipelineState.data._pipeline_start ?? existing.pipelineStartedAt,
      gateWaiting: detectGateWaiting(pipelineState),
    });

    set({ tickets: next });
  },

  updateReviewData: (data) => {
    set({ reviewData: data });
  },

  addLog: (entry) => {
    const ticket = entry.ticket ?? get().activeTicket;
    if (!ticket) return;

    const next = new Map(get().tickets);
    const ts = next.get(ticket);
    if (!ts) return;

    let logs = [...ts.logs, entry];
    if (logs.length > MAX_LOG_ENTRIES) {
      logs = logs.slice(logs.length - MAX_LOG_ENTRIES);
    }

    next.set(ticket, { ...ts, logs });
    set({ tickets: next });
  },

  addLogBatch: (entries) => {
    if (entries.length === 0) return;

    const buckets = new Map<string, LogEntry[]>();
    const activeTicket = get().activeTicket;

    for (const entry of entries) {
      const t = entry.ticket ?? activeTicket ?? '_default';
      const arr = buckets.get(t) ?? [];
      arr.push(entry);
      buckets.set(t, arr);
    }

    const next = new Map(get().tickets);

    for (const [ticket, newEntries] of buckets) {
      const ts = next.get(ticket);
      if (!ts) continue;

      let logs = [...ts.logs, ...newEntries];
      if (logs.length > MAX_LOG_ENTRIES) {
        logs = logs.slice(logs.length - MAX_LOG_ENTRIES);
      }
      next.set(ticket, { ...ts, logs });
    }

    set({ tickets: next });
  },

  // ── SSE connection ──

  setSseConnected: (connected) => {
    set({ sseConnected: connected, sseRetryCount: connected ? 0 : get().sseRetryCount });
  },

  setSseRetryCount: (count) => {
    set({ sseRetryCount: count });
  },

  setLastHeartbeat: (ts) => {
    set({ lastHeartbeat: ts });
  },

  // ── Error handling ──

  setError: (ticket, error) => {
    const next = new Map(get().tickets);
    const ts = next.get(ticket);
    if (ts) {
      next.set(ticket, { ...ts, error });
      set({ tickets: next });
    }
  },

  clearError: (ticket) => {
    get().setError(ticket, null);
  },
}));

// ── Selectors ──────────────────────────────────────────────────

/** Get the active ticket's state */
export function useActiveTicketState(): PipelineTicketState | null {
  return usePipelineStore((s) => {
    if (!s.activeTicket) return null;
    return s.tickets.get(s.activeTicket) ?? null;
  });
}

/** Get whether the active ticket is stuck (no activity for 10+ minutes) */
export function useIsStuck(): boolean {
  return usePipelineStore((s) => {
    if (!s.activeTicket) return false;
    const ts = s.tickets.get(s.activeTicket);
    if (!ts?.isRunning || !ts.stageStartedAt) return false;
    return Date.now() - ts.stageStartedAt > STUCK_THRESHOLD_MS;
  });
}

/** Get all ticket IDs as an array */
export function useTicketIds(): string[] {
  return usePipelineStore((s) => Array.from(s.tickets.keys()));
}

/** Get the active ticket's logs */
export function useActiveLogs(): LogEntry[] {
  return usePipelineStore((s) => {
    if (!s.activeTicket) return [];
    return s.tickets.get(s.activeTicket)?.logs ?? [];
  });
}

/** Get pipelines grouped by status */
export function useGroupedPipelines(): Record<string, PipelineSummary[]> {
  return usePipelineStore((s) => {
    const groups: Record<string, PipelineSummary[]> = {
      running: [],
      gate_waiting: [],
      paused: [],
      done: [],
      expired: [],
    };
    for (const p of s.pipelines) {
      (groups[p.status] ?? (groups[p.status] = [])).push(p);
    }
    return groups;
  });
}

/** Get the stage index (0-based) for progress display */
export function stageIndex(stage: StageName): number {
  const STAGES: StageName[] = [
    'fetch_ticket', 'explore_plan', 'generate_code',
    'gate_code_review', 'deploy_qa', 'test_qa',
    'gate_preprod_approval', 'create_preprod_mr',
    'gate_dual_approval', 'deploy_prod', 'done',
  ];
  return STAGES.indexOf(stage);
}
