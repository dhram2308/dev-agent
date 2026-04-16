"use strict";
// ═══════════════════════════════════════════════════════════════
// server/state-io.ts — Server-side state API (unified)
// Converted from: server/state-io.js (22 lines)
// ═══════════════════════════════════════════════════════════════
//
// This file is now a thin shim that delegates ALL state operations to the
// unified state manager (state-unified.js) via the migration bridge
// (state-migration.js). All callers of server/state-io.js get:
//
//   - Exclusive file locking on every write
//   - HMAC verification on every read
//   - Atomic tmp-rename writes
//   - CAS (compare-and-swap) via monotonic sequence counter
//   - State size management with auto-pruning
//
// Exports are 100% backward-compatible with the old state-io.js API:
//   unwrapStateEnvelope, getState, writeStateAsync, readStateAsync,
//   saveReviewComments, getReviewComments, loadEnv,
//   patchUIAsync, updateAsync
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateAsync = exports.patchUIAsync = exports.loadEnv = exports.getReviewComments = exports.saveReviewComments = exports.readStateAsync = exports.writeStateAsync = exports.getState = exports.unwrapStateEnvelope = void 0;
// TODO: Replace with proper typed import once state-migration.ts is converted
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stateMigration = require("../lib/state-migration");
const { unwrapStateEnvelope, getState, writeStateAsync, readStateAsync, saveReviewComments, getReviewComments, loadEnv, patchUIAsync, updateAsync, } = stateMigration.serverAPI;
exports.unwrapStateEnvelope = unwrapStateEnvelope;
exports.getState = getState;
exports.writeStateAsync = writeStateAsync;
exports.readStateAsync = readStateAsync;
exports.saveReviewComments = saveReviewComments;
exports.getReviewComments = getReviewComments;
exports.loadEnv = loadEnv;
exports.patchUIAsync = patchUIAsync;
exports.updateAsync = updateAsync;
//# sourceMappingURL=state-io.js.map