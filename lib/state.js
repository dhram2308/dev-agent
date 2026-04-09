"use strict";

/**
 * lib/state.js — Agent-side state API (unified)
 *
 * This file is now a thin shim that delegates ALL state operations to the
 * unified state manager (state-unified.js) via the migration bridge
 * (state-migration.js). All callers of lib/state.js get:
 *
 *   - Exclusive file locking on every write
 *   - HMAC verification on every read
 *   - Atomic tmp-rename writes
 *   - Field-level merge (UI fields preserved across agent writes)
 *   - State size management with auto-pruning
 *   - Crash recovery (orphaned .tmp cleanup)
 *
 * Exports are 100% backward-compatible with the old state.js API:
 *   loadState, save, stateSecret, checkUIApproval, getCurrentState, setCurrentState
 */

module.exports = require("./state-migration").agentAPI;
