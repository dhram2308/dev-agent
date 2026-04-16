// ===================================================================
// MI Dev Agent -- Diff Stats Bar
// Compact horizontal stats: N files changed, +N additions, -N deletions
// with proportional green/red bar
// ===================================================================

import { useMemo } from 'react';
import { parseDiffStatsFromChanges } from '../../utils/diff';
import type { ReviewData } from '../../types';

// -- Types ----------------------------------------------------------

type FileChange = NonNullable<ReviewData['changes']>[number];

interface DiffStatsBarProps {
  changes: FileChange[];
}

// -- Styles ---------------------------------------------------------

const styles = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-tertiary)',
    whiteSpace: 'nowrap' as const,
  },
  files: {
    color: 'var(--text-secondary)',
    fontWeight: 600,
  },
  additions: {
    color: 'var(--success)',
    fontWeight: 600,
  },
  deletions: {
    color: 'var(--danger)',
    fontWeight: 600,
  },
  barContainer: {
    display: 'flex',
    gap: 1,
    height: 8,
    width: 50,
    borderRadius: 2,
    overflow: 'hidden' as const,
    background: 'var(--bg-elevated)',
  },
  barAdd: {
    background: 'var(--success)',
    borderRadius: '2px 0 0 2px',
    transition: 'width 0.3s',
    minWidth: 0,
  },
  barDel: {
    background: 'var(--danger)',
    borderRadius: '0 2px 2px 0',
    transition: 'width 0.3s',
    minWidth: 0,
  },
} as const;

// -- Component ------------------------------------------------------

export function DiffStatsBar({ changes }: DiffStatsBarProps): JSX.Element {
  const stats = useMemo(
    () => parseDiffStatsFromChanges(changes),
    [changes],
  );

  const total = stats.additions + stats.deletions;
  const addPct = total > 0 ? (stats.additions / total) * 100 : 50;
  const delPct = total > 0 ? (stats.deletions / total) * 100 : 50;

  return (
    <div style={styles.container}>
      <span style={styles.files}>{stats.filesChanged}</span>
      <span>files</span>
      <span style={styles.additions}>+{stats.additions}</span>
      <span style={styles.deletions}>-{stats.deletions}</span>
      {total > 0 && (
        <div style={styles.barContainer}>
          <div
            style={{
              ...styles.barAdd,
              width: `${addPct}%`,
            }}
          />
          <div
            style={{
              ...styles.barDel,
              width: `${delPct}%`,
            }}
          />
        </div>
      )}
    </div>
  );
}
