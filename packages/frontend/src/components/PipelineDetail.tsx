// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Pipeline Detail View
// Stage progress bar, history, and metadata for selected pipeline
// ═══════════════════════════════════════════════════════════════

import { STAGE_INFO, type PipelineSummary } from '../types';

// ── Styles ─────────────────────────────────────────────────────

const styles = {
  container: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
    padding: 'var(--sp-4)',
    marginBottom: 'var(--sp-4)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 'var(--sp-3)',
  },
  ticket: {
    fontSize: 14,
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
  stageProgress: {
    display: 'flex',
    gap: 3,
    marginBottom: 'var(--sp-3)',
  },
  stageStep: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 2,
  },
  stepBar: {
    width: '100%',
    height: 4,
    borderRadius: 2,
  },
  stepLabel: {
    fontSize: 8,
    color: 'var(--text-tertiary)',
    textAlign: 'center' as const,
    lineHeight: 1.2,
    maxWidth: '100%',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
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
} as const;

// ── Helpers ──────────────────────────────────────────────────────

function getStatusPillStyle(status: string): React.CSSProperties {
  switch (status) {
    case 'running': return { background: 'var(--success-muted)', color: 'var(--success)' };
    case 'gate_waiting': return { background: 'var(--warning-muted)', color: 'var(--warning)' };
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

  return (
    <div style={styles.container}>
      {/* Header row */}
      <div style={styles.header}>
        <span style={styles.ticket}>{pipeline.ticket}</span>
        <span style={{ ...styles.statusPill, ...getStatusPillStyle(pipeline.status) }}>
          {statusText(pipeline.status)}
        </span>
      </div>

      {/* Stage progress bar */}
      <div style={styles.stageProgress}>
        {STAGE_INFO.map((info, idx) => (
          <div key={info.stage} style={styles.stageStep}>
            <div
              style={{
                ...styles.stepBar,
                background:
                  idx < stageIdx
                    ? 'var(--success)'
                    : idx === stageIdx
                      ? (pipeline.running ? 'var(--accent)' : 'var(--warning)')
                      : 'var(--bg-elevated)',
              }}
            />
            <span style={{
              ...styles.stepLabel,
              color: idx === stageIdx ? 'var(--text-primary)' : undefined,
              fontWeight: idx === stageIdx ? 600 : undefined,
            }}>
              {info.label.split(' ')[0]}
            </span>
          </div>
        ))}
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
    </div>
  );
}
