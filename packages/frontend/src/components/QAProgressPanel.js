import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — QA Progress Panel
// Visualises the two parallel QA streams (QA Main & QA1) as pill
// rows, one pill per module. Reads `state.data.qa_test` once the
// backend has written results. Shown while the pipeline is on the
// test-qa stage or any later stage (results remain visible).
// ═══════════════════════════════════════════════════════════════
import { useMemo } from 'react';
import { useActiveTicketState } from '../store/pipeline';
// Legacy QA module list (must match packages/backend/.../test-qa.ts)
const QA_MAIN_MODULES = [
    { name: 'Dashboard', path: '/dashboard' },
    { name: 'GST Return', path: '/gst-return' },
    { name: 'Reports', path: '/reports' },
    { name: 'Configurations', path: '/configurations' },
    { name: 'Import', path: '/import' },
];
const QA1_MODULES = [
    { name: 'IMS (Inventory)', path: '/ims' },
    { name: 'Reconcile', path: '/reconcile' },
];
// Stages after which QA results are meaningful to show
const SHOW_AFTER_STAGES = [
    'test_qa',
    'gate_preprod_approval',
    'create_preprod_mr',
    'gate_dual_approval',
    'deploy_prod',
    'done',
];
const styles = {
    container: {
        marginBottom: 'var(--sp-4)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-surface)',
        padding: 'var(--sp-4)',
    },
    title: {
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--text-primary)',
        marginBottom: 'var(--sp-3)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
    },
    streams: {
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 'var(--sp-4)',
    },
    stream: {
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-2)',
    },
    streamHeader: {
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        color: 'var(--text-tertiary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    streamSummary: {
        fontSize: 11,
        color: 'var(--text-tertiary)',
        fontWeight: 400,
        textTransform: 'none',
        letterSpacing: 0,
    },
    pillRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        padding: '6px 10px',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        fontSize: 12,
    },
    pillDot: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
    },
    pillName: {
        flex: 1,
        color: 'var(--text-primary)',
        fontWeight: 500,
    },
    pillBadge: {
        fontSize: 10,
        fontWeight: 700,
        padding: '1px 6px',
        borderRadius: 'var(--radius-full)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
    },
    pillError: {
        fontSize: 11,
        color: 'var(--danger)',
        marginLeft: 'var(--sp-2)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: 180,
    },
};
function statusColors(status) {
    switch (status) {
        case 'pass':
            return {
                dot: 'var(--success)',
                badgeBg: 'var(--success-muted)',
                badgeFg: 'var(--success)',
                label: 'Pass',
            };
        case 'fail':
            return {
                dot: 'var(--danger)',
                badgeBg: 'var(--danger-muted)',
                badgeFg: 'var(--danger)',
                label: 'Fail',
            };
        case 'env_down':
            return {
                dot: 'var(--warning)',
                badgeBg: 'var(--warning-muted)',
                badgeFg: 'var(--warning)',
                label: 'Env down',
            };
        default:
            return {
                dot: 'var(--text-ghost)',
                badgeBg: 'var(--bg-elevated)',
                badgeFg: 'var(--text-tertiary)',
                label: 'Pending',
            };
    }
}
function resolveStatus(moduleName, envName, results) {
    const r = results.find((x) => x.name === moduleName && x.env === envName);
    if (!r)
        return 'pending';
    if (r.ok)
        return 'pass';
    if (r.errorType === 'ENV_DOWN')
        return 'env_down';
    return 'fail';
}
function StreamColumn({ title, envName, modules, results, }) {
    const passed = modules.filter((m) => resolveStatus(m.name, envName, results) === 'pass').length;
    return (_jsxs("div", { style: styles.stream, children: [_jsxs("div", { style: styles.streamHeader, children: [_jsx("span", { children: title }), _jsxs("span", { style: styles.streamSummary, children: [passed, "/", modules.length, " passed"] })] }), modules.map((m) => {
                const status = resolveStatus(m.name, envName, results);
                const colors = statusColors(status);
                const result = results.find((x) => x.name === m.name && x.env === envName);
                return (_jsxs("div", { style: styles.pillRow, children: [_jsx("span", { style: { ...styles.pillDot, background: colors.dot } }), _jsx("span", { style: styles.pillName, children: m.name }), _jsx("span", { style: {
                                ...styles.pillBadge,
                                background: colors.badgeBg,
                                color: colors.badgeFg,
                            }, children: colors.label }), result && !result.ok && result.error && (_jsx("span", { style: styles.pillError, title: result.error, children: result.error }))] }, m.name));
            })] }));
}
export function QAProgressPanel() {
    const ticketState = useActiveTicketState();
    const shouldShow = useMemo(() => {
        if (!ticketState)
            return false;
        return SHOW_AFTER_STAGES.includes(ticketState.stage);
    }, [ticketState]);
    const results = useMemo(() => {
        const data = ticketState?.state?.data;
        const raw = data?.qa_test;
        if (Array.isArray(raw)) {
            return raw;
        }
        return [];
    }, [ticketState]);
    if (!shouldShow)
        return null;
    return (_jsxs("div", { style: styles.container, children: [_jsxs("div", { style: styles.title, children: [_jsx("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", children: _jsx("path", { d: "M6 2h4v2l3 6a2 2 0 01-1.8 3H4.8A2 2 0 013 9l3-6V2z" }) }), "QA Test Progress"] }), _jsxs("div", { style: styles.streams, children: [_jsx(StreamColumn, { title: "QA Main", envName: "QA Main", modules: QA_MAIN_MODULES, results: results }), _jsx(StreamColumn, { title: "QA1", envName: "QA1", modules: QA1_MODULES, results: results })] })] }));
}
