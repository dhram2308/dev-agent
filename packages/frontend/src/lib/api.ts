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

    try {
      const body = await response.json();
      if (body.error) message = body.error;
      if (body.code) code = body.code;
    } catch {
      // Response body not JSON, use default message
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

/** Get the current pipeline state */
export async function getState(ticket?: string): Promise<PipelineState | null> {
  const query = ticket ? `?ticket=${encodeURIComponent(ticket)}` : '';
  return apiFetch(`/api/state${query}`);
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
  return apiFetch('/api/review/decision', {
    method: 'POST',
    body: JSON.stringify({ ticket, decision, comments, feedback }),
  });
}

/** Skip the current stage */
export async function skipStage(ticket?: string): Promise<{ ok: boolean }> {
  return apiFetch('/api/skip', {
    method: 'POST',
    body: JSON.stringify({ ticket }),
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

/** Submit plan refinement instructions */
export async function submitRefine(
  ticket: string,
  instructions: string,
): Promise<{ ok: boolean }> {
  return apiFetch('/api/refine', {
    method: 'POST',
    body: JSON.stringify({ ticket, instructions }),
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
