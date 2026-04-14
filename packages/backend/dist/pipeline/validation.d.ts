import type { PipelineState, StageName } from '@shared/types';
/**
 * Check that all required data fields exist for the current stage.
 *
 * This is a soft validation -- it logs warnings but does NOT throw.
 * Some fields may legitimately be set during the stage itself (e.g.,
 * `code_mr_iid` is created during `generate_code`).
 *
 * Missing fields are recorded in `state.data._warnings` for diagnostics.
 *
 * @param state - Current pipeline state
 */
export declare function validateStageEntry(state: PipelineState): void;
/**
 * Verify that all required gates have been completed before production deploy.
 *
 * This is a hard validation -- it THROWS if any required gate is missing.
 * Only enforced at the `deploy_prod` stage.
 *
 * Required gates: every stage from fetch_ticket through gate_dual_approval
 * must appear in `state.data._completedGates`.
 *
 * @param state - Current pipeline state
 * @throws Error if any required gates are missing
 */
export declare function validateCompletedGates(state: PipelineState): void;
/**
 * Wipe stale downstream data when re-entering a stage.
 *
 * When a stage is re-entered (e.g., code generation after review rejection),
 * all data fields listed in STAGE_CLEARS for that stage are set to null.
 * This prevents downstream stages from using outdated artifacts.
 *
 * @param state - Current pipeline state
 * @param targetStage - The stage being re-entered
 */
export declare function clearDownstreamData(state: PipelineState, targetStage: StageName): void;
