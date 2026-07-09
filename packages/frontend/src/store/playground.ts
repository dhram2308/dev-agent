// ===================================================================
// MI Dev Agent -- Zustand Playground Store
// Tracks Playground runs (pick a stage, optionally borrow a real
// ticket's context, override the instruction, run it in isolation).
// Kept separate from usePipelineStore: that store's invariants
// (ticket-regex validation, STAGE_ORDER position tracking) don't fit
// a run that may have no real ticket at all.
//
// Populated from SSE `playground:log` / `playground:status` events,
// routed via hooks/useSSEConnection.ts.
// ===================================================================

import { create } from 'zustand';
import { startPlaygroundRun, stopPlaygroundRun, getPlaygroundRun } from '../lib/api';
import type { StageName } from '../types';

export type PlaygroundRunStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface PlaygroundLogEntry {
  id: string;
  timestamp: number;
  level: string;
  message: string;
}

export interface PlaygroundRun {
  runId: string;
  stage: StageName;
  ticket: string | null;
  customInstruction: string;
  status: PlaygroundRunStatus;
  startedAt: number;
  finishedAt: number | null;
  logs: PlaygroundLogEntry[];
}

let logIdCounter = 0;
function nextLogId(): string {
  return `pglog_${Date.now()}_${++logIdCounter}`;
}

export interface PlaygroundStore {
  runs: Map<string, PlaygroundRun>;
  activeRunId: string | null;
  /** Prefill values set by "Run this stage in Playground" deep links elsewhere in the app. */
  prefillStage: StageName | null;
  prefillTicket: string | null;

  startRun: (stage: StageName, ticket: string | null, customInstruction: string) => Promise<{ ok: boolean; error?: string }>;
  stopRun: (runId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Fetch a past run's persisted metadata (from GateApproval's "validated in Playground" link) and show it. */
  viewRun: (runId: string) => Promise<{ ok: boolean; error?: string }>;
  appendLog: (runId: string, entry: { level?: string; message?: string; timestamp?: number }) => void;
  setStatus: (runId: string, status: PlaygroundRunStatus) => void;
  setActiveRun: (runId: string | null) => void;
  prefill: (stage: StageName, ticket?: string | null) => void;
  clearPrefill: () => void;
}

export const usePlaygroundStore = create<PlaygroundStore>((set, get) => ({
  runs: new Map(),
  activeRunId: null,
  prefillStage: null,
  prefillTicket: null,

  startRun: async (stage, ticket, customInstruction) => {
    try {
      const res = await startPlaygroundRun(stage, ticket ?? undefined, customInstruction || undefined);
      if (!res.ok || !res.runId) {
        return { ok: false, error: res.error ?? 'Failed to start Playground run' };
      }
      const run: PlaygroundRun = {
        runId: res.runId,
        stage,
        ticket: ticket ?? null,
        customInstruction,
        status: 'running',
        startedAt: Date.now(),
        finishedAt: null,
        logs: [],
      };
      const next = new Map(get().runs);
      next.set(run.runId, run);
      set({ runs: next, activeRunId: run.runId });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  stopRun: async (runId) => {
    try {
      const res = await stopPlaygroundRun(runId);
      return res.ok ? { ok: true } : { ok: false, error: res.error ?? 'Failed to stop run' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  viewRun: async (runId) => {
    try {
      const res = await getPlaygroundRun(runId);
      if (!res.ok || !res.run) {
        return { ok: false, error: res.error ?? 'Run not found' };
      }
      const record = res.run;
      const run: PlaygroundRun = {
        runId: record.runId,
        stage: record.stage as StageName,
        ticket: record.ticket,
        customInstruction: record.customInstruction ?? '',
        status: record.status,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        // Historical runs only persist final metadata, not the full log
        // stream — show the result summary as the sole "log" line.
        logs: record.resultSummary
          ? [{ id: nextLogId(), timestamp: record.finishedAt ?? record.startedAt, level: 'info', message: record.resultSummary }]
          : [],
      };
      const next = new Map(get().runs);
      next.set(run.runId, run);
      set({ runs: next, activeRunId: run.runId });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  appendLog: (runId, entry) => {
    const { runs } = get();
    const run = runs.get(runId);
    if (!run) return;
    const next = new Map(runs);
    next.set(runId, {
      ...run,
      logs: [
        ...run.logs,
        {
          id: nextLogId(),
          timestamp: entry.timestamp ?? Date.now(),
          level: entry.level ?? 'info',
          message: entry.message ?? '',
        },
      ],
    });
    set({ runs: next });
  },

  setStatus: (runId, status) => {
    const { runs } = get();
    const run = runs.get(runId);
    if (!run) return;
    const next = new Map(runs);
    const isTerminal = status === 'completed' || status === 'failed' || status === 'stopped';
    next.set(runId, {
      ...run,
      status,
      finishedAt: isTerminal ? Date.now() : run.finishedAt,
    });
    set({ runs: next });
  },

  setActiveRun: (runId) => set({ activeRunId: runId }),

  prefill: (stage, ticket) => set({ prefillStage: stage, prefillTicket: ticket ?? null }),
  clearPrefill: () => set({ prefillStage: null, prefillTicket: null }),
}));

/** Get a specific run, or null. */
export function usePlaygroundRun(runId: string | null): PlaygroundRun | null {
  return usePlaygroundStore((s) => (runId ? s.runs.get(runId) ?? null : null));
}
