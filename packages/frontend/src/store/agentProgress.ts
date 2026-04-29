// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Zustand Agent-Progress Store
// Tracks per-ticket agent lifecycle from two sources:
//   1. SSE `agent:progress` events routed via useSSEConnection
//   2. One-shot `/api/agents/progress?ticket=...` hydration on first
//      view of a ticket in `generate_code` with no entry yet
//
// Mirrors the shape + conventions of `codegenLive.ts`.
// ═══════════════════════════════════════════════════════════════

import { create } from 'zustand';
import { getApiToken } from '../lib/api';

// -- Wire types (local copies; backend may later publish via @mi/shared) --

export type AgentPhase = 'start' | 'complete' | 'failed';

export interface AgentProgressEvent {
  ticket: string;
  team: string;
  agent: string;
  phase: AgentPhase;
  ts: number;
  startedAt: number;
  required: boolean;
  durationMs?: number;
  outputChars?: number;
  promptChars?: number;
  timeoutMs?: number;
  maxTurns?: number | null;
  errorMessage?: string;
}

export interface ActiveAgent {
  name: string;
  team: string;
  startedAt: number;
  phase: 'running';
  // Kept for drawer rendering when a row is still live.
  promptChars?: number;
  timeoutMs?: number;
  maxTurns?: number | null;
  required?: boolean;
}

export interface HistoryAgent {
  name: string;
  team: string;
  startedAt: number;
  durationMs: number;
  phase: 'complete' | 'failed';
  outputChars?: number;
  required: boolean;
  errorMessage?: string;
  // Preserved from the matching `start` event when available.
  promptChars?: number;
  timeoutMs?: number;
  maxTurns?: number | null;
}

export interface ProgressEntry {
  active: ActiveAgent[];
  history: HistoryAgent[];
  ts: number;
}

export interface HydrationResponse {
  live: boolean;
  active: ActiveAgent[];
  history: HistoryAgent[];
  ts: number;
}

export interface AgentProgressStore {
  byTicket: Map<string, ProgressEntry>;
  applyEvent: (ev: AgentProgressEvent) => void;
  hydrate: (ticket: string) => Promise<void>;
  clear: (ticket: string) => void;
}

// -- Helpers ---------------------------------------------------------

function emptyEntry(): ProgressEntry {
  return { active: [], history: [], ts: 0 };
}

function sameHistoryRecord(a: HistoryAgent, name: string, startedAt: number): boolean {
  return a.name === name && a.startedAt === startedAt;
}

// -- Store -----------------------------------------------------------

export const useAgentProgressStore = create<AgentProgressStore>((set, get) => ({
  byTicket: new Map(),

  applyEvent: (ev) => {
    const { byTicket } = get();
    const existing = byTicket.get(ev.ticket) ?? emptyEntry();

    // Drop stale events when a newer one for the same key is already applied.
    // We only compare per-entry below (per agent + phase bucket) so a late
    // `start` doesn't resurrect a finished row.
    const nextTs = Math.max(existing.ts, ev.ts);

    let active = existing.active;
    let history = existing.history;

    if (ev.phase === 'start') {
      const already = active.find((a) => a.name === ev.agent);
      if (!already) {
        active = [
          ...active,
          {
            name: ev.agent,
            team: ev.team,
            startedAt: ev.startedAt,
            phase: 'running',
            promptChars: ev.promptChars,
            timeoutMs: ev.timeoutMs,
            maxTurns: ev.maxTurns,
            required: ev.required,
          },
        ];
      } else if (already.startedAt < ev.startedAt) {
        // Re-emitted start with a newer run — refresh in place.
        active = active.map((a) =>
          a.name === ev.agent
            ? {
                ...a,
                startedAt: ev.startedAt,
                team: ev.team,
                promptChars: ev.promptChars,
                timeoutMs: ev.timeoutMs,
                maxTurns: ev.maxTurns,
                required: ev.required,
              }
            : a,
        );
      }
    } else {
      // Terminal phases: remove from active, append to history if new.
      const activeMatch = active.find((a) => a.name === ev.agent);
      active = active.filter((a) => a.name !== ev.agent);

      const dup = history.find((h) => sameHistoryRecord(h, ev.agent, ev.startedAt));
      if (!dup) {
        history = [
          ...history,
          {
            name: ev.agent,
            team: ev.team,
            startedAt: ev.startedAt,
            durationMs: ev.durationMs ?? 0,
            phase: ev.phase === 'failed' ? 'failed' : 'complete',
            outputChars: ev.outputChars,
            required: ev.required,
            errorMessage: ev.errorMessage,
            promptChars: activeMatch?.promptChars,
            timeoutMs: activeMatch?.timeoutMs,
            maxTurns: activeMatch?.maxTurns,
          },
        ];
      }
    }

    const next = new Map(byTicket);
    next.set(ev.ticket, { active, history, ts: nextTs });
    set({ byTicket: next });
  },

  hydrate: async (ticket) => {
    try {
      const token = getApiToken();
      const qs = new URLSearchParams({ ticket });
      if (token) qs.set('token', token);
      const res = await fetch(`/api/agents/progress?${qs.toString()}`);
      if (!res.ok) return;
      const body = (await res.json()) as Partial<HydrationResponse>;
      const active = Array.isArray(body.active) ? body.active : [];
      const history = Array.isArray(body.history) ? body.history : [];
      const ts = typeof body.ts === 'number' ? body.ts : Date.now();
      const { byTicket } = get();
      const next = new Map(byTicket);
      next.set(ticket, { active, history, ts });
      set({ byTicket: next });
    } catch {
      // Best-effort hydration; SSE will backfill.
    }
  },

  clear: (ticket) => {
    const { byTicket } = get();
    if (!byTicket.has(ticket)) return;
    const next = new Map(byTicket);
    next.delete(ticket);
    set({ byTicket: next });
  },
}));

// -- Selectors -------------------------------------------------------

export function useAgentProgress(ticket: string | null): ProgressEntry | null {
  return useAgentProgressStore((s) => (ticket ? s.byTicket.get(ticket) ?? null : null));
}

export function useActiveAgents(ticket: string | null): ActiveAgent[] {
  return useAgentProgressStore((s) => (ticket ? s.byTicket.get(ticket)?.active ?? [] : []));
}

export function useAgentHistory(ticket: string | null): HistoryAgent[] {
  return useAgentProgressStore((s) => (ticket ? s.byTicket.get(ticket)?.history ?? [] : []));
}
