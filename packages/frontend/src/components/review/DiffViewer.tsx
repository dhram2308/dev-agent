// ===================================================================
// MI Dev Agent -- Diff Viewer (Main Shell)
// GitHub/GitLab-style code review with split/unified toggle,
// file tree sidebar, diff content, inline comments, plan tabs
// ===================================================================

import { useEffect, useState, useCallback } from 'react';
import { usePipelineStore } from '../../store/pipeline';
import { useReviewStore } from '../../store/review';
import * as api from '../../lib/api';
import { FileTree } from './FileTree';
import { DiffPane } from './DiffPane';
import { DiffStatsBar } from './DiffStatsBar';
import { PlanTabs } from './PlanTabs';
import type { ReviewData } from '../../types';

// -- Styles ---------------------------------------------------------

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 0,
    height: '100%',
    minHeight: 0,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 'var(--sp-3) var(--sp-4)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
    gap: 'var(--sp-3)',
    flexWrap: 'wrap' as const,
  },
  toolbarLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
    flex: 1,
    minWidth: 0,
  },
  toolbarRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
  },
  title: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text-primary)',
    letterSpacing: '-0.01em',
  },
  gateBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 'var(--radius-full)',
    background: 'var(--accent-muted)',
    color: 'var(--accent)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  modeToggle: {
    display: 'flex',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-default)',
    overflow: 'hidden' as const,
  },
  modeBtn: {
    padding: '4px 12px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-sans)',
    transition: 'all 0.15s',
  },
  modeBtnActive: {
    background: 'var(--accent-muted)',
    color: 'var(--accent)',
  },
  tabBar: {
    display: 'flex',
    gap: 0,
    background: 'var(--bg-surface)',
    borderLeft: '1px solid var(--border-subtle)',
    borderRight: '1px solid var(--border-subtle)',
  },
  tab: {
    padding: 'var(--sp-2) var(--sp-4)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
    borderBottom: '2px solid transparent',
    background: 'transparent',
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-sans)',
    transition: 'all 0.15s',
  },
  tabActive: {
    color: 'var(--accent)',
    borderBottomColor: 'var(--accent)',
    background: 'var(--bg-elevated)',
  },
  body: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    border: '1px solid var(--border-subtle)',
    borderTop: 'none',
    borderRadius: '0 0 var(--radius-md) var(--radius-md)',
    overflow: 'hidden' as const,
  },
  fileSidebar: {
    width: 260,
    minWidth: 200,
    maxWidth: 360,
    borderRight: '1px solid var(--border-subtle)',
    background: 'var(--bg-surface)',
    overflowY: 'auto' as const,
    flexShrink: 0,
  },
  diffArea: {
    flex: 1,
    overflowY: 'auto' as const,
    overflowX: 'auto' as const,
    background: 'var(--bg-base)',
    minWidth: 0,
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'var(--sp-8)',
    color: 'var(--text-tertiary)',
    fontSize: 13,
    fontFamily: 'var(--font-mono)',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'var(--sp-8)',
    color: 'var(--text-tertiary)',
    fontSize: 13,
    gap: 'var(--sp-2)',
    textAlign: 'center' as const,
  },
  mrLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-1)',
    padding: '4px 12px',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--blue-muted)',
    color: 'var(--blue)',
    textDecoration: 'none',
    fontSize: 12,
    fontWeight: 600,
    transition: 'background 0.15s',
  },
} as const;

type ViewTab = 'changes' | 'plan';

// -- Component ------------------------------------------------------

export function DiffViewer(): JSX.Element {
  const activeTicket = usePipelineStore((s) => s.activeTicket);
  const reviewData = usePipelineStore((s) => s.reviewData);

  const viewMode = useReviewStore((s) => s.viewMode);
  const setViewMode = useReviewStore((s) => s.setViewMode);
  const selectedFile = useReviewStore((s) => s.selectedFile);
  const setSelectedFile = useReviewStore((s) => s.setSelectedFile);

  const [activeTab, setActiveTab] = useState<ViewTab>('changes');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch review data on mount or when active ticket changes
  const fetchData = useCallback(async () => {
    if (!activeTicket) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getReviewData(activeTicket);
      usePipelineStore.getState().updateReviewData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [activeTicket]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-select first file when review data arrives
  useEffect(() => {
    if (reviewData?.changes && reviewData.changes.length > 0 && !selectedFile) {
      setSelectedFile(reviewData.changes[0].file);
    }
  }, [reviewData, selectedFile, setSelectedFile]);

  // Find the selected change
  const selectedChange = reviewData?.changes?.find(
    (c) => c.file === selectedFile,
  );

  const hasPlan = reviewData?.plan && Object.keys(reviewData.plan).length > 0;
  const hasChanges = reviewData?.changes && reviewData.changes.length > 0;

  // Loading state
  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>Loading review data...</div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div style={styles.container}>
        <div style={styles.empty}>
          <div style={{ color: 'var(--danger)', fontWeight: 600 }}>
            Failed to load review data
          </div>
          <div>{error}</div>
          <button
            onClick={fetchData}
            style={{
              marginTop: 'var(--sp-2)',
              padding: 'var(--sp-2) var(--sp-4)',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-default)',
              background: 'var(--bg-elevated)',
              color: 'var(--text-secondary)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // No review data
  if (!reviewData) {
    return (
      <div style={styles.container}>
        <div style={styles.empty}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-secondary)' }}>
            No Review Data
          </div>
          <div>
            {activeTicket
              ? 'No review data available for this ticket yet. Wait for the pipeline to reach a gate stage.'
              : 'Select a ticket to view review data.'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <div style={styles.toolbarLeft}>
          <span style={styles.title}>Code Review</span>
          {reviewData.gate && (
            <span style={styles.gateBadge}>{reviewData.gate.replace(/_/g, ' ')}</span>
          )}
          {reviewData.mrUrl && (
            <a
              href={reviewData.mrUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={styles.mrLink}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M6 3H3v10h10v-3M10 2h4v4M7 9l7-7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              MR {reviewData.mrIid ? `!${reviewData.mrIid}` : ''}
            </a>
          )}
        </div>
        <div style={styles.toolbarRight}>
          {hasChanges && (
            <DiffStatsBar changes={reviewData.changes!} />
          )}
          <div style={styles.modeToggle}>
            <button
              style={{
                ...styles.modeBtn,
                ...(viewMode === 'unified' ? styles.modeBtnActive : {}),
              }}
              onClick={() => setViewMode('unified')}
            >
              Unified
            </button>
            <button
              style={{
                ...styles.modeBtn,
                ...(viewMode === 'split' ? styles.modeBtnActive : {}),
                borderLeft: '1px solid var(--border-default)',
              }}
              onClick={() => setViewMode('split')}
            >
              Split
            </button>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      {hasPlan && (
        <div style={styles.tabBar}>
          <button
            style={{
              ...styles.tab,
              ...(activeTab === 'changes' ? styles.tabActive : {}),
            }}
            onClick={() => setActiveTab('changes')}
          >
            Changes {hasChanges ? `(${reviewData.changes!.length})` : ''}
          </button>
          <button
            style={{
              ...styles.tab,
              ...(activeTab === 'plan' ? styles.tabActive : {}),
            }}
            onClick={() => setActiveTab('plan')}
          >
            Plan
          </button>
        </div>
      )}

      {/* Body */}
      {activeTab === 'plan' && reviewData.plan ? (
        <div style={{
          ...styles.body,
          ...(hasPlan ? { borderRadius: '0 0 var(--radius-md) var(--radius-md)' } : {}),
        }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--sp-4)' }}>
            <PlanTabs plan={reviewData.plan} />
          </div>
        </div>
      ) : (
        <div style={{
          ...styles.body,
          ...(hasPlan ? { borderRadius: '0 0 var(--radius-md) var(--radius-md)' } : {}),
        }}>
          {/* File sidebar */}
          {hasChanges && (
            <div style={styles.fileSidebar}>
              <FileTree
                changes={reviewData.changes!}
                selectedFile={selectedFile}
                onSelect={setSelectedFile}
              />
            </div>
          )}

          {/* Diff area */}
          <div style={styles.diffArea}>
            {selectedChange ? (
              <DiffPane
                change={selectedChange}
                viewMode={viewMode}
              />
            ) : (
              <div style={styles.empty}>
                {hasChanges
                  ? 'Select a file to view changes'
                  : 'No file changes in this review'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
