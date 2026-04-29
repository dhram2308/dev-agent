// ===================================================================
// MI Dev Agent -- Zustand Codegen-Live Store
// Manages the live-diff snapshot streamed from the agents-team poller
// while `stageGenerateCode` is running. Populated from two sources:
//   1. SSE `codegen:live` / `codegen:live-stop` events (routed via
//      `hooks/useSSEConnection.ts`)
//   2. One-shot `/api/codegen/live?ticket=...` snapshot fetched on
//      first view of a ticket whose `stage === 'generate_code'` and
//      which has no entry yet (catches the window before the first
//      SSE tick arrives).
// ===================================================================

import { create } from 'zustand';
import type { FileChange } from '@mi/shared';
import { getApiToken } from '../lib/api';

// -- Types ----------------------------------------------------------

export interface LiveEntry {
  team: string;
  activeAgents: string[];
  changes: FileChange[];
  original_files: Record<string, string>;
  lastTs: number;
  stale: boolean;
}

export interface SetLivePatch {
  team: string;
  activeAgents: string[];
  changes: FileChange[];
  original_files: Record<string, string>;
  ts: number;
}

export interface CodegenLiveStore {
  liveByTicket: Map<string, LiveEntry>;
  setLive: (ticket: string, patch: SetLivePatch) => void;
  markStale: (ticket: string) => void;
  clearLive: (ticket: string) => void;
  hydrateFromSnapshot: (ticket: string) => Promise<void>;
}

// -- Store ----------------------------------------------------------

export const useCodegenLiveStore = create<CodegenLiveStore>((set, get) => ({
  liveByTicket: new Map(),

  setLive: (ticket, patch) => {
    const { liveByTicket } = get();
    const next = new Map(liveByTicket);
    next.set(ticket, {
      team: patch.team,
      activeAgents: patch.activeAgents,
      changes: patch.changes,
      original_files: patch.original_files,
      lastTs: patch.ts,
      stale: false,
    });
    set({ liveByTicket: next });
  },

  markStale: (ticket) => {
    const { liveByTicket } = get();
    const existing = liveByTicket.get(ticket);
    if (!existing) return;
    const next = new Map(liveByTicket);
    next.set(ticket, { ...existing, stale: true });
    set({ liveByTicket: next });
  },

  clearLive: (ticket) => {
    const { liveByTicket } = get();
    if (!liveByTicket.has(ticket)) return;
    const next = new Map(liveByTicket);
    next.delete(ticket);
    set({ liveByTicket: next });
  },

  hydrateFromSnapshot: async (ticket) => {
    try {
      const token = getApiToken();
      const qs = new URLSearchParams({ ticket });
      if (token) qs.set('token', token);
      const res = await fetch(`/api/codegen/live?${qs.toString()}`);
      if (!res.ok) return;
      const body = await res.json();
      if (body && body.live === true) {
        get().setLive(ticket, {
          team: typeof body.team === 'string' ? body.team : '',
          activeAgents: Array.isArray(body.activeAgents) ? body.activeAgents : [],
          changes: Array.isArray(body.changes) ? body.changes : [],
          original_files:
            body.original_files && typeof body.original_files === 'object'
              ? body.original_files
              : {},
          ts: typeof body.ts === 'number' ? body.ts : Date.now(),
        });
      }
    } catch {
      // Best-effort hydration; fall back to SSE.
    }
  },
}));

// -- Selectors ------------------------------------------------------

/** Get the live-codegen entry for a specific ticket, or null. */
export function useLiveForTicket(ticket: string | null): LiveEntry | null {
  return useCodegenLiveStore((s) => (ticket ? s.liveByTicket.get(ticket) ?? null : null));
}

/** Whether the store has any live entry for the given ticket. */
export function useIsLive(ticket: string | null): boolean {
  return useCodegenLiveStore((s) => (ticket ? s.liveByTicket.has(ticket) : false));
}
