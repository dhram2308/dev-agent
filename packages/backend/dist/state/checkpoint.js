"use strict";
// ===================================================================
// MI Dev Agent -- Checkpoint & Resume System
// (TypeScript port of lib/checkpoint.js)
//
// Crash recovery through checkpoint persistence:
//
//   saveCheckpoint()          -- Save a SHA256-hashed checkpoint before
//                                each stage. Maintains a 20-entry ring
//                                buffer of checkpoint history.
//
//   verifyCheckpointOnResume() -- On resume after crash, verify that
//                                 the checkpoint is consistent (stage
//                                 match, config hash, prerequisites).
//                                 Recommends rollback if inconsistent.
//
//   markStageCompleted()      -- Record successful stage completion with
//                                timestamp, state hash, and PID.
//
//   applyRollback()           -- Roll back to a previous stage, clear
//                                downstream data, and record the rollback.
//
// All hashing uses SHA256 (via Node.js crypto). Checkpoint data is
// stored inline in state.data._checkpoint and state.data._checkpoint_history.
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
exports.createCheckpoint = createCheckpoint;
exports.saveCheckpoint = saveCheckpoint;
exports.markStageCompleted = markStageCompleted;
exports.verifyCheckpointOnResume = verifyCheckpointOnResume;
exports.applyRollback = applyRollback;
const crypto = __importStar(require("crypto"));
const constants_1 = require("@shared/constants");
const logger_1 = require("../lib/logger");
// ── Internal helpers ────────────────────────────────────────────────
/**
 * Hash an arbitrary object for comparison.
 * Produces a truncated (24-char) hex SHA256 digest.
 */
function hashObject(obj) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(obj))
        .digest('hex')
        .substring(0, 24);
}
/**
 * Compute a hash of critical state fields for integrity checking.
 *
 * Not a full state hash -- only the fields that define "where we are"
 * and "what we've done" are included. This keeps the hash stable even
 * when non-critical metadata changes.
 */
function computeStateHash(state) {
    const data = state.data;
    const criticalData = {
        stage: state.stage,
        ticket: state.ticket,
        code_branch: data.code_branch ?? null,
        code_mr_iid: data.code_mr_iid ?? null,
        preprod_mr_iid: data.preprod_mr_iid ?? null,
        completedGates: state.data._completedGates ?? [],
    };
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(criticalData))
        .digest('hex')
        .substring(0, 24);
}
/**
 * Check prerequisites for the current stage.
 *
 * Returns a summary of which required data fields are present and
 * which are missing, based on STAGE_REQUIREMENTS.
 */
function checkPrerequisites(state) {
    const reqs = constants_1.STAGE_REQUIREMENTS[state.stage] || [];
    const present = [];
    const missing = [];
    const data = state.data;
    for (const field of reqs) {
        if (data[field] !== undefined && data[field] !== null) {
            present.push(field);
        }
        else {
            missing.push(field);
        }
    }
    return {
        ok: missing.length === 0,
        present,
        missing,
        summary: missing.length === 0 ? 'all_met' : `missing:${missing.join(',')}`,
    };
}
// ── Checkpoint creation ─────────────────────────────────────────────
/** Maximum number of checkpoint history entries (ring buffer). */
const MAX_CHECKPOINT_HISTORY = 20;
/**
 * Create a checkpoint object (without saving it to state).
 *
 * A checkpoint captures a snapshot of pipeline progress at stage entry:
 * - Current and previous stage
 * - Pipeline elapsed time
 * - Config snapshot hash (for consistency detection)
 * - Prerequisite field presence
 * - State integrity hash
 * - Completed gates list
 *
 * @param state - Current pipeline state
 * @param _cfg - App config (used for snapshot hash, optional)
 * @returns CheckpointData or null if state is invalid
 */
function createCheckpoint(state, _cfg) {
    if (!state || !state.data)
        return null;
    const data = state.data;
    const checkpoint = {
        stage: state.stage,
        entryTime: new Date().toISOString(),
        entryTimeMs: Date.now(),
        previousStage: state.data._last_completed_stage || null,
        pipelineElapsedMs: Date.now() - (state.data._pipeline_start || Date.now()),
        pid: process.pid,
        // Config consistency
        configSnapshotHash: state.data._config_snapshot
            ? hashObject(state.data._config_snapshot)
            : null,
        // Prerequisites check
        prerequisites: checkPrerequisites(state),
        // State integrity hash
        stateHash: computeStateHash(state),
        // Completed gates at checkpoint time
        completedGates: state.data._completedGates
            ? [...state.data._completedGates]
            : [],
        // Version for forward compatibility
        version: 1,
    };
    return checkpoint;
}
// ── Save checkpoint ─────────────────────────────────────────────────
/**
 * Save a checkpoint into state before stage execution.
 *
 * Stores the checkpoint at `state.data._checkpoint` and appends a
 * lightweight summary to `state.data._checkpoint_history` (ring buffer,
 * max 20 entries -- oldest are dropped).
 *
 * @param state - Current pipeline state
 * @param cfg - App config (optional, used for snapshot hash)
 * @returns The saved CheckpointData, or undefined if state is invalid
 */
function saveCheckpoint(state, cfg) {
    const checkpoint = createCheckpoint(state, cfg);
    if (!checkpoint)
        return undefined;
    state.data._checkpoint = checkpoint;
    // Maintain ring buffer history (last 20)
    if (!state.data._checkpoint_history) {
        state.data._checkpoint_history = [];
    }
    const historyEntry = {
        stage: checkpoint.stage,
        entryTime: checkpoint.entryTime,
        stateHash: checkpoint.stateHash,
        prerequisites: checkpoint.prerequisites.summary,
    };
    state.data._checkpoint_history.push(historyEntry);
    if (state.data._checkpoint_history.length > MAX_CHECKPOINT_HISTORY) {
        state.data._checkpoint_history = state.data._checkpoint_history.slice(-MAX_CHECKPOINT_HISTORY);
    }
    (0, logger_1.logDebug)(`[Checkpoint] Saved for stage "${state.stage}" (hash: ${checkpoint.stateHash.substring(0, 12)})`);
    return checkpoint;
}
// ── Mark stage completed ────────────────────────────────────────────
/**
 * Mark a stage as successfully completed.
 *
 * Call this after a stage handler returns without error. Records:
 * - `_last_completed_stage` / `_last_completed_time` for quick lookup
 * - Per-stage completion record in `_stage_completions` with hash and PID
 *
 * @param state - Current pipeline state
 * @param stageName - The stage that just completed
 */
function markStageCompleted(state, stageName) {
    state.data._last_completed_stage = stageName;
    state.data._last_completed_time = new Date().toISOString();
    // Save per-stage completion record
    if (!state.data._stage_completions) {
        state.data._stage_completions = {};
    }
    state.data._stage_completions[stageName] = {
        completedAt: new Date().toISOString(),
        stateHash: computeStateHash(state),
        pid: process.pid,
    };
}
// ── Resume verification ─────────────────────────────────────────────
/**
 * Verify checkpoint consistency on resume after a crash.
 *
 * Checks performed:
 *   1. Stage consistency (checkpoint stage vs state.stage)
 *   2. Config snapshot hash (detect env/config changes between runs)
 *   3. Stage gap detection (skipped stages)
 *   4. Data corruption indicators (missing prerequisites)
 *
 * If prerequisites are missing and a completed stage exists to roll
 * back to, recommends rollback to the stage after the last completed one.
 *
 * @param state - Loaded pipeline state from disk
 * @returns Verification result with validity, rollback recommendation, and issues
 */
function verifyCheckpointOnResume(state) {
    const issues = [];
    const checkpoint = state.data._checkpoint;
    // No checkpoint -- first run or pre-checkpoint state
    if (!checkpoint) {
        (0, logger_1.logInfo)('[Checkpoint] No checkpoint found -- this is likely a first run or pre-checkpoint state');
        return {
            valid: true,
            stage: state.stage,
            rollback: false,
            rollbackTo: null,
            issues: [],
        };
    }
    (0, logger_1.logInfo)(`[Checkpoint] Verifying checkpoint for stage "${checkpoint.stage}" (from ${checkpoint.entryTime})`);
    // 1. Stage consistency: checkpoint stage should match state.stage
    if (checkpoint.stage !== state.stage) {
        issues.push(`Stage mismatch: checkpoint="${checkpoint.stage}", state="${state.stage}"`);
        // state.stage was likely updated after checkpoint but before crash
        // Trust state.stage as it's more recent
        (0, logger_1.logWarn)(`[Checkpoint] Stage mismatch -- checkpoint was for "${checkpoint.stage}" ` +
            `but state is at "${state.stage}"`);
    }
    // 2. Config snapshot consistency
    if (checkpoint.configSnapshotHash && state.data._config_snapshot) {
        const currentHash = hashObject(state.data._config_snapshot);
        if (currentHash !== checkpoint.configSnapshotHash) {
            issues.push('Config snapshot hash mismatch -- config may have changed between runs');
            (0, logger_1.logWarn)('[Checkpoint] Config snapshot changed since last checkpoint');
        }
    }
    // 3. Check if we crashed mid-stage (checkpoint exists but stage not completed)
    const lastCompleted = state.data._last_completed_stage;
    const currentStageIdx = constants_1.STAGES.indexOf(state.stage);
    const lastCompletedIdx = lastCompleted
        ? constants_1.STAGES.indexOf(lastCompleted)
        : -1;
    if (currentStageIdx > lastCompletedIdx + 1) {
        issues.push(`Stage gap: last completed="${lastCompleted}" but current="${state.stage}" ` +
            `(expected next stage after completed)`);
        (0, logger_1.logWarn)('[Checkpoint] Stage gap detected -- may have skipped stages');
    }
    // 4. Check for data corruption indicators
    const prereqs = checkPrerequisites(state);
    if (!prereqs.ok && prereqs.missing.length > 0) {
        issues.push(`Missing prerequisites for "${state.stage}": ${prereqs.missing.join(', ')}`);
    }
    // 5. Determine if rollback is needed
    let rollback = false;
    let rollbackTo = null;
    // Rollback if current stage has missing prerequisites AND we can go back
    if (!prereqs.ok && prereqs.missing.length > 0 && lastCompleted) {
        // Find the most recent stage that was successfully completed
        const rollbackCandidates = constants_1.STAGES.filter((s, idx) => {
            if (idx >= currentStageIdx)
                return false;
            const completion = state.data._stage_completions && state.data._stage_completions[s];
            return !!completion;
        });
        if (rollbackCandidates.length > 0) {
            // Roll back to the stage AFTER the last completed one
            const lastGoodStage = rollbackCandidates[rollbackCandidates.length - 1];
            const lastGoodIdx = constants_1.STAGES.indexOf(lastGoodStage);
            if (lastGoodIdx + 1 < constants_1.STAGES.length) {
                rollbackTo = constants_1.STAGES[lastGoodIdx + 1];
                rollback = true;
                (0, logger_1.logWarn)(`[Checkpoint] Rolling back to "${rollbackTo}" (last good: "${lastGoodStage}")`);
            }
        }
    }
    // Log issues
    if (issues.length > 0) {
        (0, logger_1.logWarn)(`[Checkpoint] ${issues.length} issue(s) found during verification:`);
        for (const issue of issues) {
            (0, logger_1.logWarn)(`[Checkpoint]   - ${issue}`);
        }
    }
    else {
        (0, logger_1.logInfo)('[Checkpoint] Checkpoint verification passed');
    }
    return {
        valid: issues.length === 0,
        stage: rollback && rollbackTo ? rollbackTo : state.stage,
        rollback,
        rollbackTo,
        issues,
    };
}
// ── Rollback ────────────────────────────────────────────────────────
/** Maximum number of rollback records to keep in state. */
const MAX_ROLLBACK_HISTORY = 10;
/**
 * Apply a rollback: set state.stage to the target and optionally clear
 * downstream data.
 *
 * Records the rollback in `state.data._rollbacks` (capped at 10 entries).
 *
 * @param state - Current pipeline state (mutated in place)
 * @param rollbackTo - Stage to roll back to
 * @param clearDownstreamFn - Optional function to clear downstream data
 *        (typically `clearDownstreamData` from validation.ts)
 * @returns The mutated state (same reference)
 */
function applyRollback(state, rollbackTo, clearDownstreamFn) {
    const previousStage = state.stage;
    state.stage = rollbackTo;
    if (clearDownstreamFn) {
        clearDownstreamFn(state, rollbackTo);
    }
    (0, logger_1.logWarn)(`[Checkpoint] Rolled back from "${previousStage}" to "${rollbackTo}"`);
    // Record rollback in state
    if (!state.data._rollbacks)
        state.data._rollbacks = [];
    state.data._rollbacks.push({
        from: previousStage,
        to: rollbackTo,
        timestamp: new Date().toISOString(),
        reason: 'checkpoint_verification_failed',
    });
    if (state.data._rollbacks.length > MAX_ROLLBACK_HISTORY) {
        state.data._rollbacks = state.data._rollbacks.slice(-MAX_ROLLBACK_HISTORY);
    }
    return state;
}
//# sourceMappingURL=checkpoint.js.map