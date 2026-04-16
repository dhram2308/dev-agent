import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
// ===================================================================
// MI Dev Agent -- Diff Pane Component
// Custom diff renderer: unified and split modes, char highlights,
// line numbers, hunk headers, inline comment triggers
// ===================================================================
import { useMemo, useState, Fragment } from 'react';
import { useReviewStore } from '../../store/review';
import { InlineComment } from './InlineComment';
import { parseUnifiedDiff, computeCharHighlights, getFileExtension, actionColor, actionLabel, } from '../../utils/diff';
// -- Styles ---------------------------------------------------------
const s = {
    container: {
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        lineHeight: '20px',
        color: 'var(--text-secondary)',
    },
    fileHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        padding: 'var(--sp-3) var(--sp-4)',
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border-subtle)',
        position: 'sticky',
        top: 0,
        zIndex: 5,
    },
    fileAction: {
        fontSize: 10,
        fontWeight: 700,
        padding: '1px 6px',
        borderRadius: 'var(--radius-sm)',
    },
    filePath: {
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--text-primary)',
        wordBreak: 'break-all',
    },
    table: {
        width: '100%',
        borderCollapse: 'collapse',
        tableLayout: 'fixed',
    },
    // Unified mode columns
    lineNum: {
        width: 50,
        minWidth: 50,
        padding: '0 8px',
        textAlign: 'right',
        color: 'var(--text-ghost)',
        userSelect: 'none',
        verticalAlign: 'top',
        fontSize: 11,
        cursor: 'pointer',
        position: 'relative',
    },
    lineContent: {
        padding: '0 12px',
        whiteSpace: 'pre',
        overflowX: 'auto',
        wordBreak: 'break-all',
        direction: 'ltr',
        unicodeBidi: 'embed',
    },
    prefix: {
        width: 16,
        minWidth: 16,
        textAlign: 'center',
        userSelect: 'none',
        verticalAlign: 'top',
        fontWeight: 600,
    },
    // Row backgrounds
    rowAdd: { background: 'rgba(52, 211, 153, 0.08)' },
    rowDel: { background: 'rgba(248, 113, 113, 0.08)' },
    rowCtx: { background: 'transparent' },
    rowHunk: {
        background: 'var(--bg-elevated)',
        color: 'var(--blue)',
        fontSize: 11,
        fontWeight: 600,
    },
    // Text colors by type
    textAdd: { color: 'var(--success)' },
    textDel: { color: 'var(--danger)' },
    textCtx: { color: 'var(--text-tertiary)' },
    textHunk: { color: 'var(--blue)' },
    // Char-level highlights
    charHighlightAdd: {
        background: 'rgba(52, 211, 153, 0.25)',
        borderRadius: 2,
    },
    charHighlightDel: {
        background: 'rgba(248, 113, 113, 0.25)',
        borderRadius: 2,
    },
    // Split mode
    splitGutter: {
        width: 1,
        minWidth: 1,
        background: 'var(--border-subtle)',
        padding: 0,
    },
    splitContent: {
        width: '45%',
        padding: '0 10px',
        whiteSpace: 'pre',
        overflowX: 'auto',
        direction: 'ltr',
        unicodeBidi: 'embed',
    },
    emptyCell: {
        background: 'rgba(128, 128, 128, 0.04)',
    },
    // Comment trigger button
    commentTrigger: {
        position: 'absolute',
        left: 2,
        top: 1,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: 'var(--accent)',
        color: '#fff',
        border: 'none',
        fontSize: 10,
        fontWeight: 700,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: 0,
        transition: 'opacity 0.1s',
        zIndex: 2,
    },
    // No diff available
    noContent: {
        padding: 'var(--sp-6)',
        textAlign: 'center',
        color: 'var(--text-tertiary)',
        fontSize: 12,
    },
    newFileContent: {
        padding: 'var(--sp-4)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--text-secondary)',
    },
    // Fold (collapsed context) row
    foldRow: {
        background: 'var(--bg-elevated)',
        cursor: 'pointer',
        userSelect: 'none',
    },
    foldCell: {
        padding: '4px 12px',
        color: 'var(--text-tertiary)',
        fontStyle: 'italic',
        fontSize: 11,
        textAlign: 'center',
        borderTop: '1px dashed var(--border-subtle)',
        borderBottom: '1px dashed var(--border-subtle)',
    },
};
// -- Context-fold configuration ------------------------------------
/** Minimum consecutive ctx lines before we start folding. */
const FOLD_THRESHOLD = 10;
/** How many ctx lines to show around the fold (top + bottom). */
const FOLD_EDGE = 3;
/**
 * Walk hunk.lines and produce a list of items that collapses long runs of
 * consecutive ctx lines into a single fold marker (respecting expanded set).
 */
function foldHunk(hunk, hunkIdx, expanded) {
    const items = [];
    let i = 0;
    while (i < hunk.lines.length) {
        const line = hunk.lines[i];
        if (line.type !== 'ctx') {
            items.push({ kind: 'line', line, hunkIdx, lineIdx: i });
            i++;
            continue;
        }
        // Scan the ctx run
        const runStart = i;
        while (i < hunk.lines.length && hunk.lines[i].type === 'ctx')
            i++;
        const runEnd = i; // exclusive
        const runLen = runEnd - runStart;
        const foldId = `fold-${hunkIdx}-${runStart}`;
        if (runLen <= FOLD_THRESHOLD || expanded.has(foldId)) {
            for (let j = runStart; j < runEnd; j++) {
                items.push({ kind: 'line', line: hunk.lines[j], hunkIdx, lineIdx: j });
            }
        }
        else {
            for (let j = runStart; j < runStart + FOLD_EDGE; j++) {
                items.push({ kind: 'line', line: hunk.lines[j], hunkIdx, lineIdx: j });
            }
            items.push({
                kind: 'fold',
                foldId,
                hiddenCount: runLen - 2 * FOLD_EDGE,
            });
            for (let j = runEnd - FOLD_EDGE; j < runEnd; j++) {
                items.push({ kind: 'line', line: hunk.lines[j], hunkIdx, lineIdx: j });
            }
        }
    }
    return items;
}
// -- Helpers --------------------------------------------------------
function getRowStyle(type) {
    switch (type) {
        case 'add': return s.rowAdd;
        case 'del': return s.rowDel;
        case 'hunk': return s.rowHunk;
        default: return s.rowCtx;
    }
}
function getTextStyle(type) {
    switch (type) {
        case 'add': return s.textAdd;
        case 'del': return s.textDel;
        case 'hunk': return s.textHunk;
        default: return s.textCtx;
    }
}
function getPrefixChar(type) {
    switch (type) {
        case 'add': return '+';
        case 'del': return '-';
        case 'hunk': return '';
        default: return ' ';
    }
}
// -- Render content with char highlights ----------------------------
function renderHighlighted(content, ranges, highlightStyle) {
    if (ranges.length === 0)
        return content;
    const parts = [];
    let lastIdx = 0;
    for (let i = 0; i < ranges.length; i++) {
        const { start, end } = ranges[i];
        if (start > lastIdx) {
            parts.push(content.slice(lastIdx, start));
        }
        parts.push(_jsx("span", { style: highlightStyle, children: content.slice(start, end) }, `hl-${i}`));
        lastIdx = end;
    }
    if (lastIdx < content.length) {
        parts.push(content.slice(lastIdx));
    }
    return _jsx(_Fragment, { children: parts });
}
// -- Compute char highlights for adjacent del/add pairs -------------
function computeHunkHighlights(hunk) {
    const highlights = new Map();
    const lines = hunk.lines;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].type !== 'del')
            continue;
        // Gather consecutive del lines
        let delEnd = i;
        while (delEnd + 1 < lines.length && lines[delEnd + 1].type === 'del') {
            delEnd++;
        }
        // Check for matching add lines after
        let addStart = delEnd + 1;
        if (addStart >= lines.length || lines[addStart].type !== 'add')
            continue;
        let addEnd = addStart;
        while (addEnd + 1 < lines.length && lines[addEnd + 1].type === 'add') {
            addEnd++;
        }
        // Pair up del/add lines
        const delCount = delEnd - i + 1;
        const addCount = addEnd - addStart + 1;
        const pairCount = Math.min(delCount, addCount);
        for (let p = 0; p < pairCount; p++) {
            const delIdx = i + p;
            const addIdx = addStart + p;
            const result = computeCharHighlights('-' + lines[delIdx].content, '+' + lines[addIdx].content);
            if (result.oldRanges.length > 0) {
                highlights.set(delIdx, result.oldRanges);
            }
            if (result.newRanges.length > 0) {
                highlights.set(addIdx, result.newRanges);
            }
        }
        // Skip past the add lines
        i = addEnd;
    }
    return highlights;
}
// -- Unified Mode Renderer ------------------------------------------
function UnifiedDiff({ hunks, file, }) {
    const commentingOn = useReviewStore((s) => s.commentingOn);
    const setCommentingOn = useReviewStore((s) => s.setCommentingOn);
    const comments = useReviewStore((s) => s.comments);
    const [expandedFolds, setExpandedFolds] = useState(() => new Set());
    const toggleFold = (foldId) => {
        setExpandedFolds((prev) => {
            const next = new Set(prev);
            if (next.has(foldId))
                next.delete(foldId);
            else
                next.add(foldId);
            return next;
        });
    };
    return (_jsxs("table", { style: s.table, children: [_jsxs("colgroup", { children: [_jsx("col", { style: { width: 50 } }), _jsx("col", { style: { width: 50 } }), _jsx("col", { style: { width: 16 } }), _jsx("col", {})] }), _jsx("tbody", { children: hunks.map((hunk, hunkIdx) => {
                    const charHighlights = computeHunkHighlights(hunk);
                    const items = foldHunk(hunk, hunkIdx, expandedFolds);
                    return (_jsx(Fragment, { children: items.map((item, itemIdx) => {
                            if (item.kind === 'fold') {
                                return (_jsx("tr", { style: s.foldRow, onClick: () => toggleFold(item.foldId), children: _jsxs("td", { colSpan: 4, style: s.foldCell, children: ["\u2195 Show ", item.hiddenCount, " more unchanged line", item.hiddenCount === 1 ? '' : 's'] }) }, `fold-${hunkIdx}-${itemIdx}`));
                            }
                            const { line, lineIdx } = item;
                            const lineKey = `${hunkIdx}-${lineIdx}`;
                            const lineNum = line.type === 'add' ? line.newNum : (line.oldNum ?? line.newNum);
                            const commentKey = `${file}:${lineNum}`;
                            // Only render root comments here; replies render recursively inside CommentDisplay.
                            const lineComments = (comments.get(commentKey) ?? []).filter((c) => !c.parentId);
                            const isCommenting = commentingOn?.file === file &&
                                commentingOn?.line === lineNum;
                            const charHL = charHighlights.get(lineIdx);
                            return (_jsxs(Fragment, { children: [_jsxs("tr", { style: getRowStyle(line.type), className: "diff-row", children: [_jsxs("td", { style: {
                                                    ...s.lineNum,
                                                    ...(line.type === 'hunk' ? { background: 'var(--bg-elevated)' } : {}),
                                                }, onMouseEnter: (e) => {
                                                    const btn = e.currentTarget.querySelector('.comment-btn');
                                                    if (btn)
                                                        btn.style.opacity = '1';
                                                }, onMouseLeave: (e) => {
                                                    const btn = e.currentTarget.querySelector('.comment-btn');
                                                    if (btn)
                                                        btn.style.opacity = '0';
                                                }, children: [line.type !== 'hunk' && lineNum != null && (_jsx("button", { className: "comment-btn", style: s.commentTrigger, onClick: () => setCommentingOn(isCommenting
                                                            ? null
                                                            : { file, line: lineNum }), title: "Add comment", "aria-label": `Add comment on line ${lineNum}`, children: "+" })), line.oldNum ?? ''] }), _jsx("td", { style: {
                                                    ...s.lineNum,
                                                    ...(line.type === 'hunk' ? { background: 'var(--bg-elevated)' } : {}),
                                                }, children: line.newNum ?? '' }), _jsx("td", { style: {
                                                    ...s.prefix,
                                                    ...getTextStyle(line.type),
                                                    ...(line.type === 'hunk' ? { background: 'var(--bg-elevated)' } : {}),
                                                }, children: getPrefixChar(line.type) }), _jsx("td", { style: {
                                                    ...s.lineContent,
                                                    ...getTextStyle(line.type),
                                                    ...(line.type === 'hunk'
                                                        ? {
                                                            background: 'var(--bg-elevated)',
                                                            padding: '4px 12px',
                                                            fontStyle: 'italic',
                                                        }
                                                        : {}),
                                                }, children: line.type === 'hunk' ? (line.content) : charHL ? (renderHighlighted(line.content, charHL, line.type === 'add'
                                                    ? s.charHighlightAdd
                                                    : s.charHighlightDel)) : (line.content) })] }), lineComments.length > 0 &&
                                        lineComments.map((comment) => (_jsx("tr", { children: _jsx("td", { colSpan: 4, style: { padding: 0 }, children: _jsx(InlineComment, { comment: comment }) }) }, `comment-${comment.id}`))), isCommenting && lineNum != null && (_jsx("tr", { children: _jsx("td", { colSpan: 4, style: { padding: 0 }, children: _jsx(InlineComment, { file: file, line: lineNum, isEditing: true }) }) }))] }, lineKey));
                        }) }, hunkIdx));
                }) })] }));
}
function buildSplitRows(hunks, expanded) {
    const rows = [];
    for (let hunkIdx = 0; hunkIdx < hunks.length; hunkIdx++) {
        const hunk = hunks[hunkIdx];
        const charHighlights = computeHunkHighlights(hunk);
        // Add hunk header as a full-width row
        if (hunk.lines.length > 0 && hunk.lines[0].type === 'hunk') {
            rows.push({
                left: hunk.lines[0],
                right: hunk.lines[0],
            });
        }
        let i = hunk.lines[0]?.type === 'hunk' ? 1 : 0;
        while (i < hunk.lines.length) {
            const line = hunk.lines[i];
            if (line.type === 'ctx') {
                // Collect the full ctx run, then decide whether to fold it
                const runStart = i;
                while (i < hunk.lines.length && hunk.lines[i].type === 'ctx')
                    i++;
                const runEnd = i;
                const runLen = runEnd - runStart;
                const foldId = `split-fold-${hunkIdx}-${runStart}`;
                if (runLen <= FOLD_THRESHOLD || expanded.has(foldId)) {
                    for (let j = runStart; j < runEnd; j++) {
                        rows.push({ left: hunk.lines[j], right: hunk.lines[j] });
                    }
                }
                else {
                    for (let j = runStart; j < runStart + FOLD_EDGE; j++) {
                        rows.push({ left: hunk.lines[j], right: hunk.lines[j] });
                    }
                    rows.push({
                        left: null,
                        right: null,
                        fold: { foldId, hiddenCount: runLen - 2 * FOLD_EDGE },
                    });
                    for (let j = runEnd - FOLD_EDGE; j < runEnd; j++) {
                        rows.push({ left: hunk.lines[j], right: hunk.lines[j] });
                    }
                }
                continue;
            }
            if (line.type === 'del') {
                // Gather consecutive deletions
                const dels = [];
                while (i < hunk.lines.length && hunk.lines[i].type === 'del') {
                    dels.push({ line: hunk.lines[i], idx: i });
                    i++;
                }
                // Gather consecutive additions
                const adds = [];
                while (i < hunk.lines.length && hunk.lines[i].type === 'add') {
                    adds.push({ line: hunk.lines[i], idx: i });
                    i++;
                }
                // Pair them up
                const maxLen = Math.max(dels.length, adds.length);
                for (let j = 0; j < maxLen; j++) {
                    const del = j < dels.length ? dels[j] : null;
                    const add = j < adds.length ? adds[j] : null;
                    rows.push({
                        left: del?.line ?? null,
                        right: add?.line ?? null,
                        leftHighlight: del ? charHighlights.get(del.idx) : undefined,
                        rightHighlight: add ? charHighlights.get(add.idx) : undefined,
                    });
                }
                continue;
            }
            if (line.type === 'add') {
                rows.push({
                    left: null,
                    right: line,
                    rightHighlight: charHighlights.get(i),
                });
                i++;
                continue;
            }
            // Hunk lines inside (shouldn't happen after index 0, but handle)
            i++;
        }
    }
    return rows;
}
function SplitDiff({ hunks, file, }) {
    const commentingOn = useReviewStore((s) => s.commentingOn);
    const setCommentingOn = useReviewStore((s) => s.setCommentingOn);
    const comments = useReviewStore((s) => s.comments);
    const [expandedFolds, setExpandedFolds] = useState(() => new Set());
    const splitRows = useMemo(() => buildSplitRows(hunks, expandedFolds), [hunks, expandedFolds]);
    const toggleFold = (foldId) => {
        setExpandedFolds((prev) => {
            const next = new Set(prev);
            if (next.has(foldId))
                next.delete(foldId);
            else
                next.add(foldId);
            return next;
        });
    };
    return (_jsxs("table", { style: { ...s.table, tableLayout: 'fixed' }, children: [_jsxs("colgroup", { children: [_jsx("col", { style: { width: 48 } }), _jsx("col", {}), _jsx("col", { style: { width: 1 } }), _jsx("col", { style: { width: 48 } }), _jsx("col", {})] }), _jsx("tbody", { children: splitRows.map((row, rowIdx) => {
                    if (row.fold) {
                        const fold = row.fold;
                        return (_jsx("tr", { style: s.foldRow, onClick: () => toggleFold(fold.foldId), children: _jsxs("td", { colSpan: 5, style: s.foldCell, children: ["\u2195 Show ", fold.hiddenCount, " more unchanged line", fold.hiddenCount === 1 ? '' : 's'] }) }, `split-fold-${rowIdx}`));
                    }
                    const isHunk = row.left?.type === 'hunk';
                    if (isHunk) {
                        return (_jsx("tr", { style: s.rowHunk, children: _jsx("td", { colSpan: 5, style: { ...s.lineContent, ...s.textHunk, padding: '4px 12px', fontStyle: 'italic' }, children: row.left.content }) }, rowIdx));
                    }
                    const leftType = row.left?.type ?? 'ctx';
                    const rightType = row.right?.type ?? 'ctx';
                    const leftLineNum = row.left?.oldNum ?? row.left?.newNum;
                    const rightLineNum = row.right?.newNum ?? row.right?.oldNum;
                    // Check for comments on the right (new) side. Only render root comments here;
                    // replies render recursively inside CommentDisplay.
                    const commentKey = rightLineNum != null ? `${file}:${rightLineNum}` : null;
                    const lineComments = commentKey
                        ? (comments.get(commentKey) ?? []).filter((c) => !c.parentId)
                        : [];
                    const isCommenting = commentingOn?.file === file &&
                        rightLineNum != null &&
                        commentingOn?.line === rightLineNum;
                    return (_jsxs(Fragment, { children: [_jsxs("tr", { children: [_jsx("td", { style: {
                                            ...s.lineNum,
                                            ...(row.left ? {} : s.emptyCell),
                                        }, children: row.left ? (leftLineNum ?? '') : '' }), _jsx("td", { style: {
                                            ...s.splitContent,
                                            ...(row.left
                                                ? { ...getRowStyle(leftType), ...getTextStyle(leftType) }
                                                : s.emptyCell),
                                        }, children: row.left
                                            ? row.leftHighlight
                                                ? renderHighlighted(row.left.content, row.leftHighlight, s.charHighlightDel)
                                                : row.left.content
                                            : '' }), _jsx("td", { style: s.splitGutter }), _jsxs("td", { style: {
                                            ...s.lineNum,
                                            ...(row.right ? {} : s.emptyCell),
                                        }, onMouseEnter: (e) => {
                                            const btn = e.currentTarget.querySelector('.comment-btn');
                                            if (btn)
                                                btn.style.opacity = '1';
                                        }, onMouseLeave: (e) => {
                                            const btn = e.currentTarget.querySelector('.comment-btn');
                                            if (btn)
                                                btn.style.opacity = '0';
                                        }, children: [row.right && rightLineNum != null && (_jsx("button", { className: "comment-btn", style: s.commentTrigger, onClick: () => setCommentingOn(isCommenting
                                                    ? null
                                                    : { file, line: rightLineNum }), title: "Add comment", "aria-label": `Add comment on line ${rightLineNum}`, children: "+" })), row.right ? (rightLineNum ?? '') : ''] }), _jsx("td", { style: {
                                            ...s.splitContent,
                                            ...(row.right
                                                ? { ...getRowStyle(rightType), ...getTextStyle(rightType) }
                                                : s.emptyCell),
                                        }, children: row.right
                                            ? row.rightHighlight
                                                ? renderHighlighted(row.right.content, row.rightHighlight, s.charHighlightAdd)
                                                : row.right.content
                                            : '' })] }), lineComments.length > 0 &&
                                lineComments.map((comment) => (_jsx("tr", { children: _jsx("td", { colSpan: 5, style: { padding: 0 }, children: _jsx(InlineComment, { comment: comment }) }) }, `comment-${comment.id}`))), isCommenting && rightLineNum != null && (_jsx("tr", { children: _jsx("td", { colSpan: 5, style: { padding: 0 }, children: _jsx(InlineComment, { file: file, line: rightLineNum, isEditing: true }) }) }))] }, rowIdx));
                }) })] }));
}
// -- Main Component -------------------------------------------------
export function DiffPane({ change, viewMode }) {
    const hunks = useMemo(() => {
        if (change.diff) {
            return parseUnifiedDiff(change.diff);
        }
        return [];
    }, [change.diff]);
    const hasDiff = hunks.length > 0;
    const ext = getFileExtension(change.file);
    return (_jsxs("div", { style: s.container, children: [_jsxs("div", { style: s.fileHeader, children: [_jsx("span", { style: {
                            ...s.fileAction,
                            background: change.action === 'create'
                                ? 'var(--success-muted)'
                                : change.action === 'delete'
                                    ? 'var(--danger-muted)'
                                    : 'var(--warning-muted)',
                            color: actionColor(change.action),
                        }, children: actionLabel(change.action) }), _jsx("span", { style: s.filePath, children: change.file }), ext && (_jsx("span", { style: {
                            fontSize: 10,
                            color: 'var(--text-ghost)',
                            fontWeight: 600,
                            textTransform: 'uppercase',
                        }, children: ext }))] }), hasDiff ? (viewMode === 'split' ? (_jsx(SplitDiff, { hunks: hunks, file: change.file })) : (_jsx(UnifiedDiff, { hunks: hunks, file: change.file }))) : change.content ? (
            /* New file with content but no diff */
            _jsx("div", { style: s.newFileContent, children: change.content })) : (_jsx("div", { style: s.noContent, children: change.action === 'delete'
                    ? 'File deleted'
                    : 'No diff available for this file' }))] }));
}
