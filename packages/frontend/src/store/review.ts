// ===================================================================
// MI Dev Agent -- Zustand Review Store
// Manages diff viewer state: view mode, selected file, comments
// ===================================================================

import { create } from 'zustand';

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
