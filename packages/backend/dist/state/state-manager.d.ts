import type { PipelineState } from '@shared/types';
import { ENVELOPE_VERSION, MAX_STATE_SIZE, PRUNE_THRESHOLD } from '@shared/schema/state';
export { ENVELOPE_VERSION, MAX_STATE_SIZE, PRUNE_THRESHOLD };
/** V3 state envelope written to disk */
export interface StateEnvelopeV3 {
    _version: 3;
    _hmac: string;
    _seq: number;
    _written_by: number | string;
    _written_at: string;
    state: PipelineState;
}
/** V2 state envelope (legacy, read-only backward compat) */
export interface StateEnvelopeV2 {
    _version: 2;
    _hmac: string;
    state: PipelineState;
}
/** Result from unwrapping an on-disk envelope */
export interface UnwrapResult {
    state: PipelineState;
    seq: number;
    valid: boolean;
    version: number;
}
/** Result from reading state from disk */
export interface ReadResult {
    state: PipelineState;
    seq: number;
    source: 'main' | 'backup' | 'main_unverified' | 'backup_unverified';
}
/** Options for readStateFromDisk */
export interface ReadOpts {
    allowUnverified?: boolean;
    onWarn?: (msg: string) => void;
    onDebug?: (msg: string) => void;
}
/** Options for save operations */
export interface SaveOpts {
    onWarn?: (msg: string) => void;
    onDebug?: (msg: string) => void;
}
/** Defaults for creating fresh state */
export interface StateDefaults {
    stage: PipelineState['stage'];
    ticket: string;
}
/** Recovered tmp file info */
export interface RecoveredFile {
    file: string;
    action: 'promoted_to_main' | 'removed_orphan';
}
/**
 * Initialize and return the HMAC secret. Reads or creates .state-secret.
 * @param baseDir - Base directory for the secret file (defaults to project root)
 */
export declare function initSecret(baseDir?: string): Buffer;
/**
 * Get the cached HMAC secret string. Creates it if not yet initialized.
 */
export declare function stateSecret(baseDir?: string): string;
/** Allow injection of a secret for testing. */
export declare function _setStateSecret(s: string | null): void;
/**
 * Compute HMAC-SHA256 over a state object.
 * Uses Rust native addon if available, falls back to Node.js crypto.
 */
export declare function computeHmac(stateObj: PipelineState, secret: string): string;
/**
 * Wrap a state object in a V3 HMAC envelope for disk storage.
 * Increments _seq on each wrap.
 */
export declare function wrapEnvelope(stateObj: PipelineState, secret: string): StateEnvelopeV3;
/**
 * Unwrap a state envelope from raw JSON. Validates HMAC strictly.
 *
 * @param raw - Raw JSON string from disk
 * @param secret - HMAC secret
 * @param label - "main" or "backup" for diagnostics
 * @returns Unwrapped state with validity flag
 * @throws If JSON is unparseable or format is unrecognized
 */
export declare function unwrapEnvelope(raw: string, secret: string, label?: string): UnwrapResult;
/**
 * Move a corrupt state file to quarantine directory.
 * Returns the destination path, or null if quarantine failed.
 */
export declare function quarantineFile(filePath: string, baseDir: string): string | null;
/**
 * Scan for orphaned .tmp files from crashed writes.
 * Promotes a valid orphan to main if no main file exists; otherwise removes it.
 * Files younger than 10s are left alone (possibly in-progress writes).
 */
export declare function recoverTmpFiles(stateFilePath: string): RecoveredFile[];
/**
 * Prune oversized state by trimming non-essential historical data.
 * Operates in 4 levels of increasing aggression:
 *   1. Trim metrics runs to last 3 per stage
 *   2. Trim warnings to last 50
 *   3. Trim rejection history to last 5
 *   4. Remove large debug/trace fields (>50KB)
 */
export declare function pruneState(state: PipelineState): PipelineState;
/**
 * Merge UI fields from disk state into in-memory state.
 * Called by the agent before writing. Preserves UI fields set by the server
 * that the agent doesn't know about yet.
 */
export declare function mergeUIFieldsFromDisk(memoryState: PipelineState, diskState: PipelineState): void;
/**
 * Apply a UI patch: only writes UI-namespaced fields, returns the full state.
 * Server route handlers use this instead of full state writes.
 *
 * @param diskState - Current state from disk
 * @param gate - Gate prefix (e.g., "gate1", "gate2b", "explore_plan")
 * @param uiFields - Fields to set/delete (e.g., { _ui_approved: true })
 * @returns Updated state
 */
export declare function applyUIPatch(diskState: PipelineState, gate: string, uiFields: Record<string, unknown>): PipelineState;
/**
 * Write state atomically (sync): tmp -> fsync -> rename.
 * Lock MUST be held by the caller.
 */
export declare function atomicWriteSync(stateFilePath: string, envelope: StateEnvelopeV3): void;
/**
 * Write state atomically (async): tmp -> fsync -> rename.
 * Lock MUST be held by the caller.
 */
export declare function atomicWriteAsync(stateFilePath: string, envelope: StateEnvelopeV3): Promise<void>;
/**
 * Read state from disk with full HMAC verification.
 * If main file is corrupt, tries backup. If both are corrupt,
 * quarantines and returns null.
 *
 * @param stateFilePath - Path to the state-{ticket}.json file
 * @param opts - Read options
 * @returns Read result with state, seq, and source indicator, or null
 */
export declare function readStateFromDisk(stateFilePath: string, opts?: ReadOpts): ReadResult | null;
/**
 * Get the cached in-memory state.
 * Does NOT read from disk; use `load()` for that.
 */
export declare function getCurrentState(): PipelineState | null;
/**
 * Set the cached in-memory state.
 * Does NOT write to disk; use `save()` for that.
 */
export declare function setCurrentState(state: PipelineState | null): void;
/**
 * Load state from disk for a ticket. Handles crash recovery,
 * HMAC verification, and V2/V3 backward compatibility.
 *
 * Returns the deserialized PipelineState, or null if no valid state exists.
 *
 * @param ticket - Jira ticket ID (used to construct state file path)
 * @param opts - Read options (allowUnverified defaults to true)
 * @returns Loaded PipelineState or null
 */
export declare function load(ticket: string, opts?: ReadOpts & {
    baseDir?: string;
}): PipelineState | null;
/**
 * Save state to disk with HMAC envelope and atomic write.
 * Merges UI fields from disk before writing, increments _seq,
 * prunes oversized state, and updates the in-memory cache.
 *
 * NOTE: This function does NOT acquire a lock. The caller is responsible
 * for holding a lock via lock.ts when concurrent access is possible.
 * For agent-side (single-threaded) use, locking may be omitted.
 *
 * @param state - The full PipelineState to save
 * @param opts - Save options
 */
export declare function save(state: PipelineState, opts?: SaveOpts & {
    baseDir?: string;
}): void;
/**
 * Save state to disk asynchronously with HMAC envelope and atomic write.
 * Same behavior as save() but uses async I/O.
 */
export declare function saveAsync(state: PipelineState, opts?: SaveOpts & {
    baseDir?: string;
}): Promise<void>;
/**
 * Check UI approval fields from disk without modifying agent's in-memory state.
 * Returns the UI action if any, or null.
 *
 * @param ticket - Jira ticket ID
 * @param gatePrefix - Gate prefix (e.g., "gate1", "gate2b", "explore_plan")
 * @param baseDir - Optional base directory for the state file
 */
export declare function checkUIApproval(ticket: string, gatePrefix: string, baseDir?: string): {
    approved: boolean;
    feedback?: string;
    refine?: boolean;
    instructions?: string;
} | null;
/**
 * Read state for the server (read-only, no lock needed for reads).
 * Returns unwrapped state or null.
 */
export declare function readForDisplay(ticket: string, baseDir?: string): PipelineState | null;
/**
 * Get review comments from the state for display.
 */
export declare function getReviewComments(ticket: string, baseDir?: string): Record<string, unknown>;
/**
 * Get the full path to a state file for a given ticket.
 */
export declare function getStateFilePath(ticket: string, baseDir?: string): string;
/** Pipeline status values */
export type PipelineStatus = 'running' | 'paused' | 'gate_waiting' | 'done' | 'expired';
/** Summary returned by scanAllStates / getPipelineList */
export interface PipelineSummary {
    ticket: string;
    stage: string;
    startedAt: string | null;
    lastActivity: string | null;
    running: boolean;
    resumable: boolean;
    daysRemaining: number;
    needsApproval: boolean;
    gateStage: string | null;
    progress: number;
    status: PipelineStatus;
    resumeCount: number;
}
/**
 * Scan all state-*.json files from disk.
 * Reads each with HMAC validation, skips corrupt files.
 * Returns raw state data for classification.
 */
export declare function scanAllStates(baseDir?: string): Array<{
    ticket: string;
    state: PipelineState;
    filePath: string;
}>;
/**
 * Classify a scanned state into a PipelineSummary.
 * Cross-references with agentProcs map for running status.
 */
export declare function classifyPipeline(ticket: string, state: PipelineState, isRunning: boolean): PipelineSummary;
/**
 * Build the full pipeline list: scan disk + classify with running status.
 *
 * @param agentProcs - Map of running agent processes (ticket → process)
 * @param baseDir - Base directory for state files
 */
export declare function buildPipelineList(agentProcs: Record<string, unknown>, baseDir?: string): PipelineSummary[];
/**
 * Get the cached pipeline list, rebuilding if stale.
 */
export declare function getCachedPipelineList(agentProcs: Record<string, unknown>, baseDir?: string): PipelineSummary[];
/**
 * Invalidate the pipeline list cache.
 * Call on agent start/stop, state writes, and pipeline deletes.
 */
export declare function invalidatePipelineCache(): void;
/**
 * Clean up stale state files on server startup.
 * Archives done > 30 days and expired > 14 days.
 * Deletes archived files > 7 days old.
 */
export declare function cleanupStaleStates(baseDir?: string): {
    archived: string[];
    deleted: string[];
};
/**
 * Delete a pipeline's state file and log file from disk.
 * Returns true if anything was deleted.
 */
export declare function deletePipeline(ticket: string, baseDir?: string): boolean;
