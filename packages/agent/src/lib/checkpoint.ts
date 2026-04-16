/**
 * checkpoint.ts — Checkpoint & Resume System
 *
 * Converted from lib/checkpoint.js (zero functional changes).
 *
 * Solves crash recovery:
 * - Before each stage, save a detailed checkpoint
 * - On resume after crash, verify checkpoint consistency
 * - If inconsistent, roll back to last known-good stage
 * - Track checkpoint history for debugging
 */

import crypto from "crypto";

import type {
  CheckpointData,
  CheckpointPrerequisites,
  CheckpointVerification,
  StageName,
} from "@mi/shared";

import { STAGES, STAGE_REQUIREMENTS } from "./constants";

// Hub file not yet converted — use require
const { logInfo, logWarn, logErr, logDebug } = require("./logging") as {
  logInfo: (msg: string) => void;
  logWarn: (msg: string) => void;
  logErr: (msg: string) => void;
  logDebug: (msg: string) => void;
};

// ── Checkpoint data structure ───────────────────────────────────────

/**
 * Create a checkpoint before stage execution.
 */
function createCheckpoint(state: any, cfg?: any): CheckpointData | null {
  if (!state || !state.data) return null;

  const checkpoint: CheckpointData = {
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

    // Prerequisites check
    prerequisites: _checkPrerequisites(state),

    // State integrity hash
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
function saveCheckpoint(state: any, cfg?: any): CheckpointData | undefined {
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
 */
function markStageCompleted(state: any, stageName: string): void {
  state.data._last_completed_stage = stageName;
  state.data._last_completed_time = new Date().toISOString();

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
 */
function verifyCheckpointOnResume(state: any): CheckpointVerification {
  const issues: string[] = [];
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

  // 1. Stage consistency
  if (checkpoint.stage !== state.stage) {
    issues.push(`Stage mismatch: checkpoint="${checkpoint.stage}", state="${state.stage}"`);
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

  // 3. Check if we crashed mid-stage
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
  let rollbackTo: StageName | null = null;

  if (!prereqs.ok && prereqs.missing.length > 0 && lastCompleted) {
    const rollbackCandidates = STAGES.filter((s: string, idx: number) => {
      if (idx >= currentStageIdx) return false;
      const completion = state.data._stage_completions && state.data._stage_completions[s];
      return !!completion;
    });

    if (rollbackCandidates.length > 0) {
      const lastGoodStage = rollbackCandidates[rollbackCandidates.length - 1];
      const lastGoodIdx = STAGES.indexOf(lastGoodStage);
      if (lastGoodIdx + 1 < STAGES.length) {
        rollbackTo = STAGES[lastGoodIdx + 1] as StageName;
        rollback = true;
        logWarn(`[Checkpoint] Rolling back to "${rollbackTo}" (last good: "${lastGoodStage}")`);
      }
    }
  }

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
    stage: rollback ? rollbackTo! : state.stage,
    rollback,
    rollbackTo,
    issues,
  };
}

/**
 * Apply rollback: set state.stage to the rollback target and clear downstream data.
 */
function applyRollback(state: any, rollbackTo: string, clearDownstreamFn?: (state: any, rollbackTo: string) => void): void {
  const previousStage = state.stage;
  state.stage = rollbackTo;

  if (clearDownstreamFn) {
    clearDownstreamFn(state, rollbackTo);
  }

  logWarn(`[Checkpoint] Rolled back from "${previousStage}" to "${rollbackTo}"`);

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
function _checkPrerequisites(state: any): CheckpointPrerequisites {
  const reqs = STAGE_REQUIREMENTS[state.stage as keyof typeof STAGE_REQUIREMENTS] || [];
  const present: string[] = [];
  const missing: string[] = [];

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
 */
function _computeStateHash(state: any): string {
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
function _hashObject(obj: any): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify(obj))
    .digest("hex")
    .substring(0, 24);
}

export {
  createCheckpoint,
  saveCheckpoint,
  markStageCompleted,
  verifyCheckpointOnResume,
  applyRollback,
};
