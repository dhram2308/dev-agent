// ═══════════════════════════════════════════════════════════════
// server/routes.ts — HTTP API route handler
// Converted from: server/routes.js (975 lines)
// ═══════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';

const { checkRateLimit } = require('./rate-limiter') as { checkRateLimit: (ip: string) => boolean };
const { addLog, broadcast, getLogBuffer, getSseClients, addSseClient, removeSseClient, registerClient, getSSEStats, clearTicketLogs } = require('./sse') as {
  addLog: (line: string, type: string, ticket: string) => void;
  broadcast: (event: string, data: any) => void;
  getLogBuffer: () => any[];
  getSseClients: () => ServerResponse[];
  addSseClient: (res: ServerResponse) => void;
  removeSseClient: (res: ServerResponse) => void;
  registerClient: (res: ServerResponse, req: IncomingMessage, url: URL, apiToken: string) => any;
  getSSEStats: () => any;
  clearTicketLogs: (ticket: string) => void;
};
const { getState, writeStateAsync, readStateAsync, saveReviewComments, getReviewComments, patchUIAsync, updateAsync } = require('./state-io') as {
  getState: (ticket: string) => any;
  writeStateAsync: (ticket: string, state: any) => Promise<void>;
  readStateAsync: (ticket: string) => Promise<any>;
  saveReviewComments: (ticket: string, comments: any) => Promise<boolean>;
  getReviewComments: (ticket: string) => any;
  patchUIAsync: (ticket: string, gate: string, patch: any) => Promise<void>;
  updateAsync: (ticket: string, mutator: (state: any) => Promise<any>) => Promise<any>;
};
const { startAgent, stopAgent, checkProcessHealth, getAgentProcs, STAGE_DATA_MAP } = require('./agent-process') as {
  startAgent: (ticket: string) => any;
  stopAgent: (ticket?: string | null) => any;
  checkProcessHealth: (ticket: string) => any;
  getAgentProcs: () => Record<string, any>;
  STAGE_DATA_MAP: Record<string, readonly string[]>;
};

// ── Resilience modules (safe require -- each may not exist yet) ──
// Security: input sanitization + safe body parsing
let validateTicketSec: any, validateGateSec: any, validateStageSec: any, parseBodySafe: any, sanitizeSec: any, ENDPOINT_SCHEMAS: any, ENDPOINT_SIZE_LIMITS: any;
try {
  const security = require('../lib/security');
  validateTicketSec = security.validateTicket;
  validateGateSec = security.validateGate;
  validateStageSec = security.validateStage;
  parseBodySafe = security.parseBodySafe;
  sanitizeSec = security.sanitize;
  ENDPOINT_SCHEMAS = security.ENDPOINT_SCHEMAS;
  ENDPOINT_SIZE_LIMITS = security.ENDPOINT_SIZE_LIMITS;
} catch { validateTicketSec = null; validateGateSec = null; validateStageSec = null; parseBodySafe = null; sanitizeSec = null; ENDPOINT_SCHEMAS = null; ENDPOINT_SIZE_LIMITS = null; }

// Health monitor: service health for enhanced /api/health
let getServiceHealth: (() => any) | null;
try {
  getServiceHealth = require('../lib/health-monitor').getServiceHealth;
} catch { getServiceHealth = null; }

// Notification audit: for /api/notification-audit endpoint
let getAuditLog: (() => any[]) | null, getAuditSummary: (() => any) | null;
try {
  const audit = require('../lib/notification-audit');
  getAuditLog = audit.getAuditLog;
  getAuditSummary = audit.getAuditSummary;
} catch { getAuditLog = null; getAuditSummary = null; }

// Escalation: for /api/escalations endpoint
let getEscalationLog: (() => any[]) | null, getActiveEscalations: (() => any[]) | null;
try {
  const esc = require('../lib/escalation');
  getEscalationLog = esc.getEscalationLog;
  getActiveEscalations = esc.getActiveEscalations;
} catch { getEscalationLog = null; getActiveEscalations = null; }

// Slack health: for enhanced health endpoint
let getSlackHealth: (() => any) | null;
try {
  getSlackHealth = require('../lib/slack').getSlackHealth;
} catch { getSlackHealth = null; }

// Config schema: for /api/config endpoints
const { CONFIG_SCHEMA } = require('../lib/config-schema') as { CONFIG_SCHEMA: Record<string, any> };

// Notification config: for /api/notification-config endpoints
let loadNotificationConfig: () => any, saveNotificationConfig: (config: any) => void;
try {
  const nc = require('../lib/notification-config');
  loadNotificationConfig = nc.loadNotificationConfig;
  saveNotificationConfig = nc.saveNotificationConfig;
} catch { loadNotificationConfig = () => ({}); saveNotificationConfig = () => {}; }

// Navigate to project root: at runtime __dirname is packages/agent/dist/server/
const BASE_DIR = path.resolve(__dirname, '..', '..', '..', '..');

// O7: Stage skip requires env var opt-in
const ALLOW_STAGE_SKIP = process.env.ALLOW_STAGE_SKIP === "true";

// F12: Path traversal guard — validate ticket params
// Uses security module's validateTicket when available, falls back to basic regex
function safeTicket(t: string | null): string | null {
  if (validateTicketSec) return validateTicketSec(t);
  const s = (t || "").trim();
  if (!/^[A-Za-z]+-\d+$/.test(s)) return null;
  return s;
}

// Gate parameter sanitization — whitelist valid gate names
function safeGate(g: string | null): string | null {
  if (validateGateSec) return validateGateSec(g);
  const s = (g || "").trim();
  const valid = new Set(["explore_plan", "gate_code_review", "deploy_qa", "gate_preprod_approval", "gate_dual_approval"]);
  return valid.has(s) ? s : null;
}

// Stage parameter sanitization — whitelist valid stage names
function safeStage(s: string | null): string | null {
  if (validateStageSec) return validateStageSec(s);
  const st = (s || "").trim();
  return (STAGE_DATA_MAP as any)[st] !== undefined ? st : null;
}

// Parse POST body helper — delegates to security module's parseBodySafe when available
// parseBodySafe adds: prototype pollution guard via safeJsonParse, proper chunk buffering
function parseBody(request: IncomingMessage, maxSize: number = 1_048_576): Promise<any> {
  if (parseBodySafe) return parseBodySafe(request, maxSize);
  // Fallback: basic parser (for envs where security module isn't loaded)
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (c: Buffer) => {
      body += c;
      if (body.length > maxSize) { request.destroy(); reject(new Error("Payload too large")); }
    });
    request.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch (e) { reject(e); }
    });
  });
}

// Sanitize parsed body against endpoint schema — returns sanitized object or throws
function sanitizeBody(pathname: string, body: any): any {
  if (!sanitizeSec || !ENDPOINT_SCHEMAS || !ENDPOINT_SCHEMAS[pathname]) return body;
  return sanitizeSec(body, ENDPOINT_SCHEMAS[pathname]);
}

// Get per-endpoint body size limit
function getBodySizeLimit(pathname: string): number {
  if (!ENDPOINT_SIZE_LIMITS) return 1_048_576;
  return ENDPOINT_SIZE_LIMITS[pathname] || ENDPOINT_SIZE_LIMITS.default || 1_048_576;
}

/**
 * Handle all API routes for the server.
 */
async function handleRequest(
  url: URL,
  request: IncomingMessage,
  res: ServerResponse,
  apiToken: string,
  html: string,
): Promise<boolean> {

  // S12: Rate limiting for API routes
  if (url.pathname.startsWith("/api/")) {
    const clientIp = (request.socket as any).remoteAddress || "unknown";
    if (!checkRateLimit(clientIp)) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
      res.end(JSON.stringify({ error: "Rate limit exceeded. Max 60 requests per minute." }));
      return true;
    }
  }

  // T1.8: Auth token check on ALL /api/ requests (GET and POST)
  if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health") {
    const token = (request.headers as any)["x-api-token"] || url.searchParams.get("token");
    if (token !== apiToken) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden: invalid or missing API token" }));
      return true;
    }
  }

  // ── POST /api/start ──
  if (url.pathname === "/api/start" && request.method === "POST") {
    try {
      const raw = await parseBody(request, getBodySizeLimit("/api/start"));
      const { ticket } = sanitizeBody("/api/start", raw);
      const t = safeTicket(ticket);
      if (!t) {
        res.writeHead(400, {"Content-Type":"application/json"});
        res.end(JSON.stringify({ ok: false, error: "Valid ticket ID required (e.g. AUT-1234)" }));
        return true;
      }
      const result = startAgent(t);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e: any) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // ── POST /api/stop ──
  if (url.pathname === "/api/stop" && request.method === "POST") {
    try {
      const raw = await parseBody(request, getBodySizeLimit("/api/stop"));
      const parsed = sanitizeBody("/api/stop", raw);
      const t = parsed.ticket ? safeTicket(parsed.ticket) : null;
      // t can be null for legacy "stop any" behavior, but if ticket provided it must be valid
      if (parsed.ticket && !t) {
        res.writeHead(400, {"Content-Type":"application/json"});
        res.end(JSON.stringify({ ok: false, error: "Invalid ticket format" }));
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(stopAgent(t)));
    } catch (e: any) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // ── GET /api/state ──
  if (url.pathname === "/api/state") {
    const ticket = safeTicket(url.searchParams.get("ticket"));
    if (!ticket) { res.writeHead(400, {"Content-Type":"application/json"}); res.end('{"error":"Invalid ticket format"}'); return true; }
    const state = getState(ticket);
    const agentProcs = getAgentProcs();
    const health = checkProcessHealth(ticket);
    if (!health.alive && agentProcs[ticket]) {
      addLog(`Agent for ${ticket} detected as unhealthy (${health.reason}), cleaning up`, "system", ticket);
      delete agentProcs[ticket];
    }
    const completedGates = (state && state.data && state.data._completedGates) || null;
    let stuck = false;
    let stuckMinutes = 0;
    if (state && state.data && state.data._lastActivity && agentProcs[ticket]) {
      const stuckDuration = Date.now() - new Date(state.data._lastActivity).getTime();
      stuckMinutes = Math.floor(stuckDuration / 60000);
      if (stuckDuration > 10 * 60 * 1000) stuck = true;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      running: !!agentProcs[ticket],
      state,
      logCount: getLogBuffer().length,
      health,
      stuck,
      stuckMinutes,
      _completedGates: completedGates,
      activeAgents: Object.keys(agentProcs),
    }));
    return true;
  }

  // ── GET /api/logs (SSE) — Robust connection with auth, replay, backpressure ──
  if (url.pathname === "/api/logs" || url.pathname === "/events") {
    // registerClient handles: auth, limits, LRU eviction, headers,
    // replay from Last-Event-ID, keepalive, backpressure, cleanup
    registerClient(res, request, url, apiToken);
    return true;
  }

  // ── GET /api/sse-stats — SSE diagnostics ──
  if (url.pathname === "/api/sse-stats" && request.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getSSEStats()));
    return true;
  }

  // ── POST /api/reset ──
  if (url.pathname === "/api/reset" && request.method === "POST") {
    try {
      const rawBody = await parseBody(request, getBodySizeLimit("/api/reset"));
      const { ticket } = sanitizeBody("/api/reset", rawBody);
      const t = safeTicket(ticket);
      if (!t) { res.writeHead(400, {"Content-Type":"application/json"}); res.end(JSON.stringify({ok:false, error:"Valid ticket ID required"})); return true; }
      const f = path.join(BASE_DIR, `state-${t}.json`);
      const agentProcs = getAgentProcs();
      const runningProc = agentProcs[t];
      if (runningProc && (runningProc as any).exitCode === null) {
        (runningProc as any).kill("SIGTERM");
        setTimeout(() => { try { if (agentProcs[t] && (agentProcs[t] as any).exitCode === null) (agentProcs[t] as any).kill("SIGKILL"); } catch {} }, 5000);
      }
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e: any) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // ── GET /api/review ──
  if (url.pathname === "/api/review") {
    const ticket = safeTicket(url.searchParams.get("ticket"));
    if (!ticket) { res.writeHead(400, {"Content-Type":"application/json"}); res.end('{"error":"Invalid ticket format"}'); return true; }
    const state = getState(ticket);
    if (!state) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ gate: null }));
      return true;
    }
    const d: any = state.data || {};
    const result: any = { gate: null };

    if (state.stage === "explore_plan" && d.explore_plan_posted) {
      result.gate = "explore_plan";
      result.plan = d.explore_plan || "";
      result.agents = d.explore_agents || {};
      result.openspec = d.explore_openspec || null;
    } else if (state.stage === "gate_code_review" && d.code_mr_iid) {
      result.gate = "gate_code_review";
      result.changes = (d.codeChanges && d.codeChanges.changes) || [];
      result.summary = (d.codeChanges && d.codeChanges.summary) || "";
      result.test_notes = (d.codeChanges && d.codeChanges.test_notes) || "";
      result.original_files = d.original_files || {};
      result.mr_url = d.code_mr_url || "";
      result.unit_tests = d._unit_tests_complete || null;
      result.unit_tests_count = d._unit_tests_count || null;
      result.e2e_tests = d._e2e_tests_complete || null;
      result.e2e_tests_count = d._e2e_tests_count || null;
      result.e2e_console_errors = d._e2e_console_errors || null;
    } else if (state.stage === "deploy_qa" && d.deploy_qa_posted) {
      result.gate = "deploy_qa";
      result.changes = (d.codeChanges && d.codeChanges.changes) || [];
      result.summary = (d.codeChanges && d.codeChanges.summary) || "";
      result.test_notes = (d.codeChanges && d.codeChanges.test_notes) || "";
      result.original_files = d.original_files || {};
      result.mr_url = d.code_mr_url || "";
    } else if (state.stage === "gate_preprod_approval" && d.gate2a_posted) {
      result.gate = "gate_preprod_approval";
      result.qa_test = d.qa_test || [];
      result.mr_url = d.code_mr_url || "";
    } else if (state.stage === "gate_dual_approval" && d.gate2b_posted) {
      result.gate = "gate_dual_approval";
      result.preprod_mr_url = d.preprod_mr_url || "";
      result.summary = (d.codeChanges && d.codeChanges.summary) || "";
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return true;
  }

  // ── GET /api/changes ──
  // Durable diff-data surface for the Write Code stage card.
  // Picks the best available source (live/state/git/none) so the UI can
  // render the same DiffViewer across running, post-run, cached-resume, and
  // past-gate contexts without stage-gated branches.
  if (url.pathname === "/api/changes") {
    const ticket = safeTicket(url.searchParams.get("ticket"));
    if (!ticket) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid ticket format" }));
      return true;
    }

    const now = Date.now();
    const state = getState(ticket);
    if (!state) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ source: "none", changes: [], summary: "", original_files: {}, ts: now, reason: "no_state" }));
      return true;
    }

    try {
      const d: any = state.data || {};
      const { cfg } = require("../lib/config") as { cfg: { localRepo: string | null } };

      const liveActive = state.stage === "generate_code" && !!d._active_team;
      const hasStateChanges = Array.isArray(d.codeChanges?.changes) && d.codeChanges.changes.length > 0;

      if (liveActive && cfg.localRepo) {
        const { buildLiveSnapshot } = require("../lib/agents-team") as {
          buildLiveSnapshot: (cwd: string, ticket: string, team: string, activeAgents: string[]) => import("@mi/shared").CodegenLivePayload;
        };
        const rawAgents: unknown = d._active_agents || [];
        const activeAgents: string[] = Array.isArray(rawAgents)
          ? rawAgents.map((a: any) => (typeof a === "string" ? a : a?.name)).filter((n: any) => typeof n === "string")
          : [];
        const snap = buildLiveSnapshot(cfg.localRepo, ticket, (d._active_team as string) || "Developer Team", activeAgents);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          source: "live",
          changes: snap.changes,
          summary: d.codeChanges?.summary || "",
          original_files: snap.original_files,
          ts: now,
        }));
        return true;
      }

      if (hasStateChanges) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          source: "state",
          changes: d.codeChanges.changes,
          summary: d.codeChanges.summary || "",
          original_files: d.original_files || {},
          ts: now,
        }));
        return true;
      }

      if (cfg.localRepo) {
        const { localGetChanges, localGetOriginal } = require("../lib/local-repo") as {
          localGetChanges: (cwd: string) => Array<{ action: string; file_path: string; content: string }>;
          localGetOriginal: (cwd: string, filePath: string) => string | null;
        };
        const SENSITIVE = /^(\.env(\..*)?|\.api-token|\.state-secret|\.debug)$/;
        const raw = localGetChanges(cfg.localRepo);
        const filtered = raw.filter((c) => !SENSITIVE.test(c.file_path));
        if (filtered.length > 0) {
          const originals: Record<string, string> = {};
          for (const c of filtered) {
            if (c.action !== "update") continue;
            const orig = localGetOriginal(cfg.localRepo, c.file_path);
            if (orig !== null) originals[c.file_path] = orig;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            source: "git",
            changes: filtered,
            summary: "",
            original_files: originals,
            ts: now,
          }));
          return true;
        }
      }

      const reason = cfg.localRepo ? "no_changes_yet" : "no_local_repo";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ source: "none", changes: [], summary: "", original_files: {}, ts: now, reason }));
    } catch (e: any) {
      const msg = (e?.message || "unknown error").substring(0, 500);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ source: "none", changes: [], summary: "", original_files: {}, ts: now, reason: "error", error: msg }));
    }
    return true;
  }

  // ── GET /api/codegen/live ──
  // One-shot snapshot for the frontend to hydrate its live-codegen store when
  // the user opens the UI mid-codegen. SSE is authoritative for subsequent
  // updates; this endpoint just catches the first-mount window.
  if (url.pathname === "/api/codegen/live") {
    const ticket = safeTicket(url.searchParams.get("ticket"));
    if (!ticket) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid ticket format" }));
      return true;
    }

    const state = getState(ticket);
    if (!state) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ live: false, reason: "no_state" }));
      return true;
    }

    if (state.stage !== "generate_code") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ live: false, reason: "not_generating" }));
      return true;
    }

    // Pull cfg + buildLiveSnapshot lazily (routes.ts may not already import them)
    const { cfg } = require("../lib/config") as {
      cfg: { localRepo: string | null };
    };

    if (!cfg.localRepo) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ live: false, reason: "no_local_repo" }));
      return true;
    }

    try {
      const { buildLiveSnapshot } = require("../lib/agents-team") as {
        buildLiveSnapshot: (
          cwd: string,
          ticket: string,
          team: string,
          activeAgents: string[],
        ) => import("@mi/shared").CodegenLivePayload;
      };
      const rawAgents: unknown = (state.data as any)._active_agents || [];
      const activeAgents: string[] = Array.isArray(rawAgents)
        ? rawAgents.map((a: any) => (typeof a === 'string' ? a : a?.name)).filter((n: any) => typeof n === 'string')
        : [];
      const teamName: string = ((state.data as any)._active_team as string) || "Developer Team";
      const snapshot = buildLiveSnapshot(cfg.localRepo, ticket, teamName, activeAgents);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ live: true, ...snapshot }));
    } catch (e: any) {
      const msg = (e?.message || "unknown error").substring(0, 500);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ live: false, error: msg }));
    }
    return true;
  }

  // ── GET /api/agents/progress ──
  // Hydration endpoint for the AgentSwimLanes frontend store. Mirrors
  // /api/codegen/live shape (one-shot snapshot; SSE is authoritative for
  // updates). Returns active + history arrays so a mid-run page refresh can
  // reconstruct lanes before the first `agent:progress` event arrives.
  if (url.pathname === "/api/agents/progress") {
    const ticket = safeTicket(url.searchParams.get("ticket"));
    if (!ticket) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid ticket format" }));
      return true;
    }

    const state = getState(ticket);
    if (!state) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "ticket not found" }));
      return true;
    }

    const d: any = state.data || {};
    const rawActive: unknown = d._active_agents || [];
    const active = Array.isArray(rawActive)
      ? rawActive.map((a: any) =>
          typeof a === 'string'
            ? { name: a, team: '', startedAt: 0, phase: 'running' }
            : a,
        )
      : [];
    const history = Array.isArray(d._agents_history) ? d._agents_history : [];
    const live = state.stage === "generate_code" && active.length > 0;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ live, active, history, ts: Date.now() }));
    return true;
  }

  // ── POST /api/approve ──
  // Uses patchUIAsync for atomic locked write with HMAC
  if (url.pathname === "/api/approve" && request.method === "POST") {
    try {
      const raw = await parseBody(request, getBodySizeLimit("/api/approve"));
      const { ticket, gate } = sanitizeBody("/api/approve", raw);
      const t = safeTicket(ticket);
      if (!t) { res.writeHead(400, {"Content-Type":"application/json"}); res.end('{"error":"Invalid ticket"}'); return true; }
      const g = safeGate(gate);
      if (!g) { res.writeHead(400, {"Content-Type":"application/json"}); res.end('{"error":"Invalid gate parameter"}'); return true; }
      await patchUIAsync(t, g, {
        "_ui_approved": true,
        "_ui_rejected": null,    // delete
        "_ui_feedback": null,    // delete
        "_ui_refine": null,      // delete
        "_ui_refine_instructions": null,  // delete
      });
      broadcast("review", { gate: g, action: "approved", ticket: t });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e: any) {
      const status = e.message.includes("no state file") ? 404 : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // ── POST /api/reject ──
  // Uses patchUIAsync for atomic locked write with HMAC
  if (url.pathname === "/api/reject" && request.method === "POST") {
    try {
      const raw = await parseBody(request, getBodySizeLimit("/api/reject"));
      const { ticket, gate, feedback } = sanitizeBody("/api/reject", raw);
      const t = safeTicket(ticket);
      if (!t) { res.writeHead(400, {"Content-Type":"application/json"}); res.end('{"error":"Invalid ticket"}'); return true; }
      const g = safeGate(gate);
      if (!g) { res.writeHead(400, {"Content-Type":"application/json"}); res.end('{"error":"Invalid gate parameter"}'); return true; }
      await patchUIAsync(t, g, {
        "_ui_rejected": true,
        "_ui_feedback": feedback || "",
        "_ui_approved": null,    // delete
        "_ui_refine": null,      // delete
        "_ui_refine_instructions": null,  // delete
      });
      broadcast("review", { gate: g, action: "rejected", feedback, ticket: t });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e: any) {
      const status = e.message.includes("no state file") ? 404 : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // ── POST /api/refine ──
  // Uses patchUIAsync for atomic locked write with HMAC
  if (url.pathname === "/api/refine" && request.method === "POST") {
    try {
      const raw = await parseBody(request, getBodySizeLimit("/api/refine"));
      const { ticket, gate, instructions } = sanitizeBody("/api/refine", raw);
      if (!instructions || typeof instructions !== "string" || instructions.trim().length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Refine instructions are required" }));
        return true;
      }
      const t = safeTicket(ticket);
      if (!t) { res.writeHead(400, {"Content-Type":"application/json"}); res.end('{"error":"Invalid ticket"}'); return true; }
      const g = safeGate(gate);
      if (!g) { res.writeHead(400, {"Content-Type":"application/json"}); res.end('{"error":"Invalid gate parameter"}'); return true; }
      await patchUIAsync(t, g, {
        "_ui_refine": true,
        "_ui_refine_instructions": instructions.trim(),
        "_ui_approved": null,    // delete
        "_ui_rejected": null,    // delete
        "_ui_feedback": null,    // delete
      });
      broadcast("review", { gate: g, action: "refine", instructions: instructions.trim(), ticket: t });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e: any) {
      const status = e.message.includes("no state file") ? 404 : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // ── GET /api/error ──
  if (url.pathname === "/api/error") {
    const ticket = safeTicket(url.searchParams.get("ticket"));
    if (!ticket) { res.writeHead(400, {"Content-Type":"application/json"}); res.end('{"error":"Invalid ticket"}'); return true; }
    const state = getState(ticket);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: state?.data?._lastError || null }));
    return true;
  }

  // ── POST /api/comments ──
  if (url.pathname === "/api/comments" && request.method === "POST") {
    try {
      const rawComments = await parseBody(request, getBodySizeLimit("/api/comments"));
      const { ticket, comments } = sanitizeBody("/api/comments", rawComments);
      const t = safeTicket(ticket);
      if (!t) { res.writeHead(400, {"Content-Type":"application/json"}); res.end('{"error":"Invalid ticket"}'); return true; }
      const ok = await saveReviewComments(t, comments || {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok }));
    } catch (e: any) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // ── GET /api/comments ──
  if (url.pathname === "/api/comments" && request.method === "GET") {
    const ticket = safeTicket(url.searchParams.get("ticket"));
    if (!ticket) { res.writeHead(400, {"Content-Type":"application/json"}); res.end('{"error":"Invalid ticket"}'); return true; }
    const comments = getReviewComments(ticket);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ comments }));
    return true;
  }

  // ── POST /api/skip-stage ──
  // Uses updateAsync for atomic locked read-modify-write with HMAC
  if (url.pathname === "/api/skip-stage" && request.method === "POST") {
    if (!ALLOW_STAGE_SKIP) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Stage skip disabled. Set ALLOW_STAGE_SKIP=true to enable." }));
      return true;
    }
    try {
      const rawSkip = await parseBody(request, getBodySizeLimit("/api/skip-stage"));
      const { ticket, confirm } = sanitizeBody("/api/skip-stage", rawSkip);
      if (!confirm) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Confirmation required: send confirm=true" }));
        return true;
      }
      const t = safeTicket(ticket);
      if (!t) { res.writeHead(400, {"Content-Type":"application/json"}); res.end('{"error":"Invalid ticket"}'); return true; }
      const updated = await updateAsync(t, async (state: any) => {
        state.data = state.data || {};
        state.data._force_advance = true;
        return state;
      });
      addLog(`[O7] Stage skip requested for ${t} (current stage: ${updated.stage})`, "system", t);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, stage: updated.stage }));
    } catch (e: any) {
      const status = e.message.includes("no state file") ? 404 : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // ── POST /api/reset-stage ──
  // Uses updateAsync for atomic locked read-modify-write with HMAC
  if (url.pathname === "/api/reset-stage" && request.method === "POST") {
    try {
      const rawReset = await parseBody(request, getBodySizeLimit("/api/reset-stage"));
      const { ticket, stage } = sanitizeBody("/api/reset-stage", rawReset);
      const t = safeTicket(ticket);
      if (!t) { res.writeHead(400, {"Content-Type":"application/json"}); res.end('{"error":"Invalid ticket"}'); return true; }
      // [Security] Sanitize stage parameter with whitelist
      const s = safeStage(stage);
      if (!s) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid stage. Valid: " + Object.keys(STAGE_DATA_MAP).join(", ") }));
        return true;
      }
      const fieldsToClear = (STAGE_DATA_MAP as any)[s] || [];
      await updateAsync(t, async (state: any) => {
        state.data = state.data || {};
        for (const field of fieldsToClear) {
          delete state.data[field];
        }
        state.stage = s;
        return state;
      });
      addLog(`[O8] Stage reset to '${s}' for ${t}, cleared ${fieldsToClear.length} fields`, "system", t);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, stage: s, clearedFields: fieldsToClear }));
    } catch (e: any) {
      const status = e.message.includes("no state file") ? 404 : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // ── GET /api/logs-file ──
  if (url.pathname === "/api/logs-file" && request.method === "GET") {
    const ticket = safeTicket(url.searchParams.get("ticket"));
    if (!ticket) { res.writeHead(400, {"Content-Type":"application/json"}); res.end('{"error":"Invalid ticket format"}'); return true; }
    const tail = Math.min(Math.max(parseInt(url.searchParams.get("tail") as string, 10) || 50, 1), 500);
    const logPath = path.join(BASE_DIR, `agent-${ticket}.log`);
    try {
      if (!fs.existsSync(logPath)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ lines: [], total: 0 }));
        return true;
      }
      const content = await fs.promises.readFile(logPath, "utf8");
      const allLines = content.split("\n").filter(Boolean);
      const total = allLines.length;
      const lines = allLines.slice(-tail);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ lines, total }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to read log file: " + e.message }));
    }
    return true;
  }

  // ── POST /api/answer-questions ──
  // Accepts user answers to Architect-raised clarifying questions.
  // Appends to state.data._qa_answers and removes answered entries
  // from state.data._pending_questions. Broadcasts a state event so
  // the UI re-enables the Approve button and hides answered rows.
  if (url.pathname === "/api/answer-questions" && request.method === "POST") {
    try {
      const rawAns = await parseBody(request, 10_000);
      const body: any = JSON.parse(rawAns.toString() || "{}");
      const t = safeTicket(body?.ticket);
      if (!t) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid ticket format" }));
        return true;
      }
      if (!Array.isArray(body?.answers) || body.answers.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "'answers' must be a non-empty array" }));
        return true;
      }
      for (const a of body.answers) {
        if (!a || typeof a !== "object" || typeof a.id !== "string" || typeof a.choice !== "number") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Each answer must be {id: string, choice: number}" }));
          return true;
        }
      }
      const via: "user" | "ai-default" = body?.via === "ai-default" ? "ai-default" : "user";

      let remaining = 0;
      let validationError: { code: number; message: string } | null = null;

      await updateAsync(t, async (state: any) => {
        state.data = state.data || {};
        const pending: any[] = Array.isArray(state.data._pending_questions) ? state.data._pending_questions : [];
        const answers: any[] = Array.isArray(state.data._qa_answers) ? state.data._qa_answers : [];

        // Validate every incoming answer against the current pending list.
        for (const a of body.answers) {
          const q = pending.find((p) => p.id === a.id);
          if (!q) {
            validationError = { code: 400, message: `Unknown question id: ${a.id}` };
            return state;
          }
          if (!Array.isArray(q.options) || a.choice < 0 || a.choice >= q.options.length) {
            validationError = {
              code: 400,
              message: `Choice out of range for '${a.id}': got ${a.choice}, have ${q.options?.length ?? 0} options`,
            };
            return state;
          }
        }

        const now = Date.now();
        const answeredIds = new Set<string>();
        for (const a of body.answers) {
          const q = pending.find((p) => p.id === a.id)!;
          answers.push({
            id: a.id,
            choice: a.choice,
            optionText: q.options[a.choice],
            via,
            ts: now,
          });
          answeredIds.add(a.id);
        }

        state.data._qa_answers = answers;
        state.data._pending_questions = pending.filter((p) => !answeredIds.has(p.id));
        remaining = state.data._pending_questions.length;
        return state;
      });

      if (validationError) {
        const err: { code: number; message: string } = validationError;
        res.writeHead(err.code, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
        return true;
      }

      // Re-read the freshly written state and broadcast it so every UI
      // client updates the pending-questions panel in real time.
      const updated = getState(t);
      if (updated) {
        broadcast("state", { ticket: t, stage: updated.stage, data: updated.data });
      }

      addLog(`[qa] ${body.answers.length} answer(s) applied for ${t} (remaining pending: ${remaining})`, "system", t);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, remaining }));
    } catch (e: any) {
      const status = e.message.includes("no state file") ? 404 : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // ── POST /api/inject-context ──
  // Uses updateAsync for atomic locked read-modify-write with HMAC
  if (url.pathname === "/api/inject-context" && request.method === "POST") {
    try {
      const rawCtx = await parseBody(request, getBodySizeLimit("/api/inject-context"));
      const { ticket, context } = sanitizeBody("/api/inject-context", rawCtx);
      const t = safeTicket(ticket);
      if (!t) { res.writeHead(400, {"Content-Type":"application/json"}); res.end('{"error":"Invalid ticket format"}'); return true; }
      if (!context || typeof context !== "string" || context.trim().length === 0) {
        res.writeHead(400, {"Content-Type":"application/json"});
        res.end(JSON.stringify({ ok: false, error: "Context text is required" }));
        return true;
      }
      if (context.length > 10000) {
        res.writeHead(400, {"Content-Type":"application/json"});
        res.end(JSON.stringify({ ok: false, error: "Context too long (max 10000 chars)" }));
        return true;
      }
      await updateAsync(t, async (state: any) => {
        state.data = state.data || {};
        state.data._injectedContext = { text: context.trim(), timestamp: new Date().toISOString() };
        return state;
      });
      addLog(`[O9] Context injected for ${t} (${context.trim().length} chars)`, "system", t);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e: any) {
      const status = e.message.includes("no state file") ? 404 : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // ── GET /api/health — Enhanced with service health, Slack, escalations ──
  if (url.pathname === "/api/health" && request.method === "GET") {
    const ticket = url.searchParams.get("ticket");
    const t = ticket ? safeTicket(ticket) : null;
    let currentStageVal: string | null = null;
    let lastActivityVal: string | null = null;
    let pipelineHealth: any = null;
    if (t) {
      const state = getState(t);
      if (state) {
        currentStageVal = state.stage || null;
        lastActivityVal = (state.data && state.data._lastActivity) || null;
        pipelineHealth = (state.data && state.data._health) || null;
      }
    }
    const agentProcs = getAgentProcs();
    const healthData: any = {
      pid: process.pid,
      uptime: process.uptime(),
      lastActivity: lastActivityVal,
      currentStage: currentStageVal,
      memoryUsage: process.memoryUsage(),
      tickets: Object.keys(agentProcs),
    };

    // [Health Monitor] Include service health (Jira, GitLab, Slack, Claude)
    if (getServiceHealth) {
      healthData.services = getServiceHealth();
    }

    // [Slack] Include Slack integration health
    if (getSlackHealth) {
      healthData.slack = getSlackHealth();
    }

    // [Escalation] Include active escalations
    if (getActiveEscalations) {
      healthData.escalations = getActiveEscalations();
    }

    // [Health Monitor] Include pipeline-level health from state
    if (pipelineHealth) {
      healthData.pipeline = pipelineHealth;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(healthData));
    return true;
  }

  // ── GET /api/test-artifacts ──
  if (url.pathname === "/api/test-artifacts" && request.method === "GET") {
    const ticket = safeTicket(url.searchParams.get("ticket"));
    if (!ticket) { res.writeHead(400, {"Content-Type":"application/json"}); res.end('{"error":"Invalid ticket format"}'); return true; }
    const artifactsDir = path.join(BASE_DIR, ".test-artifacts", ticket);
    const files: any[] = [];
    try {
      if (fs.existsSync(artifactsDir)) {
        const entries = fs.readdirSync(artifactsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            files.push({ name: entry.name, type: "file" });
          } else if (entry.isDirectory()) {
            try {
              const subEntries = fs.readdirSync(path.join(artifactsDir, entry.name));
              files.push({ name: entry.name, type: "directory", files: subEntries });
            } catch { files.push({ name: entry.name, type: "directory", files: [] }); }
          }
        }
      }
    } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ticket, files }));
    return true;
  }

  // ── GET /api/notification-audit — Notification audit trail ──
  if (url.pathname === "/api/notification-audit" && request.method === "GET") {
    if (getAuditLog && getAuditSummary) {
      const response = {
        summary: getAuditSummary(),
        log: getAuditLog(),
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ summary: null, log: [], message: "Notification audit module not loaded" }));
    }
    return true;
  }

  // ── GET /api/escalations — Active escalations and history ──
  if (url.pathname === "/api/escalations" && request.method === "GET") {
    const response = {
      active: getActiveEscalations ? getActiveEscalations() : [],
      log: getEscalationLog ? getEscalationLog() : [],
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return true;
  }

  // ── GET /api/tickets — Overview of all active tickets ──
  if (url.pathname === "/api/tickets" && request.method === "GET") {
    const { STAGES } = require('../lib/constants') as { STAGES: readonly string[] };
    const GATE_STAGES = new Set(["gate_code_review", "gate_preprod_approval", "gate_dual_approval", "explore_plan"]);
    const agentProcs = getAgentProcs();
    const tickets: any[] = [];

    // Iterate all running agent tickets
    for (const ticket of Object.keys(agentProcs)) {
      const state = getState(ticket);
      const stage = (state && state.stage) || "unknown";
      const stageIndex = (STAGES as readonly string[]).indexOf(stage);
      const progress = stageIndex >= 0 ? parseFloat((stageIndex / STAGES.length).toFixed(2)) : 0;
      const rawActive = (state && state.data && state.data._active_agents) || [];
      const activeAgents: string[] = Array.isArray(rawActive)
        ? rawActive.map((a: any) => (typeof a === 'string' ? a : a?.name)).filter((n: any) => typeof n === 'string')
        : [];
      const startedAt = (state && state.data && state.data._startedAt) || null;
      let needsApproval = GATE_STAGES.has(stage);
      // explore_plan only needs approval when plan is posted
      if (stage === "explore_plan" && state && state.data && !state.data.explore_plan_posted) {
        needsApproval = false;
      }

      tickets.push({ ticket, stage, running: true, activeAgents, startedAt, needsApproval, progress });
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, tickets }));
    return true;
  }

  // ── GET /api/config — Return all config vars with values (secrets masked) ──
  if (url.pathname === "/api/config" && request.method === "GET") {
    const items: any[] = [];
    for (const [key, schema] of Object.entries(CONFIG_SCHEMA) as [string, any][]) {
      const rawValue = process.env[schema.env];
      let value = rawValue !== undefined ? rawValue : (schema.default !== undefined ? String(schema.default) : "");
      // Mask sensitive values — show last 4 chars for identification
      if (schema.sensitive && rawValue) {
        value = rawValue.length > 4 ? "****" + rawValue.slice(-4) : "****";
      }
      items.push({
        key,
        env: schema.env,
        type: schema.type,
        value,
        default: schema.default !== undefined ? String(schema.default) : "",
        required: !!schema.required,
        sensitive: !!schema.sensitive,
        group: schema.group || "",
        description: schema.description || "",
        hotReload: !!schema.hotReload,
        allowed: schema.allowed || null,
      });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, items }));
    return true;
  }

  // ── POST /api/config/save — Save env var changes to .env file atomically ──
  if (url.pathname === "/api/config/save" && request.method === "POST") {
    try {
      const raw = await parseBody(request, getBodySizeLimit("/api/config/save"));
      const { values } = sanitizeBody("/api/config/save", raw);
      if (!values || typeof values !== "object") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "values object is required" }));
        return true;
      }

      // Read current .env file
      const envPath = path.join(BASE_DIR, ".env");
      let envContent = "";
      try { envContent = fs.readFileSync(envPath, "utf8"); } catch { /* no .env yet */ }

      // Parse existing .env into ordered lines
      const lines = envContent.split("\n");
      const existingKeys = new Set<string>();
      const updatedLines: string[] = [];

      for (const line of lines) {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
        if (match) {
          const envKey = match[1];
          existingKeys.add(envKey);
          if (envKey in values && !(values as any)[envKey].startsWith("****")) {
            // Replace with new value
            updatedLines.push(`${envKey}=${(values as any)[envKey]}`);
            // Also update process.env for immediate effect
            process.env[envKey] = (values as any)[envKey];
          } else {
            // Keep existing line unchanged
            updatedLines.push(line);
          }
        } else {
          // Comments, blank lines — keep as-is
          updatedLines.push(line);
        }
      }

      // Append new keys that were not in the original .env
      for (const [envKey, envVal] of Object.entries(values) as [string, any][]) {
        if ((envVal as string).startsWith("****")) continue; // Skip masked (unchanged) secrets
        if (!existingKeys.has(envKey)) {
          updatedLines.push(`${envKey}=${envVal}`);
          process.env[envKey] = envVal;
        }
      }

      // Atomic write: write to tmp file, then rename
      const tmpPath = envPath + "." + Date.now() + ".tmp";
      fs.writeFileSync(tmpPath, updatedLines.join("\n"), "utf8");
      fs.renameSync(tmpPath, envPath);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, saved: Object.keys(values).filter((k: string) => (values as any)[k] !== "****").length }));
    } catch (e: any) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // ── POST /api/config/test — Test service connectivity (Jira, GitLab, Slack) ──
  if (url.pathname === "/api/config/test" && request.method === "POST") {
    try {
      const raw = await parseBody(request, getBodySizeLimit("/api/config/test"));
      const { service } = sanitizeBody("/api/config/test", raw);
      if (!service || !["jira", "gitlab", "slack", "gdrive", "figma", "postman"].includes(service)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "service must be one of: jira, gitlab, slack, gdrive, figma, postman" }));
        return true;
      }

      const https = require("https");
      const http = require("http");

      if (service === "jira") {
        const jiraBase = (process.env.JIRA_BASE_URL || "https://mastersindia-sols.atlassian.net").replace(/\/+$/, "");
        const jiraEmail = process.env.JIRA_EMAIL;
        const jiraToken = process.env.JIRA_TOKEN;
        if (!jiraEmail || !jiraToken) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "JIRA_EMAIL and JIRA_TOKEN must be set" }));
          return true;
        }
        const testUrl = new URL(jiraBase + "/rest/api/3/myself");
        const proto = testUrl.protocol === "https:" ? https : http;
        const authHeader = "Basic " + Buffer.from(`${jiraEmail}:${jiraToken}`).toString("base64");
        const result = await new Promise<any>((resolve) => {
          const req = proto.get(testUrl.href, { headers: { Authorization: authHeader, Accept: "application/json" }, timeout: 10000 }, (resp: any) => {
            let body = "";
            resp.on("data", (c: any) => { body += c; });
            resp.on("end", () => {
              if (resp.statusCode >= 200 && resp.statusCode < 300) {
                try { const j = JSON.parse(body); resolve({ ok: true, message: `Connected as ${j.displayName || j.emailAddress || "OK"}` }); }
                catch { resolve({ ok: true, message: "Connected (status " + resp.statusCode + ")" }); }
              } else {
                resolve({ ok: false, error: `HTTP ${resp.statusCode}: ${body.slice(0, 200)}` });
              }
            });
          });
          req.on("error", (e: any) => resolve({ ok: false, error: e.message }));
          req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "Connection timed out" }); });
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));

      } else if (service === "gitlab") {
        const gitlabUrl = (process.env.GITLAB_URL || "http://10.200.11.32").replace(/\/+$/, "");
        const gitlabToken = process.env.GITLAB_TOKEN;
        const gitlabProjectId = process.env.GITLAB_PROJECT_ID;
        if (!gitlabToken || !gitlabProjectId) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "GITLAB_TOKEN and GITLAB_PROJECT_ID must be set" }));
          return true;
        }
        const testUrl = new URL(`${gitlabUrl}/api/v4/projects/${gitlabProjectId}`);
        const proto = testUrl.protocol === "https:" ? https : http;
        const result = await new Promise<any>((resolve) => {
          const req = proto.get(testUrl.href, { headers: { "PRIVATE-TOKEN": gitlabToken, Accept: "application/json" }, timeout: 10000 }, (resp: any) => {
            let body = "";
            resp.on("data", (c: any) => { body += c; });
            resp.on("end", () => {
              if (resp.statusCode >= 200 && resp.statusCode < 300) {
                try { const j = JSON.parse(body); resolve({ ok: true, message: `Connected to project: ${j.name_with_namespace || j.name || "OK"}` }); }
                catch { resolve({ ok: true, message: "Connected (status " + resp.statusCode + ")" }); }
              } else {
                resolve({ ok: false, error: `HTTP ${resp.statusCode}: ${body.slice(0, 200)}` });
              }
            });
          });
          req.on("error", (e: any) => resolve({ ok: false, error: e.message }));
          req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "Connection timed out" }); });
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));

      } else if (service === "slack") {
        const webhookUrl = process.env.SLACK_WEBHOOK;
        if (!webhookUrl) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "SLACK_WEBHOOK must be set" }));
          return true;
        }
        const payload = JSON.stringify({ text: "[MI Dev Agent] Connectivity test — this message confirms Slack integration is working." });
        const testUrl = new URL(webhookUrl);
        const proto = testUrl.protocol === "https:" ? https : http;
        const result = await new Promise<any>((resolve) => {
          const req = proto.request(testUrl.href, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, timeout: 10000 }, (resp: any) => {
            let body = "";
            resp.on("data", (c: any) => { body += c; });
            resp.on("end", () => {
              if (resp.statusCode >= 200 && resp.statusCode < 300) {
                resolve({ ok: true, message: "Slack webhook responded OK — test message sent" });
              } else if (resp.statusCode === 302 || resp.statusCode === 301) {
                resolve({ ok: false, error: "Webhook returned redirect — the URL is likely expired or revoked. Generate a new webhook in Slack." });
              } else {
                resolve({ ok: false, error: `HTTP ${resp.statusCode}: ${body.slice(0, 200)}` });
              }
            });
          });
          req.on("error", (e: any) => resolve({ ok: false, error: e.message }));
          req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "Connection timed out" }); });
          req.write(payload);
          req.end();
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));

      } else if (service === "gdrive") {
        const gdrive = require('../lib/gdrive');
        const result = await gdrive.testConnection();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));

      } else if (service === "figma") {
        const figma = require('../lib/figma');
        const result = await figma.testConnection();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));

      } else if (service === "postman") {
        const postmanLib = require('../lib/postman');
        const result = await postmanLib.testConnection();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      }
    } catch (e: any) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // ── GET /api/notification-config — Return current notification config ──
  if (url.pathname === "/api/notification-config" && request.method === "GET") {
    const config = loadNotificationConfig();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, config }));
    return true;
  }

  // ── POST /api/notification-config — Save notification config ──
  if (url.pathname === "/api/notification-config" && request.method === "POST") {
    try {
      const raw = await parseBody(request, getBodySizeLimit("/api/notification-config"));
      const { config } = sanitizeBody("/api/notification-config", raw);
      if (!config || typeof config !== "object") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "config object is required" }));
        return true;
      }
      saveNotificationConfig(config);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e: any) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // D14: Unknown API routes return 404
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return true;
  }

  // Serve UI
  res.writeHead(200, {
    "Content-Type": "text/html",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
  });
  res.end(html);
  return true;
}

export { handleRequest };
