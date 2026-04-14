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

import * as crypto from 'crypto';
import type {
  PipelineState,
  StageName,
  CheckpointData,
  CheckpointHistoryEntry,
  CheckpointPrerequisites,
  CheckpointVerification,
} from '@shared/types';
import { STAGES, STAGE_REQUIREMENTS } from '@shared/constants';
import { logInfo, logWarn, logDebug } from '../lib/logger';

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Hash an arbitrary object for comparison.
 * Produces a truncated (24-char) hex SHA256 digest.
 */
function hashObject(obj: unknown): string {
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
function computeStateHash(state: PipelineState): string {
  const data = state.data as Record<string, unknown>;
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
function checkPrerequisites(state: PipelineState): CheckpointPrerequisites {
  const reqs = STAGE_REQUIREMENTS[state.stage] || [];
  const present: string[] = [];
  const missing: string[] = [];
  const data = state.data as Record<string, unknown>;

  for (const field of reqs) {
    if (data[field] !== undefined && data[field] !== null) {
      present.push(field);
    } else {
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
export function createCheckpoint(
  state: PipelineState,
  _cfg?: unknown,
): CheckpointData | null {
  if (!state || !state.data) return null;

  const data = state.data as Record<string, unknown>;

  const checkpoint: CheckpointData = {
    stage: state.stage,
    entryTime: new Date().toISOString(),
    entryTimeMs: Date.now(),
    previousStage: (state.data._last_completed_stage as StageName) || null,
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
export function saveCheckpoint(
  state: PipelineState,
  cfg?: unknown,
): CheckpointData | undefined {
  const checkpoint = createCheckpoint(state, cfg);
  if (!checkpoint) return undefined;

  state.data._checkpoint = checkpoint;

  // Maintain ring buffer history (last 20)
  if (!state.data._checkpoint_history) {
    state.data._checkpoint_history = [];
  }

  const historyEntry: CheckpointHistoryEntry = {
    stage: checkpoint.stage,
    entryTime: checkpoint.entryTime,
    stateHash: checkpoint.stateHash,
    prerequisites: checkpoint.prerequisites.summary,
  };

  state.data._checkpoint_history.push(historyEntry);

  if (state.data._checkpoint_history.length > MAX_CHECKPOINT_HISTORY) {
    state.data._checkpoint_history = state.data._checkpoint_history.slice(
      -MAX_CHECKPOINT_HISTORY,
    );
  }

  logDebug(
    `[Checkpoint] Saved for stage "${state.stage}" (hash: ${checkpoint.stateHash.substring(0, 12)})`,
  );

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
export function markStageCompleted(state: PipelineState, stageName: StageName): void {
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
export function verifyCheckpointOnResume(state: PipelineState): CheckpointVerification {
  const issues: string[] = [];
  const checkpoint = state.data._checkpoint;

  // No checkpoint -- first run or pre-checkpoint state
  if (!checkpoint) {
    logInfo('[Checkpoint] No checkpoint found -- this is likely a first run or pre-checkpoint state');
    return {
      valid: true,
      stage: state.stage,
      rollback: false,
      rollbackTo: null,
      issues: [],
    };
  }

  logInfo(
    `[Checkpoint] Verifying checkpoint for stage "${checkpoint.stage}" (from ${checkpoint.entryTime})`,
  );

  // 1. Stage consistency: checkpoint stage should match state.stage
  if (checkpoint.stage !== state.stage) {
    issues.push(
      `Stage mismatch: checkpoint="${checkpoint.stage}", state="${state.stage}"`,
    );
    // state.stage was likely updated after checkpoint but before crash
    // Trust state.stage as it's more recent
    logWarn(
      `[Checkpoint] Stage mismatch -- checkpoint was for "${checkpoint.stage}" ` +
      `but state is at "${state.stage}"`,
    );
  }

  // 2. Config snapshot consistency
  if (checkpoint.configSnapshotHash && state.data._config_snapshot) {
    const currentHash = hashObject(state.data._config_snapshot);
    if (currentHash !== checkpoint.configSnapshotHash) {
      issues.push('Config snapshot hash mismatch -- config may have changed between runs');
      logWarn('[Checkpoint] Config snapshot changed since last checkpoint');
    }
  }

  // 3. Check if we crashed mid-stage (checkpoint exists but stage not completed)
  const lastCompleted = state.data._last_completed_stage;
  const currentStageIdx = STAGES.indexOf(state.stage);
  const lastCompletedIdx = lastCompleted
    ? STAGES.indexOf(lastCompleted as StageName)
    : -1;

  if (currentStageIdx > lastCompletedIdx + 1) {
    issues.push(
      `Stage gap: last completed="${lastCompleted}" but current="${state.stage}" ` +
      `(expected next stage after completed)`,
    );
    logWarn('[Checkpoint] Stage gap detected -- may have skipped stages');
  }

  // 4. Check for data corruption indicators
  const prereqs = checkPrerequisites(state);
  if (!prereqs.ok && prereqs.missing.length > 0) {
    issues.push(
      `Missing prerequisites for "${state.stage}": ${prereqs.missing.join(', ')}`,
    );
  }

  // 5. Determine if rollback is needed
  let rollback = false;
  let rollbackTo: StageName | null = null;

  // Rollback if current stage has missing prerequisites AND we can go back
  if (!prereqs.ok && prereqs.missing.length > 0 && lastCompleted) {
    // Find the most recent stage that was successfully completed
    const rollbackCandidates = STAGES.filter((s, idx) => {
      if (idx >= currentStageIdx) return false;
      const completion =
        state.data._stage_completions && state.data._stage_completions[s];
      return !!completion;
    });

    if (rollbackCandidates.length > 0) {
      // Roll back to the stage AFTER the last completed one
      const lastGoodStage = rollbackCandidates[rollbackCandidates.length - 1];
      const lastGoodIdx = STAGES.indexOf(lastGoodStage);
      if (lastGoodIdx + 1 < STAGES.length) {
        rollbackTo = STAGES[lastGoodIdx + 1] as StageName;
        rollback = true;
        logWarn(
          `[Checkpoint] Rolling back to "${rollbackTo}" (last good: "${lastGoodStage}")`,
        );
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
    logInfo('[Checkpoint] Checkpoint verification passed');
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
export function applyRollback(
  state: PipelineState,
  rollbackTo: StageName,
  clearDownstreamFn?: (state: PipelineState, stage: StageName) => void,
): PipelineState {
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
    reason: 'checkpoint_verification_failed',
  });

  if (state.data._rollbacks.length > MAX_ROLLBACK_HISTORY) {
    state.data._rollbacks = state.data._rollbacks.slice(-MAX_ROLLBACK_HISTORY);
  }

  return state;
}
