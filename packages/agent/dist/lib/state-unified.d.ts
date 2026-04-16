/**
 * state-unified.ts -- Unified State Manager for MI Dev Agent
 *
 * Converted from lib/state-unified.js (zero functional changes).
 *
 * Single source of truth for all state reads/writes. Replaces both
 * lib/state.js and server/state-io.js with a single module that provides:
 *
 *   1. Exclusive file locking (via state-lock.js)
 *   2. Mandatory HMAC verification with quarantine on mismatch
 *   3. Atomic write (tmp -> rename) with crash recovery
 *   4. CAS (compare-and-swap) using monotonic _seq counter
 *   5. Field-level merge: UI writes _ui_* fields, agent writes everything else
 *   6. State size management with auto-pruning
 *   7. Crash recovery: orphaned .tmp detection, corrupt JSON handling
 *   8. Backward-compatible v2 envelope format
 *
 * API:
 *   Sync  (agent):  loadSync(), saveSync(state), updateSync(mutator), checkUIApprovalSync(state, gate)
 *   Async (server):  loadAsync(), saveAsync(state), updateAsync(mutator), patchUIAsync(ticket, gate, fields)
 */
export {};
//# sourceMappingURL=state-unified.d.ts.map