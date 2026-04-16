// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Toast Context Provider
// Provides addToast() hook for displaying toast notifications
// with auto-dismiss and a max of 5 visible toasts
// ═══════════════════════════════════════════════════════════════

import { createContext, useContext, useCallback, useState } from 'react';
import { ToastContainer, type ToastVariant, type ToastItem } from '../components/Toast';

// ── Constants ──────────────────────────────────────────────────

/** Default toast auto-dismiss duration in milliseconds */
const DEFAULT_DURATION = 5000;

/** Maximum number of toasts visible at once */
const MAX_TOASTS = 5;

// ── Context types ──────────────────────────────────────────────

interface ToastContextValue {
  addToast: (message: string, variant: ToastVariant, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// ── ID generator ───────────────────────────────────────────────

let toastIdCounter = 0;
function nextToastId(): string {
  toastIdCounter += 1;
  return `toast-${toastIdCounter}-${Date.now()}`;
}

// ── Provider ───────────────────────────────────────────────────

interface ToastProviderProps {
  children: React.ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps): JSX.Element {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((message: string, variant: ToastVariant, duration?: number) => {
    const newToast: ToastItem = {
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

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
}

// ── Hook ───────────────────────────────────────────────────────

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast() must be used within a <ToastProvider>');
  }
  return ctx;
}
