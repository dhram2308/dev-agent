"use strict";

/**
 * Checkpoint & Resume System
 *
 * Solves crash recovery:
 * - Before each stage, save a detailed checkpoint
 * - On resume after crash, verify checkpoint consistency
 * - If inconsistent, roll back to last known-good stage
 * - Track checkpoint history for debugging
 */

const crypto = require("crypto");
const { STAGES } = require("./constants");
const { logInfo, logWarn, logErr, logDebug } = require("./logging");

// ── Checkpoint data structure ───────────────────────────────────────

/**
 * Create a checkpoint before stage execution.
 *
 * A checkpoint captures:
 * - stage: current stage name
 * - entryTime: when we entered the stage
 * - configSnapshotHash: hash of the config snapshot for consistency check
 * - prerequisites: which required data fields are present
 * - previousStage: what stage we came from
 * - pipelineElapsed: how long the pipeline has been running
 * - stateHash: hash of critical state data at checkpoint time
 */
function createCheckpoint(state, cfg) {
  if (!state || !state.data) return null;

  const checkpoint = {
    stage: state.stage,
    entryTime: new Date().toISOString(),
    entryTimeMs: Date.now(),
    previousStage: state.data._last_completed_stage || null,
    pipelineElapsedMs: Date.now() - (state.data._pipeline_start || Date.now()),
    pid: process.pid,

    // Config consistency
    configSnapshotHash: state.data._config_snapshot
      ? _hashObject(state.data._config_snapshot)
      : null,

    // Prerequisites check — which critical data fields exist
    prerequisites: _checkPrerequisites(state),

    // State integrity hash (hash of key fields, not full state)
    stateHash: _computeStateHash(state),

    // Completed gates at checkpoint time
    completedGates: state.data._completedGates
      ? [...state.data._completedGates]
      : [],

    // Version for forward compatibility
    version: 1,
  };

  return checkpoint;
}

/**
 * Save a checkpoint into state.
 */
function saveCheckpoint(state, cfg) {
  const checkpoint = createCheckpoint(state, cfg);
  if (!checkpoint) return;

  state.data._checkpoint = checkpoint;

  // Keep checkpoint history (last 20)
  if (!state.data._checkpoint_history) {
    state.data._checkpoint_history = [];
  }
  state.data._checkpoint_history.push({
    stage: checkpoint.stage,
    entryTime: checkpoint.entryTime,
    stateHash: checkpoint.stateHash,
    prerequisites: checkpoint.prerequisites.summary,
  });
  if (state.data._checkpoint_history.length > 20) {
    state.data._checkpoint_history = state.data._checkpoint_history.slice(-20);
  }

  logDebug(`[Checkpoint] Saved for stage "${state.stage}" (hash: ${checkpoint.stateHash.substring(0, 12)})`);
  return checkpoint;
}

/**
 * Mark a stage as successfully completed.
 * Call this after a stage handler returns without error.
 */
function markStageCompleted(state, stageName) {
  state.data._last_completed_stage = stageName;
  state.data._last_completed_time = new Date().toISOString();

  // Save completion record
  if (!state.data._stage_completions) {
    state.data._stage_completions = {};
  }
  state.data._stage_completions[stageName] = {
    completedAt: new Date().toISOString(),
    stateHash: _computeStateHash(state),
    pid: process.pid,
  };
}

// ── Resume verification ─────────────────────────────────────────────

/**
 * Verify checkpoint consistency on resume after a crash.
 *
 * Returns:
 * {
 *   valid: boolean,          // Is the checkpoint consistent?
 *   stage: string,           // Stage to resume from
 *   rollback: boolean,       // Should we roll back?
 *   rollbackTo: string|null, // Stage to roll back to
 *   issues: string[],        // List of issues found
 * }
 */
function verifyCheckpointOnResume(state) {
  const issues = [];
  const checkpoint = state.data._checkpoint;

  // No checkpoint — first run or very old state
  if (!checkpoint) {
    logInfo("[Checkpoint] No checkpoint found — this is likely a first run or pre-checkpoint state");
    return {
      valid: true,
      stage: state.stage,
      rollback: false,
      rollbackTo: null,
      issues: [],
    };
  }

  logInfo(`[Checkpoint] Verifying checkpoint for stage "${checkpoint.stage}" (from ${checkpoint.entryTime})`);

  // 1. Stage consistency: checkpoint stage should match state.stage
  if (checkpoint.stage !== state.stage) {
    issues.push(`Stage mismatch: checkpoint="${checkpoint.stage}", state="${state.stage}"`);
    // The state.stage was likely updated after checkpoint but before crash
    // Trust state.stage as it's more recent
    logWarn(`[Checkpoint] Stage mismatch — checkpoint was for "${checkpoint.stage}" but state is at "${state.stage}"`);
  }

  // 2. Config snapshot consistency
  if (checkpoint.configSnapshotHash && state.data._config_snapshot) {
    const currentHash = _hashObject(state.data._config_snapshot);
    if (currentHash !== checkpoint.configSnapshotHash) {
      issues.push("Config snapshot hash mismatch — config may have changed between runs");
      logWarn("[Checkpoint] Config snapshot changed since last checkpoint");
    }
  }

  // 3. Check if we crashed mid-stage (checkpoint exists but stage not completed)
  const lastCompleted = state.data._last_completed_stage;
  const currentStageIdx = STAGES.indexOf(state.stage);
  const lastCompletedIdx = lastCompleted ? STAGES.indexOf(lastCompleted) : -1;

  if (currentStageIdx > lastCompletedIdx + 1) {
    issues.push(`Stage gap: last completed="${lastCompleted}" but current="${state.stage}" (expected next stage after completed)`);
    logWarn(`[Checkpoint] Stage gap detected — may have skipped stages`);
  }

  // 4. Check for data corruption indicators
  const prereqs = _checkPrerequisites(state);
  if (!prereqs.ok && prereqs.missing.length > 0) {
    issues.push(`Missing prerequisites for "${state.stage}": ${prereqs.missing.join(", ")}`);
  }

  // 5. Determine if rollback is needed
  let rollback = false;
  let rollbackTo = null;

  // Rollback if current stage has missing prerequisites AND we can go back
  if (!prereqs.ok && prereqs.missing.length > 0 && lastCompleted) {
    // Find the most recent stage that was successfully completed
    // and whose prerequisites are satisfied
    const rollbackCandidates = STAGES.filter((s, idx) => {
      if (idx >= currentStageIdx) return false;
      const completion = state.data._stage_completions && state.data._stage_completions[s];
      return !!completion;
    });

    if (rollbackCandidates.length > 0) {
      // Roll back to the stage AFTER the last completed one
      const lastGoodStage = rollbackCandidates[rollbackCandidates.length - 1];
      const lastGoodIdx = STAGES.indexOf(lastGoodStage);
      if (lastGoodIdx + 1 < STAGES.length) {
        rollbackTo = STAGES[lastGoodIdx + 1];
        rollback = true;
        logWarn(`[Checkpoint] Rolling back to "${rollbackTo}" (last good: "${lastGoodStage}")`);
      }
    }
  }

  // Log issues
  if (issues.length > 0) {
    logWarn(`[Checkpoint] ${issues.length} issue(s) found during verification:`);
    for (const issue of issues) {
      logWarn(`[Checkpoint]   - ${issue}`);
    }
  } else {
    logInfo("[Checkpoint] Checkpoint verification passed");
  }

  return {
    valid: issues.length === 0,
    stage: rollback ? rollbackTo : state.stage,
    rollback,
    rollbackTo,
    issues,
  };
}

/**
 * Apply rollback: set state.stage to the rollback target and clear downstream data.
 */
function applyRollback(state, rollbackTo, clearDownstreamFn) {
  const previousStage = state.stage;
  state.stage = rollbackTo;

  if (clearDownstreamFn) {
    clearDownstreamFn(state, rollbackTo);
  }

  logWarn(`[Checkpoint] Rolled back from "${previousStage}" to "${rollbackTo}"`);

  // Record rollback in state
  if (!state.data._rollbacks) state.data._rollbacks = [];
  state.data._rollbacks.push({
    from: previousStage,
    to: rollbackTo,
    timestamp: new Date().toISOString(),
    reason: "checkpoint_verification_failed",
  });
  if (state.data._rollbacks.length > 10) {
    state.data._rollbacks = state.data._rollbacks.slice(-10);
  }
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Check prerequisites for the current stage.
 */
function _checkPrerequisites(state) {
  // Import STAGE_REQUIREMENTS inline to avoid circular deps
  const { STAGE_REQUIREMENTS } = require("./constants");

  const reqs = STAGE_REQUIREMENTS[state.stage] || [];
  const present = [];
  const missing = [];

  for (const field of reqs) {
    if (state.data[field] !== undefined && state.data[field] !== null) {
      present.push(field);
    } else {
      missing.push(field);
    }
  }

  return {
    ok: missing.length === 0,
    present,
    missing,
    summary: missing.length === 0 ? "all_met" : `missing:${missing.join(",")}`,
  };
}

/**
 * Compute a hash of critical state fields for integrity checking.
 * Not a full state hash — just the important bits.
 */
function _computeStateHash(state) {
  const criticalData = {
    stage: state.stage,
    ticket: state.ticket,
    code_branch: state.data.code_branch || null,
    code_mr_iid: state.data.code_mr_iid || null,
    preprod_mr_iid: state.data.preprod_mr_iid || null,
    completedGates: state.data._completedGates || [],
  };
  return crypto.createHash("sha256")
    .update(JSON.stringify(criticalData))
    .digest("hex")
    .substring(0, 24);
}

/**
 * Hash an object for comparison.
 */
function _hashObject(obj) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(obj))
    .digest("hex")
    .substring(0, 24);
}

module.exports = {
  createCheckpoint,
  saveCheckpoint,
  markStageCompleted,
  verifyCheckpointOnResume,
  applyRollback,
};
