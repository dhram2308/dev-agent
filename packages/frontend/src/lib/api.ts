// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Typed API Client
// ═══════════════════════════════════════════════════════════════

import type { ApiError, PipelineState, PipelineSummary, ReviewData } from '../types';

// API token: injected by the backend at page load or via env var in dev
let apiToken: string = '';

/** Initialize the API token from page load or dev environment */
export function setApiToken(token: string): void {
  apiToken = token;
}

/** Get the current API token */
export function getApiToken(): string {
  return apiToken;
}

// ── Internal fetch wrapper ─────────────────────────────────────

class ApiRequestError extends Error implements ApiError {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
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
    let code: string | undefined;
    let retryAfter: number | undefined;

    try {
      const body = await response.json();
      if (body.error) message = body.error;
      if (body.code) code = body.code;
      if (typeof body.retryAfter === 'number') retryAfter = body.retryAfter;
    } catch {
      // Response body not JSON, use default message
    }

    // Fall back to Retry-After header for rate-limit signals
    if (response.status === 429 && retryAfter === undefined) {
      const headerVal = response.headers.get('Retry-After');
      if (headerVal) {
        const parsed = parseInt(headerVal, 10);
        if (!Number.isNaN(parsed)) retryAfter = parsed;
      }
    }

    // Broadcast rate-limit info to any UI listeners (e.g. RateLimitBanner)
    if (response.status === 429 && typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('mi:rate-limit', {
          detail: { retryAfter: retryAfter ?? 60, message, code },
        }),
      );
    }

    throw new ApiRequestError(response.status, message, code);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

// ── Public API Methods ─────────────────────────────────────────

/** Start the agent pipeline for a ticket with optional mode */
export async function startAgent(
  ticket: string,
  mode?: 'resume' | 'fresh',
): Promise<{ ok: boolean; message?: string; error?: string; expired?: boolean }> {
  return apiFetch('/api/start', {
    method: 'POST',
    body: JSON.stringify({ ticket, ...(mode ? { mode } : {}) }),
  });
}

/** Get all pipeline summaries */
export async function getPipelines(): Promise<{ ok: boolean; pipelines: PipelineSummary[] }> {
  return apiFetch('/api/pipelines');
}

/** Delete a pipeline (state + logs) */
export async function deletePipeline(ticket: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/pipeline/${encodeURIComponent(ticket)}`, {
    method: 'DELETE',
  });
}

/** Stop the running agent for a ticket */
export async function stopAgent(ticket?: string): Promise<{ ok: boolean }> {
  return apiFetch('/api/stop', {
    method: 'POST',
    body: JSON.stringify({ ticket }),
  });
}

/** Response shape from GET /api/state (backend wraps PipelineState in metadata) */
interface StateResponse {
  running: boolean;
  state: PipelineState | null;
  logCount: number;
  health: { alive: boolean; reason?: string };
  stuck: boolean;
  stuckMinutes: number;
  _completedGates: string[] | null;
  activeAgents: string[];
}

/** Get the current pipeline state (unwraps backend metadata envelope) */
export async function getState(ticket?: string): Promise<StateResponse | null> {
  const query = ticket ? `?ticket=${encodeURIComponent(ticket)}` : '';
  return apiFetch<StateResponse>(`/api/state${query}`);
}

/** Reset the agent state */
export async function resetAgent(ticket?: string): Promise<{ ok: boolean }> {
  return apiFetch('/api/reset', {
    method: 'POST',
    body: JSON.stringify({ ticket }),
  });
}

/** Approve a gate stage */
export async function approveGate(
  ticket: string,
  gate: string,
): Promise<{ ok: boolean }> {
  return apiFetch('/api/approve', {
    method: 'POST',
    body: JSON.stringify({ ticket, gate }),
  });
}

/** Reject a gate stage with reason */
export async function rejectGate(
  ticket: string,
  gate: string,
  reason: string,
): Promise<{ ok: boolean }> {
  return apiFetch('/api/reject', {
    method: 'POST',
    body: JSON.stringify({ ticket, gate, reason }),
  });
}

/** Submit answers to Architect-raised clarifying questions. */
export async function answerQuestions(
  ticket: string,
  answers: Array<{ id: string; choice: number }>,
  via: 'user' | 'ai-default' = 'user',
): Promise<{ ok: boolean; remaining?: number; error?: string }> {
  return apiFetch('/api/answer-questions', {
    method: 'POST',
    body: JSON.stringify({ ticket, answers, via }),
  });
}

/** Get review data (diff, plan, QA results) for a gate */
export async function getReviewData(ticket?: string): Promise<ReviewData | null> {
  const query = ticket ? `?ticket=${encodeURIComponent(ticket)}` : '';
  return apiFetch(`/api/review${query}`);
}

/** Post review decision with inline comments */
export async function postReviewDecision(
  ticket: string,
  decision: 'approve' | 'reject',
  comments?: Array<{ file: string; line: number; body: string }>,
  feedback?: string,
): Promise<{ ok: boolean }> {
  return apiFetch('/api/review-decision', {
    method: 'POST',
    body: JSON.stringify({ ticket, decision, comments, feedback }),
  });
}

/** Submit an inline review comment on a file/line (optionally a reply) */
export async function submitComment(
  ticket: string,
  file: string,
  line: number,
  body: string,
  parentId?: string,
): Promise<{ ok: boolean }> {
  return apiFetch('/api/comments', {
    method: 'POST',
    body: JSON.stringify({ ticket, file, line, body, parentId }),
  });
}

/**
 * Skip the current stage. Backend sanitizer requires `confirm: true`; the UI
 * already confirms via modal, so we always pass `confirm: true` here.
 */
export async function skipStage(ticket?: string): Promise<{ ok: boolean }> {
  return apiFetch('/api/skip-stage', {
    method: 'POST',
    body: JSON.stringify({ ticket, confirm: true }),
  });
}

/** Inject additional context into the running agent */
export async function injectContext(
  ticket: string,
  context: string,
): Promise<{ ok: boolean }> {
  return apiFetch('/api/inject-context', {
    method: 'POST',
    body: JSON.stringify({ ticket, context }),
  });
}

/** Fetch on-disk log archive (agent-{TICKET}.log) */
export async function getLogFile(
  ticket: string,
  tail: number = 200,
): Promise<{ lines: string[]; total: number }> {
  const query = `?ticket=${encodeURIComponent(ticket)}&tail=${encodeURIComponent(String(tail))}`;
  return apiFetch(`/api/logs-file${query}`);
}

/** Submit plan/review refinement instructions tied to the active gate. */
export async function submitRefine(
  ticket: string,
  gate: string,
  instructions: string,
): Promise<{ ok: boolean }> {
  return apiFetch('/api/refine', {
    method: 'POST',
    body: JSON.stringify({ ticket, gate, instructions }),
  });
}

/** Health check */
export async function getHealth(): Promise<{ status: string; uptime: number }> {
  return apiFetch('/api/health');
}

/** Get SSE connection stats */
export async function getSSEStats(): Promise<{ connections: number }> {
  return apiFetch('/api/sse-stats');
}

// ── Settings API Methods ──────────────────────────────────────

/** One config item as returned by GET /api/config */
export interface ConfigItem {
  key: string;
  env: string;
  type: string;
  value: string;
  default: string;
  required: boolean;
  sensitive: boolean;
  group: string;
  description: string;
  hotReload: boolean;
  allowed: string[] | null;
}

/** Get the current agent configuration */
export async function getConfig(): Promise<{ ok: boolean; items: ConfigItem[] }> {
  return apiFetch('/api/config');
}

/**
 * Save agent configuration.
 * Backend expects `{ values: { KEY: value, ... } }`. Masked sensitive values
 * (those starting with "****") are dropped server-side.
 */
export async function saveConfig(values: Record<string, string>): Promise<{ ok: boolean; saved?: number }> {
  return apiFetch('/api/config/save', {
    method: 'POST',
    body: JSON.stringify({ values }),
  });
}

/** Test a service connection (jira, gitlab, slack) */
export async function testConnection(
  service: string,
): Promise<{ ok: boolean; message: string }> {
  return apiFetch('/api/config/test', {
    method: 'POST',
    body: JSON.stringify({ service }),
  });
}

/** Get notification routing configuration */
export async function getNotificationConfig(): Promise<{ ok: boolean; config: Record<string, Record<string, boolean>> }> {
  return apiFetch('/api/notification-config');
}

/** Save notification routing configuration */
export async function saveNotificationConfig(
  config: Record<string, Record<string, boolean>>,
): Promise<{ ok: boolean }> {
  return apiFetch('/api/notification-config', {
    method: 'POST',
    body: JSON.stringify({ config }),
  });
}
