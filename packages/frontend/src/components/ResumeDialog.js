import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Resume Dialog Component
// Shows pipeline state and resume/fresh/delete actions
// ═══════════════════════════════════════════════════════════════
import { useCallback, useState } from 'react';
import { usePipelineStore } from '../store/pipeline';
import { STAGE_INFO } from '../types';
// ── Styles ─────────────────────────────────────────────────────
const styles = {
    container: {
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--sp-6)',
        maxWidth: 600,
        margin: '0 auto',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
        marginBottom: 'var(--sp-5)',
    },
    ticket: {
        fontSize: 18,
        fontWeight: 700,
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
    },
    statusBadge: {
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        padding: 'var(--sp-1) var(--sp-3)',
        borderRadius: 'var(--radius-full)',
    },
    progressBar: {
        width: '100%',
        height: 6,
        background: 'var(--bg-elevated)',
        borderRadius: 'var(--radius-full)',
        overflow: 'hidden',
        marginBottom: 'var(--sp-4)',
    },
    progressFill: {
        height: '100%',
        borderRadius: 'var(--radius-full)',
        transition: 'width 0.3s var(--ease-smooth)',
    },
    stageList: {
        display: 'flex',
        gap: 2,
        marginBottom: 'var(--sp-4)',
    },
    stageDot: {
        flex: 1,
        height: 4,
        borderRadius: 2,
        transition: 'background 0.2s',
    },
    metaGrid: {
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: 'var(--sp-2) var(--sp-4)',
        marginBottom: 'var(--sp-5)',
        fontSize: 13,
    },
    metaLabel: {
        color: 'var(--text-tertiary)',
        fontWeight: 500,
    },
    metaValue: {
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
    },
    warning: {
        background: 'var(--warning-muted)',
        border: '1px solid var(--warning)',
        borderRadius: 'var(--radius-sm)',
        padding: 'var(--sp-3)',
        marginBottom: 'var(--sp-4)',
        fontSize: 12,
        color: 'var(--warning)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
    },
    actions: {
        display: 'flex',
        gap: 'var(--sp-3)',
        flexWrap: 'wrap',
    },
    btn: {
        padding: 'var(--sp-2) var(--sp-5)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        transition: 'all 0.2s var(--ease-smooth)',
        fontFamily: 'var(--font-sans)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
    },
    btnPrimary: {
        background: 'var(--accent)',
        color: '#fff',
    },
    btnSecondary: {
        background: 'var(--bg-elevated)',
        color: 'var(--text-secondary)',
        border: '1px solid var(--border-default)',
    },
    btnDanger: {
        background: 'var(--danger-muted)',
        color: 'var(--danger)',
        border: '1px solid rgba(239,68,68,0.2)',
    },
    btnDisabled: {
        opacity: 0.5,
        cursor: 'not-allowed',
    },
    error: {
        background: 'var(--danger-muted)',
        border: '1px solid var(--danger)',
        borderRadius: 'var(--radius-sm)',
        padding: 'var(--sp-3)',
        marginBottom: 'var(--sp-4)',
        fontSize: 12,
        color: 'var(--danger)',
    },
};
// ── Helpers ──────────────────────────────────────────────────────
function getStatusBadgeStyle(status) {
    switch (status) {
        case 'paused': return { background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' };
        case 'gate_waiting': return { background: 'var(--warning-muted)', color: 'var(--warning)' };
        case 'done': return { background: 'var(--success-muted)', color: 'var(--success)' };
        case 'expired': return { background: 'var(--danger-muted)', color: 'var(--danger)' };
        default: return { background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' };
    }
}
function statusLabel(status) {
    switch (status) {
        case 'paused': return 'Paused';
        case 'gate_waiting': return 'Awaiting Approval';
        case 'done': return 'Completed';
        case 'expired': return 'Expired';
        default: return status;
    }
}
function stageName(stage) {
    const info = STAGE_INFO.find(s => s.stage === stage);
    return info?.label ?? stage;
}
function timeAgo(dateStr) {
    if (!dateStr)
        return 'Unknown';
    const ms = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(ms / 60_000);
    if (mins < 1)
        return 'Just now';
    if (mins < 60)
        return `${mins} minute${mins !== 1 ? 's' : ''} ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
    const days = Math.floor(hrs / 24);
    return `${days} day${days !== 1 ? 's' : ''} ago`;
}
// ── Component ──────────────────────────────────────────────────
export function ResumeDialog({ pipeline }) {
    const startAgent = usePipelineStore((s) => s.startAgent);
    const deletePipeline = usePipelineStore((s) => s.deletePipeline);
    const [loading, setLoading] = useState(null);
    const [error, setError] = useState(null);
    const stageIdx = STAGE_INFO.findIndex(s => s.stage === pipeline.stage);
    const totalStages = STAGE_INFO.length;
    const handleResume = useCallback(async () => {
        setLoading('resume');
        setError(null);
        try {
            await startAgent(pipeline.ticket, 'resume');
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setLoading(null);
        }
    }, [pipeline.ticket, startAgent]);
    const handleFresh = useCallback(async () => {
        setLoading('fresh');
        setError(null);
        try {
            await startAgent(pipeline.ticket, 'fresh');
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setLoading(null);
        }
    }, [pipeline.ticket, startAgent]);
    const handleDelete = useCallback(async () => {
        setLoading('delete');
        setError(null);
        try {
            await deletePipeline(pipeline.ticket);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setLoading(null);
        }
    }, [pipeline.ticket, deletePipeline]);
    const isExpired = pipeline.status === 'expired';
    const isDone = pipeline.status === 'done';
    const canResume = pipeline.resumable && !isExpired && !isDone;
    // Resume history warning
    const showResumeWarning = pipeline.resumeCount >= 3;
    return (_jsxs("div", { style: styles.container, children: [_jsxs("div", { style: styles.header, children: [_jsx("span", { style: styles.ticket, children: pipeline.ticket }), _jsx("span", { style: { ...styles.statusBadge, ...getStatusBadgeStyle(pipeline.status) }, children: statusLabel(pipeline.status) })] }), _jsx("div", { style: styles.stageList, children: STAGE_INFO.map((info, idx) => (_jsx("div", { style: {
                        ...styles.stageDot,
                        background: idx < stageIdx
                            ? 'var(--success)'
                            : idx === stageIdx
                                ? 'var(--accent)'
                                : 'var(--bg-elevated)',
                    }, title: info.label }, info.stage))) }), _jsx("div", { style: styles.progressBar, children: _jsx("div", { style: {
                        ...styles.progressFill,
                        width: `${Math.round(pipeline.progress * 100)}%`,
                        background: isDone
                            ? 'var(--success)'
                            : isExpired
                                ? 'var(--danger)'
                                : 'var(--accent)',
                    } }) }), _jsxs("div", { style: styles.metaGrid, children: [_jsx("span", { style: styles.metaLabel, children: "Stage" }), _jsxs("span", { style: styles.metaValue, children: [stageName(pipeline.stage), " (", stageIdx >= 0 ? stageIdx + 1 : '?', "/", totalStages, ")"] }), _jsx("span", { style: styles.metaLabel, children: "Last Active" }), _jsx("span", { style: styles.metaValue, children: timeAgo(pipeline.lastActivity) }), !isDone && (_jsxs(_Fragment, { children: [_jsx("span", { style: styles.metaLabel, children: "Resume Window" }), _jsx("span", { style: { ...styles.metaValue, color: isExpired ? 'var(--danger)' : undefined }, children: isExpired
                                    ? 'Expired'
                                    : `${pipeline.daysRemaining} day${pipeline.daysRemaining !== 1 ? 's' : ''} remaining` })] })), pipeline.resumeCount > 0 && (_jsxs(_Fragment, { children: [_jsx("span", { style: styles.metaLabel, children: "Resume Count" }), _jsx("span", { style: styles.metaValue, children: pipeline.resumeCount })] }))] }), showResumeWarning && !isExpired && (_jsxs("div", { style: styles.warning, children: ["This pipeline has been resumed ", pipeline.resumeCount, " times at this stage. Consider starting fresh."] })), error && (_jsx("div", { style: styles.error, children: error })), _jsxs("div", { style: styles.actions, children: [canResume && (_jsx("button", { style: {
                            ...styles.btn,
                            ...styles.btnPrimary,
                            ...(loading ? styles.btnDisabled : {}),
                        }, onClick: handleResume, disabled: loading !== null, title: isExpired ? 'Pipeline expired' : undefined, children: loading === 'resume' ? 'Resuming...' : 'Resume' })), isExpired && (_jsx("button", { style: { ...styles.btn, ...styles.btnDisabled, background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }, disabled: true, title: "Pipeline expired \u2014 cannot resume", children: "Resume (Expired)" })), _jsx("button", { style: {
                            ...styles.btn,
                            ...styles.btnSecondary,
                            ...(loading ? styles.btnDisabled : {}),
                        }, onClick: handleFresh, disabled: loading !== null, children: loading === 'fresh' ? 'Starting...' : 'Start Fresh' }), _jsx("button", { style: {
                            ...styles.btn,
                            ...styles.btnDanger,
                            ...(loading ? styles.btnDisabled : {}),
                        }, onClick: handleDelete, disabled: loading !== null, children: loading === 'delete' ? 'Deleting...' : 'Delete' })] })] }));
}
