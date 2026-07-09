// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Playground Page
// Pick a pipeline stage, optionally borrow a real ticket's context,
// override its instruction, and run it in an isolated environment
// with all real external side effects simulated. Phase 1: stub
// backend that echoes the request back over SSE — no real stage
// execution yet (see packages/agent/src/playground-runner.ts, a
// later phase).
// ═══════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import { usePlaygroundStore, usePlaygroundRun } from '../../store/playground';
import { useToast } from '../../contexts/ToastContext';
import { STAGE_INFO, type StageName } from '../../types';

// Playground initially exposes only stages with no irreversible external
// side effects when simulated — deploy/gate/dual-approval stages are
// excluded until the safe stages are proven out (see plan section D.5).
// Exported so other views (PipelineDetail, Sidebar) can gate their own
// "run/verify in Playground" deep links to the same set without duplicating it.
export const PLAYGROUND_ALLOWED_STAGES: readonly StageName[] = ['fetch_ticket', 'explore_plan', 'generate_code'];

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--sp-5)',
  },
  banner: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    padding: 'var(--sp-3) var(--sp-4)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--warning-muted)',
    color: 'var(--warning)',
    fontSize: 13,
    fontWeight: 600,
  },
  panel: {
    borderRadius: 'var(--radius-lg)',
    border: '1px solid var(--glass-border)',
    background: 'var(--glass-bg)',
    backdropFilter: 'blur(var(--glass-blur))',
    WebkitBackdropFilter: 'blur(var(--glass-blur))',
    padding: 'var(--sp-5)',
  },
  title: {
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: 'var(--sp-4)',
  },
  field: {
    marginBottom: 'var(--sp-4)',
  },
  label: {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    marginBottom: 'var(--sp-2)',
  },
  stagePicker: {
    display: 'flex',
    gap: 'var(--sp-2)',
    flexWrap: 'wrap' as const,
  },
  stageBtn: {
    padding: 'var(--sp-2) var(--sp-4)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    border: '1.5px solid var(--border-default)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-secondary)',
    transition: 'all 0.15s',
    fontFamily: 'var(--font-sans)',
  },
  stageBtnActive: {
    border: '1.5px solid var(--accent)',
    background: 'var(--accent-muted)',
    color: 'var(--accent)',
  },
  input: {
    width: '100%',
    maxWidth: 320,
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    padding: 'var(--sp-2) var(--sp-3)',
    outline: 'none',
  },
  textarea: {
    width: '100%',
    height: 100,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    padding: 'var(--sp-3)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    resize: 'vertical' as const,
    outline: 'none',
  },
  hint: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    marginTop: 'var(--sp-1)',
  },
  runBtn: {
    padding: 'var(--sp-3) var(--sp-6)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
    background: 'linear-gradient(135deg, var(--accent), var(--blue))',
    color: '#fff',
    fontFamily: 'var(--font-sans)',
  },
  runBtnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
    marginBottom: 'var(--sp-3)',
  },
  statusBadge: {
    fontSize: 11,
    padding: '3px 10px',
    borderRadius: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  terminal: {
    background: '#0a0c10',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    height: 280,
    overflow: 'auto',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    lineHeight: '22px',
    padding: 'var(--sp-2) 0',
  },
  logLine: {
    padding: '0 var(--sp-3)',
    color: 'var(--text-secondary)',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
  },
  emptyState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: 'var(--text-ghost)',
    fontSize: 13,
    fontStyle: 'italic' as const,
  },
} as const;

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  running: { bg: 'var(--warning-muted)', fg: 'var(--warning)' },
  completed: { bg: 'var(--success-muted)', fg: 'var(--success)' },
  failed: { bg: 'var(--danger-muted)', fg: 'var(--danger)' },
  stopped: { bg: 'var(--bg-elevated)', fg: 'var(--text-tertiary)' },
};

export function PlaygroundPage(): JSX.Element {
  const prefillStage = usePlaygroundStore((s) => s.prefillStage);
  const prefillTicket = usePlaygroundStore((s) => s.prefillTicket);
  const clearPrefill = usePlaygroundStore((s) => s.clearPrefill);
  const startRun = usePlaygroundStore((s) => s.startRun);
  const activeRunId = usePlaygroundStore((s) => s.activeRunId);
  const activeRun = usePlaygroundRun(activeRunId);
  const { addToast } = useToast();

  const [stage, setStage] = useState<StageName>(PLAYGROUND_ALLOWED_STAGES[0]);
  const [ticket, setTicket] = useState('');
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Consume a "Run this stage in Playground" deep-link prefill once, then clear it.
  useEffect(() => {
    if (!prefillStage && !prefillTicket) return;
    if (prefillStage && PLAYGROUND_ALLOWED_STAGES.includes(prefillStage)) {
      setStage(prefillStage);
    }
    if (prefillTicket) {
      setTicket(prefillTicket);
    }
    clearPrefill();
  }, [prefillStage, prefillTicket, clearPrefill]);

  const handleStart = async (): Promise<void> => {
    setSubmitting(true);
    try {
      const trimmedTicket = ticket.trim().toUpperCase();
      const result = await startRun(stage, trimmedTicket || null, instruction.trim());
      if (!result.ok) {
        addToast(result.error ?? 'Failed to start Playground run', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const stageOptions = STAGE_INFO.filter((info) => PLAYGROUND_ALLOWED_STAGES.includes(info.stage));

  return (
    <div style={styles.container}>
      <div style={styles.banner} role="status">
        Playground — sandboxed. No real deploys, pushes, or notifications are performed here.
      </div>

      <div style={styles.panel}>
        <div style={styles.title}>Run a stage</div>

        <div style={styles.field}>
          <label style={styles.label}>Stage</label>
          <div style={styles.stagePicker}>
            {stageOptions.map((info) => (
              <button
                key={info.stage}
                type="button"
                style={{
                  ...styles.stageBtn,
                  ...(stage === info.stage ? styles.stageBtnActive : {}),
                }}
                onClick={() => setStage(info.stage)}
                aria-pressed={stage === info.stage}
              >
                {info.label}
              </button>
            ))}
          </div>
        </div>

        <div style={styles.field}>
          <label style={styles.label} htmlFor="playground-ticket">
            Borrow context from ticket (optional)
          </label>
          <input
            id="playground-ticket"
            type="text"
            value={ticket}
            onChange={(e) => setTicket(e.target.value)}
            placeholder="e.g. AUT-1234"
            spellCheck={false}
            style={styles.input}
          />
          <div style={styles.hint}>
            Read-only — clones that ticket&apos;s prior-stage data. Never writes back to its real state.
          </div>
        </div>

        <div style={styles.field}>
          <label style={styles.label} htmlFor="playground-instruction">
            Custom instruction (optional)
          </label>
          <textarea
            id="playground-instruction"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Override the stage's default instruction for this run only..."
            style={styles.textarea}
          />
        </div>

        <button
          type="button"
          style={{
            ...styles.runBtn,
            ...(submitting ? styles.runBtnDisabled : {}),
          }}
          onClick={handleStart}
          disabled={submitting}
        >
          {submitting ? 'Starting…' : 'Run in Playground'}
        </button>
      </div>

      <div style={styles.panel}>
        <div style={styles.title}>Live output</div>
        {activeRun && (
          <div style={styles.statusRow}>
            <span
              style={{
                ...styles.statusBadge,
                background: STATUS_COLORS[activeRun.status]?.bg,
                color: STATUS_COLORS[activeRun.status]?.fg,
              }}
            >
              {activeRun.status}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              {STAGE_INFO.find((i) => i.stage === activeRun.stage)?.label ?? activeRun.stage}
              {activeRun.ticket ? ` · ${activeRun.ticket}` : ''}
            </span>
          </div>
        )}
        <div style={styles.terminal} role="log" aria-live="polite">
          {!activeRun || activeRun.logs.length === 0 ? (
            <div style={styles.emptyState}>
              {activeRun ? 'Waiting for output…' : 'No run yet — start one above.'}
            </div>
          ) : (
            activeRun.logs.map((log) => (
              <div key={log.id} style={styles.logLine}>
                {log.message}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
