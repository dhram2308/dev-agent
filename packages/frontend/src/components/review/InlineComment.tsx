// ===================================================================
// MI Dev Agent -- Inline Comment Component
// Displays existing comments and provides a comment form for new ones
// ===================================================================

import { useState, useCallback, useRef, useEffect } from 'react';
import { useReviewStore } from '../../store/review';
import { usePipelineStore } from '../../store/pipeline';
import * as api from '../../lib/api';
import type { InlineCommentData } from '../../store/review';

// -- Types ----------------------------------------------------------

interface InlineCommentDisplayProps {
  comment: InlineCommentData;
  file?: undefined;
  line?: undefined;
  isEditing?: undefined;
  parentId?: undefined;
}

interface InlineCommentEditProps {
  comment?: undefined;
  file: string;
  line: number;
  isEditing: true;
  /** When set, the new comment will be saved as a reply to this comment id. */
  parentId?: string;
}

type InlineCommentProps = InlineCommentDisplayProps | InlineCommentEditProps;

// -- Styles ---------------------------------------------------------

const styles = {
  container: {
    background: 'var(--bg-surface)',
    borderTop: '1px solid var(--border-subtle)',
    borderBottom: '1px solid var(--border-subtle)',
    padding: 'var(--sp-3) var(--sp-4)',
    animation: 'fadeIn 0.2s ease-out',
  },
  commentDisplay: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--sp-1)',
  },
  commentHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    fontSize: 11,
  },
  author: {
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  timestamp: {
    color: 'var(--text-ghost)',
    fontSize: 10,
  },
  pendingBadge: {
    fontSize: 9,
    fontWeight: 600,
    padding: '1px 5px',
    borderRadius: 'var(--radius-full)',
    background: 'var(--warning-muted)',
    color: 'var(--warning)',
  },
  commentBody: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    fontFamily: 'var(--font-sans)',
  },
  deleteBtn: {
    fontSize: 10,
    color: 'var(--text-ghost)',
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    padding: '0 4px',
    fontFamily: 'var(--font-sans)',
    transition: 'color 0.15s',
  },
  replyBtn: {
    fontSize: 10,
    color: 'var(--text-ghost)',
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    padding: '0 4px',
    fontFamily: 'var(--font-sans)',
    transition: 'color 0.15s',
    marginLeft: 'auto',
  },
  replyStack: {
    marginTop: 'var(--sp-2)',
    paddingLeft: 'var(--sp-4)',
    borderLeft: '2px solid var(--border-subtle)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--sp-2)',
  },
  // Edit form styles
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--sp-2)',
  },
  formLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-tertiary)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-1)',
  },
  textarea: {
    width: '100%',
    minHeight: 60,
    maxHeight: 200,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    padding: 'var(--sp-2) var(--sp-3)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)',
    fontSize: 12,
    lineHeight: 1.5,
    resize: 'vertical' as const,
    outline: 'none',
    transition: 'border-color 0.2s',
  },
  formActions: {
    display: 'flex',
    gap: 'var(--sp-2)',
    justifyContent: 'flex-end',
  },
  btnCancel: {
    padding: '4px 12px',
    borderRadius: 'var(--radius-sm)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    background: 'var(--bg-elevated)',
    color: 'var(--text-tertiary)',
    border: '1px solid var(--border-default)',
    fontFamily: 'var(--font-sans)',
    transition: 'all 0.15s',
  },
  btnSubmit: {
    padding: '4px 12px',
    borderRadius: 'var(--radius-sm)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    fontFamily: 'var(--font-sans)',
    transition: 'all 0.15s',
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
} as const;

// -- Helpers --------------------------------------------------------

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString();
}

// -- Component ------------------------------------------------------

export function InlineComment(props: InlineCommentProps): JSX.Element {
  // Display mode: show existing comment
  if (props.comment) {
    return <CommentDisplay comment={props.comment} />;
  }

  // Edit mode: comment form
  return (
    <CommentForm
      file={props.file}
      line={props.line}
      parentId={props.parentId}
    />
  );
}

// -- Comment Display ------------------------------------------------

function CommentDisplay({
  comment,
}: {
  comment: InlineCommentData;
}): JSX.Element {
  const removeComment = useReviewStore((s) => s.removeComment);
  // Pull all comments for this file:line so we can find replies to this comment.
  // We intentionally avoid a new selector to keep the store surface small.
  const allForLine = useReviewStore((s) => {
    const key = `${comment.file}:${comment.line}`;
    return s.comments.get(key) ?? [];
  });
  const replies = allForLine
    .filter((c) => c.parentId === comment.id)
    .sort((a, b) => a.timestamp - b.timestamp);

  const [replying, setReplying] = useState(false);

  return (
    <div style={styles.container}>
      <div style={styles.commentDisplay}>
        <div style={styles.commentHeader}>
          <span style={styles.author}>{comment.author}</span>
          <span style={styles.timestamp}>
            {formatTime(comment.timestamp)}
          </span>
          {comment.pending && (
            <span style={styles.pendingBadge}>pending</span>
          )}
          <button
            style={styles.replyBtn}
            onClick={() => setReplying((v) => !v)}
            title={replying ? 'Cancel reply' : 'Reply to comment'}
            aria-label={replying ? 'Cancel reply' : 'Reply to comment'}
            onMouseEnter={(e) => {
              (e.target as HTMLElement).style.color = 'var(--accent)';
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLElement).style.color = 'var(--text-ghost)';
            }}
          >
            {replying ? 'Cancel' : 'Reply'}
          </button>
          <button
            style={styles.deleteBtn}
            onClick={() => removeComment(comment.id)}
            title="Delete comment"
            aria-label="Delete comment"
            onMouseEnter={(e) => {
              (e.target as HTMLElement).style.color = 'var(--danger)';
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLElement).style.color = 'var(--text-ghost)';
            }}
          >
            x
          </button>
        </div>
        <div style={styles.commentBody}>{comment.body}</div>
      </div>

      {(replies.length > 0 || replying) && (
        <div style={styles.replyStack}>
          {replies.map((r) => (
            <CommentDisplay key={r.id} comment={r} />
          ))}
          {replying && (
            <CommentForm
              file={comment.file}
              line={comment.line}
              parentId={comment.id}
              onDone={() => setReplying(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// -- Comment Form ---------------------------------------------------

function draftKey(
  ticket: string | null,
  file: string,
  line: number,
  parentId?: string,
): string {
  return `comment_draft_${ticket ?? 'no-ticket'}_${file}_${line}_${parentId ?? 'root'}`;
}

function CommentForm({
  file,
  line,
  parentId,
  onDone,
}: {
  file: string;
  line: number;
  parentId?: string;
  onDone?: () => void;
}): JSX.Element {
  const addComment = useReviewStore((s) => s.addComment);
  const setCommentingOn = useReviewStore((s) => s.setCommentingOn);
  const activeTicket = usePipelineStore((s) => s.activeTicket);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Restore any previously-saved draft for this ticket/file/line (/parent for replies)
  const [body, setBody] = useState<string>(() => {
    try {
      return localStorage.getItem(draftKey(activeTicket, file, line, parentId)) ?? '';
    } catch {
      return '';
    }
  });
  const [submitting, setSubmitting] = useState(false);

  // Auto-focus the textarea
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Persist draft to localStorage on every change (cleared on submit/cancel)
  useEffect(() => {
    try {
      const key = draftKey(activeTicket, file, line, parentId);
      if (body.length > 0) {
        localStorage.setItem(key, body);
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      // localStorage may be unavailable (private mode / quota) — fail silently
    }
  }, [body, activeTicket, file, line, parentId]);

  const clearDraft = useCallback(() => {
    try {
      localStorage.removeItem(draftKey(activeTicket, file, line, parentId));
    } catch {
      // ignore
    }
  }, [activeTicket, file, line, parentId]);

  const handleSubmit = useCallback(async () => {
    const text = body.trim();
    if (!text) return;

    setSubmitting(true);

    // Add to local store immediately (optimistic)
    const comment: InlineCommentData = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      line,
      body: text,
      author: 'You',
      timestamp: Date.now(),
      pending: true,
      parentId,
    };
    addComment(comment);
    setBody('');
    clearDraft();

    // Submit to API if ticket is available
    if (activeTicket) {
      try {
        await api.submitComment(activeTicket, file, line, text, parentId);
      } catch {
        // Comment is already added locally, just ignore API errors
      }
    }

    setSubmitting(false);
    // Close the reply form on successful submit (root forms use setCommentingOn below)
    onDone?.();
  }, [body, file, line, addComment, activeTicket, clearDraft, parentId, onDone]);

  const handleCancel = useCallback(() => {
    clearDraft();
    if (onDone) {
      onDone();
    } else {
      setCommentingOn(null);
    }
  }, [setCommentingOn, clearDraft, onDone]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Cmd/Ctrl + Enter to submit
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      }
      // Escape to cancel
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    },
    [handleSubmit, handleCancel],
  );

  return (
    <div style={styles.container}>
      <div style={styles.form}>
        <div style={styles.formLabel}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M2 3h12v8H5l-3 3V3z" strokeLinejoin="round" />
          </svg>
          {parentId ? 'Reply' : `Comment on line ${line}`}
        </div>
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Write a comment... (Ctrl+Enter to submit, Esc to cancel)"
          style={styles.textarea}
          disabled={submitting}
          aria-label={`Write comment for line ${line}`}
        />
        <div style={styles.formActions}>
          <button
            style={styles.btnCancel}
            onClick={handleCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            style={{
              ...styles.btnSubmit,
              ...(!body.trim() || submitting ? styles.btnDisabled : {}),
            }}
            onClick={handleSubmit}
            disabled={!body.trim() || submitting}
          >
            {submitting ? 'Posting...' : 'Comment'}
          </button>
        </div>
      </div>
    </div>
  );
}
