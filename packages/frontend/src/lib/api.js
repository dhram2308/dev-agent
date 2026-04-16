// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Typed API Client
// ═══════════════════════════════════════════════════════════════
// API token: injected by the backend at page load or via env var in dev
let apiToken = '';
/** Initialize the API token from page load or dev environment */
export function setApiToken(token) {
    apiToken = token;
}
/** Get the current API token */
export function getApiToken() {
    return apiToken;
}
// ── Internal fetch wrapper ─────────────────────────────────────
class ApiRequestError extends Error {
    status;
    code;
    constructor(status, message, code) {
        super(message);
        this.name = 'ApiRequestError';
        this.status = status;
        this.code = code;
    }
}
async function apiFetch(path, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
    };
    if (apiToken) {
        headers['X-Api-Token'] = apiToken;
    }
    const response = await fetch(path, {
        ...options,
        headers,
    });
    if (!response.ok) {
        let message = `HTTP ${response.status}: ${response.statusText}`;
        let code;
        let retryAfter;
        try {
            const body = await response.json();
            if (body.error)
                message = body.error;
            if (body.code)
                code = body.code;
            if (typeof body.retryAfter === 'number')
                retryAfter = body.retryAfter;
        }
        catch {
            // Response body not JSON, use default message
        }
        // Fall back to Retry-After header for rate-limit signals
        if (response.status === 429 && retryAfter === undefined) {
            const headerVal = response.headers.get('Retry-After');
            if (headerVal) {
                const parsed = parseInt(headerVal, 10);
                if (!Number.isNaN(parsed))
                    retryAfter = parsed;
            }
        }
        // Broadcast rate-limit info to any UI listeners (e.g. RateLimitBanner)
        if (response.status === 429 && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('mi:rate-limit', {
                detail: { retryAfter: retryAfter ?? 60, message, code },
            }));
        }
        throw new ApiRequestError(response.status, message, code);
    }
    // Handle 204 No Content
    if (response.status === 204) {
        return undefined;
    }
    return response.json();
}
// ── Public API Methods ─────────────────────────────────────────
/** Start the agent pipeline for a ticket with optional mode */
export async function startAgent(ticket, mode) {
    return apiFetch('/api/start', {
        method: 'POST',
        body: JSON.stringify({ ticket, ...(mode ? { mode } : {}) }),
    });
}
/** Get all pipeline summaries */
export async function getPipelines() {
    return apiFetch('/api/pipelines');
}
/** Delete a pipeline (state + logs) */
export async function deletePipeline(ticket) {
    return apiFetch(`/api/pipeline/${encodeURIComponent(ticket)}`, {
        method: 'DELETE',
    });
}
/** Stop the running agent for a ticket */
export async function stopAgent(ticket) {
    return apiFetch('/api/stop', {
        method: 'POST',
        body: JSON.stringify({ ticket }),
    });
}
/** Get the current pipeline state (unwraps backend metadata envelope) */
export async function getState(ticket) {
    const query = ticket ? `?ticket=${encodeURIComponent(ticket)}` : '';
    return apiFetch(`/api/state${query}`);
}
/** Reset the agent state */
export async function resetAgent(ticket) {
    return apiFetch('/api/reset', {
        method: 'POST',
        body: JSON.stringify({ ticket }),
    });
}
/** Approve a gate stage */
export async function approveGate(ticket, gate) {
    return apiFetch('/api/approve', {
        method: 'POST',
        body: JSON.stringify({ ticket, gate }),
    });
}
/** Reject a gate stage with reason */
export async function rejectGate(ticket, gate, reason) {
    return apiFetch('/api/reject', {
        method: 'POST',
        body: JSON.stringify({ ticket, gate, reason }),
    });
}
/** Get review data (diff, plan, QA results) for a gate */
export async function getReviewData(ticket) {
    const query = ticket ? `?ticket=${encodeURIComponent(ticket)}` : '';
    return apiFetch(`/api/review${query}`);
}
/** Post review decision with inline comments */
export async function postReviewDecision(ticket, decision, comments, feedback) {
    return apiFetch('/api/review-decision', {
        method: 'POST',
        body: JSON.stringify({ ticket, decision, comments, feedback }),
    });
}
/** Submit an inline review comment on a file/line (optionally a reply) */
export async function submitComment(ticket, file, line, body, parentId) {
    return apiFetch('/api/comments', {
        method: 'POST',
        body: JSON.stringify({ ticket, file, line, body, parentId }),
    });
}
/**
 * Skip the current stage. Backend sanitizer requires `confirm: true`; the UI
 * already confirms via modal, so we always pass `confirm: true` here.
 */
export async function skipStage(ticket) {
    return apiFetch('/api/skip-stage', {
        method: 'POST',
        body: JSON.stringify({ ticket, confirm: true }),
    });
}
/** Inject additional context into the running agent */
export async function injectContext(ticket, context) {
    return apiFetch('/api/inject-context', {
        method: 'POST',
        body: JSON.stringify({ ticket, context }),
    });
}
/** Fetch on-disk log archive (agent-{TICKET}.log) */
export async function getLogFile(ticket, tail = 200) {
    const query = `?ticket=${encodeURIComponent(ticket)}&tail=${encodeURIComponent(String(tail))}`;
    return apiFetch(`/api/logs-file${query}`);
}
/** Submit plan/review refinement instructions tied to the active gate. */
export async function submitRefine(ticket, gate, instructions) {
    return apiFetch('/api/refine', {
        method: 'POST',
        body: JSON.stringify({ ticket, gate, instructions }),
    });
}
/** Health check */
export async function getHealth() {
    return apiFetch('/api/health');
}
/** Get SSE connection stats */
export async function getSSEStats() {
    return apiFetch('/api/sse-stats');
}
/** Get the current agent configuration */
export async function getConfig() {
    return apiFetch('/api/config');
}
/**
 * Save agent configuration.
 * Backend expects `{ values: { KEY: value, ... } }`. Masked sensitive values
 * (those starting with "****") are dropped server-side.
 */
export async function saveConfig(values) {
    return apiFetch('/api/config/save', {
        method: 'POST',
        body: JSON.stringify({ values }),
    });
}
/** Test a service connection (jira, gitlab, slack) */
export async function testConnection(service) {
    return apiFetch('/api/config/test', {
        method: 'POST',
        body: JSON.stringify({ service }),
    });
}
/** Get notification routing configuration */
export async function getNotificationConfig() {
    return apiFetch('/api/notification-config');
}
/** Save notification routing configuration */
export async function saveNotificationConfig(config) {
    return apiFetch('/api/notification-config', {
        method: 'POST',
        body: JSON.stringify({ config }),
    });
}
