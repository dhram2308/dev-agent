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

/** Canonical ordering of pipeline stages for monotonic-guard dedup. */
const STAGE_ORDER: Record<StageName, number> = {
  fetch_ticket: 0,
  explore_plan: 1,
  generate_code: 2,
  gate_code_review: 3,
  deploy_qa: 4,
  test_qa: 5,
  gate_preprod_approval: 6,
  create_preprod_mr: 7,
  gate_dual_approval: 8,
  deploy_prod: 9,
  done: 10,
};

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

  /** Global uncaught error for ErrorOverlay (null when no error) */
  globalError: Error | string | null;

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
  syncStageFromPipelines: () => void;

  // Agent control
  startAgent: (ticket: string, mode?: 'resume' | 'fresh') => Promise<void>;
  stopAgent: (ticket?: string) => Promise<void>;
  resetAgent: (ticket?: string) => Promise<void>;
  deletePipeline: (ticket: string) => Promise<void>;

  // Gate actions
  approveGate: (ticket: string, gate: string) => Promise<void>;
  rejectGate: (ticket: string, gate: string, reason: string) => Promise<void>;
  refineGate: (ticket: string, gate: string, instructions: string) => Promise<void>;

  // Clarifying-questions actions (plan-clarifying-questions)
  answerQuestions: (
    ticket: string,
    answers: Array<{ id: string; choice: number }>,
    via?: 'user' | 'ai-default',
  ) => Promise<void>;
  acceptAllAIPicks: (ticket: string) => Promise<void>;

  /**
   * Apply a `review` SSE event (approve/reject/refine). Clears `gateWaiting`
   * on the target ticket so any mounted `GateApproval` unmounts immediately
   * without waiting for the trailing `state` broadcast.
   */
  handleReviewEvent: (payload: {
    ticket: string;
    gate: string;
    action: string;
    feedback?: string;
    instructions?: string;
  }) => void;

  // On-demand state loading
  fetchTicketState: (ticket: string) => Promise<void>;

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

  // Global error (surfaces ErrorOverlay)
  setGlobalError: (error: Error | string | null) => void;
  clearGlobalError: () => void;
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
  const { stage, data } = state;

  // explore_plan: plan posted to Jira, waiting for UI approval
  if (stage === 'explore_plan' && data.explore_plan_posted && !data.explore_plan_ui_approved) {
    return 'explore_plan';
  }
  // gate_code_review: MR created, waiting for code review approval
  if (stage === 'gate_code_review' && data.code_mr_iid && !data.gate_code_review_ui_approved) {
    return 'gate_code_review';
  }
  // gate_preprod_approval: pre-prod gate posted, waiting for approval
  if (stage === 'gate_preprod_approval' && data.gate2a_posted && !data.gate_preprod_approval_ui_approved) {
    return 'gate_preprod_approval';
  }
  // gate_dual_approval: dual gate posted, waiting for approval
  if (stage === 'gate_dual_approval' && data.gate2b_posted && !data.gate_dual_approval_ui_approved) {
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
  globalError: null,
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

  syncStageFromPipelines: () => {
    const { pipelines, tickets } = get();
    if (pipelines.length === 0) return;

    let changed = false;
    const next = new Map(tickets);

    for (const p of pipelines) {
      const pipelineStage = p.stage as StageName;
      const ts = next.get(p.ticket);

      if (!ts) {
        // Seed a new ticket entry from pipeline summary so it has
        // correct stage immediately (instead of defaulting to fetch_ticket)
        changed = true;
        next.set(p.ticket, {
          ...createTicketState(p.ticket),
          stage: pipelineStage,
          isRunning: p.running,
        });
        continue;
      }

      const pipelineOrder = STAGE_ORDER[pipelineStage] ?? -1;
      const currentOrder = STAGE_ORDER[ts.stage] ?? -1;

      // Only advance forward (monotonic) to avoid flickering
      if (pipelineOrder > currentOrder) {
        changed = true;
        next.set(p.ticket, {
          ...ts,
          stage: pipelineStage,
          isRunning: p.running,
          stageStartedAt: Date.now(),
        });
      } else if (ts.isRunning !== p.running) {
        // Sync running status even if stage hasn't changed
        changed = true;
        next.set(p.ticket, { ...ts, isRunning: p.running });
      }
    }

    if (changed) set({ tickets: next });
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

  refineGate: async (ticket, gate, instructions) => {
    try {
      await api.submitRefine(ticket, gate, instructions);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      get().setError(ticket, message);
    }
  },

  // Clarifying-questions — POST answers; the trailing SSE `state` event
  // refreshes tickets.get(ticket).state.data._pending_questions for us.
  answerQuestions: async (ticket, answers, via = 'user') => {
    if (!answers || answers.length === 0) return;
    try {
      await api.answerQuestions(ticket, answers, via);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      get().setError(ticket, message);
    }
  },

  acceptAllAIPicks: async (ticket) => {
    const entry = get().tickets.get(ticket);
    const pending = (entry?.state?.data as any)?._pending_questions as
      | Array<{ id: string; recommend?: number }>
      | undefined;
    if (!pending || pending.length === 0) return;
    const answers = pending
      .filter((q) => typeof q.recommend === 'number')
      .map((q) => ({ id: q.id, choice: q.recommend as number }));
    if (answers.length === 0) return;
    await get().answerQuestions(ticket, answers, 'ai-default');
  },

  handleReviewEvent: ({ ticket }) => {
    // Clear the active gate so GateApproval unmounts immediately; a trailing
    // `state` event will re-populate downstream stage data.
    const { tickets } = get();
    const ts = tickets.get(ticket);
    if (!ts || ts.gateWaiting === null) return;
    const next = new Map(tickets);
    next.set(ticket, { ...ts, gateWaiting: null });
    set({ tickets: next });
  },

  // ── On-demand state loading ──

  fetchTicketState: async (ticket) => {
    try {
      const result = await api.getState(ticket);
      // Backend wraps PipelineState in { running, state, health, ... }
      const pipelineState = result?.state;
      if (pipelineState && pipelineState.stage && pipelineState.ticket) {
        get().updateState(pipelineState);
      }
      // Also sync running status from the response
      if (result) {
        const next = new Map(get().tickets);
        const ts = next.get(ticket);
        if (ts && ts.isRunning !== result.running) {
          next.set(ticket, { ...ts, isRunning: result.running });
          set({ tickets: next });
        }
      }
    } catch {
      // Non-fatal: state may not exist yet for new tickets
    }
  },

  // ── State updates ──

  updateState: (pipelineState) => {
    const ticket = pipelineState.ticket;
    if (!ticket) return;

    const next = new Map(get().tickets);
    const existing = next.get(ticket) ?? createTicketState(ticket);

    const incomingStage = pipelineState.stage;
    const incomingOrder = STAGE_ORDER[incomingStage] ?? -1;
    const existingOrder = STAGE_ORDER[existing.stage] ?? -1;
    const incomingPipelineStart = pipelineState.data._pipeline_start ?? null;

    // Guard: ignore events that carry a strictly earlier stage UNLESS a reset
    // happened (detected via a newer `_pipeline_start` or the ticket coming
    // back from `done`/not-running into a fresh run).
    const isReset =
      incomingPipelineStart !== null &&
      existing.pipelineStartedAt !== null &&
      incomingPipelineStart > existing.pipelineStartedAt;

    if (existing.state !== null && incomingOrder >= 0 && existingOrder > incomingOrder && !isReset) {
      if (import.meta.env.DEV) {
        console.warn(
          `[pipeline] dropping out-of-order state for ${ticket}: ${incomingStage} < ${existing.stage}`,
        );
      }
      return;
    }

    // Dedup: skip if the exact same (stage, _seq) was already applied.
    const incomingSeq = pipelineState._seq;
    const existingSeq = existing.state?._seq;
    if (
      existing.state !== null &&
      existing.stage === incomingStage &&
      incomingSeq !== undefined &&
      existingSeq !== undefined &&
      incomingSeq === existingSeq
    ) {
      if (import.meta.env.DEV) {
        console.warn(`[pipeline] dropping duplicate state for ${ticket} stage=${incomingStage} seq=${incomingSeq}`);
      }
      return;
    }

    const isRunning = incomingStage !== 'done' && (
      incomingStage !== 'fetch_ticket' ||
      pipelineState.data._pipeline_start != null
    );

    const stageChanged = existing.stage !== incomingStage;

    next.set(ticket, {
      ...existing,
      state: pipelineState,
      stage: incomingStage,
      isRunning,
      stageStartedAt: stageChanged ? Date.now() : existing.stageStartedAt,
      pipelineStartedAt: incomingPipelineStart ?? existing.pipelineStartedAt,
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

  setGlobalError: (error) => {
    set({ globalError: error });
  },

  clearGlobalError: () => {
    set({ globalError: null });
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

/**
 * Read pending clarifying questions for a ticket.
 * Returns the array from `state.data._pending_questions`, or `[]` if absent.
 */
export function usePendingQuestions(
  ticket: string | null,
): import('@mi/shared').PendingQuestion[] {
  return usePipelineStore((s) => {
    if (!ticket) return [];
    const entry = s.tickets.get(ticket);
    const pending = (entry?.state?.data as any)?._pending_questions;
    return Array.isArray(pending) ? pending : [];
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
