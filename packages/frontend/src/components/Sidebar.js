import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Sidebar Component (Pipeline Dashboard)
// Grouped pipeline list with status indicators, gate badges,
// stage navigation, and add-ticket input
// ═══════════════════════════════════════════════════════════════
import { useState, useCallback } from 'react';
import { usePipelineStore, useGroupedPipelines, stageIndex, } from '../store/pipeline';
import { useNavigationStore } from '../store/navigation';
import { STAGE_INFO } from '../types';
const VIEW_NAV_ITEMS = [
    {
        view: 'dashboard',
        label: 'Dashboard',
        iconPath: 'M2 2h5v6H2V2zm7 0h5v4H9V2zM2 10h5v4H2v-4zm7-2h5v6H9V8z',
    },
    {
        view: 'settings',
        label: 'Settings',
        iconPath: 'M8 10a2 2 0 100-4 2 2 0 000 4zm6.32-1.9l1.12.65a.5.5 0 01.18.68l-1 1.73a.5.5 0 01-.68.18l-1.12-.65a4.97 4.97 0 01-1.32.76v1.3a.5.5 0 01-.5.5h-2a.5.5 0 01-.5-.5v-1.3a4.97 4.97 0 01-1.32-.76l-1.12.65a.5.5 0 01-.68-.18l-1-1.73a.5.5 0 01.18-.68l1.12-.65a5.03 5.03 0 010-1.52L4.54 5.93a.5.5 0 01-.18-.68l1-1.73a.5.5 0 01.68-.18l1.12.65a4.97 4.97 0 011.32-.76V1.93a.5.5 0 01.5-.5h2a.5.5 0 01.5.5v1.3c.48.18.92.44 1.32.76l1.12-.65a.5.5 0 01.68.18l1 1.73a.5.5 0 01-.18.68l-1.12.65a5.03 5.03 0 010 1.52z',
    },
    {
        view: 'review',
        label: 'Review',
        iconPath: 'M8 1C4.13 1 1 4.13 1 8s3.13 7 7 7 7-3.13 7-7-3.13-7-7-7zm3.22 5.28l-3.5 3.5a.75.75 0 01-1.06 0l-1.5-1.5a.75.75 0 111.06-1.06L7.22 8.22l2.97-2.97a.75.75 0 111.06 1.06z',
    },
];
// ── Styles ─────────────────────────────────────────────────────
const styles = {
    sidebar: {
        width: 'var(--sidebar-w)',
        minWidth: 'var(--sidebar-w)',
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        position: 'fixed',
        top: 3,
        left: 0,
        bottom: 0,
        zIndex: 100,
        transition: 'width 0.3s var(--ease-smooth), min-width 0.3s var(--ease-smooth)',
        overflowY: 'auto',
        overflowX: 'hidden',
    },
    header: {
        padding: 'var(--sp-5) var(--sp-4)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
        borderBottom: '1px solid var(--border-subtle)',
    },
    logo: {
        width: 32,
        height: 32,
        background: 'linear-gradient(135deg, var(--accent), var(--blue))',
        borderRadius: 'var(--radius-sm)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontSize: 16,
        flexShrink: 0,
    },
    headerText: {
        overflow: 'hidden',
    },
    headerTitle: {
        fontSize: 14,
        fontWeight: 700,
        color: 'var(--text-primary)',
        letterSpacing: '-0.02em',
    },
    headerSub: {
        fontSize: 10,
        color: 'var(--text-tertiary)',
        marginTop: 1,
    },
    sectionTitle: {
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: 'var(--text-tertiary)',
        padding: 'var(--sp-4) var(--sp-4) var(--sp-2)',
    },
    groupTitle: {
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--text-tertiary)',
        padding: 'var(--sp-3) var(--sp-4) var(--sp-1)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
    },
    groupCount: {
        fontSize: 9,
        background: 'var(--bg-elevated)',
        borderRadius: 'var(--radius-full)',
        padding: '1px 5px',
        color: 'var(--text-tertiary)',
    },
    nav: {
        flex: 1,
        padding: 'var(--sp-2)',
    },
    navItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
        padding: 'var(--sp-2) var(--sp-3)',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        transition: 'all 150ms var(--ease-smooth)',
        position: 'relative',
        border: 'none',
        background: 'transparent',
        width: '100%',
        textAlign: 'left',
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        color: 'var(--text-secondary)',
        borderLeft: '2px solid transparent',
        marginBottom: 1,
    },
    navItemActive: {
        borderLeftColor: 'var(--accent)',
        background: 'var(--accent-muted)',
        color: 'var(--text-primary)',
    },
    dot: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
        transition: 'all 0.3s var(--ease-smooth)',
    },
    label: {
        flex: 1,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
    },
    pipelineItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        padding: 'var(--sp-2) var(--sp-3)',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        transition: 'all 150ms',
        border: 'none',
        background: 'transparent',
        width: '100%',
        textAlign: 'left',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color: 'var(--text-secondary)',
        position: 'relative',
    },
    pipelineItemActive: {
        background: 'var(--accent-muted)',
        color: 'var(--accent)',
        fontWeight: 600,
    },
    pipelineDot: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
    },
    pipelineMeta: {
        fontSize: 10,
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-sans)',
        whiteSpace: 'nowrap',
    },
    gateBadge: {
        fontSize: 9,
        background: 'var(--warning-muted)',
        color: 'var(--warning)',
        borderRadius: 'var(--radius-full)',
        padding: '1px 5px',
        fontWeight: 600,
        whiteSpace: 'nowrap',
    },
    addTicketRow: {
        padding: 'var(--sp-2) var(--sp-3)',
        borderTop: '1px solid var(--border-subtle)',
    },
    addTicketInput: {
        width: '100%',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-elevated)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        padding: 'var(--sp-2)',
        outline: 'none',
        transition: 'border-color 0.2s',
    },
    footer: {
        padding: 'var(--sp-3) var(--sp-4)',
        borderTop: '1px solid var(--border-subtle)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        flexWrap: 'wrap',
    },
    connDot: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        display: 'inline-block',
        flexShrink: 0,
    },
    footerText: {
        fontSize: 11,
        color: 'var(--text-tertiary)',
    },
    viewNav: {
        padding: 'var(--sp-3) var(--sp-2)',
        borderBottom: '1px solid var(--border-subtle)',
    },
    viewNavItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
        padding: 'var(--sp-2) var(--sp-3)',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        transition: 'all 150ms var(--ease-smooth)',
        border: 'none',
        background: 'transparent',
        width: '100%',
        textAlign: 'left',
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        color: 'var(--text-secondary)',
        marginBottom: 1,
    },
    viewNavItemActive: {
        background: 'var(--accent-muted)',
        color: 'var(--text-primary)',
        fontWeight: 600,
    },
    viewNavIcon: {
        width: 16,
        height: 16,
        flexShrink: 0,
        opacity: 0.7,
    },
};
// ── Pipeline status dot styles ──────────────────────────────────
function getPipelineDotStyle(status) {
    switch (status) {
        case 'running':
            return { background: 'var(--success)', animation: 'dotPulse 2s infinite ease-in-out', boxShadow: '0 0 6px var(--success-glow)' };
        case 'gate_waiting':
            return { background: 'var(--warning)', animation: 'dotPulse 1.5s infinite' };
        case 'paused':
            return { background: 'var(--text-tertiary)' };
        case 'done':
            return { background: 'var(--success)' };
        case 'expired':
            return { background: 'var(--danger)', opacity: 0.5 };
        default:
            return { background: 'var(--text-ghost)' };
    }
}
// ── Stage dot for pipeline view ──────────────────────────────────
function getDotStyle(stageIdx, currentIdx, isRunning) {
    if (stageIdx < currentIdx) {
        return { background: 'var(--success)', boxShadow: '0 0 6px var(--success-glow)' };
    }
    if (stageIdx === currentIdx && isRunning) {
        return { background: 'var(--warning)', animation: 'dotPulse 2s infinite ease-in-out' };
    }
    return { background: 'var(--text-ghost)' };
}
// ── Time ago helper ──────────────────────────────────────────────
function timeAgo(dateStr) {
    if (!dateStr)
        return '';
    const ms = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(ms / 60_000);
    if (mins < 1)
        return 'just now';
    if (mins < 60)
        return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
}
// ── Group labels ─────────────────────────────────────────────────
const GROUP_CONFIG = [
    { key: 'running', label: 'Active' },
    { key: 'gate_waiting', label: 'Awaiting Action' },
    { key: 'paused', label: 'Paused' },
    { key: 'done', label: 'Completed' },
    { key: 'expired', label: 'Expired' },
];
// ── Stage abbreviation ──────────────────────────────────────────
function stageAbbrev(stage) {
    const info = STAGE_INFO.find(s => s.stage === stage);
    return info?.label ?? stage;
}
// ── Component ──────────────────────────────────────────────────
export function Sidebar() {
    const activeTicket = usePipelineStore((s) => s.activeTicket);
    const tickets = usePipelineStore((s) => s.tickets);
    const setActiveTicket = usePipelineStore((s) => s.setActiveTicket);
    const startAgent = usePipelineStore((s) => s.startAgent);
    const sseConnected = usePipelineStore((s) => s.sseConnected);
    const grouped = useGroupedPipelines();
    const currentView = useNavigationStore((s) => s.currentView);
    const setView = useNavigationStore((s) => s.setView);
    const [addTicketValue, setAddTicketValue] = useState('');
    // Get the active ticket's state for stage navigation
    const activeTs = activeTicket ? tickets.get(activeTicket) : null;
    const currentStage = activeTs?.stage ?? 'fetch_ticket';
    const currentIdx = stageIndex(currentStage);
    const isRunning = activeTs?.isRunning ?? false;
    const handlePipelineClick = useCallback((ticket) => {
        setActiveTicket(ticket);
        const store = usePipelineStore.getState();
        // Ensure ticket exists in tickets map
        if (!store.tickets.has(ticket)) {
            store.addTicket(ticket);
        }
        // Immediately fetch full state from backend so stage, data, and
        // gate status populate without waiting for SSE or the 30s poll
        store.fetchTicketState(ticket);
    }, [setActiveTicket]);
    const handleAddTicket = useCallback((e) => {
        e.preventDefault();
        const value = addTicketValue.trim().toUpperCase();
        if (value && /^[A-Z]+-\d+$/.test(value)) {
            // Check if pipeline already exists
            const store = usePipelineStore.getState();
            const existing = store.pipelines.find(p => p.ticket === value);
            if (existing) {
                // Just select it — resume dialog will handle the rest
                handlePipelineClick(value);
            }
            else {
                startAgent(value, 'fresh');
            }
            setAddTicketValue('');
        }
    }, [addTicketValue, handlePipelineClick, startAgent]);
    const hasPipelines = Object.values(grouped).some(g => g.length > 0);
    return (_jsxs("aside", { style: styles.sidebar, children: [_jsxs("div", { style: styles.header, children: [_jsx("div", { style: styles.logo, "aria-hidden": "true", children: _jsx("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", children: _jsx("path", { d: "M8 1l1.5 4.5L14 7l-4.5 1.5L8 13l-1.5-4.5L2 7l4.5-1.5z" }) }) }), _jsxs("div", { style: styles.headerText, children: [_jsx("div", { style: styles.headerTitle, children: "AI Dev Agent" }), _jsx("div", { style: styles.headerSub, children: "Pipeline Automation" })] })] }), _jsx("div", { style: styles.viewNav, children: VIEW_NAV_ITEMS.map((item) => {
                    const isActive = currentView === item.view;
                    return (_jsxs("button", { style: {
                            ...styles.viewNavItem,
                            ...(isActive ? styles.viewNavItemActive : {}),
                        }, onClick: () => setView(item.view), "aria-current": isActive ? 'page' : undefined, children: [_jsx("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "currentColor", style: styles.viewNavIcon, children: _jsx("path", { d: item.iconPath }) }), _jsx("span", { style: styles.label, children: item.label })] }, item.view));
                }) }), hasPipelines && (_jsx("div", { style: { flex: 1, overflow: 'auto' }, children: GROUP_CONFIG.map(({ key, label }) => {
                    const items = grouped[key] || [];
                    if (items.length === 0)
                        return null;
                    return (_jsxs("div", { children: [_jsxs("div", { style: styles.groupTitle, children: [label, _jsx("span", { style: styles.groupCount, children: items.length })] }), _jsx("div", { style: { padding: '0 var(--sp-2)' }, children: items.map((p) => {
                                    const isActive = p.ticket === activeTicket;
                                    return (_jsxs("button", { style: {
                                            ...styles.pipelineItem,
                                            ...(isActive ? styles.pipelineItemActive : {}),
                                        }, onClick: () => handlePipelineClick(p.ticket), title: `${p.ticket} - ${stageAbbrev(p.stage)} (${p.status})`, children: [_jsx("span", { style: {
                                                    ...styles.pipelineDot,
                                                    ...getPipelineDotStyle(p.status),
                                                } }), _jsx("span", { style: styles.label, children: p.ticket }), p.needsApproval && (_jsx("span", { style: styles.gateBadge, children: "Needs approval" })), _jsx("span", { style: styles.pipelineMeta, children: timeAgo(p.lastActivity) })] }, p.ticket));
                                }) })] }, key));
                }) })), !hasPipelines && (_jsx("div", { style: { padding: 'var(--sp-5) var(--sp-4)', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }, children: "No pipelines yet. Add a ticket below to start." })), activeTicket && (_jsxs(_Fragment, { children: [_jsx("div", { style: styles.sectionTitle, children: "Pipeline Stages" }), _jsx("nav", { style: styles.nav, role: "tablist", "aria-label": "Pipeline steps", children: STAGE_INFO.map((info, idx) => {
                            const isCurrentStage = idx === currentIdx;
                            return (_jsxs("button", { style: {
                                    ...styles.navItem,
                                    ...(isCurrentStage ? styles.navItemActive : {}),
                                }, role: "tab", "aria-selected": isCurrentStage, tabIndex: isCurrentStage ? 0 : -1, title: `${info.label} (${info.who})`, children: [_jsx("span", { style: { ...styles.dot, ...getDotStyle(idx, currentIdx, isRunning) } }), _jsx("span", { style: styles.label, children: info.label })] }, info.stage));
                        }) })] })), _jsx("div", { style: styles.addTicketRow, children: _jsx("form", { onSubmit: handleAddTicket, children: _jsx("input", { type: "text", value: addTicketValue, onChange: (e) => setAddTicketValue(e.target.value), placeholder: "Add ticket (e.g. AUT-1234)", spellCheck: false, style: styles.addTicketInput, "aria-label": "Add ticket ID" }) }) }), _jsxs("div", { style: styles.footer, children: [_jsx("span", { style: {
                            ...styles.connDot,
                            background: sseConnected ? 'var(--success)' : 'var(--danger)',
                            boxShadow: sseConnected
                                ? '0 0 6px var(--success-glow)'
                                : '0 0 6px var(--danger-glow)',
                        }, "aria-hidden": "true" }), _jsx("span", { style: styles.footerText, children: sseConnected ? 'Connected' : 'Disconnected' })] })] }));
}
