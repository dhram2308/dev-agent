// ===================================================================
// MI Dev Agent -- State I/O (TypeScript port of server-side state ops)
//
// Async state I/O for server context where multiple concurrent requests
// may read/write the same state file. All operations go through lock.ts
// for thread safety.
//
// This module provides the server-facing API:
//   - getState(ticket)      -- read state (read-only, no lock)
//   - writeStateAsync()     -- full state write with lock + HMAC
//   - patchUIAsync()        -- UI-only field merge (approve/reject/refine)
//   - updateAsync()         -- read-modify-write with lock held
//   - saveReviewComments()  -- persist review comments in state
//
// Ported from: lib/state-unified.js (async API section)
// ===================================================================

import * as path from 'path';
import type { PipelineState, PipelineData } from '@shared/types';
import { logWarn, logInfo } from '../lib/logger';
import { acquireLockAsync } from './lock';
import {
  readStateFromDisk,
  recoverTmpFiles,
  stateSecret,
  wrapEnvelope,
  atomicWriteAsync,
  pruneState,
  mergeUIFieldsFromDisk,
  applyUIPatch,
} from './state-manager';

// ── Configuration ─────────────────────────────────────────────────

/** Default base directory for state files. */
function defaultBaseDir(): string {
  return path.join(__dirname, '..', '..', '..', '..');
}

// ── Startup: Orphaned .tmp cleanup ────────────────────────────────

let _startupCleanupDone = false;

/**
 * Clean orphaned .tmp files on first call. Idempotent.
 * Called automatically by getState() and writeStateAsync().
 */
function ensureStartupCleanup(stateFilePath: string): void {
  if (_startupCleanupDone) return;
  _startupCleanupDone = true;
  const recovered = recoverTmpFiles(stateFilePath);
  if (recovered.length > 0) {
    logInfo(`[StateIO] Startup cleanup: ${recovered.length} orphaned tmp file(s) handled`);
  }
}

/** Reset startup cleanup flag (for testing). */
export function _resetStartupCleanup(): void {
  _startupCleanupDone = false;
}

// ── Read State ────────────────────────────────────────────────────

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
export async function getState(
  ticket: string,
  baseDir?: string
): Promise<PipelineState | null> {
  const dir = baseDir || defaultBaseDir();
  const stateFilePath = path.join(dir, `state-${ticket}.json`);

  // One-time startup cleanup
  ensureStartupCleanup(stateFilePath);

  const result = readStateFromDisk(stateFilePath, {
    allowUnverified: true,
    onWarn: (msg: string) => logWarn(msg),
  });

  if (result) {
    const state = result.state;
    if (!state._seq) state._seq = result.seq || 1;
    return state;
  }

  return null;
}

// ── Write State (full replace) ────────────────────────────────────

/**
 * Write the full state to disk with exclusive lock, HMAC envelope, and
 * atomic write. Merges UI fields from disk before writing to prevent
 * overwriting concurrent UI approvals.
 *
 * @param ticket - Jira ticket ID
 * @param state - The full PipelineState to write
 * @param baseDir - Optional base directory for state files
 */
export async function writeStateAsync(
  ticket: string,
  state: PipelineState,
  baseDir?: string
): Promise<void> {
  const dir = baseDir || defaultBaseDir();
  const stateFilePath = path.join(dir, `state-${ticket}.json`);

  ensureStartupCleanup(stateFilePath);

  const release = await acquireLockAsync(stateFilePath);
  try {
    // Re-read disk for CAS validation and UI field merge
    const diskResult = readStateFromDisk(stateFilePath, {
      allowUnverified: true,
      onWarn: (msg: string) => logWarn(msg),
    });

    if (diskResult) {
      // CAS guard: verify disk _seq matches expected in-memory _seq
      const memSeq = state._seq || 0;
      const diskSeq = diskResult.seq || diskResult.state._seq || 0;
      if (memSeq > 0 && diskSeq > 0 && memSeq !== diskSeq) {
        logWarn(
          `[StateIO CAS] CAS conflict: expected seq ${memSeq}, found ${diskSeq} -- merging`
        );
        mergeUIFieldsFromDisk(state, diskResult.state);
        state._seq = diskSeq; // Adopt disk seq for correct increment
      } else {
        mergeUIFieldsFromDisk(state, diskResult.state);
      }
    }

    // Bump sequence number
    state._seq = (state._seq || 0) + 1;
    state.data = state.data || ({} as PipelineData);
    (state.data as Record<string, unknown>)._lastActivity = new Date().toISOString();

    // Prune if needed
    pruneState(state);

    // Write with HMAC envelope
    const secret = stateSecret();
    const envelope = wrapEnvelope(state, secret);
    await atomicWriteAsync(stateFilePath, envelope);
  } finally {
    release();
  }
}

// ── Patch UI Fields ───────────────────────────────────────────────

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
export async function patchUIAsync(
  ticket: string,
  patch: Partial<PipelineState['data']>,
  baseDir?: string
): Promise<void> {
  const dir = baseDir || defaultBaseDir();
  const stateFilePath = path.join(dir, `state-${ticket}.json`);

  const release = await acquireLockAsync(stateFilePath);
  try {
    // Read current state
    const diskResult = readStateFromDisk(stateFilePath, {
      allowUnverified: true,
      onWarn: (msg: string) => logWarn(msg),
    });

    if (!diskResult) {
      throw new Error(`Cannot patch UI: no state file found for ticket ${ticket}`);
    }

    let state = diskResult.state;
    if (!state._seq) state._seq = diskResult.seq || 1;
    if (!state.data) state.data = {} as PipelineData;

    // Apply UI fields
    const data = state.data as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (value === undefined || value === null) {
        delete data[key];
      } else {
        data[key] = value;
      }
    }

    // Bump seq and write
    state._seq = (state._seq || 0) + 1;
    data._lastActivity = new Date().toISOString();

    pruneState(state);

    const secret = stateSecret();
    const envelope = wrapEnvelope(state, secret);
    await atomicWriteAsync(stateFilePath, envelope);
  } finally {
    release();
  }
}

/**
 * Apply a UI patch using gate prefix + suffix fields.
 * This is the gate-aware version used by server route handlers.
 *
 * @param ticket - Jira ticket ID
 * @param gate - Gate prefix (e.g., "gate1", "gate2b", "explore_plan")
 * @param uiFields - Fields to set/delete (e.g., { "_ui_approved": true })
 * @param baseDir - Optional base directory
 */
export async function patchUIWithGateAsync(
  ticket: string,
  gate: string,
  uiFields: Record<string, unknown>,
  baseDir?: string
): Promise<void> {
  const dir = baseDir || defaultBaseDir();
  const stateFilePath = path.join(dir, `state-${ticket}.json`);

  await updateAsync(ticket, async (state) => {
    return applyUIPatch(state, gate, uiFields);
  }, dir);
}

// ── Read-Modify-Write ─────────────────────────────────────────────

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
export async function updateAsync(
  ticket: string,
  mutator: (state: PipelineState) => PipelineState | Promise<PipelineState>,
  baseDir?: string
): Promise<PipelineState> {
  const dir = baseDir || defaultBaseDir();
  const stateFilePath = path.join(dir, `state-${ticket}.json`);

  const release = await acquireLockAsync(stateFilePath);
  try {
    // Read current state
    const diskResult = readStateFromDisk(stateFilePath, {
      allowUnverified: true,
      onWarn: (msg: string) => logWarn(msg),
    });

    if (!diskResult) {
      throw new Error(`Cannot update: no state file found for ticket ${ticket}`);
    }

    let state = diskResult.state;
    if (!state._seq) state._seq = diskResult.seq || 1;
    const readSeq = state._seq;

    // Apply mutation (supports both sync and async mutators)
    state = (await mutator(state)) || state;

    // Bump seq
    state._seq = readSeq + 1;
    state.data = state.data || ({} as PipelineData);
    (state.data as Record<string, unknown>)._lastActivity = new Date().toISOString();

    // Prune if needed
    pruneState(state);

    // Write with HMAC envelope
    const secret = stateSecret();
    const envelope = wrapEnvelope(state, secret);
    await atomicWriteAsync(stateFilePath, envelope);

    return state;
  } finally {
    release();
  }
}

// ── Review Comments ───────────────────────────────────────────────

/**
 * Save review comments into the state file.
 * Uses updateAsync for safe read-modify-write.
 *
 * @param ticket - Jira ticket ID
 * @param comments - Review comments object to persist
 * @param baseDir - Optional base directory
 * @returns true on success, false on failure
 */
export async function saveReviewComments(
  ticket: string,
  comments: Record<string, unknown>,
  baseDir?: string
): Promise<boolean> {
  try {
    await updateAsync(ticket, async (state) => {
      (state.data as Record<string, unknown>)._reviewComments = comments;
      return state;
    }, baseDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get review comments from the state (read-only, no lock).
 *
 * @param ticket - Jira ticket ID
 * @param baseDir - Optional base directory
 * @returns Review comments object, or empty object
 */
export async function getReviewComments(
  ticket: string,
  baseDir?: string
): Promise<Record<string, unknown>> {
  const state = await getState(ticket, baseDir);
  return ((state?.data as Record<string, unknown>)?._reviewComments as Record<string, unknown>) || {};
}
