// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Pipeline Detail View
// Ticket title, status, and metadata — the top of the Dashboard's
// sticky header (paired visually with AgentStatus's stepper strip
// directly below it; see dashboard-activity-timeline-redesign).
// ═══════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import { STAGE_INFO, type PipelineSummary, type StageName } from '../types';
import { usePlaygroundStore } from '../store/playground';
import { useNavigationStore } from '../store/navigation';
import { PLAYGROUND_ALLOWED_STAGES } from './playground/PlaygroundPage';
import { getPlaygroundRuns } from '../lib/api';

// ── Styles ─────────────────────────────────────────────────────

const styles = {
  container: {
    background: 'var(--glass-bg)',
    backdropFilter: 'blur(var(--glass-blur))',
    WebkitBackdropFilter: 'blur(var(--glass-blur))',
    border: '1px solid var(--glass-border)',
    borderBottom: 'none',
    borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
    padding: 'var(--sp-4)',
    marginBottom: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 'var(--sp-3)',
  },
  ticket: {
    fontSize: 17,
    fontWeight: 700,
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
  },
  statusPill: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    padding: '2px 8px',
    borderRadius: 'var(--radius-full)',
  },
  meta: {
    display: 'flex',
    gap: 'var(--sp-4)',
    flexWrap: 'wrap' as const,
    fontSize: 11,
    color: 'var(--text-tertiary)',
  },
  metaItem: {
    display: 'flex',
    gap: 'var(--sp-1)',
    alignItems: 'center',
  },
  metaValue: {
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
  },
  playgroundBtn: {
    marginLeft: 'auto',
    padding: 'var(--sp-1) var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    background: 'transparent',
    color: 'var(--accent)',
    border: '1px solid var(--accent)',
    fontFamily: 'var(--font-sans)',
    whiteSpace: 'nowrap' as const,
  },
  bridgeRow: {
    marginTop: 'var(--sp-2)',
  },
  bridgeLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-1)',
    padding: '3px 10px',
    borderRadius: 'var(--radius-full)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    background: 'var(--accent-muted)',
    color: 'var(--accent)',
    border: '1px solid transparent',
    fontFamily: 'var(--font-sans)',
  },
} as const;

// ── Helpers ──────────────────────────────────────────────────────

function getStatusPillStyle(status: string): React.CSSProperties {
  switch (status) {
    case 'running': return { background: 'var(--success-muted)', color: 'var(--success)' };
    case 'gate_waiting': return { background: 'var(--gate-muted)', color: 'var(--gate)' };
    case 'paused': return { background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' };
    case 'done': return { background: 'var(--success-muted)', color: 'var(--success)' };
    case 'expired': return { background: 'var(--danger-muted)', color: 'var(--danger)' };
    default: return { background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' };
  }
}

function statusText(status: string): string {
  switch (status) {
    case 'running': return 'Running';
    case 'gate_waiting': return 'Gate Waiting';
    case 'paused': return 'Paused';
    case 'done': return 'Done';
    case 'expired': return 'Expired';
    default: return status;
  }
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'N/A';
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Props ──────────────────────────────────────────────────────

interface PipelineDetailProps {
  pipeline: PipelineSummary;
}

// ── Component ──────────────────────────────────────────────────

export function PipelineDetail({ pipeline }: PipelineDetailProps): JSX.Element {
  const stageIdx = STAGE_INFO.findIndex(s => s.stage === pipeline.stage);
  const canVerifyInPlayground = PLAYGROUND_ALLOWED_STAGES.includes(pipeline.stage as StageName);

  const handleVerifyInPlayground = (): void => {
    usePlaygroundStore.getState().prefill(pipeline.stage as StageName, pipeline.ticket);
    useNavigationStore.getState().setView('playground');
  };

  // Bridge link: surface past Playground runs for this ticket, if any,
  // as a one-click jump to the full Playground page (run history there).
  const [pastRunCount, setPastRunCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getPlaygroundRuns(pipeline.ticket)
      .then((res) => {
        if (!cancelled && res.ok) setPastRunCount(res.runs.length);
      })
      .catch(() => { /* best-effort — bridge link just stays hidden */ });
    return () => { cancelled = true; };
  }, [pipeline.ticket]);

  const handleViewPlaygroundRuns = (): void => {
    usePlaygroundStore.getState().prefill(pipeline.stage as StageName, pipeline.ticket);
    useNavigationStore.getState().setView('playground');
  };

  return (
    <div style={styles.container}>
      {/* Header row */}
      <div style={styles.header}>
        <span style={styles.ticket}>{pipeline.ticket}</span>
        <span style={{ ...styles.statusPill, ...getStatusPillStyle(pipeline.status) }}>
          {statusText(pipeline.status)}
        </span>
        {canVerifyInPlayground && (
          <button
            type="button"
            style={styles.playgroundBtn}
            onClick={handleVerifyInPlayground}
            aria-label={`Run ${STAGE_INFO[stageIdx]?.label ?? pipeline.stage} in Playground`}
          >
            Run in Playground
          </button>
        )}
      </div>

      {/* Metadata row */}
      <div style={styles.meta}>
        <div style={styles.metaItem}>
          Stage: <span style={styles.metaValue}>{STAGE_INFO[stageIdx]?.label ?? pipeline.stage}</span>
        </div>
        <div style={styles.metaItem}>
          Last active: <span style={styles.metaValue}>{timeAgo(pipeline.lastActivity)}</span>
        </div>
        {pipeline.startedAt && (
          <div style={styles.metaItem}>
            Started: <span style={styles.metaValue}>{timeAgo(pipeline.startedAt)}</span>
          </div>
        )}
        {pipeline.resumeCount > 0 && (
          <div style={styles.metaItem}>
            Resumes: <span style={styles.metaValue}>{pipeline.resumeCount}</span>
          </div>
        )}
        {!pipeline.running && pipeline.status !== 'done' && pipeline.status !== 'expired' && (
          <div style={styles.metaItem}>
            Window: <span style={styles.metaValue}>{pipeline.daysRemaining}d left</span>
          </div>
        )}
      </div>

      {/* Bridge link to Playground's run history for this ticket */}
      {pastRunCount > 0 && (
        <div style={styles.bridgeRow}>
          <button type="button" style={styles.bridgeLink} onClick={handleViewPlaygroundRuns}>
            {pastRunCount} past Playground run{pastRunCount === 1 ? '' : 's'} for this ticket →
          </button>
        </div>
      )}
    </div>
  );
}
