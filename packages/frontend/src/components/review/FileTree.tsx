// ===================================================================
// MI Dev Agent -- File Tree Component
// File list with action indicators, line-change badges, search filter
// ===================================================================

import { useState, useMemo } from 'react';
import { useReviewStore } from '../../store/review';
import {
  actionColor,
  actionBgColor,
  actionLabel,
  parseDiffStatsFromChanges,
} from '../../utils/diff';
import type { ReviewData } from '../../types';

// -- Types ----------------------------------------------------------

type FileChange = NonNullable<ReviewData['changes']>[number];

interface FileTreeProps {
  changes: FileChange[];
  selectedFile: string | null;
  onSelect: (file: string) => void;
}

// -- Styles ---------------------------------------------------------

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
  },
  searchBox: {
    padding: 'var(--sp-2) var(--sp-3)',
    borderBottom: '1px solid var(--border-subtle)',
  },
  searchInput: {
    width: '100%',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    padding: '5px 8px',
    outline: 'none',
    transition: 'border-color 0.2s',
  },
  header: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: 'var(--text-tertiary)',
    padding: 'var(--sp-3) var(--sp-3) var(--sp-1)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  fileCount: {
    fontSize: 9,
    background: 'var(--bg-elevated)',
    borderRadius: 'var(--radius-full)',
    padding: '1px 6px',
    color: 'var(--text-tertiary)',
    fontWeight: 600,
  },
  list: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: 'var(--sp-1) var(--sp-2)',
  },
  dirHeader: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-tertiary)',
    padding: '6px 8px 2px',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-1)',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    padding: '4px 8px',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    width: '100%',
    textAlign: 'left' as const,
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--text-secondary)',
    transition: 'all 0.1s',
    position: 'relative' as const,
  },
  itemActive: {
    background: 'var(--accent-muted)',
    color: 'var(--text-primary)',
  },
  itemHover: {
    background: 'var(--bg-elevated)',
  },
  actionBadge: {
    width: 16,
    height: 16,
    borderRadius: 'var(--radius-sm)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 9,
    fontWeight: 700,
    flexShrink: 0,
  },
  fileName: {
    flex: 1,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
    direction: 'rtl' as const,
    textAlign: 'left' as const,
  },
  lineStats: {
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    display: 'flex',
    gap: 4,
    flexShrink: 0,
    whiteSpace: 'nowrap' as const,
  },
  added: {
    color: 'var(--success)',
  },
  deleted: {
    color: 'var(--danger)',
  },
  noResults: {
    padding: 'var(--sp-4)',
    textAlign: 'center' as const,
    color: 'var(--text-tertiary)',
    fontSize: 11,
  },
} as const;

// -- Helpers --------------------------------------------------------

function countDiffLines(diff?: string): { added: number; deleted: number } {
  if (!diff) return { added: 0, deleted: 0 };
  let added = 0;
  let deleted = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) deleted++;
  }
  return { added, deleted };
}

/** Group files by their directory path */
function groupByDirectory(
  changes: FileChange[],
): Map<string, FileChange[]> {
  const groups = new Map<string, FileChange[]>();
  for (const change of changes) {
    const lastSlash = change.file.lastIndexOf('/');
    const dir = lastSlash >= 0 ? change.file.slice(0, lastSlash) : '';
    const list = groups.get(dir) ?? [];
    list.push(change);
    groups.set(dir, list);
  }
  return groups;
}

// -- Component ------------------------------------------------------

export function FileTree({
  changes,
  selectedFile,
  onSelect,
}: FileTreeProps): JSX.Element {
  const fileFilter = useReviewStore((s) => s.fileFilter);
  const setFileFilter = useReviewStore((s) => s.setFileFilter);
  const [hoveredFile, setHoveredFile] = useState<string | null>(null);

  // Filter files
  const filteredChanges = useMemo(() => {
    if (!fileFilter.trim()) return changes;
    const lower = fileFilter.toLowerCase();
    return changes.filter((c) => c.file.toLowerCase().includes(lower));
  }, [changes, fileFilter]);

  // Group by directory
  const grouped = useMemo(
    () => groupByDirectory(filteredChanges),
    [filteredChanges],
  );

  // Overall stats
  const stats = useMemo(
    () => parseDiffStatsFromChanges(changes),
    [changes],
  );

  return (
    <div style={styles.container}>
      {/* Search filter */}
      <div style={styles.searchBox}>
        <input
          type="text"
          value={fileFilter}
          onChange={(e) => setFileFilter(e.target.value)}
          placeholder="Filter files..."
          spellCheck={false}
          style={styles.searchInput}
          aria-label="Filter files"
        />
      </div>

      {/* Header */}
      <div style={styles.header}>
        <span>Files Changed</span>
        <span style={styles.fileCount}>
          {filteredChanges.length}
          {fileFilter && filteredChanges.length !== changes.length
            ? ` / ${changes.length}`
            : ''}
        </span>
      </div>

      {/* File list */}
      <div style={styles.list}>
        {filteredChanges.length === 0 ? (
          <div style={styles.noResults}>
            {fileFilter ? 'No files match filter' : 'No files'}
          </div>
        ) : (
          Array.from(grouped.entries()).map(([dir, files]) => (
            <div key={dir}>
              {/* Directory label (only if there are multiple directories) */}
              {grouped.size > 1 && dir && (
                <div style={styles.dirHeader}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M2 4h4l2 2h6v7H2z" strokeLinejoin="round" />
                  </svg>
                  {dir}
                </div>
              )}
              {files.map((change) => {
                const isActive = change.file === selectedFile;
                const isHovered =
                  change.file === hoveredFile && !isActive;
                const diffLines = countDiffLines(change.diff);
                const fileName = change.file.split('/').pop() ?? change.file;

                return (
                  <button
                    key={change.file}
                    style={{
                      ...styles.item,
                      ...(isActive ? styles.itemActive : {}),
                      ...(isHovered ? styles.itemHover : {}),
                    }}
                    onClick={() => onSelect(change.file)}
                    onMouseEnter={() => setHoveredFile(change.file)}
                    onMouseLeave={() => setHoveredFile(null)}
                    title={change.file}
                  >
                    {/* Action badge */}
                    <span
                      style={{
                        ...styles.actionBadge,
                        background: actionBgColor(change.action),
                        color: actionColor(change.action),
                      }}
                    >
                      {actionLabel(change.action)}
                    </span>

                    {/* Filename (RTL to show the filename part) */}
                    <span style={styles.fileName}>
                      {/* Use LTR embedding to show from the right */}
                      <bdi>{fileName}</bdi>
                    </span>

                    {/* Line stats */}
                    {(diffLines.added > 0 || diffLines.deleted > 0) && (
                      <span style={styles.lineStats}>
                        {diffLines.added > 0 && (
                          <span style={styles.added}>+{diffLines.added}</span>
                        )}
                        {diffLines.deleted > 0 && (
                          <span style={styles.deleted}>
                            -{diffLines.deleted}
                          </span>
                        )}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
