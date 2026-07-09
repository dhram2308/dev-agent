// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Gate Notification Bar
// Lists pipelines waiting for gate approval across tickets and lets
// the user jump to a ticket to act on it via the guarded GateApproval
// panel — this bar itself never approves/rejects a gate.
// ═══════════════════════════════════════════════════════════════

import { usePipelineStore } from '../store/pipeline';
import { STAGE_INFO, type PipelineSummary } from '../types';

// ── Styles ─────────────────────────────────────────────────────

const styles = {
  bar: {
    background: 'var(--warning-muted)',
    borderBottom: '1px solid var(--warning)',
    padding: 'var(--sp-2) var(--sp-4)',
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 'var(--sp-2)',
    alignItems: 'center',
    fontSize: 12,
  },
  entry: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    padding: 'var(--sp-1) var(--sp-3)',
  },
  ticket: {
    fontWeight: 600,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)',
  },
  gate: {
    color: 'var(--text-tertiary)',
  },
  reviewBtn: {
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    padding: '2px 8px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
  },
} as const;

function gateLabel(stage: string): string {
  const info = STAGE_INFO.find(s => s.stage === stage);
  return info?.label ?? stage;
}

export function GateNotificationBar(): JSX.Element | null {
  const pipelines = usePipelineStore((s) => s.pipelines);
  const activeTicket = usePipelineStore((s) => s.activeTicket);
  const setActiveTicket = usePipelineStore((s) => s.setActiveTicket);

  const gateWaiting = pipelines.filter(
    (p: PipelineSummary) => p.status === 'gate_waiting' && p.needsApproval && p.ticket !== activeTicket,
  );

  if (gateWaiting.length === 0) return null;

  return (
    <div style={styles.bar}>
      {gateWaiting.map((p: PipelineSummary) => (
        <div key={p.ticket} style={styles.entry}>
          <span style={styles.ticket}>{p.ticket}</span>
          <span style={styles.gate}>needs approval at {gateLabel(p.gateStage || '')}</span>
          <button
            style={styles.reviewBtn}
            onClick={() => setActiveTicket(p.ticket)}
          >
            Review
          </button>
        </div>
      ))}
    </div>
  );
}
