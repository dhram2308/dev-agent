// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Reject Form Component
// Textarea + submit for gate rejection feedback
// ═══════════════════════════════════════════════════════════════

import { useState } from 'react';

interface RejectFormProps {
  onSubmit: (reason: string) => Promise<void>;
  onCancel: () => void;
  submitting: boolean;
}

const styles = {
  container: {
    marginTop: 'var(--sp-3)',
    animation: 'slideDown 0.2s ease-out',
  },
  label: {
    display: 'block',
    fontSize: 12,
    fontWeight: 600 as const,
    color: 'var(--text-secondary)',
    marginBottom: 'var(--sp-2)',
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
    transition: 'border-color 0.2s',
    boxSizing: 'border-box' as const,
  },
  actions: {
    display: 'flex',
    gap: 'var(--sp-2)',
    marginTop: 'var(--sp-2)',
    alignItems: 'center',
  },
  btnSubmit: {
    padding: 'var(--sp-2) var(--sp-5)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 600 as const,
    cursor: 'pointer',
    border: 'none',
    background: 'var(--danger)',
    color: '#fff',
    transition: 'all 0.2s',
    fontFamily: 'var(--font-sans)',
  },
  btnCancel: {
    padding: 'var(--sp-2) var(--sp-5)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 600 as const,
    cursor: 'pointer',
    background: 'transparent',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-default)',
    transition: 'all 0.2s',
    fontFamily: 'var(--font-sans)',
  },
  disabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  spinner: {
    display: 'inline-block',
    width: 12,
    height: 12,
    border: '2px solid rgba(255,255,255,0.3)',
    borderTopColor: '#fff',
    borderRadius: '50%',
    animation: 'spin 0.6s linear infinite',
    marginRight: 6,
    verticalAlign: 'middle',
  },
} as const;

export function RejectForm({ onSubmit, onCancel, submitting }: RejectFormProps): JSX.Element {
  const [reason, setReason] = useState('');
  const canSubmit = reason.trim().length > 0 && !submitting;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    await onSubmit(reason.trim());
    setReason('');
  };

  return (
    <div style={styles.container}>
      <label style={styles.label}>Rejection Feedback</label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Describe what needs to change..."
        style={styles.textarea}
        aria-label="Rejection feedback"
        disabled={submitting}
      />
      <div style={styles.actions}>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          style={{
            ...styles.btnSubmit,
            ...(!canSubmit ? styles.disabled : {}),
          }}
          aria-label="Submit rejection"
        >
          {submitting && <span style={styles.spinner} />}
          Submit Rejection
        </button>
        <button
          onClick={onCancel}
          style={styles.btnCancel}
          disabled={submitting}
          aria-label="Cancel rejection"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
