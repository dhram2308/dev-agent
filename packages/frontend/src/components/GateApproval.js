import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Gate Approval Component
// Shows approval/reject dialogs when pipeline is waiting at a gate
// ═══════════════════════════════════════════════════════════════
import { useState, useRef } from 'react';
import { usePipelineStore, useActiveTicketState } from '../store/pipeline';
import { useToast } from '../contexts/ToastContext';
import { RejectForm } from './approval/RejectForm';
import { RefineForm } from './approval/RefineForm';
// ── Styles ─────────────────────────────────────────────────────
const styles = {
    container: {
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--glass-border)',
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(var(--glass-blur))',
        WebkitBackdropFilter: 'blur(var(--glass-blur))',
        padding: 'var(--sp-5)',
        marginBottom: 'var(--sp-6)',
        animation: 'fadeIn 0.3s ease-out',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
        marginBottom: 'var(--sp-4)',
    },
    title: {
        fontSize: 15,
        fontWeight: 600,
        color: 'var(--text-primary)',
    },
    gateBadge: {
        fontSize: 11,
        padding: '3px 10px',
        borderRadius: 10,
        background: 'var(--warning-muted)',
        color: 'var(--warning)',
        fontWeight: 600,
    },
    description: {
        fontSize: 13,
        color: 'var(--text-secondary)',
        lineHeight: 1.7,
        marginBottom: 'var(--sp-4)',
    },
    planContent: {
        background: 'var(--bg-elevated)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--sp-4)',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        lineHeight: 1.8,
        maxHeight: 400,
        overflowY: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--text-secondary)',
        marginBottom: 'var(--sp-4)',
    },
    mrLink: {
        display: 'inline-block',
        padding: 'var(--sp-2) var(--sp-4)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--blue-muted)',
        color: 'var(--blue)',
        textDecoration: 'none',
        fontSize: 13,
        fontWeight: 600,
        marginBottom: 'var(--sp-4)',
        transition: 'background 0.15s',
    },
    approvalStatus: {
        fontSize: 12,
        color: 'var(--text-secondary)',
        marginBottom: 'var(--sp-3)',
    },
    actions: {
        display: 'flex',
        gap: 'var(--sp-3)',
        alignItems: 'center',
        paddingTop: 'var(--sp-4)',
        borderTop: '1px solid var(--border-default)',
        flexWrap: 'wrap',
    },
    btnApprove: {
        padding: 'var(--sp-3) var(--sp-6)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        background: 'linear-gradient(135deg, #22c55e, #16a34a)',
        color: '#fff',
        transition: 'all 0.2s',
        boxShadow: '0 0 16px var(--success-glow)',
        fontFamily: 'var(--font-sans)',
    },
    btnReject: {
        padding: 'var(--sp-3) var(--sp-6)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        background: 'transparent',
        color: 'var(--danger)',
        border: '1.5px solid var(--danger)',
        transition: 'all 0.2s',
        fontFamily: 'var(--font-sans)',
    },
    btnRefine: {
        padding: 'var(--sp-3) var(--sp-6)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        background: 'transparent',
        color: 'var(--accent)',
        border: '1.5px solid var(--accent)',
        transition: 'all 0.2s',
        fontFamily: 'var(--font-sans)',
    },
    disabled: {
        opacity: 0.4,
        cursor: 'not-allowed',
        boxShadow: 'none',
    },
    feedbackArea: {
        marginTop: 'var(--sp-3)',
        animation: 'slideDown 0.2s ease-out',
    },
    textarea: {
        width: '100%',
        height: 80,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--sp-3)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        resize: 'vertical',
        outline: 'none',
        transition: 'border-color 0.2s',
    },
    submitBtn: {
        marginTop: 'var(--sp-2)',
        padding: 'var(--sp-2) var(--sp-5)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        color: '#fff',
        transition: 'all 0.2s',
        fontFamily: 'var(--font-sans)',
    },
    // Dialog overlay
    dialogOverlay: {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'var(--bg-overlay)',
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'fadeIn 0.15s ease-out',
    },
    dialogBox: {
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--sp-6)',
        maxWidth: 400,
        width: '90%',
        animation: 'modalIn 0.3s var(--ease-spring)',
    },
    dialogTitle: {
        fontSize: 16,
        fontWeight: 700,
        marginBottom: 'var(--sp-2)',
    },
    dialogMsg: {
        fontSize: 13,
        color: 'var(--text-secondary)',
        marginBottom: 'var(--sp-5)',
        lineHeight: 1.6,
    },
    dialogActions: {
        display: 'flex',
        gap: 'var(--sp-2)',
        justifyContent: 'flex-end',
    },
    dialogCancel: {
        padding: 'var(--sp-2) var(--sp-5)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        background: 'var(--bg-elevated)',
        color: 'var(--text-secondary)',
        border: '1px solid var(--border-default)',
        fontFamily: 'var(--font-sans)',
    },
    dialogConfirm: {
        padding: 'var(--sp-2) var(--sp-5)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        fontFamily: 'var(--font-sans)',
    },
    suggestions: {
        marginTop: 'var(--sp-3)',
        padding: 'var(--sp-3) var(--sp-4)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--warning-muted)',
        border: '1px solid rgba(234,179,8,0.2)',
    },
    sugTitle: {
        fontSize: 12,
        fontWeight: 700,
        color: 'var(--warning)',
        marginBottom: 'var(--sp-2)',
    },
    sugItem: {
        fontSize: 12,
        color: 'var(--text-secondary)',
        padding: '3px 0 3px 16px',
        position: 'relative',
        lineHeight: 1.5,
    },
};
const GATE_CONFIGS = {
    explore_plan: {
        title: 'Plan Review',
        description: 'The agent has generated an exploration plan and OpenSpec artifacts. Review the plan and approve, reject, or request refinements.',
        showPlan: true,
        showMR: false,
        showRefine: true,
        approveLabel: 'Approve Plan',
        rejectLabel: 'Reject Plan',
    },
    gate_code_review: {
        title: 'Code Review',
        description: 'The agent has generated code and created a Merge Request. Review the changes and approve or reject.',
        showPlan: false,
        showMR: true,
        showRefine: false,
        approveLabel: 'Approve MR',
        rejectLabel: 'Request Changes',
    },
    gate_preprod_approval: {
        title: 'Pre-Production Approval',
        description: 'QA testing has passed. Approve deployment to the pre-production environment.',
        showPlan: false,
        showMR: false,
        showRefine: false,
        approveLabel: 'Approve Pre-Prod',
        rejectLabel: 'Reject',
    },
    gate_dual_approval: {
        title: 'Dual Approval (Production)',
        description: 'Pre-production deployment complete. Both approvals are required for production deployment.',
        showPlan: false,
        showMR: false,
        showRefine: false,
        approveLabel: 'Approve Production',
        rejectLabel: 'Reject',
    },
};
// ── Component ──────────────────────────────────────────────────
export function GateApproval() {
    const ticketState = useActiveTicketState();
    const reviewData = usePipelineStore((s) => s.reviewData);
    const activeTicket = usePipelineStore((s) => s.activeTicket);
    const approveGateAction = usePipelineStore((s) => s.approveGate);
    const rejectGateAction = usePipelineStore((s) => s.rejectGate);
    const refineGateAction = usePipelineStore((s) => s.refineGate);
    const { addToast } = useToast();
    const [showRejectForm, setShowRejectForm] = useState(false);
    const [showRefineForm, setShowRefineForm] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [confirmDialog, setConfirmDialog] = useState(null);
    const dialogRef = useRef(null);
    // Determine if we're at a gate
    const gateWaiting = ticketState?.gateWaiting;
    if (!gateWaiting || !activeTicket)
        return null;
    const config = GATE_CONFIGS[gateWaiting];
    if (!config)
        return null;
    const data = ticketState?.state?.data ?? {};
    // Handle approve
    const handleApprove = async () => {
        setConfirmDialog(null);
        setSubmitting(true);
        try {
            await approveGateAction(activeTicket, gateWaiting);
            addToast(`${config.title} approved — pipeline proceeding`, 'success');
        }
        catch {
            addToast('Approval failed — please try again', 'error');
        }
        finally {
            setSubmitting(false);
        }
    };
    // Handle reject (from RejectForm component)
    const handleReject = async (reason) => {
        setSubmitting(true);
        try {
            await rejectGateAction(activeTicket, gateWaiting, reason);
            setShowRejectForm(false);
            addToast('Rejection submitted — agent will address feedback', 'warn');
        }
        catch {
            addToast('Rejection failed — please try again', 'error');
        }
        finally {
            setSubmitting(false);
        }
    };
    // Handle refine (from RefineForm component)
    const handleRefine = async (instructions) => {
        setSubmitting(true);
        try {
            await refineGateAction(activeTicket, gateWaiting, instructions);
            setShowRefineForm(false);
            addToast('Refinement submitted — agent will revise plan', 'info');
        }
        catch {
            addToast('Refinement failed — please try again', 'error');
        }
        finally {
            setSubmitting(false);
        }
    };
    // Plan content (for explore_plan gate)
    const planContent = data.explore_plan;
    const openspecData = data.explore_openspec;
    const suggestions = data._agent_suggestions;
    // MR URL (for code review gate)
    const mrUrl = data.code_mr_url;
    const mrIid = data.code_mr_iid;
    return (_jsxs(_Fragment, { children: [_jsxs("div", { style: styles.container, children: [_jsxs("div", { style: styles.header, children: [_jsx("div", { style: styles.title, children: config.title }), _jsx("span", { style: styles.gateBadge, children: "Waiting" })] }), _jsx("div", { style: styles.description, children: config.description }), config.showPlan && planContent && (_jsx("div", { style: styles.planContent, children: typeof planContent === 'string' ? planContent : JSON.stringify(planContent, null, 2) })), config.showPlan && openspecData && Object.keys(openspecData).length > 0 && (_jsx(OpenSpecTabs, { data: openspecData })), suggestions && suggestions.length > 0 && (_jsxs("div", { style: styles.suggestions, children: [_jsx("div", { style: styles.sugTitle, children: "Suggestions" }), suggestions.map((sug, i) => (_jsxs("div", { style: styles.sugItem, children: ["\u2022 ", sug] }, i)))] })), config.showMR && mrUrl && (_jsxs("a", { href: mrUrl, target: "_blank", rel: "noopener noreferrer", style: styles.mrLink, children: ["View Merge Request ", mrIid ? `!${mrIid}` : ''] })), gateWaiting === 'gate_dual_approval' && (_jsxs("div", { style: styles.approvalStatus, children: [_jsxs("span", { style: { color: data._ui_approve_preprod ? 'var(--success)' : 'var(--warning)', fontWeight: 600 }, children: ["Pre-Prod: ", data._ui_approve_preprod ? 'Approved' : 'Pending'] }), ' | ', _jsxs("span", { style: { color: data._ui_approve_dual ? 'var(--success)' : 'var(--warning)', fontWeight: 600 }, children: ["Production: ", data._ui_approve_dual ? 'Approved' : 'Pending'] })] })), _jsxs("div", { style: styles.actions, children: [_jsx("button", { style: { ...styles.btnApprove, ...(submitting ? styles.disabled : {}) }, onClick: () => setConfirmDialog('approve'), disabled: submitting, "aria-label": config.approveLabel, children: config.approveLabel }), _jsx("button", { style: { ...styles.btnReject, ...(submitting ? styles.disabled : {}) }, onClick: () => {
                                    setShowRejectForm(!showRejectForm);
                                    setShowRefineForm(false);
                                }, disabled: submitting, "aria-label": config.rejectLabel, children: config.rejectLabel }), config.showRefine && (_jsx("button", { style: { ...styles.btnRefine, ...(submitting ? styles.disabled : {}) }, onClick: () => {
                                    setShowRefineForm(!showRefineForm);
                                    setShowRejectForm(false);
                                }, disabled: submitting, "aria-label": "Request refinement", children: "Refine" }))] }), showRejectForm && (_jsx(RejectForm, { onSubmit: handleReject, onCancel: () => setShowRejectForm(false), submitting: submitting })), showRefineForm && (_jsx(RefineForm, { onSubmit: handleRefine, onCancel: () => setShowRefineForm(false), submitting: submitting }))] }), confirmDialog === 'approve' && (_jsx("div", { style: styles.dialogOverlay, onClick: (e) => { if (e.target === e.currentTarget)
                    setConfirmDialog(null); }, children: _jsxs("div", { ref: dialogRef, style: styles.dialogBox, role: "alertdialog", "aria-labelledby": "confirm-title", "aria-describedby": "confirm-msg", children: [_jsx("h3", { id: "confirm-title", style: styles.dialogTitle, children: "Confirm Approval" }), _jsxs("p", { id: "confirm-msg", style: styles.dialogMsg, children: ["Are you sure you want to approve ", config.title.toLowerCase(), "? The pipeline will proceed to the next stage."] }), _jsxs("div", { style: styles.dialogActions, children: [_jsx("button", { style: styles.dialogCancel, onClick: () => setConfirmDialog(null), children: "Cancel" }), _jsx("button", { style: {
                                        ...styles.dialogConfirm,
                                        background: 'var(--success)',
                                        color: '#fff',
                                    }, onClick: handleApprove, children: "Approve" })] })] }) }))] }));
}
// ── OpenSpec Tabs sub-component ────────────────────────────────
function OpenSpecTabs({ data }) {
    const keys = Object.keys(data);
    const [activeTab, setActiveTab] = useState(keys[0] ?? '');
    if (keys.length === 0)
        return _jsx(_Fragment, {});
    return (_jsxs("div", { style: { marginBottom: 'var(--sp-4)' }, children: [_jsx("div", { style: {
                    display: 'flex',
                    gap: 4,
                    marginBottom: 'var(--sp-3)',
                    borderBottom: '2px solid var(--border-default)',
                    paddingBottom: 0,
                }, children: keys.map((key) => (_jsx("button", { onClick: () => setActiveTab(key), style: {
                        padding: '8px 18px',
                        borderRadius: '8px 8px 0 0',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                        border: '1px solid transparent',
                        borderBottom: 'none',
                        background: activeTab === key ? 'var(--bg-elevated)' : 'transparent',
                        color: activeTab === key ? 'var(--accent)' : 'var(--text-tertiary)',
                        transition: 'all 0.15s',
                        fontFamily: 'var(--font-sans)',
                        ...(activeTab === key ? {
                            borderColor: 'var(--border-default)',
                            borderBottom: '2px solid var(--bg-elevated)',
                            marginBottom: -2,
                        } : {}),
                    }, children: key }, key))) }), _jsx("div", { style: {
                    background: 'var(--bg-elevated)',
                    borderRadius: '0 var(--radius-md) var(--radius-md) var(--radius-md)',
                    padding: 'var(--sp-4)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    lineHeight: 1.8,
                    maxHeight: 400,
                    overflowY: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: 'var(--text-secondary)',
                }, children: data[activeTab] ?? '' })] }));
}
