import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Log File Archive Viewer
// Collapsible panel that reads the persisted `agent-{TICKET}.log`
// file from disk via /api/logs-file. Offers a tail-size selector
// and a manual refresh. Shows total line count vs visible tail.
// Complements the live (SSE-backed) LogViewer, which only shows
// messages received during the current session.
// ═══════════════════════════════════════════════════════════════
import { useCallback, useEffect, useState } from 'react';
import { getLogFile } from '../lib/api';
const TAIL_OPTIONS = [50, 100, 200, 500];
const styles = {
    container: {
        marginBottom: 'var(--sp-4)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-surface)',
        overflow: 'hidden',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 'var(--sp-3) var(--sp-4)',
        cursor: 'pointer',
        userSelect: 'none',
    },
    title: {
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--text-secondary)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
    },
    badge: {
        fontSize: 11,
        color: 'var(--text-tertiary)',
        background: 'var(--bg-elevated)',
        padding: '2px 8px',
        borderRadius: 10,
    },
    chevron: {
        transition: 'transform 0.2s var(--ease-smooth)',
        color: 'var(--text-tertiary)',
    },
    body: {
        padding: '0 var(--sp-4) var(--sp-4)',
    },
    controls: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        marginBottom: 'var(--sp-3)',
    },
    label: {
        fontSize: 12,
        color: 'var(--text-tertiary)',
    },
    select: {
        padding: '4px 8px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text-primary)',
        fontSize: 12,
        outline: 'none',
        cursor: 'pointer',
    },
    refreshBtn: {
        padding: '4px 10px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text-secondary)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
    },
    logBox: {
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-sm)',
        padding: 'var(--sp-3)',
        maxHeight: 360,
        overflow: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        lineHeight: 1.55,
        color: 'var(--text-primary)',
        whiteSpace: 'pre',
    },
    empty: {
        fontSize: 12,
        color: 'var(--text-tertiary)',
        padding: 'var(--sp-3)',
        textAlign: 'center',
    },
    error: {
        fontSize: 12,
        color: 'var(--danger)',
        padding: 'var(--sp-2) var(--sp-3)',
    },
};
export function LogFileArchiveViewer({ ticket }) {
    const [expanded, setExpanded] = useState(false);
    const [tail, setTail] = useState(200);
    const [lines, setLines] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const fetchLogs = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await getLogFile(ticket, tail);
            setLines(res.lines);
            setTotal(res.total);
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            setLoading(false);
        }
    }, [ticket, tail]);
    // Fetch on first expand and whenever the tail/ticket changes
    useEffect(() => {
        if (expanded)
            void fetchLogs();
    }, [expanded, fetchLogs]);
    return (_jsxs("div", { style: styles.container, children: [_jsxs("div", { style: styles.header, onClick: () => setExpanded((x) => !x), role: "button", tabIndex: 0, "aria-expanded": expanded, children: [_jsxs("span", { style: styles.title, children: [_jsxs("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", children: [_jsx("path", { d: "M3 2h7l3 3v9H3z" }), _jsx("path", { d: "M10 2v3h3" })] }), "Log archive", expanded && total > 0 && (_jsxs("span", { style: styles.badge, children: ["tail ", lines.length, " / total ", total] }))] }), _jsx("span", { style: {
                            ...styles.chevron,
                            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                        }, "aria-hidden": "true", children: _jsx("svg", { width: "12", height: "12", viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", children: _jsx("path", { d: "M3 4.5l3 3 3-3" }) }) })] }), expanded && (_jsxs("div", { style: styles.body, children: [_jsxs("div", { style: styles.controls, children: [_jsx("span", { style: styles.label, children: "Show last" }), _jsx("select", { value: tail, onChange: (e) => setTail(parseInt(e.target.value, 10)), style: styles.select, "aria-label": "Number of lines to tail", children: TAIL_OPTIONS.map((n) => (_jsxs("option", { value: n, children: [n, " lines"] }, n))) }), _jsx("button", { type: "button", onClick: () => void fetchLogs(), disabled: loading, style: styles.refreshBtn, "aria-label": "Refresh log archive", children: loading ? 'Loading...' : 'Refresh' })] }), error && _jsxs("div", { style: styles.error, children: ["Failed to load log: ", error] }), !error && lines.length === 0 && !loading && (_jsx("div", { style: styles.empty, children: "No log file on disk yet." })), lines.length > 0 && (_jsx("div", { style: styles.logBox, children: lines.join('\n') }))] }))] }));
}
