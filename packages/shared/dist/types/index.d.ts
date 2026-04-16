/** All pipeline stage names as a literal union */
export type StageName = 'fetch_ticket' | 'explore_plan' | 'generate_code' | 'gate_code_review' | 'deploy_qa' | 'test_qa' | 'gate_preprod_approval' | 'create_preprod_mr' | 'gate_dual_approval' | 'deploy_prod' | 'done';
/** Ordered array of all stages */
export declare const STAGE_ORDER: readonly StageName[];
/** Error classification categories */
export declare enum ErrorClass {
    TRANSIENT = "TRANSIENT",
    AUTH = "AUTH",
    PERMANENT = "PERMANENT",
    TIMEOUT = "TIMEOUT"
}
/** External service names */
export declare enum ServiceName {
    JIRA = "jira",
    GITLAB = "gitlab",
    SLACK = "slack",
    CLAUDE = "claude"
}
/** Error classification result */
export interface ErrorClassification {
    class: ErrorClass;
    confidence: number;
    reason: string;
    retryable: boolean;
}
/** Recovery action returned by executeWithRecovery */
export type RecoveryAction = 'HALT' | 'AUTH_FAILED' | 'TIMEOUT_EXHAUSTED' | 'RETRIES_EXHAUSTED';
/** Individual retry history entry */
export interface RetryHistoryEntry {
    attempt: number;
    timestamp: string;
    error: string;
    classification: ErrorClassification;
}
/** Pipeline state data object (extensible) */
export interface PipelineData {
    _pipeline_start?: number;
    _lastActivity?: string;
    _retries?: Record<string, number>;
    _lastError?: {
        stage: string;
        message: string;
        classification: ErrorClass;
        attempt: number;
        timestamp: string;
        stack?: string;
    };
    _checkpoint?: CheckpointData;
    _checkpoint_history?: CheckpointHistoryEntry[];
    _stage_completions?: Record<string, {
        completedAt: string;
        stateHash: string;
        pid: number;
    }>;
    _last_completed_stage?: string;
    _last_completed_time?: string;
    _config_snapshot?: Record<string, unknown>;
    _completedGates?: string[];
    _rollbacks?: RollbackRecord[];
    _stage_timeout?: StageTimeoutInfo;
    _warnings?: Array<{
        stage: string;
        message: string;
        timestamp: string;
    }>;
    _health?: HealthReport;
    _escalations?: EscalationRecord[];
    _notification_failures?: NotificationFailure[];
    _ui_approve_gate?: string;
    _ui_approve_preprod?: string;
    _ui_approve_dual?: string;
    /** OAuth: provider that caused an auth failure (exit-78 path) */
    _authFailure?: {
        provider: string;
        ts: number;
        reason?: string;
    };
    /** OAuth: per-provider respawn count within this pipeline run */
    _authRespawnCount?: Record<string, number>;
    /** OAuth: set to true when pipeline is paused waiting for re-auth */
    _authPaused?: boolean;
    /** OAuth: stage the pipeline was on when auth pause started */
    _authPausedAtStage?: string;
    [key: string]: unknown;
}
/** Core pipeline state */
export interface PipelineState {
    ticket: string;
    stage: StageName;
    data: PipelineData;
    _seq?: number;
    _hmac?: string;
    _v?: number;
}
/** Checkpoint data */
export interface CheckpointData {
    stage: StageName;
    previousStage: StageName | null;
    entryTime: string;
    entryTimeMs: number;
    pipelineElapsedMs: number;
    pid: number;
    stateHash: string;
    configSnapshotHash: string | null;
    prerequisites: CheckpointPrerequisites;
    completedGates: string[];
    version: number;
}
/** Lightweight checkpoint history entry (stored in ring buffer) */
export interface CheckpointHistoryEntry {
    stage: StageName;
    entryTime: string;
    stateHash: string;
    prerequisites: string;
}
/** Health report */
export interface HealthReport {
    stage: StageName;
    memory: {
        rss: number;
        heapUsed: number;
        heapTotal: number;
        trend: {
            trend: 'growing' | 'stable' | 'shrinking' | 'insufficient_data';
            currentMB: number;
        };
    };
    services: Record<ServiceName, ServiceHealth>;
    progress: {
        stuck: boolean;
        stuckMinutes: number;
        lastStageChange: string;
    };
    warnings: string[];
    warningCount: number;
}
/** Service health status */
export interface ServiceHealth {
    status: 'healthy' | 'degraded' | 'unhealthy';
    consecutiveFailures: number;
    lastSuccess?: string;
    lastFailure?: string;
    lastError?: string;
    latencyMs?: number;
}
/** Escalation record */
export interface EscalationRecord {
    rule: string;
    severity: 'critical' | 'warning' | 'info';
    message: string;
    timestamp: string;
    acknowledged: boolean;
}
/** Notification failure */
export interface NotificationFailure {
    channel: 'slack' | 'jira';
    message: string;
    error: string;
    timestamp: string;
    fallback?: string;
}
/** Stage handler function signature */
export type StageHandler = (state: PipelineState) => Promise<void>;
/** Stage handler with timeout wrapper */
export type TimedStageHandler = (state: PipelineState) => Promise<void>;
/** Recovery options */
export interface RecoveryOptions {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
    jitterFraction?: number;
    saveState?: (state: PipelineState) => void;
}
/** Recovery result */
export interface RecoveryResult {
    success: boolean;
    retries: number;
    classification?: ErrorClassification;
    error?: Error;
    action?: RecoveryAction;
    retryHistory: RetryHistoryEntry[];
}
/** Rollback record saved in state */
export interface RollbackRecord {
    from: string;
    to: string;
    timestamp: string;
    reason: string;
}
/** Stage timeout tracking info stored in state */
export interface StageTimeoutInfo {
    stage: StageName;
    timeoutMs: number;
    startedAt: number;
    deadline: number;
}
/** Checkpoint prerequisites result */
export interface CheckpointPrerequisites {
    ok: boolean;
    present: string[];
    missing: string[];
    summary: string;
}
/** Checkpoint verification result */
export interface CheckpointVerification {
    valid: boolean;
    stage: StageName;
    rollback: boolean;
    rollbackTo: StageName | null;
    issues: string[];
}
/** Pipeline budget check result */
export interface PipelineBudget {
    ok: boolean;
    remainingMs: number;
    requiredMs: number;
    sufficientForStage: boolean;
    pipelineElapsedMs: number;
    pipelineMaxMs: number;
}
/** App configuration (typed) */
export interface AppConfig {
    ticket: string;
    jira: {
        base: string;
        token: string;
        email: string;
    };
    gitlab: {
        base: string;
        token: string;
        projectId: number;
        authMode?: 'oauth' | 'pat';
    };
    slack: {
        token?: string;
        channel?: string;
        ownerSlackId?: string;
    };
    branches: {
        source: string;
        qa: string;
        preprod: string;
        prod: string;
    };
    owner: {
        jiraId?: string;
        gitlabId?: number;
        name?: string;
        email?: string;
    };
    timeouts: {
        maxPipelineDuration: number;
        stageTimeouts: Record<string, number>;
        claudeTimeout: number;
    };
    flags: {
        runBuildCheck: boolean;
        runRuntimeTests: boolean;
        browserVerify: boolean;
        runACVerification: boolean;
    };
    limits: {
        maxRejections: number;
        maxConcurrentAgents: number;
    };
}
export * from './jira';
export * from './gitlab';
export * from './adf';
export * from './tickets';
export * from './codegen';
export * from './http';
export * from './state';
export * from './process';
export * from './sse';
export * from './connectors';
export * from './slack';
export * from './approval';
export * from './review';
export * from './diff';
export * from './logging';
export * from './metrics';
export * from './notifications';
export * from './qa';
//# sourceMappingURL=index.d.ts.map