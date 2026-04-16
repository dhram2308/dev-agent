import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Confirm Dialog Component
// Modal with Cancel/Confirm buttons, Esc to close,
// click outside to close, and keyboard focus trap
// ═══════════════════════════════════════════════════════════════
import { useEffect, useRef, useCallback } from 'react';
// ── Styles ─────────────────────────────────────────────────────
const styles = {
    overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-overlay)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        animation: 'fadeIn 0.2s var(--ease-smooth)',
    },
    dialog: {
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--sp-6)',
        maxWidth: 440,
        width: '90%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        animation: 'modalIn 0.2s var(--ease-smooth)',
    },
    title: {
        fontSize: 16,
        fontWeight: 700,
        color: 'var(--text-primary)',
        marginBottom: 'var(--sp-3)',
        fontFamily: 'var(--font-sans)',
    },
    message: {
        fontSize: 13,
        color: 'var(--text-secondary)',
        lineHeight: 1.6,
        marginBottom: 'var(--sp-6)',
        fontFamily: 'var(--font-sans)',
    },
    actions: {
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 'var(--sp-3)',
    },
    btn: {
        padding: 'var(--sp-2) var(--sp-5)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        transition: 'all 0.15s var(--ease-smooth)',
        fontFamily: 'var(--font-sans)',
    },
    cancelBtn: {
        background: 'var(--bg-elevated)',
        color: 'var(--text-secondary)',
        border: '1px solid var(--border-default)',
    },
    confirmBtn: {
        background: 'var(--accent)',
        color: '#fff',
    },
    confirmDangerBtn: {
        background: 'var(--danger)',
        color: '#fff',
    },
};
// ── Component ──────────────────────────────────────────────────
export function ConfirmDialog({ open, title, message, confirmText = 'Confirm', cancelText = 'Cancel', onConfirm, onCancel, danger = false, }) {
    const dialogRef = useRef(null);
    const cancelBtnRef = useRef(null);
    const confirmBtnRef = useRef(null);
    // Focus the cancel button when dialog opens
    useEffect(() => {
        if (open) {
            cancelBtnRef.current?.focus();
        }
    }, [open]);
    // Handle Escape key
    useEffect(() => {
        if (!open)
            return;
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
                return;
            }
            // Focus trap: Tab cycles between cancel and confirm buttons
            if (e.key === 'Tab') {
                const focusable = [cancelBtnRef.current, confirmBtnRef.current].filter(Boolean);
                if (focusable.length === 0)
                    return;
                const firstEl = focusable[0];
                const lastEl = focusable[focusable.length - 1];
                if (e.shiftKey) {
                    if (document.activeElement === firstEl) {
                        e.preventDefault();
                        lastEl.focus();
                    }
                }
                else {
                    if (document.activeElement === lastEl) {
                        e.preventDefault();
                        firstEl.focus();
                    }
                }
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [open, onCancel]);
    // Click outside to close
    const handleOverlayClick = useCallback((e) => {
        if (e.target === e.currentTarget) {
            onCancel();
        }
    }, [onCancel]);
    if (!open)
        return null;
    return (_jsx("div", { style: styles.overlay, onClick: handleOverlayClick, role: "dialog", "aria-modal": "true", "aria-labelledby": "confirm-dialog-title", "aria-describedby": "confirm-dialog-message", children: _jsxs("div", { style: styles.dialog, ref: dialogRef, children: [_jsx("div", { id: "confirm-dialog-title", style: styles.title, children: title }), _jsx("div", { id: "confirm-dialog-message", style: styles.message, children: message }), _jsxs("div", { style: styles.actions, children: [_jsx("button", { ref: cancelBtnRef, style: { ...styles.btn, ...styles.cancelBtn }, onClick: onCancel, children: cancelText }), _jsx("button", { ref: confirmBtnRef, style: {
                                ...styles.btn,
                                ...(danger ? styles.confirmDangerBtn : styles.confirmBtn),
                            }, onClick: onConfirm, children: confirmText })] })] }) }));
}
