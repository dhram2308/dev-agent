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

// ── Test Flow ───────────────────────────────────────────────────────

export const FLOW_STAGES: StageName[] = ['fetch_ticket', 'explore_plan', 'generate_code'];

export interface TestFlowStage {
  stage: StageName;
  runId: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number | null;
  finishedAt: number | null;
  summary: string | null;
  logsOpen: boolean;
}

export interface TestFlow {
  ticket: string;
  stages: TestFlowStage[];
  currentIndex: number;   // 0–2; which stage is active
  running: boolean;
  stopped: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────

let logIdCounter = 0;
function nextLogId(): string {
  return `pglog_${Date.now()}_${++logIdCounter}`;
}

function makePendingStages(): TestFlowStage[] {
  return FLOW_STAGES.map((stage) => ({
    stage,
    runId: null,
    status: 'pending' as const,
    startedAt: null,
    finishedAt: null,
    summary: null,
    logsOpen: false,
  }));
}

// ── Store Interface ─────────────────────────────────────────────────

export interface PlaygroundStore {
  runs: Map<string, PlaygroundRun>;
  activeRunId: string | null;
  prefillStage: StageName | null;
  prefillTicket: string | null;

  // Single-stage actions (existing)
  startRun: (stage: StageName, ticket: string | null, customInstruction: string) => Promise<{ ok: boolean; error?: string }>;
  stopRun: (runId: string) => Promise<{ ok: boolean; error?: string }>;
  viewRun: (runId: string) => Promise<{ ok: boolean; error?: string }>;
  appendLog: (runId: string, entry: { level?: string; message?: string; timestamp?: number }) => void;
  setStatus: (runId: string, status: PlaygroundRunStatus, summary?: string) => void;
  setActiveRun: (runId: string | null) => void;
  prefill: (stage: StageName, ticket?: string | null) => void;
  clearPrefill: () => void;

  // Test-flow actions (new)
  testFlow: TestFlow | null;
  startTestFlow: (ticket: string) => Promise<{ ok: boolean; error?: string }>;
  _startFlowStage: (index: number, ticket: string) => Promise<{ ok: boolean; error?: string }>;
  _advanceTestFlow: (completedRunId: string, finalStatus: PlaygroundRunStatus, summary?: string) => void;
  stopTestFlow: () => Promise<void>;
  toggleStageLog: (stageIndex: number) => void;
  resetTestFlow: () => void;
}

// ── Store Implementation ─────────────────────────────────────────────

export const usePlaygroundStore = create<PlaygroundStore>((set, get) => ({
  runs: new Map(),
  activeRunId: null,
  prefillStage: null,
  prefillTicket: null,
  testFlow: null,

  // ── Single-stage ──────────────────────────────────────────────────

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

  setStatus: (runId, status, summary) => {
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

    // Hook into the test flow chain
    if (isTerminal) {
      get()._advanceTestFlow(runId, status, summary);
    }
  },

  setActiveRun: (runId) => set({ activeRunId: runId }),
  prefill: (stage, ticket) => set({ prefillStage: stage, prefillTicket: ticket ?? null }),
  clearPrefill: () => set({ prefillStage: null, prefillTicket: null }),

  // ── Test-flow ─────────────────────────────────────────────────────

  resetTestFlow: () => set({ testFlow: null }),

  startTestFlow: async (ticket) => {
    set({
      testFlow: {
        ticket,
        stages: makePendingStages(),
        currentIndex: 0,
        running: true,
        stopped: false,
      },
    });
    return get()._startFlowStage(0, ticket);
  },

  _startFlowStage: async (index, ticket) => {
    const stage = FLOW_STAGES[index];
    let res: { ok: boolean; runId?: string; error?: string };
    try {
      res = await startPlaygroundRun(stage, ticket);
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    if (!res.ok || !res.runId) {
      const { testFlow } = get();
      if (testFlow) {
        const newStages = [...testFlow.stages];
        newStages[index] = { ...newStages[index], status: 'failed', startedAt: Date.now(), finishedAt: Date.now() };
        set({ testFlow: { ...testFlow, stages: newStages, running: false } });
      }
      return { ok: false, error: res.error ?? 'Stage failed to start' };
    }

    // Register the run in the runs map
    const run: PlaygroundRun = {
      runId: res.runId,
      stage,
      ticket,
      customInstruction: '',
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      logs: [],
    };
    const { testFlow, runs } = get();
    const nextRuns = new Map(runs);
    nextRuns.set(run.runId, run);

    if (testFlow) {
      const newStages = [...testFlow.stages];
      newStages[index] = {
        ...newStages[index],
        runId: res.runId,
        status: 'running',
        startedAt: Date.now(),
        logsOpen: true,
      };
      set({ runs: nextRuns, testFlow: { ...testFlow, stages: newStages }, activeRunId: res.runId });
    } else {
      set({ runs: nextRuns, activeRunId: res.runId });
    }
    return { ok: true };
  },

  _advanceTestFlow: (completedRunId, finalStatus, summary) => {
    const { testFlow } = get();
    if (!testFlow?.running) return;

    const { stages, currentIndex, ticket } = testFlow;
    const currentStage = stages[currentIndex];
    if (!currentStage || currentStage.runId !== completedRunId) return;

    // Update the completed stage
    const newStages = [...stages];
    newStages[currentIndex] = {
      ...currentStage,
      status: finalStatus,
      finishedAt: Date.now(),
      summary: summary ?? null,
      logsOpen: false,  // collapse on completion
    };

    const isLast = currentIndex >= FLOW_STAGES.length - 1;
    const chainContinues = finalStatus === 'completed' && !isLast && !testFlow.stopped;

    if (!chainContinues) {
      set({ testFlow: { ...testFlow, stages: newStages, running: false } });
      return;
    }

    const nextIndex = currentIndex + 1;
    set({ testFlow: { ...testFlow, stages: newStages, currentIndex: nextIndex } });
    get()._startFlowStage(nextIndex, ticket);
  },

  stopTestFlow: async () => {
    const { testFlow } = get();
    if (!testFlow?.running) return;

    set({ testFlow: { ...testFlow, running: false, stopped: true } });

    // Kill whichever stage is currently running
    const currentStage = testFlow.stages[testFlow.currentIndex];
    if (currentStage?.runId && currentStage.status === 'running') {
      try {
        await stopPlaygroundRun(currentStage.runId);
      } catch { /* ignore */ }
    }
  },

  toggleStageLog: (stageIndex) => {
    const { testFlow } = get();
    if (!testFlow) return;
    const newStages = [...testFlow.stages];
    newStages[stageIndex] = { ...newStages[stageIndex], logsOpen: !newStages[stageIndex].logsOpen };
    set({ testFlow: { ...testFlow, stages: newStages } });
  },
}));

// ── Selectors ────────────────────────────────────────────────────────

export function usePlaygroundRun(runId: string | null): PlaygroundRun | null {
  return usePlaygroundStore((s) => (runId ? s.runs.get(runId) ?? null : null));
}
