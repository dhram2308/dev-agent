import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Gate Notification Bar
// Shows all pipelines waiting for gate approval across tickets
// ═══════════════════════════════════════════════════════════════
import { useState, useCallback } from 'react';
import { usePipelineStore } from '../store/pipeline';
import { STAGE_INFO } from '../types';
// ── Styles ─────────────────────────────────────────────────────
const styles = {
    bar: {
        background: 'var(--warning-muted)',
        borderBottom: '1px solid var(--warning)',
        padding: 'var(--sp-2) var(--sp-4)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--sp-2)',
        alignItems: 'center',
        fontSize: 12,
    },
    entry: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-sm)',
        padding: 'var(--sp-1) var(--sp-3)',
    },
    ticket: {
        fontWeight: 600,
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-primary)',
    },
    gate: {
        color: 'var(--text-tertiary)',
    },
    reviewBtn: {
        background: 'var(--accent)',
        color: '#fff',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        padding: '2px 8px',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
    },
    panel: {
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--sp-4)',
        margin: 'var(--sp-3) var(--sp-4)',
        boxShadow: 'var(--shadow-md)',
    },
    panelHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 'var(--sp-3)',
    },
    panelTitle: {
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--text-primary)',
    },
    panelClose: {
        background: 'none',
        border: 'none',
        color: 'var(--text-tertiary)',
        cursor: 'pointer',
        fontSize: 16,
        padding: '2px 6px',
    },
    panelMeta: {
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: 'var(--sp-1) var(--sp-3)',
        fontSize: 12,
        marginBottom: 'var(--sp-3)',
    },
    panelLabel: {
        color: 'var(--text-tertiary)',
        fontWeight: 500,
    },
    panelValue: {
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
    },
    panelActions: {
        display: 'flex',
        gap: 'var(--sp-2)',
        marginTop: 'var(--sp-3)',
    },
    approveBtn: {
        background: 'var(--success)',
        color: '#fff',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        padding: 'var(--sp-2) var(--sp-4)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
    },
    rejectBtn: {
        background: 'var(--danger-muted)',
        color: 'var(--danger)',
        border: '1px solid rgba(239,68,68,0.2)',
        borderRadius: 'var(--radius-sm)',
        padding: 'var(--sp-2) var(--sp-4)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
    },
    feedbackInput: {
        width: '100%',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-elevated)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        padding: 'var(--sp-2)',
        marginTop: 'var(--sp-2)',
        resize: 'vertical',
        minHeight: 60,
        outline: 'none',
    },
};
function gateLabel(stage) {
    const info = STAGE_INFO.find(s => s.stage === stage);
    return info?.label ?? stage;
}
export function GateNotificationBar() {
    const pipelines = usePipelineStore((s) => s.pipelines);
    const approveGate = usePipelineStore((s) => s.approveGate);
    const rejectGate = usePipelineStore((s) => s.rejectGate);
    const [reviewTicket, setReviewTicket] = useState(null);
    const [showFeedback, setShowFeedback] = useState(false);
    const [feedback, setFeedback] = useState('');
    const [loading, setLoading] = useState(false);
    const gateWaiting = pipelines.filter((p) => p.status === 'gate_waiting' && p.needsApproval);
    const handleReview = useCallback((ticket) => {
        setReviewTicket(ticket);
        setShowFeedback(false);
        setFeedback('');
    }, []);
    const handleApprove = useCallback(async () => {
        if (!reviewTicket)
            return;
        const pipeline = gateWaiting.find((p) => p.ticket === reviewTicket);
        if (!pipeline?.gateStage)
            return;
        setLoading(true);
        try {
            await approveGate(reviewTicket, pipeline.gateStage);
            setReviewTicket(null);
        }
        finally {
            setLoading(false);
        }
    }, [reviewTicket, gateWaiting, approveGate]);
    const handleReject = useCallback(async () => {
        if (!reviewTicket)
            return;
        const pipeline = gateWaiting.find((p) => p.ticket === reviewTicket);
        if (!pipeline?.gateStage)
            return;
        if (!showFeedback) {
            setShowFeedback(true);
            return;
        }
        setLoading(true);
        try {
            await rejectGate(reviewTicket, pipeline.gateStage, feedback);
            setReviewTicket(null);
            setShowFeedback(false);
            setFeedback('');
        }
        finally {
            setLoading(false);
        }
    }, [reviewTicket, gateWaiting, rejectGate, showFeedback, feedback]);
    if (gateWaiting.length === 0)
        return null;
    const reviewPipeline = reviewTicket
        ? gateWaiting.find((p) => p.ticket === reviewTicket)
        : null;
    return (_jsxs(_Fragment, { children: [_jsx("div", { style: styles.bar, children: gateWaiting.map((p) => (_jsxs("div", { style: styles.entry, children: [_jsx("span", { style: styles.ticket, children: p.ticket }), _jsxs("span", { style: styles.gate, children: ["needs approval at ", gateLabel(p.gateStage || '')] }), _jsx("button", { style: styles.reviewBtn, onClick: () => handleReview(p.ticket), children: "Review" })] }, p.ticket))) }), reviewPipeline && (_jsxs("div", { style: styles.panel, children: [_jsxs("div", { style: styles.panelHeader, children: [_jsxs("span", { style: styles.panelTitle, children: ["Gate Review: ", reviewPipeline.ticket] }), _jsx("button", { style: styles.panelClose, onClick: () => setReviewTicket(null), children: "\u00D7" })] }), _jsxs("div", { style: styles.panelMeta, children: [_jsx("span", { style: styles.panelLabel, children: "Ticket" }), _jsx("span", { style: styles.panelValue, children: reviewPipeline.ticket }), _jsx("span", { style: styles.panelLabel, children: "Gate" }), _jsx("span", { style: styles.panelValue, children: gateLabel(reviewPipeline.gateStage || '') }), _jsx("span", { style: styles.panelLabel, children: "Progress" }), _jsxs("span", { style: styles.panelValue, children: [Math.round(reviewPipeline.progress * 100), "%"] })] }), showFeedback && (_jsx("textarea", { style: styles.feedbackInput, value: feedback, onChange: (e) => setFeedback(e.target.value), placeholder: "Enter rejection feedback...", autoFocus: true })), _jsxs("div", { style: styles.panelActions, children: [_jsx("button", { style: styles.approveBtn, onClick: handleApprove, disabled: loading, children: loading ? 'Approving...' : 'Approve' }), _jsx("button", { style: styles.rejectBtn, onClick: handleReject, disabled: loading, children: showFeedback
                                    ? (loading ? 'Rejecting...' : 'Submit Rejection')
                                    : 'Reject with Feedback' })] })] }))] }));
}
