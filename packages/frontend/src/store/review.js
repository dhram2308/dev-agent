// ===================================================================
// MI Dev Agent -- Zustand Review Store
// Manages diff viewer state: view mode, selected file, comments
// ===================================================================
import { create } from 'zustand';
// -- Helpers --------------------------------------------------------
function commentKey(file, line) {
    return `${file}:${line}`;
}
// -- Store ----------------------------------------------------------
export const useReviewStore = create((set, get) => ({
    viewMode: 'unified',
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
        const next = new Map();
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
        const result = [];
        for (const list of get().comments.values()) {
            result.push(...list);
        }
        return result.sort((a, b) => a.timestamp - b.timestamp);
    },
    reset: () => set({
        viewMode: 'unified',
        selectedFile: null,
        comments: new Map(),
        commentingOn: null,
        fileFilter: '',
        refineOpen: false,
    }),
}));
// -- Selectors ------------------------------------------------------
/** Get comments for a specific file and line */
export function useCommentsForLine(file, line) {
    return useReviewStore((s) => {
        const key = commentKey(file, line);
        return s.comments.get(key) ?? [];
    });
}
/** Get total comment count */
export function useCommentCount() {
    return useReviewStore((s) => {
        let count = 0;
        for (const list of s.comments.values()) {
            count += list.length;
        }
        return count;
    });
}
