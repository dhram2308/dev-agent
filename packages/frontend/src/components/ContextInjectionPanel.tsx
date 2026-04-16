// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Context Injection Panel
// Collapsible textarea + submit button that pushes additional
// context into the currently running agent via /api/inject-context.
// ═══════════════════════════════════════════════════════════════

import { useCallback, useState } from 'react';
import { injectContext } from '../lib/api';

interface ContextInjectionPanelProps {
  ticket: string;
  /** Whether the agent is currently running (injection only valid when running) */
  isRunning: boolean;
}

const styles = {
  container: {
    marginBottom: 'var(--sp-4)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--bg-surface)',
    overflow: 'hidden' as const,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 'var(--sp-3) var(--sp-4)',
    cursor: 'pointer',
    userSelect: 'none' as const,
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
  },
  chevron: {
    transition: 'transform 0.2s var(--ease-smooth)',
    color: 'var(--text-tertiary)',
  },
  body: {
    padding: '0 var(--sp-4) var(--sp-4)',
  },
  textarea: {
    width: '100%',
    minHeight: 80,
    padding: 'var(--sp-3)',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    resize: 'vertical' as const,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 'var(--sp-2)',
    marginTop: 'var(--sp-3)',
  },
  submitBtn: {
    padding: 'var(--sp-2) var(--sp-4)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    fontFamily: 'var(--font-sans)',
  },
  submitBtnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  status: {
    marginTop: 'var(--sp-2)',
    fontSize: 11,
    color: 'var(--text-tertiary)',
  },
  statusSuccess: {
    color: 'var(--success)',
  },
  statusError: {
    color: 'var(--danger)',
  },
} as const;

export function ContextInjectionPanel({ ticket, isRunning }: ContextInjectionPanelProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'err'; msg: string }>({
    kind: 'idle',
    msg: '',
  });

  const handleSubmit = useCallback(async () => {
    if (!text.trim()) return;
    setSubmitting(true);
    setStatus({ kind: 'idle', msg: '' });
    try {
      await injectContext(ticket, text.trim());
      setStatus({ kind: 'ok', msg: 'Context injected — the agent will see it on next iteration.' });
      setText('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus({ kind: 'err', msg: `Failed: ${msg}` });
    } finally {
      setSubmitting(false);
    }
  }, [text, ticket]);

  // Only show when agent is running
  if (!isRunning) return null;

  const canSubmit = !submitting && text.trim().length > 0;

  return (
    <div style={styles.container}>
      <div
        style={styles.header}
        onClick={() => setExpanded((x) => !x)}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
      >
        <span style={styles.headerTitle}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M2 4h12M2 8h12M2 12h8" />
          </svg>
          Inject additional context
        </span>
        <span
          style={{
            ...styles.chevron,
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
          aria-hidden="true"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 4.5l3 3 3-3" />
          </svg>
        </span>
      </div>

      {expanded && (
        <div style={styles.body}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Use the existing `orderService.createDraft()` pattern, not a new helper."
            style={styles.textarea}
            aria-label="Additional context to inject"
            spellCheck={false}
          />
          <div style={styles.actions}>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              style={{
                ...styles.submitBtn,
                ...(canSubmit ? {} : styles.submitBtnDisabled),
              }}
            >
              {submitting ? 'Sending...' : 'Inject'}
            </button>
          </div>
          {status.kind !== 'idle' && (
            <div
              style={{
                ...styles.status,
                ...(status.kind === 'ok' ? styles.statusSuccess : styles.statusError),
              }}
              role="status"
            >
              {status.msg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
