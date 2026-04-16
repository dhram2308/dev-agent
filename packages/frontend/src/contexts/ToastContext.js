import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Toast Context Provider
// Provides addToast() hook for displaying toast notifications
// with auto-dismiss and a max of 5 visible toasts
// ═══════════════════════════════════════════════════════════════
import { createContext, useContext, useCallback, useState } from 'react';
import { ToastContainer } from '../components/Toast';
// ── Constants ──────────────────────────────────────────────────
/** Default toast auto-dismiss duration in milliseconds */
const DEFAULT_DURATION = 5000;
/** Maximum number of toasts visible at once */
const MAX_TOASTS = 5;
const ToastContext = createContext(null);
// ── ID generator ───────────────────────────────────────────────
let toastIdCounter = 0;
function nextToastId() {
    toastIdCounter += 1;
    return `toast-${toastIdCounter}-${Date.now()}`;
}
export function ToastProvider({ children }) {
    const [toasts, setToasts] = useState([]);
    const removeToast = useCallback((id) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);
    const addToast = useCallback((message, variant, duration) => {
        const newToast = {
            id: nextToastId(),
            message,
            variant,
            duration: duration ?? DEFAULT_DURATION,
        };
        setToasts((prev) => {
            // Keep newest on top, cap at MAX_TOASTS
            const next = [newToast, ...prev];
            if (next.length > MAX_TOASTS) {
                return next.slice(0, MAX_TOASTS);
            }
            return next;
        });
    }, []);
    return (_jsxs(ToastContext.Provider, { value: { addToast }, children: [children, _jsx(ToastContainer, { toasts: toasts, onDismiss: removeToast })] }));
}
// ── Hook ───────────────────────────────────────────────────────
export function useToast() {
    const ctx = useContext(ToastContext);
    if (!ctx) {
        throw new Error('useToast() must be used within a <ToastProvider>');
    }
    return ctx;
}
