// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — useTheme Hook
// Reads & writes the theme (dark/light) used by CSS variables
// Theme is stored on documentElement as data-theme="light" (absent = dark)
// Persisted to localStorage under "mi-agent-theme"
// ═══════════════════════════════════════════════════════════════
import { useState, useCallback, useEffect } from 'react';
const STORAGE_KEY = 'mi-agent-theme';
function readTheme() {
    // 1) localStorage wins (persists across sessions)
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === 'light' || saved === 'dark')
            return saved;
    }
    catch {
        // storage unavailable
    }
    // 2) fall back to whatever is on the DOM (set by boot script, if any)
    return document.documentElement.getAttribute('data-theme') === 'light'
        ? 'light'
        : 'dark';
}
function writeTheme(theme) {
    if (theme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
    }
    else {
        document.documentElement.removeAttribute('data-theme');
    }
    try {
        localStorage.setItem(STORAGE_KEY, theme);
    }
    catch {
        // storage unavailable
    }
}
/**
 * Hook that manages the theme state. On first mount it reconciles the DOM
 * with localStorage so the saved preference is applied.
 */
export function useTheme() {
    const [theme, setThemeState] = useState(readTheme);
    // Reconcile DOM once on mount in case a cold load left it inconsistent
    useEffect(() => {
        writeTheme(theme);
        // only on mount
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const setTheme = useCallback((t) => {
        writeTheme(t);
        setThemeState(t);
    }, []);
    const toggleTheme = useCallback(() => {
        setThemeState((prev) => {
            const next = prev === 'dark' ? 'light' : 'dark';
            writeTheme(next);
            return next;
        });
    }, []);
    return { theme, setTheme, toggleTheme };
}
