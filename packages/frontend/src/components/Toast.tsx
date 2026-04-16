// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Toast Notification Component
// Displays stacked toast notifications with auto-dismiss,
// variants (success, error, warn, info), and CSS transitions
// ═══════════════════════════════════════════════════════════════

import { useEffect, useState, useCallback } from 'react';

// ── Types ──────────────────────────────────────────────────────

export type ToastVariant = 'success' | 'error' | 'warn' | 'info';

export interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
}

interface ToastProps {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}

// ── Variant styles ─────────────────────────────────────────────

const VARIANT_STYLES: Record<ToastVariant, { background: string; border: string; color: string; icon: string }> = {
  success: {
    background: 'var(--success-muted)',
    border: '1px solid rgba(34,197,94,0.25)',
    color: 'var(--success)',
    icon: '\u2713',
  },
  error: {
    background: 'var(--danger-muted)',
    border: '1px solid rgba(239,68,68,0.25)',
    color: 'var(--danger)',
    icon: '\u2717',
  },
  warn: {
    background: 'var(--warning-muted)',
    border: '1px solid rgba(234,179,8,0.25)',
    color: 'var(--warning)',
    icon: '\u26A0',
  },
  info: {
    background: 'var(--blue-muted)',
    border: '1px solid rgba(59,130,246,0.25)',
    color: 'var(--blue)',
    icon: '\u2139',
  },
};

// ── Styles ─────────────────────────────────────────────────────

const styles = {
  container: {
    position: 'fixed' as const,
    top: 'var(--sp-4)',
    right: 'var(--sp-4)',
    zIndex: 10000,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--sp-2)',
    pointerEvents: 'none' as const,
    maxWidth: 420,
  },
  toast: {
    pointerEvents: 'auto' as const,
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
    padding: 'var(--sp-3) var(--sp-4)',
    borderRadius: 'var(--radius-md)',
    backdropFilter: 'blur(var(--glass-blur))',
    WebkitBackdropFilter: 'blur(var(--glass-blur))',
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    fontWeight: 500,
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    transition: 'all 0.3s var(--ease-smooth)',
    minWidth: 280,
  },
  toastEnter: {
    opacity: 1,
    transform: 'translateX(0)',
  },
  toastExit: {
    opacity: 0,
    transform: 'translateX(100%)',
  },
  icon: {
    fontSize: 16,
    flexShrink: 0,
    width: 20,
    textAlign: 'center' as const,
  },
  message: {
    flex: 1,
    color: 'var(--text-primary)',
    lineHeight: 1.4,
  },
  dismissBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: 'var(--sp-1)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-tertiary)',
    fontSize: 14,
    lineHeight: 1,
    flexShrink: 0,
    transition: 'color 0.15s',
    fontFamily: 'var(--font-sans)',
  },
} as const;

// ── Single Toast ───────────────────────────────────────────────

function ToastNotification({ toast, onDismiss }: ToastProps): JSX.Element {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger enter animation on next frame
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (toast.duration <= 0) return;
    const timer = setTimeout(() => {
      setVisible(false);
      // Allow exit animation to complete before removing
      setTimeout(() => onDismiss(toast.id), 300);
    }, toast.duration);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, onDismiss]);

  const variant = VARIANT_STYLES[toast.variant];

  const handleDismiss = useCallback(() => {
    setVisible(false);
    setTimeout(() => onDismiss(toast.id), 300);
  }, [onDismiss, toast.id]);

  return (
    <div
      role="alert"
      style={{
        ...styles.toast,
        background: variant.background,
        border: variant.border,
        ...(visible ? styles.toastEnter : styles.toastExit),
      }}
    >
      <span style={{ ...styles.icon, color: variant.color }}>{variant.icon}</span>
      <span style={styles.message}>{toast.message}</span>
      <button
        style={styles.dismissBtn}
        onClick={handleDismiss}
        aria-label="Dismiss notification"
      >
        {'\u2715'}
      </button>
    </div>
  );
}

// ── Toast Container ────────────────────────────────────────────

interface ToastContainerProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps): JSX.Element | null {
  if (toasts.length === 0) return null;

  return (
    <div style={styles.container}>
      {toasts.map((toast) => (
        <ToastNotification key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
