/**
 * A Slack message to be sent via webhook.
 */
export interface SlackMessage {
    /** Message text content */
    text: string;
    /** Slack user IDs to mention */
    mentionIds?: readonly string[];
    /** Options for send behavior */
    options?: SlackSendOptions;
}
/**
 * Options controlling Slack send behavior.
 */
export interface SlackSendOptions {
    /** Reply in this thread (Slack message timestamp) */
    threadTs?: string;
    /** If true and batch mode is on, buffer the message */
    batch?: boolean;
}
/**
 * A Slack Block Kit block element.
 */
export interface SlackBlock {
    /** Block type (section, divider, header, context, etc.) */
    type: string;
    /** Block text (for section/header types) */
    text?: {
        type: 'plain_text' | 'mrkdwn';
        text: string;
    };
    /** Block fields (for section type) */
    fields?: Array<{
        type: 'plain_text' | 'mrkdwn';
        text: string;
    }>;
    /** Additional block properties */
    [key: string]: unknown;
}
/**
 * A Slack attachment (legacy rich formatting).
 */
export interface SlackAttachment {
    /** Attachment color sidebar */
    color?: string;
    /** Attachment title */
    title?: string;
    /** Attachment body text */
    text?: string;
    /** Attachment footer */
    footer?: string;
    /** Unix timestamp for the attachment */
    ts?: number;
    /** Additional attachment fields */
    fields?: Array<{
        title: string;
        value: string;
        short: boolean;
    }>;
}
/**
 * Response from a Slack webhook send.
 */
export interface SlackResponse {
    /** Whether the message was sent successfully */
    ok: boolean;
    /** Thread timestamp (for reply-in-thread support) */
    ts?: string | null;
    /** Error message on failure */
    error?: string;
    /** Whether the fallback chain was executed */
    fallbackExecuted?: boolean;
    /** Whether the message was queued in batch mode */
    queued?: boolean;
}
/**
 * Payload sent to the Slack webhook endpoint.
 */
export interface SlackWebhookPayload {
    /** Message text (with mentions prepended) */
    text: string;
    /** Thread timestamp for reply-in-thread */
    thread_ts?: string;
    /** Optional Block Kit blocks */
    blocks?: readonly SlackBlock[];
    /** Optional legacy attachments */
    attachments?: readonly SlackAttachment[];
}
/**
 * Notification request within the MI Dev Agent pipeline.
 */
export interface SlackNotification {
    /** The message text to send */
    text: string;
    /** Slack user IDs to mention (e.g. owner) */
    mentions: readonly string[];
    /** Thread timestamp for threading */
    threadTs?: string | null;
    /** Pipeline stage that triggered this notification */
    stage?: string;
    /** Whether this was a fallback notification */
    isFallback?: boolean;
}
/**
 * Health status of the Slack integration.
 */
export interface SlackHealth {
    /** Whether initSlack() has been called */
    initialized: boolean;
    /** Whether the webhook URL passed validation */
    webhookValid: boolean;
    /** Number of consecutive send failures */
    consecutiveFailures: number;
    /** Number of messages in the rate-limited send queue */
    queueLength: number;
    /** Whether batch mode is currently enabled */
    batchMode: boolean;
    /** Number of messages in the batch buffer */
    batchBufferSize: number;
    /** Default thread timestamp for follow-up messages */
    defaultThread: string | null;
    /** Overall health assessment */
    healthy: boolean;
}
/**
 * Webhook URL validation result.
 */
export interface WebhookValidation {
    /** Whether the URL is valid */
    valid: boolean;
    /** Reason for invalidity */
    reason?: string;
}
//# sourceMappingURL=slack.d.ts.map