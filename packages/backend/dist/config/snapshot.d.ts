import type { AppConfig, PipelineState } from '@shared/types';
export declare const FROZEN_FIELDS: Set<string>;
export declare const FRESH_FIELDS: Set<string>;
export interface ConfigSnapshot {
    _captured_at: string;
    _captured_pid: number;
    TICKET?: string;
    GITLAB_PROJECT_ID?: string;
    GITLAB_URL?: string;
    GITLAB_CLONE_URL?: string;
    GITLAB_ASSIGNEE_ID?: string;
    GITLAB_TOKEN_HASH: string | null;
    JIRA_TOKEN_HASH: string | null;
    JIRA_EMAIL?: string;
    SLACK_WEBHOOK_SET: boolean;
    BRANCH_TS: string;
    BRANCH_QA: string;
    BRANCH_PREPROD: string;
    BRANCH_PROD: string;
    OWNER_JIRA_ID?: string;
    QA_JIRA_ID?: string;
    OWNER_SLACK_ID?: string;
    QA_SLACK_ID?: string;
    QA_MAIN_USER?: string;
    QA_MAIN_PASS_SET: boolean;
    QA1_USER?: string;
    QA1_PASS_SET: boolean;
    QA_URL?: string;
    QA1_URL?: string;
    MAX_PIPELINE_DURATION: number;
    MAX_APPROVAL_TIMEOUT: number;
    MAX_REJECTIONS: number;
    RUN_BUILD_CHECK: boolean;
    BROWSER_VERIFY: boolean;
    RUN_RUNTIME_TESTS: boolean;
    ANALYSIS_TIMEOUT: number;
    DEVELOPER_TIMEOUT: number;
    REVIEWER_TIMEOUT: number;
    [key: string]: unknown;
}
export interface ConfigDrift {
    field: string;
    severity: 'CRITICAL' | 'INFO';
    message: string;
    frozen: boolean;
    snapshotVal?: unknown;
    liveVal?: unknown;
}
export interface ConfigDriftRecord {
    stage: string;
    timestamp: string;
    drifts: Array<{
        field: string;
        severity: string;
        message: string;
    }>;
}
/**
 * Capture a complete config snapshot at a point in time.
 * This is called at the start of the pipeline (fetch_ticket stage).
 *
 * @param cfg - The live AppConfig object.
 * @param env - Environment variables (defaults to process.env).
 * @returns A snapshot object for storage in pipeline state.
 */
export declare function captureConfigSnapshot(cfg: AppConfig, env?: Record<string, string | undefined>): ConfigSnapshot;
/**
 * Detect config drift between a stored snapshot and the live config.
 *
 * @param snapshot - The stored snapshot from pipeline state.
 * @param cfg - The live AppConfig object.
 * @param env - Environment variables (defaults to process.env).
 * @returns Array of drift records.
 */
export declare function detectConfigDrift(snapshot: ConfigSnapshot, cfg: AppConfig, env?: Record<string, string | undefined>): ConfigDrift[];
/** Logging callback type (to avoid coupling to a specific logger). */
export interface SnapshotLogger {
    warn: (msg: string) => void;
    debug: (msg: string) => void;
}
/**
 * Log config drifts using the provided logger.
 */
export declare function logConfigDrifts(drifts: ConfigDrift[], logger: SnapshotLogger): void;
/**
 * Check config on stage entry: detect frozen field drift and log it.
 *
 * @param state - The pipeline state (must contain data._config_snapshot).
 * @param cfg - The live AppConfig object.
 * @param logger - Logger for outputting drift warnings.
 */
export declare function checkConfigOnStageEntry(state: PipelineState, cfg: AppConfig, logger: SnapshotLogger): void;
/**
 * Get a timeout value fresh from env (not cached at module load).
 * Falls back to snapshot value, then default.
 *
 * @param name - Environment variable name for the timeout.
 * @param defaultMs - Default value in milliseconds.
 * @param state - Optional pipeline state for snapshot fallback.
 * @param env - Optional environment record.
 * @returns The timeout value in milliseconds.
 */
export declare function getTimeout(name: string, defaultMs: number, state?: PipelineState | null, env?: Record<string, string | undefined>): number;
/**
 * Get a boolean flag fresh from env.
 *
 * @param name - Environment variable name.
 * @param defaultVal - Default boolean value.
 * @param env - Optional environment record.
 * @returns The boolean flag value.
 */
export declare function getFlag(name: string, defaultVal?: boolean, env?: Record<string, string | undefined>): boolean;
/**
 * Get an integer config value fresh from env.
 *
 * @param name - Environment variable name.
 * @param defaultVal - Default integer value.
 * @param env - Optional environment record.
 * @returns The integer value.
 */
export declare function getInt(name: string, defaultVal: number, env?: Record<string, string | undefined>): number;
/**
 * Get a string config value fresh from env.
 *
 * @param name - Environment variable name.
 * @param defaultVal - Default string value.
 * @param env - Optional environment record.
 * @returns The string value.
 */
export declare function getString(name: string, defaultVal: string, env?: Record<string, string | undefined>): string;
/**
 * Get a frozen config value from snapshot (or live fallback if no snapshot).
 *
 * @param name - Config field name.
 * @param state - Pipeline state containing snapshot.
 * @param liveFallback - Fallback value if no snapshot.
 * @returns The frozen config value.
 */
export declare function getFrozen<T>(name: string, state: PipelineState | null | undefined, liveFallback: T): T;
