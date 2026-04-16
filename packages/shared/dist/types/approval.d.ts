/**
 * Status of an approval gate.
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout' | 'skipped';
/**
 * An approval gate in the pipeline (code review, pre-prod, dual approval).
 */
export interface ApprovalGate {
    /** Gate identifier (e.g. "gate1", "gate2a", "gate2b") */
    gateId: string;
    /** Human-readable gate name */
    name: string;
    /** Current approval status */
    status: ApprovalStatus;
    /** ISO timestamp when the gate was entered */
    enteredAt: string;
    /** ISO timestamp when the gate was resolved */
    resolvedAt?: string;
    /** Who approved/rejected (username or "Web UI") */
    resolvedBy?: string;
    /** GitLab MR IID associated with this gate */
    mrIid?: number;
    /** GitLab MR URL */
    mrUrl?: string;
    /** Number of approvals received so far */
    approvalCount?: number;
    /** Feedback text (on rejection) */
    feedback?: string;
}
/**
 * Record of a rejection event at a gate.
 */
export interface RejectionRecord {
    /** Which round of rejection this is (1-based) */
    round: number;
    /** Rejection feedback text */
    feedback: string;
    /** ISO timestamp of the rejection */
    timestamp: string;
    /** Source of the rejection */
    source?: 'web_ui' | 'gitlab_mr_closed' | 'gitlab_note' | 'gitlab_mr_rejected';
}
/**
 * Result of checking approval status (UI or GitLab).
 */
export interface ApprovalCheckResult {
    /** Whether approval was granted */
    approved: boolean;
    /** Feedback text (relevant for rejections) */
    feedback?: string;
    /** Source of the check result */
    source?: 'web_ui' | 'gitlab';
}
/**
 * Configuration for an approval gate.
 */
export interface GateConfig {
    /** Maximum time to wait for approval (milliseconds) */
    maxTimeoutMs: number;
    /** Polling interval for checking GitLab MR state (milliseconds) */
    pollIntervalMs: number;
    /** Maximum number of rejections before halting */
    maxRejections: number;
    /** Whether to check Web UI approval in addition to GitLab */
    checkWebUi: boolean;
    /** Notification channels enabled for this gate */
    notifications: {
        slack: boolean;
        jira: boolean;
        ui: boolean;
        reminder1h: boolean;
        reminder4h: boolean;
    };
}
/**
 * Per-gate rejection counter tracking (stored in state.data._gate_rejections).
 */
export type GateRejectionCounts = Record<string, number>;
//# sourceMappingURL=approval.d.ts.map