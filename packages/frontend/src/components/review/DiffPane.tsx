// ===================================================================
// MI Dev Agent -- Diff Pane Component
// Custom diff renderer: unified and split modes, char highlights,
// line numbers, hunk headers, inline comment triggers
// ===================================================================

import { useMemo, useState, Fragment } from 'react';
import { useReviewStore } from '../../store/review';
import { InlineComment } from './InlineComment';
import {
  parseUnifiedDiff,
  computeCharHighlights,
  getFileExtension,
  actionColor,
  actionLabel,
} from '../../utils/diff';
import type { ReviewData } from '../../types';
import type { DiffViewMode } from '../../store/review';
import type { DiffHunk, DiffLine } from '../../utils/diff';

// -- Types ----------------------------------------------------------

type FileChange = NonNullable<ReviewData['changes']>[number];

interface DiffPaneProps {
  change: FileChange;
  viewMode: DiffViewMode;
}

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
    position: 'sticky' as const,
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
    wordBreak: 'break-all' as const,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    tableLayout: 'fixed' as const,
  },
  // Unified mode columns
  lineNum: {
    width: 50,
    minWidth: 50,
    padding: '0 8px',
    textAlign: 'right' as const,
    color: 'var(--text-ghost)',
    userSelect: 'none' as const,
    verticalAlign: 'top' as const,
    fontSize: 11,
    cursor: 'pointer',
    position: 'relative' as const,
  },
  lineContent: {
    padding: '0 12px',
    whiteSpace: 'pre' as const,
    overflowX: 'auto' as const,
    wordBreak: 'break-all' as const,
    direction: 'ltr' as const,
    unicodeBidi: 'embed' as const,
  },
  prefix: {
    width: 16,
    minWidth: 16,
    textAlign: 'center' as const,
    userSelect: 'none' as const,
    verticalAlign: 'top' as const,
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
    whiteSpace: 'pre' as const,
    overflowX: 'auto' as const,
    direction: 'ltr' as const,
    unicodeBidi: 'embed' as const,
  },
  emptyCell: {
    background: 'rgba(128, 128, 128, 0.04)',
  },
  // Comment trigger button
  commentTrigger: {
    position: 'absolute' as const,
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
    textAlign: 'center' as const,
    color: 'var(--text-tertiary)',
    fontSize: 12,
  },
  newFileContent: {
    padding: 'var(--sp-4)',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    color: 'var(--text-secondary)',
  },
  // Fold (collapsed context) row
  foldRow: {
    background: 'var(--bg-elevated)',
    cursor: 'pointer',
    userSelect: 'none' as const,
  },
  foldCell: {
    padding: '4px 12px',
    color: 'var(--text-tertiary)',
    fontStyle: 'italic' as const,
    fontSize: 11,
    textAlign: 'center' as const,
    borderTop: '1px dashed var(--border-subtle)',
    borderBottom: '1px dashed var(--border-subtle)',
  },
} as const;

// -- Context-fold configuration ------------------------------------

/** Minimum consecutive ctx lines before we start folding. */
const FOLD_THRESHOLD = 10;
/** How many ctx lines to show around the fold (top + bottom). */
const FOLD_EDGE = 3;

/** Item in the fold-aware render list. */
type FoldItem =
  | { kind: 'line'; line: DiffLine; hunkIdx: number; lineIdx: number }
  | { kind: 'fold'; foldId: string; hiddenCount: number };

/**
 * Walk hunk.lines and produce a list of items that collapses long runs of
 * consecutive ctx lines into a single fold marker (respecting expanded set).
 */
function foldHunk(
  hunk: DiffHunk,
  hunkIdx: number,
  expanded: Set<string>,
): FoldItem[] {
  const items: FoldItem[] = [];
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
    while (i < hunk.lines.length && hunk.lines[i].type === 'ctx') i++;
    const runEnd = i; // exclusive
    const runLen = runEnd - runStart;

    const foldId = `fold-${hunkIdx}-${runStart}`;
    if (runLen <= FOLD_THRESHOLD || expanded.has(foldId)) {
      for (let j = runStart; j < runEnd; j++) {
        items.push({ kind: 'line', line: hunk.lines[j], hunkIdx, lineIdx: j });
      }
    } else {
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

function getRowStyle(type: DiffLine['type']): React.CSSProperties {
  switch (type) {
    case 'add': return s.rowAdd;
    case 'del': return s.rowDel;
    case 'hunk': return s.rowHunk;
    default: return s.rowCtx;
  }
}

function getTextStyle(type: DiffLine['type']): React.CSSProperties {
  switch (type) {
    case 'add': return s.textAdd;
    case 'del': return s.textDel;
    case 'hunk': return s.textHunk;
    default: return s.textCtx;
  }
}

function getPrefixChar(type: DiffLine['type']): string {
  switch (type) {
    case 'add': return '+';
    case 'del': return '-';
    case 'hunk': return '';
    default: return ' ';
  }
}

// -- Render content with char highlights ----------------------------

function renderHighlighted(
  content: string,
  ranges: Array<{ start: number; end: number }>,
  highlightStyle: React.CSSProperties,
): React.ReactNode {
  if (ranges.length === 0) return content;

  const parts: React.ReactNode[] = [];
  let lastIdx = 0;

  for (let i = 0; i < ranges.length; i++) {
    const { start, end } = ranges[i];
    if (start > lastIdx) {
      parts.push(content.slice(lastIdx, start));
    }
    parts.push(
      <span key={`hl-${i}`} style={highlightStyle}>
        {content.slice(start, end)}
      </span>,
    );
    lastIdx = end;
  }

  if (lastIdx < content.length) {
    parts.push(content.slice(lastIdx));
  }

  return <>{parts}</>;
}

// -- Compute char highlights for adjacent del/add pairs -------------

function computeHunkHighlights(
  hunk: DiffHunk,
): Map<number, Array<{ start: number; end: number }>> {
  const highlights = new Map<number, Array<{ start: number; end: number }>>();
  const lines = hunk.lines;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== 'del') continue;

    // Gather consecutive del lines
    let delEnd = i;
    while (delEnd + 1 < lines.length && lines[delEnd + 1].type === 'del') {
      delEnd++;
    }

    // Check for matching add lines after
    let addStart = delEnd + 1;
    if (addStart >= lines.length || lines[addStart].type !== 'add') continue;

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
      const result = computeCharHighlights(
        '-' + lines[delIdx].content,
        '+' + lines[addIdx].content,
      );
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

function UnifiedDiff({
  hunks,
  file,
}: {
  hunks: DiffHunk[];
  file: string;
}): JSX.Element {
  const commentingOn = useReviewStore((s) => s.commentingOn);
  const setCommentingOn = useReviewStore((s) => s.setCommentingOn);
  const comments = useReviewStore((s) => s.comments);
  const [expandedFolds, setExpandedFolds] = useState<Set<string>>(() => new Set());

  const toggleFold = (foldId: string): void => {
    setExpandedFolds((prev) => {
      const next = new Set(prev);
      if (next.has(foldId)) next.delete(foldId);
      else next.add(foldId);
      return next;
    });
  };

  return (
    <table style={s.table}>
      <colgroup>
        <col style={{ width: 50 }} />
        <col style={{ width: 50 }} />
        <col style={{ width: 16 }} />
        <col />
      </colgroup>
      <tbody>
        {hunks.map((hunk, hunkIdx) => {
          const charHighlights = computeHunkHighlights(hunk);
          const items = foldHunk(hunk, hunkIdx, expandedFolds);

          return (
            <Fragment key={hunkIdx}>
              {items.map((item, itemIdx) => {
                if (item.kind === 'fold') {
                  return (
                    <tr
                      key={`fold-${hunkIdx}-${itemIdx}`}
                      style={s.foldRow}
                      onClick={() => toggleFold(item.foldId)}
                    >
                      <td colSpan={4} style={s.foldCell}>
                        ↕ Show {item.hiddenCount} more unchanged line{item.hiddenCount === 1 ? '' : 's'}
                      </td>
                    </tr>
                  );
                }
                const { line, lineIdx } = item;
                const lineKey = `${hunkIdx}-${lineIdx}`;
                const lineNum = line.type === 'add' ? line.newNum : (line.oldNum ?? line.newNum);
                const commentKey = `${file}:${lineNum}`;
                // Only render root comments here; replies render recursively inside CommentDisplay.
                const lineComments = (comments.get(commentKey) ?? []).filter(
                  (c) => !c.parentId,
                );
                const isCommenting =
                  commentingOn?.file === file &&
                  commentingOn?.line === lineNum;
                const charHL = charHighlights.get(lineIdx);

                return (
                  <Fragment key={lineKey}>
                    <tr
                      style={getRowStyle(line.type)}
                      className="diff-row"
                    >
                      {/* Old line number */}
                      <td
                        style={{
                          ...s.lineNum,
                          ...(line.type === 'hunk' ? { background: 'var(--bg-elevated)' } : {}),
                        }}
                        onMouseEnter={(e) => {
                          const btn = e.currentTarget.querySelector(
                            '.comment-btn',
                          ) as HTMLElement | null;
                          if (btn) btn.style.opacity = '1';
                        }}
                        onMouseLeave={(e) => {
                          const btn = e.currentTarget.querySelector(
                            '.comment-btn',
                          ) as HTMLElement | null;
                          if (btn) btn.style.opacity = '0';
                        }}
                      >
                        {line.type !== 'hunk' && lineNum != null && (
                          <button
                            className="comment-btn"
                            style={s.commentTrigger}
                            onClick={() =>
                              setCommentingOn(
                                isCommenting
                                  ? null
                                  : { file, line: lineNum! },
                              )
                            }
                            title="Add comment"
                            aria-label={`Add comment on line ${lineNum}`}
                          >
                            +
                          </button>
                        )}
                        {line.oldNum ?? ''}
                      </td>

                      {/* New line number */}
                      <td
                        style={{
                          ...s.lineNum,
                          ...(line.type === 'hunk' ? { background: 'var(--bg-elevated)' } : {}),
                        }}
                      >
                        {line.newNum ?? ''}
                      </td>

                      {/* Prefix (+/-) */}
                      <td
                        style={{
                          ...s.prefix,
                          ...getTextStyle(line.type),
                          ...(line.type === 'hunk' ? { background: 'var(--bg-elevated)' } : {}),
                        }}
                      >
                        {getPrefixChar(line.type)}
                      </td>

                      {/* Content */}
                      <td
                        style={{
                          ...s.lineContent,
                          ...getTextStyle(line.type),
                          ...(line.type === 'hunk'
                            ? {
                                background: 'var(--bg-elevated)',
                                padding: '4px 12px',
                                fontStyle: 'italic',
                              }
                            : {}),
                        }}
                      >
                        {line.type === 'hunk' ? (
                          line.content
                        ) : charHL ? (
                          renderHighlighted(
                            line.content,
                            charHL,
                            line.type === 'add'
                              ? s.charHighlightAdd
                              : s.charHighlightDel,
                          )
                        ) : (
                          line.content
                        )}
                      </td>
                    </tr>

                    {/* Inline comments */}
                    {lineComments.length > 0 &&
                      lineComments.map((comment) => (
                        <tr key={`comment-${comment.id}`}>
                          <td colSpan={4} style={{ padding: 0 }}>
                            <InlineComment comment={comment} />
                          </td>
                        </tr>
                      ))}

                    {/* Comment form */}
                    {isCommenting && lineNum != null && (
                      <tr>
                        <td colSpan={4} style={{ padding: 0 }}>
                          <InlineComment
                            file={file}
                            line={lineNum}
                            isEditing
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

// -- Split Mode Renderer --------------------------------------------

interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
  leftHighlight?: Array<{ start: number; end: number }>;
  rightHighlight?: Array<{ start: number; end: number }>;
  /** When set, this row is a fold marker (click to expand). */
  fold?: { foldId: string; hiddenCount: number };
}

function buildSplitRows(hunks: DiffHunk[], expanded: Set<string>): SplitRow[] {
  const rows: SplitRow[] = [];

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
        while (i < hunk.lines.length && hunk.lines[i].type === 'ctx') i++;
        const runEnd = i;
        const runLen = runEnd - runStart;
        const foldId = `split-fold-${hunkIdx}-${runStart}`;

        if (runLen <= FOLD_THRESHOLD || expanded.has(foldId)) {
          for (let j = runStart; j < runEnd; j++) {
            rows.push({ left: hunk.lines[j], right: hunk.lines[j] });
          }
        } else {
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
        const dels: { line: DiffLine; idx: number }[] = [];
        while (i < hunk.lines.length && hunk.lines[i].type === 'del') {
          dels.push({ line: hunk.lines[i], idx: i });
          i++;
        }

        // Gather consecutive additions
        const adds: { line: DiffLine; idx: number }[] = [];
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

function SplitDiff({
  hunks,
  file,
}: {
  hunks: DiffHunk[];
  file: string;
}): JSX.Element {
  const commentingOn = useReviewStore((s) => s.commentingOn);
  const setCommentingOn = useReviewStore((s) => s.setCommentingOn);
  const comments = useReviewStore((s) => s.comments);
  const [expandedFolds, setExpandedFolds] = useState<Set<string>>(() => new Set());
  const splitRows = useMemo(() => buildSplitRows(hunks, expandedFolds), [hunks, expandedFolds]);

  const toggleFold = (foldId: string): void => {
    setExpandedFolds((prev) => {
      const next = new Set(prev);
      if (next.has(foldId)) next.delete(foldId);
      else next.add(foldId);
      return next;
    });
  };

  return (
    <table style={{ ...s.table, tableLayout: 'fixed' }}>
      <colgroup>
        <col style={{ width: 48 }} />
        <col />
        <col style={{ width: 1 }} />
        <col style={{ width: 48 }} />
        <col />
      </colgroup>
      <tbody>
        {splitRows.map((row, rowIdx) => {
          if (row.fold) {
            const fold = row.fold;
            return (
              <tr
                key={`split-fold-${rowIdx}`}
                style={s.foldRow}
                onClick={() => toggleFold(fold.foldId)}
              >
                <td colSpan={5} style={s.foldCell}>
                  ↕ Show {fold.hiddenCount} more unchanged line{fold.hiddenCount === 1 ? '' : 's'}
                </td>
              </tr>
            );
          }

          const isHunk = row.left?.type === 'hunk';

          if (isHunk) {
            return (
              <tr key={rowIdx} style={s.rowHunk}>
                <td colSpan={5} style={{ ...s.lineContent, ...s.textHunk, padding: '4px 12px', fontStyle: 'italic' }}>
                  {row.left!.content}
                </td>
              </tr>
            );
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
          const isCommenting =
            commentingOn?.file === file &&
            rightLineNum != null &&
            commentingOn?.line === rightLineNum;

          return (
            <Fragment key={rowIdx}>
              <tr>
                {/* Left line number */}
                <td
                  style={{
                    ...s.lineNum,
                    ...(row.left ? {} : s.emptyCell),
                  }}
                >
                  {row.left ? (leftLineNum ?? '') : ''}
                </td>

                {/* Left content */}
                <td
                  style={{
                    ...s.splitContent,
                    ...(row.left
                      ? { ...getRowStyle(leftType), ...getTextStyle(leftType) }
                      : s.emptyCell),
                  }}
                >
                  {row.left
                    ? row.leftHighlight
                      ? renderHighlighted(
                          row.left.content,
                          row.leftHighlight,
                          s.charHighlightDel,
                        )
                      : row.left.content
                    : ''}
                </td>

                {/* Gutter */}
                <td style={s.splitGutter} />

                {/* Right line number */}
                <td
                  style={{
                    ...s.lineNum,
                    ...(row.right ? {} : s.emptyCell),
                  }}
                  onMouseEnter={(e) => {
                    const btn = e.currentTarget.querySelector(
                      '.comment-btn',
                    ) as HTMLElement | null;
                    if (btn) btn.style.opacity = '1';
                  }}
                  onMouseLeave={(e) => {
                    const btn = e.currentTarget.querySelector(
                      '.comment-btn',
                    ) as HTMLElement | null;
                    if (btn) btn.style.opacity = '0';
                  }}
                >
                  {row.right && rightLineNum != null && (
                    <button
                      className="comment-btn"
                      style={s.commentTrigger}
                      onClick={() =>
                        setCommentingOn(
                          isCommenting
                            ? null
                            : { file, line: rightLineNum! },
                        )
                      }
                      title="Add comment"
                      aria-label={`Add comment on line ${rightLineNum}`}
                    >
                      +
                    </button>
                  )}
                  {row.right ? (rightLineNum ?? '') : ''}
                </td>

                {/* Right content */}
                <td
                  style={{
                    ...s.splitContent,
                    ...(row.right
                      ? { ...getRowStyle(rightType), ...getTextStyle(rightType) }
                      : s.emptyCell),
                  }}
                >
                  {row.right
                    ? row.rightHighlight
                      ? renderHighlighted(
                          row.right.content,
                          row.rightHighlight,
                          s.charHighlightAdd,
                        )
                      : row.right.content
                    : ''}
                </td>
              </tr>

              {/* Inline comments */}
              {lineComments.length > 0 &&
                lineComments.map((comment) => (
                  <tr key={`comment-${comment.id}`}>
                    <td colSpan={5} style={{ padding: 0 }}>
                      <InlineComment comment={comment} />
                    </td>
                  </tr>
                ))}

              {/* Comment form */}
              {isCommenting && rightLineNum != null && (
                <tr>
                  <td colSpan={5} style={{ padding: 0 }}>
                    <InlineComment
                      file={file}
                      line={rightLineNum}
                      isEditing
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

// -- Main Component -------------------------------------------------

export function DiffPane({ change, viewMode }: DiffPaneProps): JSX.Element {
  const hunks = useMemo(() => {
    if (change.diff) {
      return parseUnifiedDiff(change.diff);
    }
    return [];
  }, [change.diff]);

  const hasDiff = hunks.length > 0;
  const ext = getFileExtension(change.file);

  return (
    <div style={s.container}>
      {/* File header */}
      <div style={s.fileHeader}>
        <span
          style={{
            ...s.fileAction,
            background: change.action === 'create'
              ? 'var(--success-muted)'
              : change.action === 'delete'
                ? 'var(--danger-muted)'
                : 'var(--warning-muted)',
            color: actionColor(change.action),
          }}
        >
          {actionLabel(change.action)}
        </span>
        <span style={s.filePath}>{change.file}</span>
        {ext && (
          <span
            style={{
              fontSize: 10,
              color: 'var(--text-ghost)',
              fontWeight: 600,
              textTransform: 'uppercase',
            }}
          >
            {ext}
          </span>
        )}
      </div>

      {/* Diff content */}
      {hasDiff ? (
        viewMode === 'split' ? (
          <SplitDiff hunks={hunks} file={change.file} />
        ) : (
          <UnifiedDiff hunks={hunks} file={change.file} />
        )
      ) : change.content ? (
        /* New file with content but no diff */
        <div style={s.newFileContent}>
          {change.content}
        </div>
      ) : (
        <div style={s.noContent}>
          {change.action === 'delete'
            ? 'File deleted'
            : 'No diff available for this file'}
        </div>
      )}
    </div>
  );
}
