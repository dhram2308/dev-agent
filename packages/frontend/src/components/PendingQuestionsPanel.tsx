// ===================================================================
// MI Dev Agent -- Pending Questions Panel
// Renders clarifying questions raised by the Architect agent as a
// choice widget. Mounted above the Plan Review tabs when
// `state.data._pending_questions` is non-empty. Answering hides the
// question (trailing SSE `state` event refreshes the store) and
// re-enables the Approve button in GateApproval.
// ===================================================================

import { useState, useCallback, useMemo } from 'react';
import { usePipelineStore, usePendingQuestions } from '../store/pipeline';
import type { PendingQuestion } from '@mi/shared';

// ── Styles ─────────────────────────────────────────────────────

const styles = {
  container: {
    marginBottom: 'var(--sp-4)',
    padding: 'var(--sp-3) var(--sp-4)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--warning-muted)',
    border: '1px solid rgba(234, 179, 8, 0.25)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 'var(--sp-3)',
    gap: 'var(--sp-3)',
  },
  title: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--warning)',
    letterSpacing: '0.02em',
    textTransform: 'uppercase' as const,
  },
  bulkBtn: {
    fontSize: 11,
    fontWeight: 600,
    padding: '6px 12px',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--accent)',
    color: 'var(--bg-surface)',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
    whiteSpace: 'nowrap' as const,
  },
  bulkBtnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  question: {
    padding: 'var(--sp-3) 0',
    borderTop: '1px solid rgba(234, 179, 8, 0.15)',
  },
  questionText: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: 'var(--sp-2)',
  },
  optionRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--sp-2)',
    padding: '4px 0',
    cursor: 'pointer',
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
  },
  radio: {
    marginTop: 3,
    flexShrink: 0,
    cursor: 'pointer',
  },
  optionLabel: {
    flex: 1,
  },
  aiStar: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--warning)',
    marginLeft: 6,
    padding: '1px 6px',
    borderRadius: 'var(--radius-full)',
    background: 'rgba(234, 179, 8, 0.15)',
    whiteSpace: 'nowrap' as const,
  },
  reason: {
    fontSize: 11,
    fontStyle: 'italic' as const,
    color: 'var(--text-tertiary)',
    marginTop: 4,
    paddingLeft: 22,
  },
  actions: {
    marginTop: 'var(--sp-2)',
    display: 'flex',
    gap: 'var(--sp-2)',
    paddingLeft: 22,
  },
  saveBtn: {
    fontSize: 11,
    fontWeight: 600,
    padding: '4px 10px',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-surface)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
  },
  saveBtnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  skipsFooter: {
    fontSize: 10,
    fontStyle: 'italic' as const,
    color: 'var(--text-tertiary)',
    marginTop: 6,
  },
} as const;

// ── Single-question row ────────────────────────────────────────

interface QuestionRowProps {
  ticket: string;
  question: PendingQuestion;
}

function QuestionRow({ ticket, question }: QuestionRowProps): JSX.Element {
  const answerQuestions = usePipelineStore((s) => s.answerQuestions);
  const [choice, setChoice] = useState<number | null>(
    typeof question.recommend === 'number' ? question.recommend : null,
  );
  const [submitting, setSubmitting] = useState(false);

  const onSave = useCallback(async () => {
    if (choice === null) return;
    setSubmitting(true);
    try {
      await answerQuestions(ticket, [{ id: question.id, choice }], 'user');
      // The trailing SSE `state` event will remove this question from the
      // store; the component will unmount naturally on the next render.
    } finally {
      setSubmitting(false);
    }
  }, [answerQuestions, choice, question.id, ticket]);

  const nameAttr = `q_${question.id}`;

  return (
    <div style={styles.question}>
      <div style={styles.questionText}>{question.text}</div>
      {question.options.map((opt, i) => (
        <label key={i} style={styles.optionRow}>
          <input
            type="radio"
            name={nameAttr}
            checked={choice === i}
            onChange={() => setChoice(i)}
            style={styles.radio}
            disabled={submitting}
          />
          <span style={styles.optionLabel}>{opt}</span>
          {question.recommend === i ? (
            <span style={styles.aiStar} title="AI-recommended option">
              &#x2B50; AI suggests
            </span>
          ) : null}
        </label>
      ))}
      {question.reason ? <div style={styles.reason}>{question.reason}</div> : null}
      <div style={styles.actions}>
        <button
          type="button"
          onClick={onSave}
          disabled={choice === null || submitting}
          style={{
            ...styles.saveBtn,
            ...(choice === null || submitting ? styles.saveBtnDisabled : {}),
          }}
          aria-label={`Save answer for ${question.id}`}
        >
          {submitting ? 'Saving…' : 'Save answer'}
        </button>
      </div>
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────

interface PendingQuestionsPanelProps {
  ticket: string;
}

export function PendingQuestionsPanel({
  ticket,
}: PendingQuestionsPanelProps): JSX.Element | null {
  const pending = usePendingQuestions(ticket);
  const acceptAllAIPicks = usePipelineStore((s) => s.acceptAllAIPicks);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);

  const { answerable, skipped } = useMemo(() => {
    const answerable = pending.filter((q) => typeof q.recommend === 'number');
    const skipped = pending.length - answerable.length;
    return { answerable, skipped };
  }, [pending]);

  const onAcceptAll = useCallback(async () => {
    setBulkSubmitting(true);
    try {
      await acceptAllAIPicks(ticket);
    } finally {
      setBulkSubmitting(false);
    }
  }, [acceptAllAIPicks, ticket]);

  if (!pending || pending.length === 0) return null;

  const bulkDisabled = answerable.length === 0 || bulkSubmitting;

  return (
    <div style={styles.container} role="region" aria-label="Pending clarifying questions">
      <div style={styles.header}>
        <div style={styles.title}>
          &#x26A0; Decisions needed ({pending.length})
        </div>
        <button
          type="button"
          onClick={onAcceptAll}
          disabled={bulkDisabled}
          style={{
            ...styles.bulkBtn,
            ...(bulkDisabled ? styles.bulkBtnDisabled : {}),
          }}
          aria-label="Accept all AI recommendations"
        >
          {bulkSubmitting ? 'Saving…' : 'Accept all AI picks'}
        </button>
      </div>

      {pending.map((q) => (
        <QuestionRow key={q.id} ticket={ticket} question={q} />
      ))}

      {skipped > 0 ? (
        <div style={styles.skipsFooter}>
          (Accept all AI picks skips {skipped} question
          {skipped === 1 ? '' : 's'} without a suggestion — answer them manually above)
        </div>
      ) : null}
    </div>
  );
}

export default PendingQuestionsPanel;
