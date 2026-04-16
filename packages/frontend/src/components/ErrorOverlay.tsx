// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Error Overlay Component
// Full-page error card for uncaught errors with dismiss action
// ═══════════════════════════════════════════════════════════════

// ── Types ──────────────────────────────────────────────────────

interface ErrorOverlayProps {
  error: Error | string;
  /** Whether to show the stack trace (typically only in dev) */
  showStack?: boolean;
  onDismiss: () => void;
}

// ── Styles ─────────────────────────────────────────────────────

const styles = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg-overlay)',
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    animation: 'fadeIn 0.3s var(--ease-smooth)',
  },
  card: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--danger)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--sp-8)',
    maxWidth: 560,
    width: '90%',
    maxHeight: '80vh',
    overflow: 'auto' as const,
    boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px var(--danger-muted)',
    animation: 'modalIn 0.3s var(--ease-smooth)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
    marginBottom: 'var(--sp-5)',
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    background: 'var(--danger-muted)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  icon: {
    color: 'var(--danger)',
    fontSize: 20,
    fontWeight: 700,
  },
  title: {
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)',
  },
  subtitle: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-sans)',
  },
  message: {
    fontSize: 14,
    color: 'var(--text-secondary)',
    lineHeight: 1.6,
    marginBottom: 'var(--sp-5)',
    fontFamily: 'var(--font-sans)',
    wordBreak: 'break-word' as const,
  },
  stackContainer: {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-sm)',
    padding: 'var(--sp-4)',
    marginBottom: 'var(--sp-5)',
    maxHeight: 200,
    overflow: 'auto' as const,
  },
  stackLabel: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: 'var(--text-tertiary)',
    marginBottom: 'var(--sp-2)',
    fontFamily: 'var(--font-sans)',
  },
  stackTrace: {
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-tertiary)',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
    margin: 0,
  },
  dismissBtn: {
    display: 'block',
    width: '100%',
    padding: 'var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
    background: 'var(--bg-elevated)',
    color: 'var(--text-secondary)',
    transition: 'all 0.15s var(--ease-smooth)',
    fontFamily: 'var(--font-sans)',
    textAlign: 'center' as const,
  },
} as const;

// ── Component ──────────────────────────────────────────────────

export function ErrorOverlay({ error, showStack = false, onDismiss }: ErrorOverlayProps): JSX.Element {
  const errorMessage = typeof error === 'string' ? error : error.message;
  const errorStack = typeof error === 'string' ? null : error.stack;

  return (
    <div style={styles.overlay} role="alert">
      <div style={styles.card}>
        <div style={styles.header}>
          <div style={styles.iconCircle}>
            <span style={styles.icon}>!</span>
          </div>
          <div>
            <div style={styles.title}>Something went wrong</div>
            <div style={styles.subtitle}>An unexpected error occurred</div>
          </div>
        </div>

        <div style={styles.message}>{errorMessage}</div>

        {showStack && errorStack && (
          <div style={styles.stackContainer}>
            <div style={styles.stackLabel}>Stack Trace</div>
            <pre style={styles.stackTrace}>{errorStack}</pre>
          </div>
        )}

        <button
          style={styles.dismissBtn}
          onClick={onDismiss}
        >
          Dismiss and return to Dashboard
        </button>
      </div>
    </div>
  );
}
