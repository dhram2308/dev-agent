import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Log Viewer Component
// Virtual-scrolled, color-coded, filterable log display from SSE
// ═══════════════════════════════════════════════════════════════
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useActiveLogs } from '../store/pipeline';
import { LOG_LEVEL_COLORS } from '../types';
// ── Constants ──────────────────────────────────────────────────
/** Height of each log line in pixels (for virtual scrolling) */
const LINE_HEIGHT = 22;
/** Number of lines to over-render above/below the viewport */
const OVERSCAN = 20;
/** Debounce delay for search input (ms) */
const SEARCH_DEBOUNCE = 200;
// ── Log level filter options ───────────────────────────────────
const ALL_LEVELS = ['error', 'warn', 'info', 'ok', 'step', 'debug'];
const LEVEL_LABELS = {
    error: 'Error',
    warn: 'Warn',
    info: 'Info',
    ok: 'OK',
    step: 'Step',
    debug: 'Debug',
};
// ── Styles ─────────────────────────────────────────────────────
const styles = {
    container: {
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--glass-border)',
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(var(--glass-blur))',
        WebkitBackdropFilter: 'blur(var(--glass-blur))',
        padding: 'var(--sp-4) var(--sp-5)',
        marginBottom: 'var(--sp-6)',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        marginBottom: 'var(--sp-3)',
    },
    title: {
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--text-primary)',
    },
    count: {
        fontSize: 11,
        color: 'var(--text-tertiary)',
        background: 'var(--bg-elevated)',
        padding: '2px 10px',
        borderRadius: 10,
        marginLeft: 'auto',
    },
    filterBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        marginBottom: 'var(--sp-2)',
        flexWrap: 'wrap',
    },
    searchInput: {
        flex: 1,
        minWidth: 120,
        maxWidth: 280,
        padding: 'var(--sp-1) var(--sp-3)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        outline: 'none',
        transition: 'border-color 0.2s',
    },
    levelToggle: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 'var(--radius-sm)',
        fontSize: 10,
        fontWeight: 600,
        cursor: 'pointer',
        border: '1px solid var(--border-default)',
        background: 'var(--bg-elevated)',
        color: 'var(--text-tertiary)',
        transition: 'all 0.15s',
        fontFamily: 'var(--font-sans)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
    },
    levelToggleActive: {
        borderColor: 'var(--accent)',
        color: 'var(--accent)',
        background: 'var(--accent-muted)',
    },
    terminal: {
        background: '#0a0c10',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        height: 360,
        overflow: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        lineHeight: `${LINE_HEIGHT}px`,
        position: 'relative',
    },
    logLine: {
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        padding: '0 var(--sp-3)',
    },
    timestamp: {
        color: 'var(--text-ghost)',
        fontSize: 10,
        marginRight: 8,
        userSelect: 'none',
    },
    scrollBtn: {
        position: 'absolute',
        bottom: 'var(--sp-3)',
        right: 'var(--sp-3)',
        padding: 'var(--sp-1) var(--sp-3)',
        borderRadius: 'var(--radius-full)',
        background: 'var(--accent)',
        color: '#fff',
        fontSize: 11,
        fontWeight: 600,
        border: 'none',
        cursor: 'pointer',
        opacity: 0,
        transform: 'translateY(8px)',
        transition: 'opacity 0.2s, transform 0.2s',
        zIndex: 5,
        fontFamily: 'var(--font-sans)',
    },
    scrollBtnVisible: {
        opacity: 1,
        transform: 'translateY(0)',
    },
    emptyState: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--text-ghost)',
        fontSize: 13,
        fontStyle: 'italic',
    },
};
// ── Helpers ────────────────────────────────────────────────────
function formatTimestamp(ts) {
    const d = new Date(ts);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    const s = d.getSeconds().toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
}
// ── Component ──────────────────────────────────────────────────
export function LogViewer() {
    const allLogs = useActiveLogs();
    // Filter state
    const [searchTerm, setSearchTerm] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [enabledLevels, setEnabledLevels] = useState(new Set(ALL_LEVELS));
    // Scroll state
    const terminalRef = useRef(null);
    const [autoScroll, setAutoScroll] = useState(true);
    const [showScrollBtn, setShowScrollBtn] = useState(false);
    // Debounce search
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(searchTerm), SEARCH_DEBOUNCE);
        return () => clearTimeout(timer);
    }, [searchTerm]);
    // Filter logs
    const filteredLogs = useMemo(() => {
        const search = debouncedSearch.toLowerCase();
        return allLogs.filter((log) => {
            if (!enabledLevels.has(log.level))
                return false;
            if (search && !log.message.toLowerCase().includes(search))
                return false;
            return true;
        });
    }, [allLogs, enabledLevels, debouncedSearch]);
    // Auto-scroll to bottom when new logs arrive
    useEffect(() => {
        if (!autoScroll || !terminalRef.current)
            return;
        const el = terminalRef.current;
        el.scrollTop = el.scrollHeight;
    }, [filteredLogs.length, autoScroll]);
    // Handle scroll - detect if user manually scrolled up
    const handleScroll = useCallback(() => {
        const el = terminalRef.current;
        if (!el)
            return;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        setAutoScroll(atBottom);
        setShowScrollBtn(!atBottom && filteredLogs.length > 0);
    }, [filteredLogs.length]);
    const scrollToBottom = useCallback(() => {
        if (!terminalRef.current)
            return;
        terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
        setAutoScroll(true);
        setShowScrollBtn(false);
    }, []);
    const toggleLevel = useCallback((level) => {
        setEnabledLevels((prev) => {
            const next = new Set(prev);
            if (next.has(level)) {
                next.delete(level);
            }
            else {
                next.add(level);
            }
            return next;
        });
    }, []);
    // Virtual scrolling: only render visible lines
    const [scrollTop, setScrollTop] = useState(0);
    const handleTerminalScroll = useCallback((e) => {
        setScrollTop(e.target.scrollTop);
        handleScroll();
    }, [handleScroll]);
    const totalHeight = filteredLogs.length * LINE_HEIGHT;
    const viewportHeight = 360;
    const startIdx = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN);
    const endIdx = Math.min(filteredLogs.length, Math.ceil((scrollTop + viewportHeight) / LINE_HEIGHT) + OVERSCAN);
    const visibleLogs = filteredLogs.slice(startIdx, endIdx);
    const offsetY = startIdx * LINE_HEIGHT;
    return (_jsxs("div", { style: styles.container, children: [_jsxs("div", { style: styles.header, children: [_jsx("h3", { style: styles.title, children: "Live Output" }), _jsxs("span", { style: styles.count, children: [filteredLogs.length, " / ", allLogs.length, " lines"] })] }), _jsxs("div", { style: styles.filterBar, children: [_jsx("input", { type: "text", value: searchTerm, onChange: (e) => setSearchTerm(e.target.value), placeholder: "Filter logs...", style: styles.searchInput, "aria-label": "Filter log lines" }), ALL_LEVELS.map((level) => (_jsx("button", { onClick: () => toggleLevel(level), style: {
                            ...styles.levelToggle,
                            ...(enabledLevels.has(level) ? styles.levelToggleActive : {}),
                            ...(enabledLevels.has(level) ? { color: LOG_LEVEL_COLORS[level], borderColor: LOG_LEVEL_COLORS[level] } : {}),
                        }, "aria-pressed": enabledLevels.has(level), "aria-label": `Toggle ${level} logs`, children: LEVEL_LABELS[level] }, level)))] }), _jsxs("div", { style: { position: 'relative' }, children: [_jsx("div", { ref: terminalRef, style: styles.terminal, onScroll: handleTerminalScroll, role: "log", "aria-live": "polite", "aria-label": "Agent output log", children: filteredLogs.length === 0 ? (_jsx("div", { style: styles.emptyState, children: allLogs.length === 0 ? 'Waiting for output...' : 'No matching log entries' })) : (_jsx("div", { style: { height: totalHeight, position: 'relative' }, children: _jsx("div", { style: { position: 'absolute', top: offsetY, left: 0, right: 0 }, children: visibleLogs.map((log) => (_jsxs("div", { style: {
                                        ...styles.logLine,
                                        color: LOG_LEVEL_COLORS[log.level] ?? 'var(--text-primary)',
                                        height: LINE_HEIGHT,
                                    }, children: [_jsx("span", { style: styles.timestamp, children: formatTimestamp(log.timestamp) }), log.message] }, log.id))) }) })) }), _jsx("button", { style: {
                            ...styles.scrollBtn,
                            ...(showScrollBtn ? styles.scrollBtnVisible : {}),
                        }, onClick: scrollToBottom, "aria-label": "Scroll to latest output", children: "\u2193 New output" })] })] }));
}
