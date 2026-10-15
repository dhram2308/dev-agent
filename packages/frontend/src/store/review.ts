// ===================================================================
// MI Dev Agent -- Zustand Review Store
// Manages diff viewer state: view mode, selected file, comments
// ===================================================================

import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { getComments, type RawCommentEntry } from '../lib/api';

// -- Types ----------------------------------------------------------

export type DiffViewMode = 'unified' | 'split';

export interface InlineCommentData {
  id: string;
  file: string;
  line: number;
  body: string;
  author: string;
  timestamp: number;
  pending?: boolean;
  /** When set, this comment is a reply to another comment with this id. */
  parentId?: string;
}

export interface ReviewStore {
  // View mode: split or unified
  viewMode: DiffViewMode;
  setViewMode: (mode: DiffViewMode) => void;

  // Currently selected file in the file tree
  selectedFile: string | null;
  setSelectedFile: (file: string | null) => void;

  // Inline comments keyed by `${file}:${line}`
  comments: Map<string, InlineCommentData[]>;
  addComment: (comment: InlineCommentData) => void;
  removeComment: (id: string) => void;
  setComments: (comments: Map<string, InlineCommentData[]>) => void;

  // Comment form state: which file:line is currently being edited
  commentingOn: { file: string; line: number } | null;
  setCommentingOn: (target: { file: string; line: number } | null) => void;

  // File search filter
  fileFilter: string;
  setFileFilter: (filter: string) => void;

  /**
   * When `true`, any mounted `GateApproval` component for a ticket paused at
   * a refine-eligible gate opens the refine form. Triggered by the global
   * `f` keyboard shortcut. Cleared once the form opens.
   */
  refineOpen: boolean;
  setRefineOpen: (open: boolean) => void;

  // Get all comments as a flat array
  getAllComments: () => InlineCommentData[];

  // Reset all review state
  reset: () => void;
}

// -- Helpers --------------------------------------------------------

function commentKey(file: string, line: number): string {
  return `${file}:${line}`;
}

// -- Store ----------------------------------------------------------

export const useReviewStore = create<ReviewStore>((set, get) => ({
  // Default to split mode — matches the GitHub side-by-side diff that
  // most reviewers expect. The toolbar still exposes the Unified toggle.
  viewMode: 'split',
  selectedFile: null,
  comments: new Map(),
  commentingOn: null,
  fileFilter: '',
  refineOpen: false,

  setViewMode: (mode) => set({ viewMode: mode }),

  setSelectedFile: (file) => set({ selectedFile: file }),

  addComment: (comment) => {
    const { comments } = get();
    const key = commentKey(comment.file, comment.line);
    const next = new Map(comments);
    const existing = next.get(key) ?? [];
    next.set(key, [...existing, comment]);
    set({ comments: next, commentingOn: null });
  },

  removeComment: (id) => {
    const { comments } = get();
    const next = new Map<string, InlineCommentData[]>();
    for (const [key, list] of comments) {
      const filtered = list.filter((c) => c.id !== id);
      if (filtered.length > 0) {
        next.set(key, filtered);
      }
    }
    set({ comments: next });
  },

  setComments: (comments) => set({ comments }),

  setCommentingOn: (target) => set({ commentingOn: target }),

  setFileFilter: (filter) => set({ fileFilter: filter }),

  setRefineOpen: (open) => set({ refineOpen: open }),

  getAllComments: () => {
    const result: InlineCommentData[] = [];
    for (const list of get().comments.values()) {
      result.push(...list);
    }
    return result.sort((a, b) => a.timestamp - b.timestamp);
  },

  reset: () =>
    set({
      viewMode: 'split',
      selectedFile: null,
      comments: new Map(),
      commentingOn: null,
      fileFilter: '',
      refineOpen: false,
    }),
}));

// -- Selectors ------------------------------------------------------

/** Get comments for a specific file and line */
export function useCommentsForLine(
  file: string,
  line: number,
): InlineCommentData[] {
  return useReviewStore((s) => {
    const key = commentKey(file, line);
    return s.comments.get(key) ?? [];
  });
}

/** Get total comment count */
export function useCommentCount(): number {
  return useReviewStore((s) => {
    let count = 0;
    for (const list of s.comments.values()) {
      count += list.length;
    }
    return count;
  });
}

// -- Server hydration -------------------------------------------------
//
// The backend already persists comments correctly (POST /api/comments'
// "Shape 2" append path — see lib/api.ts's submitComment/getComments).
// What's missing is a read path: nothing in the app ever calls GET
// /api/comments, so `comments` above is populated only by local
// `addComment()` calls and is lost on refresh. `hydrateFromRaw` +
// `useHydrateComments` close that gap.

/** Convert the backend's `{ "${file}:${line}": RawCommentEntry[] }` blob
 * into this store's `Map<string, InlineCommentData[]>`. The backend already
 * writes entries keyed identically to `commentKey()`, so this is a
 * near-direct copy — it only fills in defensive defaults for entries that
 * might be missing a field (e.g. hand-edited state, older data). */
export function hydrateFromRaw(
  raw: Record<string, RawCommentEntry[]>,
): Map<string, InlineCommentData[]> {
  const result = new Map<string, InlineCommentData[]>();
  for (const [key, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries)) continue;
    const [file, lineStr] = key.split(':');
    const line = Number(lineStr);
    const list: InlineCommentData[] = entries
      .filter((e) => e && typeof e.body === 'string')
      .map((e, i) => ({
        id: e.id ?? `srv-${key}-${i}`,
        file: e.file ?? file ?? '',
        line: typeof e.line === 'number' ? e.line : line,
        body: e.body,
        author: e.author ?? 'reviewer',
        timestamp: e.timestamp ?? 0,
        parentId: e.parentId,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
    if (list.length > 0) result.set(key, list);
  }
  return result;
}

const hydratedTickets = new Set<string>();

/** Clear the hydration cache — comment tests must call this between tickets. */
export function resetCommentHydrationCache(): void {
  hydratedTickets.clear();
}

/**
 * Hydrate `useReviewStore.comments` from the server on ticket mount/change.
 * Skips re-fetching a ticket already hydrated this session (comments are
 * low-volume and there's no SSE event for "a comment changed").
 */
export function useHydrateComments(ticket: string | null): void {
  const setComments = useReviewStore((s) => s.setComments);
  const inFlight = useRef<string | null>(null);

  useEffect(() => {
    if (!ticket || hydratedTickets.has(ticket) || inFlight.current === ticket) return;
    inFlight.current = ticket;
    let cancelled = false;
    getComments(ticket)
      .then((res) => {
        if (cancelled || !res.ok) return;
        hydratedTickets.add(ticket);
        const hydrated = hydrateFromRaw(res.comments);
        if (hydrated.size === 0) return;
        // Merge rather than replace — preserve any optimistic/local-only
        // comments (e.g. `pending: true` entries not yet round-tripped).
        const current = useReviewStore.getState().comments;
        const merged = new Map(hydrated);
        for (const [key, list] of current) {
          const existing = merged.get(key) ?? [];
          const existingIds = new Set(existing.map((c) => c.id));
          merged.set(key, [...existing, ...list.filter((c) => !existingIds.has(c.id))]);
        }
        setComments(merged);
      })
      .catch(() => { /* best-effort — comment threads just stay session-local */ })
      .finally(() => { inFlight.current = null; });
    // Also release `inFlight` on cleanup (not just in `.finally()`), so React
    // 18 StrictMode's dev-only mount→cleanup→remount double-invoke doesn't
    // leave the *second* invocation blocked behind the *first*'s in-flight
    // guard while the first's result gets discarded via `cancelled` — that
    // combination would silently drop every hydration's very first attempt.
    return () => { cancelled = true; inFlight.current = null; };
  }, [ticket, setComments]);
}
