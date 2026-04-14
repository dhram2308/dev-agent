import type { PipelineState, StageName, CheckpointData, CheckpointVerification } from '@shared/types';
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
export declare function createCheckpoint(state: PipelineState, _cfg?: unknown): CheckpointData | null;
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
export declare function saveCheckpoint(state: PipelineState, cfg?: unknown): CheckpointData | undefined;
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
export declare function markStageCompleted(state: PipelineState, stageName: StageName): void;
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
export declare function verifyCheckpointOnResume(state: PipelineState): CheckpointVerification;
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
export declare function applyRollback(state: PipelineState, rollbackTo: StageName, clearDownstreamFn?: (state: PipelineState, stage: StageName) => void): PipelineState;
