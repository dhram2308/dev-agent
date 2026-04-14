import type { PipelineState } from '@shared/types';
export interface SlackOptions {
    /** Reply in this Slack thread */
    channel?: string;
    /** Thread timestamp for reply */
    threadTs?: string;
    /** Whether to unfurl links (default true) */
    unfurlLinks?: boolean;
    /** Block Kit blocks to send instead of text */
    blocks?: unknown[];
    /** If true and batch mode is on, buffer the message */
    batch?: boolean;
}
export interface SlackSendResult {
    ok: boolean;
    ts?: string | null;
    error?: string;
    fallbackExecuted?: boolean;
    queued?: boolean;
}
export interface SlackHealth {
    initialized: boolean;
    webhookValid: boolean;
    consecutiveFailures: number;
    queueLength: number;
    batchMode: boolean;
    batchBufferSize: number;
    defaultThread: string | null;
    healthy: boolean;
}
export interface NotificationRecord {
    channel: 'slack' | 'jira' | 'log';
    message: string;
    result: 'sent' | 'failed' | 'skipped' | 'fallback' | 'queued';
    retryCount?: number;
    latencyMs?: number;
    threadTs?: string | null;
    fallbackTo?: string;
    error?: string;
}
/**
 * HTTP request function type -- will be provided by http/client.ts.
 * Using a type alias so we can wire the real implementation at init.
 */
type ReqFn = (url: string, opts: {
    method: string;
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
}) => Promise<{
    status: number;
    data: unknown;
    headers?: Record<string, string>;
}>;
type JiraCommentFn = (ticket: string, comment: string) => Promise<void>;
type StateAccessorFn = () => PipelineState | null;
export declare class SlackService {
    private initialized;
    private webhookValid;
    private consecutiveFailures;
    private lastSendTime;
    private sendQueue;
    private drainRunning;
    private batchBuffer;
    private batchTimer;
    private batchModeEnabled;
    private defaultThreadTs;
    private batchWindowMs;
    private webhookUrl;
    private req;
    private jiraCommentFn;
    private stateAccessorFn;
    private jiraCommentsEnabled;
    private currentTicket;
    private auditLog;
    private maxAuditEntries;
    constructor(webhookUrl: string, req: ReqFn, options?: {
        batchWindowMs?: number;
        jiraCommentsEnabled?: boolean;
        currentTicket?: string;
    });
    /** Set a Jira comment function for fallback notifications. */
    setJiraFallback(fn: JiraCommentFn): void;
    /** Set a state accessor function for health flag updates. */
    setStateAccessor(fn: StateAccessorFn): void;
    /** Update the current ticket for Jira fallback. */
    setCurrentTicket(ticket: string): void;
    /**
     * Validates the Slack webhook URL format.
     * Must be a valid https://hooks.slack.com/* URL.
     */
    static validateWebhookUrl(url: string): {
        valid: boolean;
        reason?: string;
    };
    /**
     * Truncate a message to Slack's safe limit, adding a truncation indicator.
     */
    static truncateMessage(text: string): string;
    private recordNotification;
    /** Get a copy of the notification audit log. */
    getAuditLog(): readonly NotificationRecord[];
    /** Get count of consecutive failures from the audit log. */
    getConsecutiveFailures(): number;
    private enqueuePayload;
    private drainQueue;
    /**
     * Send a Slack webhook payload with retry and exponential backoff.
     */
    private sendWithRetry;
    /**
     * Execute the fallback chain when Slack fails:
     *   1. Jira comment (if enabled and function provided)
     *   2. Log file (always)
     *   3. State flag (always)
     */
    private executeFallbackChain;
    /** Enable batch mode: collect messages for batchWindowMs, then send as one. */
    enableBatchMode(): void;
    /** Disable batch mode and flush any pending messages. */
    disableBatchMode(): void;
    /** Immediately send all buffered batch messages. */
    flushBatch(): void;
    /**
     * Internal send: builds payload, truncates, enqueues.
     */
    private sendInternal;
    /**
     * Initialize the notification system.
     * Call once at startup. Validates webhook URL and optionally pings.
     */
    init(options?: {
        skipPing?: boolean;
    }): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /**
     * Send a Slack notification with full resilience (6 layers).
     *
     * @param message - The message to send
     * @param mentions - Slack user IDs to mention (e.g., ['U12345', 'U67890'])
     * @param opts - Additional options (threadTs, batch, blocks, etc.)
     * @returns Result with ok status and optional thread timestamp
     */
    send(message: string, mentions?: string[], opts?: SlackOptions): Promise<SlackSendResult>;
    /**
     * Set the default thread ts for all subsequent messages.
     * Useful for creating a "notification thread" at pipeline start.
     */
    setDefaultThread(ts: string | null): void;
    /** Get the current default thread ts. */
    getDefaultThread(): string | null;
    /** Get the health status of the Slack integration. */
    getHealth(): SlackHealth;
    /**
     * Check if the Slack webhook URL has changed and re-validate.
     * Call periodically (e.g., every stage) to detect env var changes.
     *
     * @returns true if the webhook changed and was re-validated
     */
    checkWebhookChange(newUrl?: string): boolean;
    /** Reset internal state (for testing). */
    _resetForTesting(): void;
}
/**
 * Standalone slack() function matching the original lib/slack.js API.
 *
 * Usage:
 *   const { createSlackSender } = require('./services/slack');
 *   const slack = createSlackSender(webhookUrl, reqFn);
 *   await slack('Hello world', ['U12345']);
 */
export declare function createSlackSender(webhookUrl: string, req: ReqFn, options?: {
    batchWindowMs?: number;
    jiraCommentsEnabled?: boolean;
    currentTicket?: string;
}): {
    slack: (message: string, mentions?: string[], opts?: SlackOptions) => Promise<SlackSendResult>;
    service: SlackService;
};
export {};
