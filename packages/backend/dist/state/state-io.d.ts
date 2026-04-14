import type { PipelineState } from '@shared/types';
/** Reset startup cleanup flag (for testing). */
export declare function _resetStartupCleanup(): void;
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
export declare function getState(ticket: string, baseDir?: string): Promise<PipelineState | null>;
/**
 * Write the full state to disk with exclusive lock, HMAC envelope, and
 * atomic write. Merges UI fields from disk before writing to prevent
 * overwriting concurrent UI approvals.
 *
 * @param ticket - Jira ticket ID
 * @param state - The full PipelineState to write
 * @param baseDir - Optional base directory for state files
 */
export declare function writeStateAsync(ticket: string, state: PipelineState, baseDir?: string): Promise<void>;
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
export declare function patchUIAsync(ticket: string, patch: Partial<PipelineState['data']>, baseDir?: string): Promise<void>;
/**
 * Apply a UI patch using gate prefix + suffix fields.
 * This is the gate-aware version used by server route handlers.
 *
 * @param ticket - Jira ticket ID
 * @param gate - Gate prefix (e.g., "gate1", "gate2b", "explore_plan")
 * @param uiFields - Fields to set/delete (e.g., { "_ui_approved": true })
 * @param baseDir - Optional base directory
 */
export declare function patchUIWithGateAsync(ticket: string, gate: string, uiFields: Record<string, unknown>, baseDir?: string): Promise<void>;
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
export declare function updateAsync(ticket: string, mutator: (state: PipelineState) => PipelineState | Promise<PipelineState>, baseDir?: string): Promise<PipelineState>;
/**
 * Save review comments into the state file.
 * Uses updateAsync for safe read-modify-write.
 *
 * @param ticket - Jira ticket ID
 * @param comments - Review comments object to persist
 * @param baseDir - Optional base directory
 * @returns true on success, false on failure
 */
export declare function saveReviewComments(ticket: string, comments: Record<string, unknown>, baseDir?: string): Promise<boolean>;
/**
 * Get review comments from the state (read-only, no lock).
 *
 * @param ticket - Jira ticket ID
 * @param baseDir - Optional base directory
 * @returns Review comments object, or empty object
 */
export declare function getReviewComments(ticket: string, baseDir?: string): Promise<Record<string, unknown>>;
