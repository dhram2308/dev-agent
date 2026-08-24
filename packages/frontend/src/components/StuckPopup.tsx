// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Stuck-Stage Popup
//
// Replaces StuckBanner's passive text with an actionable card: Keep
// Waiting (dismiss), Retry Stage (reset + re-run, behind a confirmation),
// and Switch Model & Retry (per-ticket model override, kill + respawn).
// Driven by a real cause classification written by the agent's
// health-monitor (state.data._health.progress), not a client-side
// elapsed-time guess.
// ═══════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import { useActiveTicketState, useStuckClassification, usePipelineStore } from '../store/pipeline';
import { STAGE_INFO } from '../types';
import { ConfirmDialog } from './ConfirmDialog';

const styles = {
  card: {
    marginBottom: 'var(--sp-4)',
    padding: 'var(--sp-4)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--warning-muted)',
    border: '1px solid var(--warning)',
    animation: 'slideDown 0.3s ease-out',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--sp-3)',
    marginBottom: 'var(--sp-3)',
  },
  icon: {
    flexShrink: 0,
    color: 'var(--warning)',
    marginTop: 1,
  },
  content: { flex: 1 },
  title: {
    fontWeight: 700,
    fontSize: 13,
    color: 'var(--warning)',
    marginBottom: 2,
  },
  detail: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
  },
  actions: {
    display: 'flex',
    gap: 'var(--sp-2)',
    flexWrap: 'wrap' as const,
  },
  btn: {
    padding: 'var(--sp-2) var(--sp-4)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)',
    transition: 'all 0.15s',
  },
  btnPrimary: {
    border: '1px solid var(--accent)',
    background: 'var(--accent-muted)',
    color: 'var(--accent)',
  },
  btnDeemphasized: {
    opacity: 0.65,
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  modelForm: {
    marginTop: 'var(--sp-3)',
    display: 'flex',
    gap: 'var(--sp-2)',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
  },
  modelInput: {
    padding: 'var(--sp-2) var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    minWidth: 220,
  },
  networkNote: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    marginTop: 'var(--sp-2)',
    fontStyle: 'italic' as const,
  },
} as const;

function stageLabel(stage: string): string {
  return STAGE_INFO.find((s) => s.stage === stage)?.label ?? stage;
}

function causeLabel(cause: 'network' | 'slow' | 'gate-wait'): string {
  switch (cause) {
    case 'network': return 'a network failure';
    case 'slow': return 'no recent activity';
    default: return 'an unknown cause';
  }
}

export function StuckPopup(): JSX.Element | null {
  const ticketState = useActiveTicketState();
  const classification = useStuckClassification();
  const retryStage = usePipelineStore((s) => s.retryStage);
  const switchModelAndRetry = usePipelineStore((s) => s.switchModelAndRetry);

  const [dismissedAtMinutes, setDismissedAtMinutes] = useState<number | null>(null);
  const [showRetryConfirm, setShowRetryConfirm] = useState(false);
  const [showModelForm, setShowModelForm] = useState(false);
  const [model, setModel] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const ticket = ticketState?.ticket ?? null;

  // Reset dismissal whenever the active ticket changes, so switching
  // tickets doesn't carry over a stale "dismissed" state.
  useEffect(() => {
    setDismissedAtMinutes(null);
    setShowModelForm(false);
  }, [ticket]);

  if (!ticketState || !classification || !ticket) return null;

  // "Keep Waiting" suppresses the card until the next distinct stuck tick
  // (a higher stuckMinutes value), not forever — matches the health-monitor's
  // ~60s check interval.
  if (dismissedAtMinutes !== null && classification.stuckMinutes <= dismissedAtMinutes) {
    return null;
  }

  const handleRetryConfirmed = async (): Promise<void> => {
    setShowRetryConfirm(false);
    setSubmitting(true);
    try {
      await retryStage(ticket);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSwitchModel = async (): Promise<void> => {
    if (!model.trim()) return;
    setSubmitting(true);
    try {
      await switchModelAndRetry(ticket, model.trim());
      setShowModelForm(false);
      setModel('');
    } finally {
      setSubmitting(false);
    }
  };

  const isNetworkCause = classification.cause === 'network';

  return (
    <>
      <div style={styles.card} role="status" aria-live="polite">
        <div style={styles.header}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={styles.icon}>
            <circle cx="9" cy="9" r="7.25" />
            <path d="M9 5v4l2.5 2.5" />
          </svg>
          <div style={styles.content}>
            <div style={styles.title}>Stage may be stuck</div>
            <div style={styles.detail}>
              <strong>{stageLabel(ticketState.stage)}</strong> — no progress for {classification.stuckMinutes}m,
              likely caused by {causeLabel(classification.cause)}. Choose how to proceed.
            </div>
          </div>
        </div>

        <div style={styles.actions}>
          <button
            type="button"
            style={styles.btn}
            onClick={() => setDismissedAtMinutes(classification.stuckMinutes)}
            disabled={submitting}
          >
            Keep Waiting
          </button>
          <button
            type="button"
            style={{ ...styles.btn, ...styles.btnPrimary, ...(submitting ? styles.btnDisabled : {}) }}
            onClick={() => setShowRetryConfirm(true)}
            disabled={submitting}
          >
            Retry Stage
          </button>
          <button
            type="button"
            style={{
              ...styles.btn,
              ...(isNetworkCause ? styles.btnDeemphasized : {}),
              ...(submitting ? styles.btnDisabled : {}),
            }}
            onClick={() => setShowModelForm((v) => !v)}
            disabled={submitting}
            title={isNetworkCause ? 'A model change will not fix a network failure' : undefined}
          >
            Switch Model &amp; Retry
          </button>
        </div>

        {isNetworkCause && (
          <div style={styles.networkNote}>
            The detected cause is a network failure — switching models is unlikely to help here.
          </div>
        )}

        {showModelForm && (
          <div style={styles.modelForm}>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. claude-sonnet-4-5-20250514"
              style={styles.modelInput}
              aria-label="Model override"
              disabled={submitting}
            />
            <button
              type="button"
              style={{ ...styles.btn, ...styles.btnPrimary, ...(!model.trim() || submitting ? styles.btnDisabled : {}) }}
              onClick={handleSwitchModel}
              disabled={!model.trim() || submitting}
            >
              {submitting ? 'Restarting…' : 'Confirm Switch'}
            </button>
            <button
              type="button"
              style={styles.btn}
              onClick={() => { setShowModelForm(false); setModel(''); }}
              disabled={submitting}
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={showRetryConfirm}
        title="Retry this stage?"
        message={`This clears "${stageLabel(ticketState.stage)}"'s cached data and re-runs it from scratch. Progress from earlier stages is not affected.`}
        confirmText="Retry Stage"
        onConfirm={handleRetryConfirmed}
        onCancel={() => setShowRetryConfirm(false)}
      />
    </>
  );
}
