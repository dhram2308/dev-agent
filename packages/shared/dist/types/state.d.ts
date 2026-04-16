import type { PipelineState } from '../types';
/**
 * Mutator function used by updateSync() and updateAsync().
 * Receives the current state, may mutate it in place, and optionally returns it.
 * If the mutator returns a state object, that object is used; otherwise the
 * original (mutated) state is used.
 */
export type StateMutator = (state: PipelineState) => PipelineState | void | Promise<PipelineState | void>;
/**
 * Result of readStateFromDisk() in lib/state-unified.js.
 * Wraps the loaded state with metadata about its source and sequence number.
 */
export interface IReadResult {
    /** The unwrapped pipeline state object */
    state: PipelineState;
    /** Sequence number from the envelope (for CAS) */
    seq: number;
    /** Where the state was loaded from */
    source: 'main' | 'backup' | 'main_unverified' | 'backup_unverified';
}
/**
 * UI approval check result returned by checkUIApprovalSync().
 * The server writes _ui_* fields to disk; the agent polls for them.
 */
export interface UIApproval {
    /** Whether the gate was approved */
    approved: boolean;
    /** Rejection feedback (present when approved is false and not a refine) */
    feedback?: string;
    /** Whether this is a "refine" action (re-run with new instructions) */
    refine?: boolean;
    /** Refine instructions from the user (present when refine is true) */
    instructions?: string;
}
/**
 * Result of pruneState() when pruning was actually performed.
 * The pruning metadata is stored in state.data._pruned_at and state.data._pruned_saved.
 */
export interface PruneResult {
    /** ISO 8601 timestamp when pruning occurred */
    prunedAt: string;
    /** Number of bytes saved by pruning */
    bytesSaved: number;
}
/**
 * Options for the state manager's load/save/update functions.
 */
export interface StateManagerOptions {
    /** Allow loading unverified v1/v2 state files (migration mode). Defaults to true. */
    allowUnverified?: boolean;
    /** Warning callback invoked for non-fatal state issues */
    onWarn?: (message: string) => void;
}
/**
 * Options for the file-based advisory lock in lib/state-lock.js.
 */
export interface StateLockOptions {
    /** Maximum time to wait for the lock in ms (default: 5000) */
    timeoutMs?: number;
    /** Interval between lock acquisition retries in ms (default: 50) */
    retryIntervalMs?: number;
}
/**
 * A file lock handle returned by acquireLockSync() / acquireLockAsync().
 */
export interface StateLock {
    /** Release the lock. Must be called in a finally block. */
    release: () => void;
}
/**
 * Result of unwrapEnvelope() — intermediate format before full validation.
 */
export interface UnwrapResult {
    /** The unwrapped state object */
    state: PipelineState;
    /** Sequence number */
    seq: number;
    /** Whether the HMAC verification passed */
    valid: boolean;
    /** Envelope version (1, 2, or 3) */
    version: number;
}
/**
 * Recovery action taken for orphaned .tmp state files.
 * Returned by recoverTmpFiles().
 */
export interface TmpRecoveryAction {
    /** The .tmp filename that was recovered */
    file: string;
    /** What was done with the file */
    action: 'promoted_to_main' | 'removed_orphan';
}
//# sourceMappingURL=state.d.ts.map