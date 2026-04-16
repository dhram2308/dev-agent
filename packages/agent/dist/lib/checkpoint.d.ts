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
import type { CheckpointData, CheckpointVerification } from "@mi/shared";
/**
 * Create a checkpoint before stage execution.
 */
declare function createCheckpoint(state: any, cfg?: any): CheckpointData | null;
/**
 * Save a checkpoint into state.
 */
declare function saveCheckpoint(state: any, cfg?: any): CheckpointData | undefined;
/**
 * Mark a stage as successfully completed.
 */
declare function markStageCompleted(state: any, stageName: string): void;
/**
 * Verify checkpoint consistency on resume after a crash.
 */
declare function verifyCheckpointOnResume(state: any): CheckpointVerification;
/**
 * Apply rollback: set state.stage to the rollback target and clear downstream data.
 */
declare function applyRollback(state: any, rollbackTo: string, clearDownstreamFn?: (state: any, rollbackTo: string) => void): void;
export { createCheckpoint, saveCheckpoint, markStageCompleted, verifyCheckpointOnResume, applyRollback, };
//# sourceMappingURL=checkpoint.d.ts.map