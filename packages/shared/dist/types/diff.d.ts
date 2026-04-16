/**
 * Diff view mode for the Web UI.
 */
export type DiffViewMode = 'unified' | 'split';
/**
 * A single line in a diff view.
 */
export interface DiffLine {
    /** Line type */
    type: 'add' | 'del' | 'ctx';
    /** Line number in the old file (null for additions) */
    oldLineNum: number | null;
    /** Line number in the new file (null for deletions) */
    newLineNum: number | null;
    /** The line content (without +/- prefix) */
    content: string;
    /** Character-level highlight ranges for inline diff */
    highlights?: readonly DiffHighlight[];
}
/**
 * Character-level highlight range within a diff line.
 */
export interface DiffHighlight {
    /** Start character offset (0-based) */
    start: number;
    /** End character offset (exclusive) */
    end: number;
}
/**
 * An inline comment on a diff (Web UI code review feature).
 */
export interface InlineComment {
    /** Unique comment ID */
    id: string;
    /** File path the comment is on */
    filePath: string;
    /** Line number in the new file */
    lineNumber: number;
    /** Comment text */
    body: string;
    /** Author of the comment */
    author: string;
    /** ISO timestamp of creation */
    createdAt: string;
    /** Whether this is a resolved comment */
    resolved?: boolean;
}
/**
 * Statistics for a single file diff.
 */
export interface DiffStats {
    /** Number of lines added */
    additions: number;
    /** Number of lines deleted */
    deletions: number;
    /** Number of context (unchanged) lines shown */
    contextLines: number;
}
/**
 * Information about a single file's diff.
 */
export interface FileDiffInfo {
    /** File path */
    filePath: string;
    /** Action that produced this diff */
    action: 'create' | 'update' | 'delete' | 'rename';
    /** Old file path (for renames) */
    oldPath?: string;
    /** Diff statistics */
    stats: DiffStats;
    /** Parsed diff lines */
    lines: readonly DiffLine[];
    /** Language for syntax highlighting (derived from extension) */
    language?: string;
}
/**
 * A complete MR diff containing all changed files.
 */
export interface MRDiff {
    /** GitLab MR IID */
    mrIid: number;
    /** MR title */
    title?: string;
    /** Source branch name */
    sourceBranch: string;
    /** Target branch name */
    targetBranch: string;
    /** List of file diffs */
    files: readonly FileDiffInfo[];
    /** Aggregate statistics across all files */
    totalStats: DiffStats;
    /** Original file contents for side-by-side view */
    originalFiles?: Record<string, string>;
    /** Inline comments from reviewers */
    comments?: readonly InlineComment[];
}
//# sourceMappingURL=diff.d.ts.map