"use strict";

/**
 * state-migration.js — Migration bridge from dual-write to unified state
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

const fs = require("fs");
const path = require("path");
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
} = require("./state-unified");

const BASE_DIR = path.join(__dirname, "..");

// ── Resolve state file path from ticket ────────────────────────────
function stateFilePath(ticket) {
  if (!ticket) {
    // Fall back to env-based TICKET
    const t = (process.env.TICKET || "").trim().toUpperCase();
    return path.join(BASE_DIR, `state-${t}.json`);
  }
  return path.join(BASE_DIR, `state-${ticket}.json`);
}

// ── Agent-side drop-in (replaces lib/state.js) ─────────────────────

let _currentState = null;

function getCurrentState() { return _currentState; }
function setCurrentState(s) { _currentState = s; }

function loadState() {
  // Uses the TICKET from environment
  const ticket = (process.env.TICKET || "").trim().toUpperCase();
  const filePath = stateFilePath(ticket);
  const { STAGES } = require("./constants");

  const state = loadSync(filePath, {
    stage: STAGES[0],
    ticket: ticket,
  }, {
    allowUnverified: true,
    onWarn: (msg) => {
      try { require("./logging").logWarn(msg); } catch { console.warn(msg); }
    },
  });

  _currentState = state;
  return state;
}

function save(state) {
  _currentState = state;
  const ticket = state.ticket || (process.env.TICKET || "").trim().toUpperCase();
  const filePath = stateFilePath(ticket);

  try {
    saveSync(filePath, state, {
      onWarn: (msg) => {
        try { require("./logging").logWarn(msg); } catch { console.warn(msg); }
      },
    });
  } catch (err) {
    if (err.message.includes("DISK FULL")) {
      try { require("./logging").logErr(err.message); } catch { console.error(err.message); }
      process.exit(1);
    }
    throw err;
  }
}

function checkUIApproval(state, gatePrefix) {
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
function saveAndThrow(state, error) {
  try {
    save(state);
  } catch (saveErr) {
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

function unwrapStateEnvelope(parsed) {
  // Backward compat: server code sometimes calls this directly
  if (parsed && parsed._version >= 2 && parsed.state) return parsed.state;
  return parsed;
}

function getState(ticket) {
  const filePath = stateFilePath(ticket);
  return readForDisplay(filePath);
}

// Write queue for backward compat — now delegates to locked writes
let writeQueue = Promise.resolve();

async function writeStateAsync(f, data) {
  // data here is the raw state (not envelope) — server code passes unwrapped state
  writeQueue = writeQueue.then(async () => {
    const { saveAsync } = require("./state-unified");
    await saveAsync(f, data);
  }).catch((err) => {
    console.error("State write failed:", err.message);
  });
  return writeQueue;
}

async function readStateAsync(f) {
  try {
    return readForDisplay(f);
  } catch {
    return null;
  }
}

async function _saveReviewComments(ticket, comments) {
  const f = stateFilePath(ticket);
  return saveReviewComments(f, comments);
}

function _getReviewComments(ticket) {
  const f = stateFilePath(ticket);
  return getReviewComments(f);
}

function loadEnv() {
  const vars = {};
  try {
    const f = path.join(BASE_DIR, ".env");
    if (fs.existsSync(f)) {
      for (const line of fs.readFileSync(f, "utf8").split("\n")) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) vars[m[1]] = m[2].trim();
      }
    }
  } catch (e) { console.warn("  .env load failed: " + e.message); }
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
  patchUIAsync: async (ticket, gate, uiFields) => {
    const f = stateFilePath(ticket);
    return patchUIAsync(f, gate, uiFields);
  },
  updateAsync: async (ticket, mutator) => {
    const f = stateFilePath(ticket);
    return updateAsync(f, mutator);
  },
};

module.exports = {
  agentAPI,
  serverAPI,
  stateFilePath,
};
