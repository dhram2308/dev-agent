"use strict";

/**
 * server/state-io.js — Server-side state API (unified)
 *
 * This file is now a thin shim that delegates ALL state operations to the
 * unified state manager (state-unified.js) via the migration bridge
 * (state-migration.js). All callers of server/state-io.js get:
 *
 *   - Exclusive file locking on every write
 *   - HMAC verification on every read
 *   - Atomic tmp-rename writes
 *   - CAS (compare-and-swap) via monotonic sequence counter
 *   - State size management with auto-pruning
 *
 * Exports are 100% backward-compatible with the old state-io.js API:
 *   unwrapStateEnvelope, getState, writeStateAsync, readStateAsync,
 *   saveReviewComments, getReviewComments, loadEnv,
 *   patchUIAsync, updateAsync
 */

module.exports = require("../lib/state-migration").serverAPI;
