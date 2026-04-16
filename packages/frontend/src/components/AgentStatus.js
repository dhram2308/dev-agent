import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Agent Status Component
// Shows current stage, pipeline progress, timers, stuck indicator
// ═══════════════════════════════════════════════════════════════
import { useState, useEffect, useCallback } from 'react';
import { usePipelineStore, useActiveTicketState, useIsStuck, stageIndex } from '../store/pipeline';
import { STAGE_ORDER, STAGE_INFO } from '../types';
import { AgentActivityBar } from './AgentActivityBar';
// ── Timer hook ─────────────────────────────────────────────────
function useElapsedTime(startTime) {
    const [, setTick] = useState(0);
    useEffect(() => {
        if (!startTime)
            return;
        const interval = setInterval(() => setTick((t) => t + 1), 1000);
        return () => clearInterval(interval);
    }, [startTime]);
    if (!startTime)
        return '--:--';
    const elapsed = Math.max(0, Date.now() - startTime);
    const secs = Math.floor(elapsed / 1000) % 60;
    const mins = Math.floor(elapsed / 60000) % 60;
    const hours = Math.floor(elapsed / 3600000);
    if (hours > 0) {
        return `${hours}h ${mins.toString().padStart(2, '0')}m`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}
// ── Styles ─────────────────────────────────────────────────────
const styles = {
    container: {
        marginBottom: 'var(--sp-6)',
    },
    topBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
        marginBottom: 'var(--sp-4)',
        flexWrap: 'wrap',
    },
    stageName: {
        fontSize: 16,
        fontWeight: 700,
        color: 'var(--text-primary)',
    },
    stageLabel: {
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--text-tertiary)',
    },
    timer: {
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        color: 'var(--text-secondary)',
        marginLeft: 'auto',
    },
    timerLabel: {
        fontSize: 10,
        color: 'var(--text-tertiary)',
        marginRight: 4,
    },
    stuckBanner: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        padding: 'var(--sp-3) var(--sp-4)',
        borderRadius: 'var(--radius-md)',
        marginBottom: 'var(--sp-3)',
        background: 'var(--warning-muted)',
        border: '1px solid rgba(234,179,8,0.2)',
        color: 'var(--warning)',
        fontSize: 13,
        fontWeight: 600,
        animation: 'slideDown 0.3s ease-out',
    },
    stopButton: {
        padding: 'var(--sp-2) var(--sp-4)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        background: 'var(--danger-muted)',
        color: 'var(--danger)',
        border: '1px solid rgba(239,68,68,0.2)',
        transition: 'all 0.2s',
        fontFamily: 'var(--font-sans)',
    },
    progressContainer: {
        display: 'flex',
        gap: 3,
        alignItems: 'stretch',
        marginBottom: 'var(--sp-4)',
    },
    progressSegment: {
        flex: 1,
        height: 6,
        borderRadius: 3,
        transition: 'background 0.3s ease, box-shadow 0.3s ease',
    },
    stageGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))',
        gap: 'var(--sp-2)',
    },
    stagePill: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        padding: 'var(--sp-3) var(--sp-2)',
        borderRadius: 'var(--radius-md)',
        border: '1.5px solid var(--border-default)',
        background: 'var(--bg-surface)',
        cursor: 'pointer',
        transition: 'all 0.2s ease, transform 0.15s ease',
        fontSize: 11,
        textAlign: 'center',
        fontFamily: 'var(--font-sans)',
        color: 'var(--text-primary)',
        position: 'relative',
    },
    pillNum: {
        fontSize: 10,
        fontWeight: 600,
        color: 'var(--text-secondary)',
    },
    pillLabel: {
        fontSize: 10,
        lineHeight: 1.3,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: '100%',
    },
    dot: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
    },
};
function getStageStatus(stageIdx, currentIdx, isRunning, hasError) {
    if (stageIdx < currentIdx)
        return 'done';
    if (stageIdx === currentIdx) {
        if (hasError)
            return 'failed';
        return isRunning ? 'current' : 'pending';
    }
    return 'pending';
}
function getSegmentStyle(status) {
    switch (status) {
        case 'done':
            return { background: 'var(--success)', boxShadow: '0 0 6px var(--success-glow)' };
        case 'current':
            return { background: 'var(--warning)', boxShadow: '0 0 6px var(--warning-muted)', animation: 'pulse 2s infinite' };
        case 'failed':
            return { background: 'var(--danger)', boxShadow: '0 0 6px var(--danger-glow)' };
        default:
            return { background: 'var(--bg-elevated)' };
    }
}
function getPillStyle(status) {
    switch (status) {
        case 'done':
            return { borderColor: 'var(--success)', background: 'var(--success-muted)' };
        case 'current':
            return { borderColor: 'var(--warning)', background: 'var(--warning-muted)', animation: 'pulse 2s infinite' };
        case 'failed':
            return { borderColor: 'var(--danger)', background: 'var(--danger-muted)' };
        default:
            return {};
    }
}
function getDotColor(status) {
    switch (status) {
        case 'done': return 'var(--success)';
        case 'current': return 'var(--warning)';
        case 'failed': return 'var(--danger)';
        default: return 'var(--text-ghost)';
    }
}
// ── Component ──────────────────────────────────────────────────
export function AgentStatus() {
    const ticketState = useActiveTicketState();
    const isStuck = useIsStuck();
    const stopAgent = usePipelineStore((s) => s.stopAgent);
    const activeTicket = usePipelineStore((s) => s.activeTicket);
    const stageElapsed = useElapsedTime(ticketState?.stageStartedAt ?? null);
    const pipelineElapsed = useElapsedTime(ticketState?.pipelineStartedAt ?? null);
    const handleStop = useCallback(() => {
        if (activeTicket) {
            stopAgent(activeTicket);
        }
    }, [activeTicket, stopAgent]);
    if (!ticketState)
        return null;
    const currentStage = ticketState.stage;
    const currentIdx = stageIndex(currentStage);
    const isRunning = ticketState.isRunning;
    const hasError = ticketState.error !== null;
    // Progress percentage
    const progressPercent = Math.round(((currentIdx + (isRunning ? 0.5 : 0)) / STAGE_ORDER.length) * 100);
    return (_jsxs("div", { style: styles.container, children: [_jsx("div", { style: {
                    position: 'fixed', top: 0, left: 0, right: 0, height: 3,
                    background: 'var(--bg-elevated)', zIndex: 1500, overflow: 'hidden',
                }, children: _jsx("div", { style: {
                        height: '100%', width: `${progressPercent}%`,
                        background: 'linear-gradient(90deg, var(--blue), var(--accent))',
                        transition: 'width 0.6s ease',
                    } }) }), isStuck && isRunning && (_jsxs("div", { style: styles.stuckBanner, role: "alert", children: [_jsx("span", { "aria-hidden": "true", children: "\u23F3" }), _jsx("span", { children: "No activity detected for 10+ minutes. Pipeline may be stuck." })] })), ticketState.error && (_jsx("div", { style: {
                    padding: 'var(--sp-3) var(--sp-4)',
                    borderRadius: 'var(--radius-md)',
                    marginBottom: 'var(--sp-3)',
                    background: 'var(--danger-muted)',
                    border: '1px solid rgba(239,68,68,0.2)',
                    color: 'var(--danger)',
                    fontSize: 13,
                    fontWeight: 500,
                    animation: 'slideDown 0.3s ease-out',
                }, role: "alert", children: ticketState.error })), _jsxs("div", { style: styles.topBar, children: [_jsxs("div", { children: [_jsxs("div", { style: styles.stageLabel, children: ["Stage ", currentIdx + 1, " of ", STAGE_ORDER.length] }), _jsx("div", { style: styles.stageName, children: STAGE_INFO[currentIdx]?.label ?? currentStage })] }), _jsxs("div", { style: styles.timer, children: [_jsx("span", { style: styles.timerLabel, children: "Stage:" }), stageElapsed, _jsx("span", { style: { margin: '0 var(--sp-2)', color: 'var(--text-ghost)' }, children: "|" }), _jsx("span", { style: styles.timerLabel, children: "Total:" }), pipelineElapsed] }), isRunning && (_jsx("button", { style: styles.stopButton, onClick: handleStop, "aria-label": "Stop the running agent", children: "Stop" }))] }), _jsx("div", { style: styles.progressContainer, role: "progressbar", "aria-valuenow": progressPercent, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": "Pipeline progress", children: STAGE_ORDER.map((stage, idx) => {
                    const status = getStageStatus(idx, currentIdx, isRunning, hasError && idx === currentIdx);
                    return (_jsx("div", { style: { ...styles.progressSegment, ...getSegmentStyle(status) }, title: STAGE_INFO[idx]?.label ?? stage }, stage));
                }) }), _jsx(AgentActivityBar, {}), _jsx("div", { style: styles.stageGrid, role: "tablist", "aria-label": "Pipeline stages", children: STAGE_INFO.map((info, idx) => {
                    const status = getStageStatus(idx, currentIdx, isRunning, hasError && idx === currentIdx);
                    return (_jsxs("div", { style: { ...styles.stagePill, ...getPillStyle(status) }, role: "tab", "aria-selected": idx === currentIdx, tabIndex: 0, title: `${info.label} - ${status}`, children: [_jsx("div", { style: { ...styles.dot, background: getDotColor(status) } }), _jsx("div", { style: styles.pillNum, children: idx + 1 }), _jsx("div", { style: styles.pillLabel, children: info.label })] }, info.stage));
                }) })] }));
}
