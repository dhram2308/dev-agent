// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Keyboard Shortcuts Help Modal
// Opens when the '?' key is pressed (via 'mi:show-shortcuts'
// CustomEvent dispatched by useGlobalKeyboardShortcuts).
// Dismissed by Esc or clicking outside the card.
// ═══════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';

interface Shortcut {
  keys: string[];
  description: string;
}

const SHORTCUTS: readonly Shortcut[] = [
  { keys: ['?'], description: 'Show this help dialog' },
  { keys: ['f'], description: 'Focus the ticket input' },
  { keys: ['Ctrl', 'K'], description: 'Focus the ticket input (also ⌘K on macOS)' },
  { keys: ['j'], description: 'Next ticket in the list' },
  { keys: ['k'], description: 'Previous ticket in the list' },
  { keys: ['a'], description: 'Approve the active gate (if waiting)' },
  { keys: ['r'], description: 'Reject the active gate (if waiting)' },
  { keys: ['g', 'd'], description: 'Go to Dashboard' },
  { keys: ['g', 's'], description: 'Go to Settings' },
  { keys: ['g', 'r'], description: 'Go to Review' },
  { keys: ['Esc'], description: 'Close modals, dismiss overlays' },
] as const;

const styles = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 9000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg-overlay)',
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    animation: 'fadeIn 0.2s var(--ease-smooth)',
  },
  card: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--sp-6)',
    maxWidth: 520,
    width: '90%',
    maxHeight: '80vh',
    overflow: 'auto' as const,
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    animation: 'modalIn 0.2s var(--ease-smooth)',
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 'var(--sp-5)',
  },
  title: {
    fontSize: 17,
    fontWeight: 700,
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)',
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 'var(--sp-2) 0',
    borderBottom: '1px solid var(--border-subtle)',
  },
  rowLast: {
    borderBottom: 'none',
  },
  description: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-sans)',
  },
  keyGroup: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  },
  kbd: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 8px',
    minWidth: 20,
    justifyContent: 'center',
    borderRadius: 4,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-default)',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  plus: {
    fontSize: 10,
    color: 'var(--text-tertiary)',
  },
  footer: {
    marginTop: 'var(--sp-5)',
    fontSize: 11,
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-sans)',
    textAlign: 'center' as const,
  },
} as const;

export function ShortcutsHelpModal(): JSX.Element | null {
  const [open, setOpen] = useState(false);

  // Open on 'mi:show-shortcuts' event; close on Esc or click outside
  useEffect(() => {
    function onShow(): void {
      setOpen(true);
    }
    function onKey(e: KeyboardEvent): void {
      if (open && e.key === 'Escape') {
        setOpen(false);
      }
    }
    window.addEventListener('mi:show-shortcuts', onShow);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mi:show-shortcuts', onShow);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      style={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={() => setOpen(false)}
    >
      <div style={styles.card} onClick={(e) => e.stopPropagation()}>
        <div style={styles.headerRow}>
          <div style={styles.title}>Keyboard shortcuts</div>
          <button
            type="button"
            style={styles.closeBtn}
            onClick={() => setOpen(false)}
            aria-label="Close shortcuts help"
          >
            ×
          </button>
        </div>

        <div>
          {SHORTCUTS.map((s, idx) => (
            <div
              key={idx}
              style={{
                ...styles.row,
                ...(idx === SHORTCUTS.length - 1 ? styles.rowLast : {}),
              }}
            >
              <span style={styles.description}>{s.description}</span>
              <span style={styles.keyGroup}>
                {s.keys.map((k, i) => (
                  <span key={i} style={styles.keyGroup}>
                    {i > 0 && <span style={styles.plus}>+</span>}
                    <kbd style={styles.kbd}>{k}</kbd>
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>

        <div style={styles.footer}>
          Press <kbd style={styles.kbd}>Esc</kbd> or click outside to close.
        </div>
      </div>
    </div>
  );
}
