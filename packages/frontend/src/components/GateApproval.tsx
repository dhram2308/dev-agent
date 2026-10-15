// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Gate Approval Component
// Shows approval/reject dialogs when pipeline is waiting at a gate
// ═══════════════════════════════════════════════════════════════

import { useState, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { usePipelineStore, useActiveTicketState } from '../store/pipeline';
import { useReviewStore } from '../store/review';
import { useSettingsStore } from '../store/settings';
import { usePlaygroundStore } from '../store/playground';
import { useNavigationStore } from '../store/navigation';
import { useToast } from '../contexts/ToastContext';
import { RejectForm } from './approval/RejectForm';
import { RefineForm } from './approval/RefineForm';
import { Markdown } from './Markdown';
import { CommentThreadPanel } from './review/CommentThreadPanel';
import { PendingQuestionsPanel } from './PendingQuestionsPanel';
import { ConfirmDialog } from './ConfirmDialog';
import { getPlaygroundRuns, type PlaygroundRunRecord } from '../lib/api';
import { AUTO_APPROVE_CONFIG_KEY } from '../lib/automation';
import type { StageName, PipelineData } from '../types';

// ── Automation policy wiring ───────────────────────────────────
// AUTO_APPROVE_CONFIG_KEY (maps each gate to its CONFIG_SCHEMA policy key —
// manual / playground_validated / always, see AutomationTab.tsx) lives in
// lib/automation.ts so the Dashboard's automation status strip can reuse it
// without duplicating the mapping. GATE_HISTORY_FIELDS below stays local —
// it's only consumed here.
//
// GATE_HISTORY_FIELDS reuses the state.data field names the agent's own gate
// handlers already accumulate (packages/agent/src/server/agent-process.ts's
// STAGE_DATA_MAP) instead of the global, non-ticket-scoped
// /api/notification-audit endpoint.
const GATE_HISTORY_FIELDS: Partial<Record<StageName, string[]>> = {
  explore_plan: ['explore_plan_ui_approved', 'explore_plan_ui_rejected', 'explore_plan_ui_feedback'],
  gate_code_review: ['gate1_ui_approved', 'gate1_ui_rejected', 'gate1_ui_feedback'],
  gate_preprod_approval: ['gate2a_ui_approved', 'gate2a_ui_rejected', 'gate2a_ui_feedback'],
  gate_dual_approval: ['gate2b_ui_approved', 'gate2b_ui_rejected', 'gate2b_ui_feedback', 'gate2b_qa_approved'],
};

/** How long the auto-approve countdown runs before it actually approves. */
const AUTO_APPROVE_COUNTDOWN_SEC = 120;

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
  // When embedded inside a timeline card, the card's own .ev-body chrome
  // already supplies border/background/blur/padding — this near-zero-chrome
  // variant avoids a visibly doubled glass panel.
  containerEmbedded: {
    padding: 0,
    marginBottom: 0,
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
  governancePill: {
    fontSize: 11,
    padding: '3px 10px',
    borderRadius: 10,
    background: 'var(--bg-elevated)',
    color: 'var(--text-tertiary)',
    fontWeight: 600,
    border: '1px solid var(--border-default)',
  },
  modeBadgeDirect: {
    fontSize: 11,
    padding: '3px 10px',
    borderRadius: 10,
    background: 'var(--accent-muted)',
    color: 'var(--accent)',
    fontWeight: 600,
  },
  modeBadgeOpenspec: {
    fontSize: 11,
    padding: '3px 10px',
    borderRadius: 10,
    background: 'var(--success-muted)',
    color: 'var(--success)',
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
    fontSize: 12,
    lineHeight: 1.8,
    maxHeight: 400,
    overflowY: 'auto' as const,
    wordBreak: 'break-word' as const,
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
    flexWrap: 'wrap' as const,
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
    resize: 'vertical' as const,
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
    padding: '2px 0',
    lineHeight: 1.5,
  },
  autoApproveBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
    padding: 'var(--sp-3) var(--sp-4)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--warning-muted)',
    border: '1px solid rgba(234,179,8,0.25)',
    marginBottom: 'var(--sp-4)',
    fontSize: 13,
    color: 'var(--warning)',
  },
  cancelAutoBtn: {
    padding: 'var(--sp-1) var(--sp-4)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    background: 'transparent',
    color: 'var(--warning)',
    border: '1.5px solid var(--warning)',
    fontFamily: 'var(--font-sans)',
    whiteSpace: 'nowrap' as const,
  },
  validatedBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-3)',
    padding: 'var(--sp-3) var(--sp-4)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--success-muted)',
    border: '1px solid rgba(34,197,94,0.2)',
    marginBottom: 'var(--sp-4)',
    fontSize: 13,
    color: 'var(--success)',
  },
  viewRunBtn: {
    padding: 'var(--sp-1) var(--sp-4)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    background: 'transparent',
    color: 'var(--success)',
    border: '1.5px solid var(--success)',
    fontFamily: 'var(--font-sans)',
    whiteSpace: 'nowrap' as const,
  },
  historyToggle: {
    marginTop: 'var(--sp-3)',
    padding: 'var(--sp-1) 0',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-tertiary)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
  },
  historyList: {
    marginTop: 'var(--sp-2)',
    padding: 'var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated)',
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.8,
  },
  viewDiffLink: {
    display: 'inline-block',
    marginLeft: 'var(--sp-3)',
    padding: 'var(--sp-2) var(--sp-4)',
    borderRadius: 'var(--radius-md)',
    background: 'transparent',
    color: 'var(--text-tertiary)',
    textDecoration: 'none',
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 'var(--sp-4)',
    border: '1px solid var(--border-default)',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
  },
  rejectionBudget: {
    fontSize: 12,
    fontWeight: 600,
    marginBottom: 'var(--sp-2)',
    color: 'var(--text-secondary)',
  },
  rejectionBudgetDanger: {
    color: 'var(--danger)',
  },
  rejectionHistoryToggle: {
    padding: 'var(--sp-1) 0',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-tertiary)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
    marginBottom: 'var(--sp-3)',
  },
  rejectionHistoryList: {
    marginTop: 'var(--sp-2)',
    marginBottom: 'var(--sp-3)',
    padding: 'var(--sp-3)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated)',
    fontSize: 12,
    color: 'var(--text-secondary)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 'var(--sp-3)',
  },
  rejectionRound: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-tertiary)',
    marginBottom: 'var(--sp-1)',
  },
  rejectionTimestamp: {
    fontSize: 10,
    color: 'var(--text-ghost)',
    fontWeight: 400,
    marginLeft: 'var(--sp-2)',
  },
  commentPanelWrap: {
    marginBottom: 'var(--sp-4)',
  },
  commentPanelLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-tertiary)',
    marginBottom: 'var(--sp-2)',
  },
} as const;

// ── Gate info per stage ────────────────────────────────────────

interface GateConfig {
  title: string;
  description: string;
  showPlan: boolean;
  showMR: boolean;
  showRefine: boolean;
  approveLabel: string;
  rejectLabel: string;
}

const GATE_CONFIGS: Partial<Record<StageName, GateConfig>> = {
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

interface GateApprovalProps {
  /** When true, renders without its own glass-panel chrome — used when
   * mounted inside a dashboard-activity-timeline-redesign card, whose
   * `.ev-body` already supplies that chrome. Defaults to false, preserving
   * today's standalone rendering for any caller that omits it. */
  embedded?: boolean;
}

export function GateApproval({ embedded = false }: GateApprovalProps = {}): JSX.Element | null {
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
  const [confirmDialog, setConfirmDialog] = useState<'approve' | null>(null);

  // Gate identity, resolved early (before any conditional return) so every
  // hook below runs unconditionally on every render, per rules-of-hooks —
  // GateApproval mounts/unmounts its gate-specific content constantly as
  // pipelines move between gate_waiting and running.
  const gateWaiting = ticketState?.gateWaiting;
  const dataEarly: PipelineData = ticketState?.state?.data ?? {};
  const pendingQuestionsRaw = (dataEarly as any)._pending_questions;
  const hasPendingQuestionsEarly = Array.isArray(pendingQuestionsRaw) && pendingQuestionsRaw.length > 0;

  // ── Automation: per-gate auto-approve policy ──────────────────
  const settingsConfig = useSettingsStore((s) => s.config);
  const fetchSettingsConfig = useSettingsStore((s) => s.fetchConfig);
  const viewPlaygroundRun = usePlaygroundStore((s) => s.viewRun);
  const setNavView = useNavigationStore((s) => s.setView);

  const [autoApproveCancelled, setAutoApproveCancelled] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(AUTO_APPROVE_COUNTDOWN_SEC);
  const [validatedRun, setValidatedRun] = useState<PlaygroundRunRecord | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showRejectionHistory, setShowRejectionHistory] = useState(false);

  // Load config once (idempotent — cheap no-op if another component already did).
  useEffect(() => {
    if (Object.keys(useSettingsStore.getState().config).length === 0) {
      fetchSettingsConfig();
    }
  }, [fetchSettingsConfig]);

  // Look up the most recent completed Playground run for this (ticket, gate).
  useEffect(() => {
    setValidatedRun(null);
    if (!activeTicket || !gateWaiting) return;
    let cancelled = false;
    getPlaygroundRuns(activeTicket, gateWaiting)
      .then((res) => {
        if (cancelled || !res.ok) return;
        const latest = res.runs.find((r) => r.status === 'completed');
        setValidatedRun(latest ?? null);
      })
      .catch(() => { /* best-effort — no validated-run banner if this fails */ });
    return () => { cancelled = true; };
  }, [activeTicket, gateWaiting]);

  const policyKey = gateWaiting ? AUTO_APPROVE_CONFIG_KEY[gateWaiting] : undefined;
  const policy = policyKey ? (settingsConfig[policyKey] as string | undefined) : undefined;
  const autoApproveActive = !!gateWaiting && !hasPendingQuestionsEarly && !autoApproveCancelled && (
    policy === 'always' || (policy === 'playground_validated' && !!validatedRun)
  );

  // Reset the countdown whenever a new gate starts waiting.
  useEffect(() => {
    setSecondsLeft(AUTO_APPROVE_COUNTDOWN_SEC);
    setAutoApproveCancelled(false);
  }, [gateWaiting, activeTicket]);

  // Tick the countdown and auto-approve at zero.
  useEffect(() => {
    if (!autoApproveActive) return;
    if (secondsLeft <= 0) {
      if (activeTicket && gateWaiting) {
        approveGateAction(activeTicket, gateWaiting)
          .then(() => addToast('Auto-approved by policy — pipeline proceeding', 'success'))
          .catch(() => addToast('Auto-approve failed — please approve manually', 'error'));
      }
      return;
    }
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [autoApproveActive, secondsLeft, activeTicket, gateWaiting, approveGateAction, addToast]);

  const handleViewValidatedRun = (): void => {
    if (!validatedRun) return;
    void viewPlaygroundRun(validatedRun.runId);
    setNavView('playground');
  };

  if (!gateWaiting || !activeTicket) return null;

  const config = GATE_CONFIGS[gateWaiting];
  if (!config) return null;

  const data: PipelineData = ticketState?.state?.data ?? {};
  const historyFields = GATE_HISTORY_FIELDS[gateWaiting] ?? [];
  const historyEntries = historyFields
    .map((key) => ({ key, value: (data as Record<string, unknown>)[key] }))
    .filter((entry) => entry.value !== undefined && entry.value !== null && entry.value !== false);

  // Handle approve
  const handleApprove = async (): Promise<void> => {
    setConfirmDialog(null);
    setSubmitting(true);
    try {
      await approveGateAction(activeTicket, gateWaiting);
      addToast(`${config.title} approved — pipeline proceeding`, 'success');
    } catch {
      addToast('Approval failed — please try again', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // Handle reject (from RejectForm component)
  const handleReject = async (reason: string): Promise<void> => {
    setSubmitting(true);
    try {
      await rejectGateAction(activeTicket, gateWaiting, reason);
      setShowRejectForm(false);
      addToast('Rejection submitted — agent will address feedback', 'warn');
    } catch {
      addToast('Rejection failed — please try again', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // Handle refine (from RefineForm component)
  const handleRefine = async (instructions: string): Promise<void> => {
    setSubmitting(true);
    try {
      await refineGateAction(activeTicket, gateWaiting, instructions);
      setShowRefineForm(false);
      addToast('Refinement submitted — agent will revise plan', 'info');
    } catch {
      addToast('Refinement failed — please try again', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // Plan content (for explore_plan gate)
  const planContent = data.explore_plan;
  const openspecData = data.explore_openspec as Record<string, string | string[]> | undefined;
  const suggestions = data._agent_suggestions as string[] | undefined;

  // Clarifying questions — block Approve until answered (Reject + Refine stay enabled).
  // Computed early (hasPendingQuestionsEarly) so the auto-approve hooks above can
  // see it too; aliased here under the name the JSX below already uses.
  const hasPendingQuestions = hasPendingQuestionsEarly;

  // MR URL (for code review gate)
  const mrUrl = data.code_mr_url as string | undefined;
  const mrIid = data.code_mr_iid;

  // Governance pill (every gate) — "Auto" covers both auto-approve policies
  // (always / playground_validated); "Plan" means this gate waits for you.
  const isAutoPolicy = policy === 'always' || policy === 'playground_validated';

  // Plan-mode badge + description (explore_plan only) — advanceMode is seeded
  // once by fetch_ticket and never re-evaluated; openspecData === undefined
  // with advanceMode !== 'direct' means OpenSpec was attempted but its
  // artifacts failed to parse, not that Direct mode is active by design.
  const advanceMode = data.advanceMode as 'direct' | 'openspec' | undefined;
  const isDirectMode = gateWaiting === 'explore_plan' && advanceMode === 'direct';
  const gateDescription = gateWaiting === 'explore_plan'
    ? (isDirectMode
        ? 'The agent has generated an implementation plan. Review the plan and approve, reject, or request refinements.'
        : config.description)
    : config.description;

  return (
    <>
      <div style={{ ...styles.container, ...(embedded ? styles.containerEmbedded : {}) }}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.title}>{config.title}</div>
          <span style={styles.gateBadge}>Waiting</span>
          <span style={styles.governancePill}>{isAutoPolicy ? 'Auto' : 'Plan'}</span>
          {config.showPlan && (
            <span style={isDirectMode ? styles.modeBadgeDirect : styles.modeBadgeOpenspec}>
              {isDirectMode ? 'Direct plan' : (openspecData ? 'OpenSpec plan' : 'OpenSpec parse failed')}
            </span>
          )}
        </div>

        {/* Description */}
        <div style={styles.description}>{gateDescription}</div>

        {/* Validated-in-Playground banner — links back to the run that proved
            this stage's behavior before it reached a real gate. */}
        {validatedRun && (
          <div style={styles.validatedBanner}>
            <span style={{ flex: 1 }}>
              Validated in Playground on {new Date(validatedRun.finishedAt ?? validatedRun.startedAt).toLocaleString()}
            </span>
            <button type="button" style={styles.viewRunBtn} onClick={handleViewValidatedRun}>
              View run
            </button>
          </div>
        )}

        {/* Auto-approve countdown — only shown when policy actually triggers it.
            Gates stay in the pipeline exactly as today; this is just a visible,
            cancellable countdown to an automatic approve. */}
        {autoApproveActive && (
          <div style={styles.autoApproveBanner}>
            <span style={{ flex: 1 }}>
              Will auto-approve in {Math.floor(secondsLeft / 60)}m {String(secondsLeft % 60).padStart(2, '0')}s unless you act
              {policy === 'playground_validated' ? ' (validated in Playground)' : ' (policy: always)'}.
            </span>
            <button
              type="button"
              style={styles.cancelAutoBtn}
              onClick={() => setAutoApproveCancelled(true)}
              aria-label="Cancel auto-approve"
            >
              Cancel auto-approve
            </button>
          </div>
        )}

        {/* Clarifying questions (explore_plan gate) — mounts above the plan
            preview and tabs when the Architect raised questions that the
            user has not yet answered. */}
        {config.showPlan && hasPendingQuestions && (
          <PendingQuestionsPanel ticket={ticketState.ticket} />
        )}

        {/* Plan content (explore_plan gate) */}
        {config.showPlan && planContent && (
          <div style={styles.planContent}>
            {typeof planContent === 'string' ? (
              <Markdown>{planContent}</Markdown>
            ) : (
              <pre>{JSON.stringify(planContent, null, 2)}</pre>
            )}
          </div>
        )}

        {/* OpenSpec tabs (explore_plan gate) */}
        {config.showPlan && openspecData && Object.keys(openspecData).length > 0 && (
          <OpenSpecTabs data={openspecData} />
        )}

        {/* Suggestions */}
        {suggestions && suggestions.length > 0 && (
          <div style={styles.suggestions}>
            <div style={styles.sugTitle}>Suggestions</div>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {suggestions.map((sug, i) => (
                <li key={i} style={styles.sugItem}>
                  <Markdown>{String(sug)}</Markdown>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* MR link (code review gate) */}
        {config.showMR && mrUrl && (
          <a
            href={mrUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.mrLink}
          >
            View Merge Request {mrIid ? `!${mrIid}` : ''}
          </a>
        )}

        {/* View full diff (code review gate) — the file tree + diff pane stay
            on /review; this card only surfaces the comment threads + decision. */}
        {gateWaiting === 'gate_code_review' && (
          <button
            type="button"
            style={styles.viewDiffLink}
            onClick={() => setNavView('review')}
          >
            View full diff →
          </button>
        )}

        {/* Rejection budget + round history (code review gate) — both fields
            already exist in state.data (written by incrementRejectionCounter()
            in gate-code-review.ts), just never surfaced in the UI before. */}
        {gateWaiting === 'gate_code_review' && (() => {
          const rejections = (data._gate_rejections as Record<string, number> | undefined)?.gate1 ?? 0;
          const maxRejections = Number(settingsConfig['MAX_REJECTIONS'] ?? 3);
          const history = (data.rejectionHistory as Array<{ round: number; feedback: string; timestamp: string }> | undefined) ?? [];
          const nearLimit = rejections >= maxRejections - 1 && maxRejections > 0;
          return (
            <>
              <div style={{ ...styles.rejectionBudget, ...(nearLimit ? styles.rejectionBudgetDanger : {}) }}>
                Rejection rounds: {rejections}/{maxRejections}
              </div>
              {history.length > 0 && (
                <>
                  <button
                    type="button"
                    style={styles.rejectionHistoryToggle}
                    onClick={() => setShowRejectionHistory(!showRejectionHistory)}
                    aria-expanded={showRejectionHistory}
                  >
                    {showRejectionHistory ? '▾' : '▸'} Rejection rounds ({history.length})
                  </button>
                  {showRejectionHistory && (
                    <div style={styles.rejectionHistoryList}>
                      {history.map((round) => (
                        <div key={round.round}>
                          <div style={styles.rejectionRound}>
                            Round {round.round}
                            <span style={styles.rejectionTimestamp}>{new Date(round.timestamp).toLocaleString()}</span>
                          </div>
                          <Markdown>{round.feedback}</Markdown>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          );
        })()}

        {/* Comment threads (code review gate) — read + reply inline, using the
            same InlineComment component and persisted comments /review shows.
            Starting a brand-new (non-reply) thread still requires /review's
            diff pane, since that's where a file/line is picked. */}
        {gateWaiting === 'gate_code_review' && (
          <div style={styles.commentPanelWrap}>
            <div style={styles.commentPanelLabel}>Comments</div>
            <CommentThreadPanel ticket={activeTicket} />
          </div>
        )}

        {/* Approval status for dual approval */}
        {gateWaiting === 'gate_dual_approval' && (
          <div style={styles.approvalStatus}>
            <span style={{ color: data._ui_approve_preprod ? 'var(--success)' : 'var(--warning)', fontWeight: 600 }}>
              Pre-Prod: {data._ui_approve_preprod ? 'Approved' : 'Pending'}
            </span>
            {' | '}
            <span style={{ color: data._ui_approve_dual ? 'var(--success)' : 'var(--warning)', fontWeight: 600 }}>
              Production: {data._ui_approve_dual ? 'Approved' : 'Pending'}
            </span>
          </div>
        )}

        {/* Action buttons */}
        <div style={styles.actions}>
          <button
            style={{ ...styles.btnApprove, ...(submitting || hasPendingQuestions ? styles.disabled : {}) }}
            onClick={() => setConfirmDialog('approve')}
            disabled={submitting || hasPendingQuestions}
            aria-label={config.approveLabel}
            title={hasPendingQuestions ? 'Answer pending questions to approve' : undefined}
          >
            {config.approveLabel}
          </button>

          <button
            style={{ ...styles.btnReject, ...(submitting ? styles.disabled : {}) }}
            onClick={() => {
              setShowRejectForm(!showRejectForm);
              setShowRefineForm(false);
            }}
            disabled={submitting}
            aria-label={config.rejectLabel}
          >
            {config.rejectLabel}
          </button>

          {config.showRefine && (
            <button
              style={{ ...styles.btnRefine, ...(submitting ? styles.disabled : {}) }}
              onClick={() => {
                setShowRefineForm(!showRefineForm);
                setShowRejectForm(false);
              }}
              disabled={submitting}
              aria-label="Request refinement"
            >
              Refine
            </button>
          )}
        </div>

        {/* Reject feedback form */}
        {showRejectForm && (
          <RejectForm
            onSubmit={handleReject}
            onCancel={() => setShowRejectForm(false)}
            submitting={submitting}
          />
        )}

        {/* Refine feedback form */}
        {showRefineForm && (
          <RefineForm
            onSubmit={handleRefine}
            onCancel={() => setShowRefineForm(false)}
            submitting={submitting}
          />
        )}

        {/* History — reuses the per-ticket state.data fields this gate already
            accumulates (set/cleared by the agent's own gate handlers), rather
            than the backend's global, non-ticket-scoped notification-audit log. */}
        {historyEntries.length > 0 && (
          <>
            <button
              type="button"
              style={styles.historyToggle}
              onClick={() => setShowHistory(!showHistory)}
              aria-expanded={showHistory}
            >
              {showHistory ? '▾' : '▸'} History ({historyEntries.length})
            </button>
            {showHistory && (
              <div style={styles.historyList}>
                {historyEntries.map(({ key, value }) => (
                  <div key={key}>
                    <strong>{key}</strong>: {typeof value === 'string' ? value : JSON.stringify(value)}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Confirmation dialog (approve only) */}
      <ConfirmDialog
        open={confirmDialog === 'approve'}
        title="Confirm Approval"
        message={`Are you sure you want to approve ${config.title.toLowerCase()}? The pipeline will proceed to the next stage.`}
        confirmText="Approve"
        onConfirm={handleApprove}
        onCancel={() => setConfirmDialog(null)}
      />
    </>
  );
}

// ── OpenSpec Tabs sub-component ────────────────────────────────

const MONO_PILL_STYLE: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  padding: '4px 8px',
  background: 'var(--bg-elevated)',
  borderRadius: 4,
  color: 'var(--text-secondary)',
  display: 'inline-block',
  wordBreak: 'break-all',
};

function renderTabBody(key: string, value: string | string[] | undefined): JSX.Element {
  if (value === undefined || value === null) {
    return <em style={{ color: 'var(--text-ghost)' }}>No content</em>;
  }
  if (key === 'suggestions' && Array.isArray(value)) {
    if (value.length === 0) {
      return <em style={{ color: 'var(--text-ghost)' }}>No suggestions</em>;
    }
    return (
      <ul style={{ margin: 0, paddingLeft: 20 }}>
        {value.map((item, i) => (
          <li key={i} style={{ padding: '2px 0' }}>
            <Markdown>{String(item)}</Markdown>
          </li>
        ))}
      </ul>
    );
  }
  if (key === 'changeName' || key === 'artifactDir') {
    return <code style={MONO_PILL_STYLE}>{String(value)}</code>;
  }
  return <Markdown>{String(value)}</Markdown>;
}

function OpenSpecTabs({ data }: { data: Record<string, string | string[]> }): JSX.Element {
  const keys = Object.keys(data);
  const [activeTab, setActiveTab] = useState(keys[0] ?? '');

  if (keys.length === 0) return <></>;

  return (
    <div style={{ marginBottom: 'var(--sp-4)' }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex',
        gap: 4,
        marginBottom: 'var(--sp-3)',
        borderBottom: '2px solid var(--border-default)',
        paddingBottom: 0,
      }}>
        {keys.map((key) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            style={{
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
            }}
          >
            {key}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{
        background: 'var(--bg-elevated)',
        borderRadius: '0 var(--radius-md) var(--radius-md) var(--radius-md)',
        padding: 'var(--sp-4)',
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        lineHeight: 1.7,
        maxHeight: 400,
        overflowY: 'auto' as const,
        wordBreak: 'break-word' as const,
        color: 'var(--text-secondary)',
      }}>
        {renderTabBody(activeTab, data[activeTab])}
      </div>
    </div>
  );
}
