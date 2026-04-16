import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Pipeline Detail View
// Stage progress bar, history, and metadata for selected pipeline
// ═══════════════════════════════════════════════════════════════
import { STAGE_INFO } from '../types';
// ── Styles ─────────────────────────────────────────────────────
const styles = {
    container: {
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--sp-4)',
        marginBottom: 'var(--sp-4)',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 'var(--sp-3)',
    },
    ticket: {
        fontSize: 14,
        fontWeight: 700,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
    },
    statusPill: {
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        padding: '2px 8px',
        borderRadius: 'var(--radius-full)',
    },
    stageProgress: {
        display: 'flex',
        gap: 3,
        marginBottom: 'var(--sp-3)',
    },
    stageStep: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
    },
    stepBar: {
        width: '100%',
        height: 4,
        borderRadius: 2,
    },
    stepLabel: {
        fontSize: 8,
        color: 'var(--text-tertiary)',
        textAlign: 'center',
        lineHeight: 1.2,
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    meta: {
        display: 'flex',
        gap: 'var(--sp-4)',
        flexWrap: 'wrap',
        fontSize: 11,
        color: 'var(--text-tertiary)',
    },
    metaItem: {
        display: 'flex',
        gap: 'var(--sp-1)',
        alignItems: 'center',
    },
    metaValue: {
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
    },
};
// ── Helpers ──────────────────────────────────────────────────────
function getStatusPillStyle(status) {
    switch (status) {
        case 'running': return { background: 'var(--success-muted)', color: 'var(--success)' };
        case 'gate_waiting': return { background: 'var(--warning-muted)', color: 'var(--warning)' };
        case 'paused': return { background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' };
        case 'done': return { background: 'var(--success-muted)', color: 'var(--success)' };
        case 'expired': return { background: 'var(--danger-muted)', color: 'var(--danger)' };
        default: return { background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' };
    }
}
function statusText(status) {
    switch (status) {
        case 'running': return 'Running';
        case 'gate_waiting': return 'Gate Waiting';
        case 'paused': return 'Paused';
        case 'done': return 'Done';
        case 'expired': return 'Expired';
        default: return status;
    }
}
function timeAgo(dateStr) {
    if (!dateStr)
        return 'N/A';
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
// ── Component ──────────────────────────────────────────────────
export function PipelineDetail({ pipeline }) {
    const stageIdx = STAGE_INFO.findIndex(s => s.stage === pipeline.stage);
    return (_jsxs("div", { style: styles.container, children: [_jsxs("div", { style: styles.header, children: [_jsx("span", { style: styles.ticket, children: pipeline.ticket }), _jsx("span", { style: { ...styles.statusPill, ...getStatusPillStyle(pipeline.status) }, children: statusText(pipeline.status) })] }), _jsx("div", { style: styles.stageProgress, children: STAGE_INFO.map((info, idx) => (_jsxs("div", { style: styles.stageStep, children: [_jsx("div", { style: {
                                ...styles.stepBar,
                                background: idx < stageIdx
                                    ? 'var(--success)'
                                    : idx === stageIdx
                                        ? (pipeline.running ? 'var(--accent)' : 'var(--warning)')
                                        : 'var(--bg-elevated)',
                            } }), _jsx("span", { style: {
                                ...styles.stepLabel,
                                color: idx === stageIdx ? 'var(--text-primary)' : undefined,
                                fontWeight: idx === stageIdx ? 600 : undefined,
                            }, children: info.label.split(' ')[0] })] }, info.stage))) }), _jsxs("div", { style: styles.meta, children: [_jsxs("div", { style: styles.metaItem, children: ["Stage: ", _jsx("span", { style: styles.metaValue, children: STAGE_INFO[stageIdx]?.label ?? pipeline.stage })] }), _jsxs("div", { style: styles.metaItem, children: ["Last active: ", _jsx("span", { style: styles.metaValue, children: timeAgo(pipeline.lastActivity) })] }), pipeline.startedAt && (_jsxs("div", { style: styles.metaItem, children: ["Started: ", _jsx("span", { style: styles.metaValue, children: timeAgo(pipeline.startedAt) })] })), pipeline.resumeCount > 0 && (_jsxs("div", { style: styles.metaItem, children: ["Resumes: ", _jsx("span", { style: styles.metaValue, children: pipeline.resumeCount })] })), !pipeline.running && pipeline.status !== 'done' && pipeline.status !== 'expired' && (_jsxs("div", { style: styles.metaItem, children: ["Window: ", _jsxs("span", { style: styles.metaValue, children: [pipeline.daysRemaining, "d left"] })] }))] })] }));
}
