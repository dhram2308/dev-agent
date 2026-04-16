import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Display Settings Component
// Theme toggle (light/dark), diff view mode, and cache clear
// Embedded in the Settings page header area
// ═══════════════════════════════════════════════════════════════
import { useState, useCallback } from 'react';
import { useTheme } from '../../hooks/useTheme';
// ── Styles ──────────────────────────────────────────────────
const styles = {
    container: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
        padding: 'var(--sp-3) var(--sp-4)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
    },
    sectionLabel: {
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--text-tertiary)',
        marginRight: 'var(--sp-2)',
    },
    toggleGroup: {
        display: 'inline-flex',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border-default)',
        overflow: 'hidden',
    },
    toggleBtn: {
        padding: 'var(--sp-1) var(--sp-3)',
        fontSize: 12,
        fontWeight: 500,
        cursor: 'pointer',
        border: 'none',
        background: 'transparent',
        color: 'var(--text-secondary)',
        transition: 'all 0.15s',
        fontFamily: 'var(--font-sans)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-1)',
    },
    toggleBtnActive: {
        background: 'var(--accent-muted)',
        color: 'var(--accent)',
        fontWeight: 600,
    },
    separator: {
        width: 1,
        height: 20,
        background: 'var(--border-default)',
        margin: '0 var(--sp-1)',
        flexShrink: 0,
    },
    clearBtn: {
        padding: 'var(--sp-1) var(--sp-3)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 12,
        fontWeight: 500,
        cursor: 'pointer',
        border: '1px solid var(--border-default)',
        background: 'transparent',
        color: 'var(--text-secondary)',
        transition: 'all 0.15s',
        fontFamily: 'var(--font-sans)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-1)',
    },
    successMsg: {
        fontSize: 11,
        color: 'var(--success)',
        fontWeight: 500,
    },
};
// ── Diff mode helpers ───────────────────────────────────────
function getDiffMode() {
    try {
        return localStorage.getItem('mi-agent-diff-mode') ?? 'split';
    }
    catch {
        return 'split';
    }
}
function setDiffMode(mode) {
    try {
        localStorage.setItem('mi-agent-diff-mode', mode);
    }
    catch {
        // Storage unavailable
    }
}
// ── Component ───────────────────────────────────────────────
export function DisplaySettings() {
    const { theme, setTheme } = useTheme();
    const [diffMode, setDiffModeState] = useState(getDiffMode);
    const [cleared, setCleared] = useState(false);
    const handleThemeChange = useCallback((t) => {
        setTheme(t);
    }, [setTheme]);
    const handleDiffModeChange = useCallback((m) => {
        setDiffMode(m);
        setDiffModeState(m);
    }, []);
    const handleClearCache = useCallback(() => {
        try {
            // Clear non-essential localStorage keys (preserve auth token and theme)
            const keep = ['mi-agent-theme', 'mi-agent-diff-mode'];
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && !keep.includes(key)) {
                    keys.push(key);
                }
            }
            keys.forEach((k) => localStorage.removeItem(k));
        }
        catch {
            // Storage unavailable
        }
        setCleared(true);
        setTimeout(() => setCleared(false), 2000);
    }, []);
    return (_jsxs("div", { style: styles.container, children: [_jsx("span", { style: styles.sectionLabel, children: "Theme" }), _jsxs("div", { style: styles.toggleGroup, children: [_jsxs("button", { type: "button", style: {
                            ...styles.toggleBtn,
                            ...(theme === 'dark' ? styles.toggleBtnActive : {}),
                        }, onClick: () => handleThemeChange('dark'), "aria-pressed": theme === 'dark', children: [_jsx("svg", { width: "12", height: "12", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", children: _jsx("path", { d: "M13.5 9.5a6 6 0 11-7-7 4.5 4.5 0 007 7z" }) }), "Dark"] }), _jsxs("button", { type: "button", style: {
                            ...styles.toggleBtn,
                            ...(theme === 'light' ? styles.toggleBtnActive : {}),
                        }, onClick: () => handleThemeChange('light'), "aria-pressed": theme === 'light', children: [_jsxs("svg", { width: "12", height: "12", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", children: [_jsx("circle", { cx: "8", cy: "8", r: "3" }), _jsx("path", { d: "M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3" })] }), "Light"] })] }), _jsx("span", { style: styles.separator }), _jsx("span", { style: styles.sectionLabel, children: "Diff View" }), _jsxs("div", { style: styles.toggleGroup, children: [_jsx("button", { type: "button", style: {
                            ...styles.toggleBtn,
                            ...(diffMode === 'split' ? styles.toggleBtnActive : {}),
                        }, onClick: () => handleDiffModeChange('split'), "aria-pressed": diffMode === 'split', children: "Split" }), _jsx("button", { type: "button", style: {
                            ...styles.toggleBtn,
                            ...(diffMode === 'unified' ? styles.toggleBtnActive : {}),
                        }, onClick: () => handleDiffModeChange('unified'), "aria-pressed": diffMode === 'unified', children: "Unified" })] }), _jsx("span", { style: styles.separator }), _jsxs("button", { type: "button", style: styles.clearBtn, onClick: handleClearCache, "aria-label": "Clear application cache", children: [_jsx("svg", { width: "12", height: "12", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", children: _jsx("path", { d: "M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 10h8l1-10" }) }), "Clear Cache"] }), cleared && _jsx("span", { style: styles.successMsg, children: "Cleared" })] }));
}
