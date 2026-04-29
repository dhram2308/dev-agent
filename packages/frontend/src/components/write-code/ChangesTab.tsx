import { useCallback, useEffect, useMemo, useState } from 'react';
import { DiffViewer } from '../review/DiffViewer';
import { usePipelineStore, useActiveTicketState } from '../../store/pipeline';
import { useLiveForTicket } from '../../store/codegenLive';
import { getApiToken } from '../../lib/api';
import type { ReviewData } from '../../types';

type ChangesSource = 'live' | 'state' | 'git' | 'none';

interface ChangesResponse {
  source: ChangesSource;
  changes: Array<{ action: 'create' | 'update' | 'delete'; file_path: string; content: string }>;
  summary: string;
  original_files: Record<string, string>;
  ts: number;
  reason?: string;
}

const styles = {
  emptyState: {
    padding: 'var(--sp-6)',
    textAlign: 'center' as const,
    color: 'var(--text-tertiary)',
    fontSize: 13,
    lineHeight: 1.6,
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    marginBottom: 'var(--sp-2)',
  },
  container: {
    minHeight: 320,
    maxHeight: '70vh',
    overflow: 'auto' as const,
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-subtle)',
  },
  livePill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    marginLeft: 'var(--sp-3)',
    padding: '2px 8px',
    borderRadius: 'var(--radius-full)',
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    background: 'rgba(34, 197, 94, 0.12)',
    color: 'var(--green, #22c55e)',
    animation: 'mi-live-pulse 1.6s ease-in-out infinite',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    padding: 'var(--sp-2) var(--sp-3)',
    marginBottom: 'var(--sp-2)',
    fontSize: 12,
    color: 'var(--text-tertiary)',
  },
  retryBtn: {
    marginTop: 'var(--sp-3)',
    padding: '6px 14px',
    fontSize: 12,
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  },
} as const;

function toReviewData(resp: ChangesResponse): ReviewData {
  return {
    gate: 'gate_code_review',
    changes: resp.changes.map((c) => ({
      file: c.file_path,
      action: c.action,
      content: c.content,
    })),
  };
}

function liveToReviewData(
  entry: { changes: Array<{ file_path: string; action: 'create' | 'update' | 'delete'; content: string }> },
): ReviewData {
  return {
    gate: 'gate_code_review',
    changes: entry.changes.map((c) => ({
      file: c.file_path,
      action: c.action,
      content: c.content,
    })),
  };
}

export function ChangesTab(): JSX.Element {
  const activeTicket = usePipelineStore((s) => s.activeTicket);
  const ticketState = useActiveTicketState();
  const liveEntry = useLiveForTicket(activeTicket);

  const stage = ticketState?.stage;
  const isRunning = ticketState?.isRunning ?? false;
  const isLive = stage === 'generate_code' && isRunning && liveEntry !== null;

  const [resp, setResp] = useState<ChangesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchChanges = useCallback(async () => {
    if (!activeTicket) return;
    setLoading(true);
    setError(null);
    try {
      const token = getApiToken();
      const qs = new URLSearchParams({ ticket: activeTicket });
      if (token) qs.set('token', token);
      const res = await fetch(`/api/changes?${qs.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as ChangesResponse;
      setResp(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [activeTicket]);

  useEffect(() => {
    if (isLive) return;
    void fetchChanges();
  }, [activeTicket, stage, isLive, fetchChanges]);

  const frozenReviewData = useMemo<ReviewData | null>(() => {
    if (!resp) return null;
    if (resp.changes.length === 0) return null;
    return toReviewData(resp);
  }, [resp]);

  if (isLive && liveEntry) {
    const liveReview = liveToReviewData(liveEntry);
    if (!liveReview.changes || liveReview.changes.length === 0) {
      return (
        <div style={styles.emptyState}>
          <div style={styles.emptyTitle}>Working…</div>
          The developer agent has not produced any file changes yet.
        </div>
      );
    }
    return (
      <>
        <div style={styles.header}>
          {liveReview.changes.length} file{liveReview.changes.length === 1 ? '' : 's'} changed
          <span style={styles.livePill}>● LIVE</span>
        </div>
        <div style={styles.container}>
          <DiffViewer source="live" liveData={liveEntry} />
        </div>
      </>
    );
  }

  if (loading && !resp) {
    return <div style={styles.emptyState}>Loading changes…</div>;
  }

  if (error && !resp) {
    return (
      <div style={styles.emptyState}>
        <div style={styles.emptyTitle}>Could not load changes</div>
        {error}
        <div>
          <button type="button" style={styles.retryBtn} onClick={() => void fetchChanges()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!resp || resp.source === 'none' || !frozenReviewData) {
    if (stage === 'generate_code' && isRunning) {
      return (
        <div style={styles.emptyState}>
          <div style={styles.emptyTitle}>Working…</div>
          The developer agent has not produced any file changes yet.
        </div>
      );
    }
    if (stage === 'generate_code') {
      return (
        <div style={styles.emptyState}>
          <div style={styles.emptyTitle}>No file changes</div>
          The developer agent returned a summary without modifying any files.
          See the <strong>Developer</strong> tab for the reasoning.
        </div>
      );
    }
    return (
      <div style={styles.emptyState}>
        <div style={styles.emptyTitle}>No changes yet</div>
        The developer has not run yet.
      </div>
    );
  }

  return (
    <>
      <div style={styles.header}>
        {resp.changes.length} file{resp.changes.length === 1 ? '' : 's'} changed
        {resp.source === 'git' ? <span style={{ marginLeft: 'var(--sp-2)', color: 'var(--text-tertiary)' }}>· from git</span> : null}
      </div>
      <div style={styles.container}>
        <DiffViewer source="frozen" frozenData={frozenReviewData} />
      </div>
    </>
  );
}
