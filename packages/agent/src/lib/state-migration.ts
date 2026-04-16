/**
 * state-migration.ts — Migration bridge from dual-write to unified state
 *
 * Converted from lib/state-migration.js (zero functional changes).
 *
 * This module provides drop-in replacement exports that match the old
 * lib/state.js and server/state-io.js APIs while delegating to the
 * new unified state-unified.js module under the hood.
 *
 * Migration steps:
 *   Phase 0 (this file): Both old files replaced with shims that call unified module
 *   Phase 1: Update all importers to use state-unified.js directly
 *   Phase 2: Remove this bridge file and old state.js / state-io.js
 *
 * Usage:
 *   // In lib/state.js (replace entire contents):
 *   module.exports = require("./state-migration").agentAPI;
 *
 *   // In server/state-io.js (replace entire contents):
 *   module.exports = require("../lib/state-migration").serverAPI;
 */

import fs from "fs";
import path from "path";

// Hub file not yet converted — use require from legacy dir
const {
  loadSync,
  saveSync,
  checkUIApprovalSync,
  readForDisplay,
  saveReviewComments,
  getReviewComments,
  patchUIAsync,
  updateAsync,
  readStateFromDisk,
  stateSecret,
  recoverTmpFiles,
} = require("./state-unified") as {
  loadSync: (filePath: string, defaults: any, opts?: any) => any;
  saveSync: (filePath: string, state: any, opts?: any) => void;
  checkUIApprovalSync: (filePath: string, gatePrefix: string) => any;
  readForDisplay: (filePath: string) => any;
  saveReviewComments: (filePath: string, comments: any) => Promise<void>;
  getReviewComments: (filePath: string) => any;
  patchUIAsync: (filePath: string, gate: string, uiFields: any) => Promise<void>;
  updateAsync: (filePath: string, mutator: (state: any) => any) => Promise<void>;
  readStateFromDisk: (filePath: string) => any;
  stateSecret: (baseDir: string) => string;
  recoverTmpFiles: (baseDir: string) => any;
};

// Resolve to project root so state files are co-located with the backend's
// scan directory (packages/backend/src/state/state-manager.ts uses the same
// path). When compiled, this file lives at packages/agent/dist/lib/, so we
// go up four levels: dist/lib -> dist -> agent -> packages -> project root.
// When run from TS source, packages/agent/src/lib -> src -> agent -> packages -> project root (same depth).
const BASE_DIR = path.resolve(__dirname, "..", "..", "..", "..");

// ── Resolve state file path from ticket ────────────────────────────
function stateFilePath(ticket?: string): string {
  if (!ticket) {
    // Fall back to env-based TICKET
    const t = (process.env.TICKET || "").trim().toUpperCase();
    return path.join(BASE_DIR, `state-${t}.json`);
  }
  return path.join(BASE_DIR, `state-${ticket}.json`);
}

// ── Agent-side drop-in (replaces lib/state.js) ─────────────────────

let _currentState: any = null;

function getCurrentState(): any { return _currentState; }
function setCurrentState(s: any): void { _currentState = s; }

function loadState(): any {
  // Uses the TICKET from environment
  const ticket = (process.env.TICKET || "").trim().toUpperCase();
  const filePath = stateFilePath(ticket);
  const { STAGES } = require("./constants") as { STAGES: readonly string[] };

  const state = loadSync(filePath, {
    stage: STAGES[0],
    ticket: ticket,
  }, {
    allowUnverified: true,
    onWarn: (msg: string) => {
      try { (require("./logging") as any).logWarn(msg); } catch { console.warn(msg); }
    },
  });

  _currentState = state;
  return state;
}

function save(state: any): void {
  _currentState = state;
  const ticket = state.ticket || (process.env.TICKET || "").trim().toUpperCase();
  const filePath = stateFilePath(ticket);

  try {
    saveSync(filePath, state, {
      onWarn: (msg: string) => {
        try { (require("./logging") as any).logWarn(msg); } catch { console.warn(msg); }
      },
    });
  } catch (err: any) {
    if (err.message.includes("DISK FULL")) {
      try { (require("./logging") as any).logErr(err.message); } catch { console.error(err.message); }
      process.exit(1);
    }
    throw err;
  }
}

function checkUIApproval(state: any, gatePrefix: string): any {
  const ticket = state.ticket || (process.env.TICKET || "").trim().toUpperCase();
  const filePath = stateFilePath(ticket);
  const result = checkUIApprovalSync(filePath, gatePrefix);

  // Mirror into in-memory state for backward compat
  if (result) {
    if (result.refine) {
      state.data[`${gatePrefix}_ui_refine`] = true;
      state.data[`${gatePrefix}_ui_refine_instructions`] = result.instructions;
    } else if (result.approved) {
      state.data[`${gatePrefix}_ui_approved`] = true;
    } else {
      state.data[`${gatePrefix}_ui_rejected`] = true;
      state.data[`${gatePrefix}_ui_feedback`] = result.feedback || "";
    }
  }

  return result;
}

/**
 * Save state, then throw the original error.
 * If save() fails, log the save error as warning and still throw original.
 */
function saveAndThrow(state: any, error: Error): never {
  try {
    save(state);
  } catch (saveErr: any) {
    // DISK FULL triggers process.exit(1) inside save() — we can't catch that.
    // All other save errors: log warning, preserve original error.
    console.warn(`[saveAndThrow] save() failed: ${saveErr.message} — throwing original error`);
  }
  throw error;
}

const agentAPI = {
  loadState,
  save,
  saveAndThrow,
  stateSecret: () => stateSecret(BASE_DIR),
  checkUIApproval,
  getCurrentState,
  setCurrentState,
};

// ── Server-side drop-in (replaces server/state-io.js) ──────────────

function unwrapStateEnvelope(parsed: any): any {
  // Backward compat: server code sometimes calls this directly
  if (parsed && parsed._version >= 2 && parsed.state) return parsed.state;
  return parsed;
}

function getState(ticket: string): any {
  const filePath = stateFilePath(ticket);
  return readForDisplay(filePath);
}

// Write queue for backward compat — now delegates to locked writes
let writeQueue = Promise.resolve();

async function writeStateAsync(f: string, data: any): Promise<void> {
  // data here is the raw state (not envelope) — server code passes unwrapped state
  writeQueue = writeQueue.then(async () => {
    const { saveAsync } = require("./state-unified") as { saveAsync: (f: string, data: any) => Promise<void> };
    await saveAsync(f, data);
  }).catch((err: any) => {
    console.error("State write failed:", err.message);
  });
  return writeQueue as any;
}

async function readStateAsync(f: string): Promise<any> {
  try {
    return readForDisplay(f);
  } catch {
    return null;
  }
}

async function _saveReviewComments(ticket: string, comments: any): Promise<void> {
  const f = stateFilePath(ticket);
  return saveReviewComments(f, comments);
}

function _getReviewComments(ticket: string): any {
  const f = stateFilePath(ticket);
  return getReviewComments(f);
}

function loadEnv(): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const f = path.join(BASE_DIR, ".env");
    if (fs.existsSync(f)) {
      for (const line of fs.readFileSync(f, "utf8").split("\n")) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) vars[m[1]] = m[2].trim();
      }
    }
  } catch (e: any) { console.warn("  .env load failed: " + e.message); }
  return vars;
}

const serverAPI = {
  unwrapStateEnvelope,
  getState,
  writeStateAsync,
  readStateAsync,
  saveReviewComments: _saveReviewComments,
  getReviewComments: _getReviewComments,
  loadEnv,
  // New preferred API
  patchUIAsync: async (ticket: string, gate: string, uiFields: any) => {
    const f = stateFilePath(ticket);
    return patchUIAsync(f, gate, uiFields);
  },
  updateAsync: async (ticket: string, mutator: (state: any) => any) => {
    const f = stateFilePath(ticket);
    return updateAsync(f, mutator);
  },
};

export {
  agentAPI,
  serverAPI,
  stateFilePath,
};
