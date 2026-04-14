"use strict";
// ===================================================================
// MI Dev Agent -- State I/O (TypeScript port of server-side state ops)
//
// Async state I/O for server context where multiple concurrent requests
// may read/write the same state file. All operations go through lock.ts
// for thread safety.
//
// This module provides the server-facing API:
//   - getState(ticket)      -- read state (read-only, no lock)
//   - writeStateAsync()     -- full state write with lock + HMAC
//   - patchUIAsync()        -- UI-only field merge (approve/reject/refine)
//   - updateAsync()         -- read-modify-write with lock held
//   - saveReviewComments()  -- persist review comments in state
//
// Ported from: lib/state-unified.js (async API section)
// ===================================================================
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports._resetStartupCleanup = _resetStartupCleanup;
exports.getState = getState;
exports.writeStateAsync = writeStateAsync;
exports.patchUIAsync = patchUIAsync;
exports.patchUIWithGateAsync = patchUIWithGateAsync;
exports.updateAsync = updateAsync;
exports.saveReviewComments = saveReviewComments;
exports.getReviewComments = getReviewComments;
const path = __importStar(require("path"));
const logger_1 = require("../lib/logger");
const lock_1 = require("./lock");
const state_manager_1 = require("./state-manager");
// ── Configuration ─────────────────────────────────────────────────
/** Default base directory for state files. */
function defaultBaseDir() {
    return path.join(__dirname, '..', '..', '..', '..');
}
// ── Startup: Orphaned .tmp cleanup ────────────────────────────────
let _startupCleanupDone = false;
/**
 * Clean orphaned .tmp files on first call. Idempotent.
 * Called automatically by getState() and writeStateAsync().
 */
function ensureStartupCleanup(stateFilePath) {
    if (_startupCleanupDone)
        return;
    _startupCleanupDone = true;
    const recovered = (0, state_manager_1.recoverTmpFiles)(stateFilePath);
    if (recovered.length > 0) {
        (0, logger_1.logInfo)(`[StateIO] Startup cleanup: ${recovered.length} orphaned tmp file(s) handled`);
    }
}
/** Reset startup cleanup flag (for testing). */
function _resetStartupCleanup() {
    _startupCleanupDone = false;
}
// ── Read State ────────────────────────────────────────────────────
/**
 * Read state for a ticket. Does NOT acquire a lock (reads are safe without
 * locking on most filesystems -- the kernel provides atomic rename guarantees).
 *
 * Returns the deserialized PipelineState, or null if no valid state exists.
 *
 * @param ticket - Jira ticket ID (e.g., "AUT-1234")
 * @param baseDir - Optional base directory for state files
 * @returns PipelineState or null
 */
async function getState(ticket, baseDir) {
    const dir = baseDir || defaultBaseDir();
    const stateFilePath = path.join(dir, `state-${ticket}.json`);
    // One-time startup cleanup
    ensureStartupCleanup(stateFilePath);
    const result = (0, state_manager_1.readStateFromDisk)(stateFilePath, {
        allowUnverified: true,
        onWarn: (msg) => (0, logger_1.logWarn)(msg),
    });
    if (result) {
        const state = result.state;
        if (!state._seq)
            state._seq = result.seq || 1;
        return state;
    }
    return null;
}
// ── Write State (full replace) ────────────────────────────────────
/**
 * Write the full state to disk with exclusive lock, HMAC envelope, and
 * atomic write. Merges UI fields from disk before writing to prevent
 * overwriting concurrent UI approvals.
 *
 * @param ticket - Jira ticket ID
 * @param state - The full PipelineState to write
 * @param baseDir - Optional base directory for state files
 */
async function writeStateAsync(ticket, state, baseDir) {
    const dir = baseDir || defaultBaseDir();
    const stateFilePath = path.join(dir, `state-${ticket}.json`);
    ensureStartupCleanup(stateFilePath);
    const release = await (0, lock_1.acquireLockAsync)(stateFilePath);
    try {
        // Re-read disk for CAS validation and UI field merge
        const diskResult = (0, state_manager_1.readStateFromDisk)(stateFilePath, {
            allowUnverified: true,
            onWarn: (msg) => (0, logger_1.logWarn)(msg),
        });
        if (diskResult) {
            // CAS guard: verify disk _seq matches expected in-memory _seq
            const memSeq = state._seq || 0;
            const diskSeq = diskResult.seq || diskResult.state._seq || 0;
            if (memSeq > 0 && diskSeq > 0 && memSeq !== diskSeq) {
                (0, logger_1.logWarn)(`[StateIO CAS] CAS conflict: expected seq ${memSeq}, found ${diskSeq} -- merging`);
                (0, state_manager_1.mergeUIFieldsFromDisk)(state, diskResult.state);
                state._seq = diskSeq; // Adopt disk seq for correct increment
            }
            else {
                (0, state_manager_1.mergeUIFieldsFromDisk)(state, diskResult.state);
            }
        }
        // Bump sequence number
        state._seq = (state._seq || 0) + 1;
        state.data = state.data || {};
        state.data._lastActivity = new Date().toISOString();
        // Prune if needed
        (0, state_manager_1.pruneState)(state);
        // Write with HMAC envelope
        const secret = (0, state_manager_1.stateSecret)();
        const envelope = (0, state_manager_1.wrapEnvelope)(state, secret);
        await (0, state_manager_1.atomicWriteAsync)(stateFilePath, envelope);
    }
    finally {
        release();
    }
}
// ── Patch UI Fields ───────────────────────────────────────────────
/**
 * Apply a UI-only patch: locks, reads disk, applies only UI fields, writes back.
 * This is the ONLY function the server should use for approve/reject/refine.
 *
 * UI patches do NOT increment _seq in the traditional sense -- the updateAsync
 * internally manages the sequence, but the agent treats UI field writes as
 * non-conflicting side-channel updates.
 *
 * @param ticket - Jira ticket ID
 * @param patch - Object with UI field keys and values to set/delete.
 *                Keys should include the full gate prefix + suffix
 *                (e.g., { "gate1_ui_approved": true })
 *                OR pass gate + uiFields separately via patchUIWithGateAsync.
 * @param baseDir - Optional base directory for state files
 */
async function patchUIAsync(ticket, patch, baseDir) {
    const dir = baseDir || defaultBaseDir();
    const stateFilePath = path.join(dir, `state-${ticket}.json`);
    const release = await (0, lock_1.acquireLockAsync)(stateFilePath);
    try {
        // Read current state
        const diskResult = (0, state_manager_1.readStateFromDisk)(stateFilePath, {
            allowUnverified: true,
            onWarn: (msg) => (0, logger_1.logWarn)(msg),
        });
        if (!diskResult) {
            throw new Error(`Cannot patch UI: no state file found for ticket ${ticket}`);
        }
        let state = diskResult.state;
        if (!state._seq)
            state._seq = diskResult.seq || 1;
        if (!state.data)
            state.data = {};
        // Apply UI fields
        const data = state.data;
        for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === null) {
                delete data[key];
            }
            else {
                data[key] = value;
            }
        }
        // Bump seq and write
        state._seq = (state._seq || 0) + 1;
        data._lastActivity = new Date().toISOString();
        (0, state_manager_1.pruneState)(state);
        const secret = (0, state_manager_1.stateSecret)();
        const envelope = (0, state_manager_1.wrapEnvelope)(state, secret);
        await (0, state_manager_1.atomicWriteAsync)(stateFilePath, envelope);
    }
    finally {
        release();
    }
}
/**
 * Apply a UI patch using gate prefix + suffix fields.
 * This is the gate-aware version used by server route handlers.
 *
 * @param ticket - Jira ticket ID
 * @param gate - Gate prefix (e.g., "gate1", "gate2b", "explore_plan")
 * @param uiFields - Fields to set/delete (e.g., { "_ui_approved": true })
 * @param baseDir - Optional base directory
 */
async function patchUIWithGateAsync(ticket, gate, uiFields, baseDir) {
    const dir = baseDir || defaultBaseDir();
    const stateFilePath = path.join(dir, `state-${ticket}.json`);
    await updateAsync(ticket, async (state) => {
        return (0, state_manager_1.applyUIPatch)(state, gate, uiFields);
    }, dir);
}
// ── Read-Modify-Write ─────────────────────────────────────────────
/**
 * Async read-modify-write with exclusive lock.
 * The mutator function receives the current state and must return the
 * modified state. The lock is held for the entire duration.
 *
 * @param ticket - Jira ticket ID
 * @param mutator - Async function that receives state and returns modified state
 * @param baseDir - Optional base directory for state files
 * @returns The saved state after mutation
 * @throws If no state file exists for the ticket
 */
async function updateAsync(ticket, mutator, baseDir) {
    const dir = baseDir || defaultBaseDir();
    const stateFilePath = path.join(dir, `state-${ticket}.json`);
    const release = await (0, lock_1.acquireLockAsync)(stateFilePath);
    try {
        // Read current state
        const diskResult = (0, state_manager_1.readStateFromDisk)(stateFilePath, {
            allowUnverified: true,
            onWarn: (msg) => (0, logger_1.logWarn)(msg),
        });
        if (!diskResult) {
            throw new Error(`Cannot update: no state file found for ticket ${ticket}`);
        }
        let state = diskResult.state;
        if (!state._seq)
            state._seq = diskResult.seq || 1;
        const readSeq = state._seq;
        // Apply mutation (supports both sync and async mutators)
        state = (await mutator(state)) || state;
        // Bump seq
        state._seq = readSeq + 1;
        state.data = state.data || {};
        state.data._lastActivity = new Date().toISOString();
        // Prune if needed
        (0, state_manager_1.pruneState)(state);
        // Write with HMAC envelope
        const secret = (0, state_manager_1.stateSecret)();
        const envelope = (0, state_manager_1.wrapEnvelope)(state, secret);
        await (0, state_manager_1.atomicWriteAsync)(stateFilePath, envelope);
        return state;
    }
    finally {
        release();
    }
}
// ── Review Comments ───────────────────────────────────────────────
/**
 * Save review comments into the state file.
 * Uses updateAsync for safe read-modify-write.
 *
 * @param ticket - Jira ticket ID
 * @param comments - Review comments object to persist
 * @param baseDir - Optional base directory
 * @returns true on success, false on failure
 */
async function saveReviewComments(ticket, comments, baseDir) {
    try {
        await updateAsync(ticket, async (state) => {
            state.data._reviewComments = comments;
            return state;
        }, baseDir);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Get review comments from the state (read-only, no lock).
 *
 * @param ticket - Jira ticket ID
 * @param baseDir - Optional base directory
 * @returns Review comments object, or empty object
 */
async function getReviewComments(ticket, baseDir) {
    const state = await getState(ticket, baseDir);
    return state?.data?._reviewComments || {};
}
//# sourceMappingURL=state-io.js.map