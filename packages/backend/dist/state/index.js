"use strict";
// ===================================================================
// MI Dev Agent -- State Module Barrel Export
//
// Re-exports all state management functionality:
//   - state-manager.ts: Core HMAC, envelope, atomic write, load/save
//   - lock.ts:          Two-layer locking (in-process mutex + OS file lock)
//   - state-io.ts:      Async server-side state operations
// ===================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports._resetStartupCleanup = exports.getReviewComments = exports.saveReviewComments = exports.updateAsync = exports.patchUIWithGateAsync = exports.patchUIAsync = exports.writeStateAsync = exports.getState = exports._lockInternals = exports.MutexTimeoutError = exports.InProcessMutex = exports.cleanStaleLocks = exports.acquireLockSync = exports.acquireLockAsync = exports._setStateSecret = exports.PRUNE_THRESHOLD = exports.MAX_STATE_SIZE = exports.ENVELOPE_VERSION = exports.applyUIPatch = exports.mergeUIFieldsFromDisk = exports.pruneState = exports.quarantineFile = exports.recoverTmpFiles = exports.readStateFromDisk = exports.atomicWriteAsync = exports.atomicWriteSync = exports.unwrapEnvelope = exports.wrapEnvelope = exports.computeHmac = exports.stateSecret = exports.getStateFilePath = exports.getReviewCommentsSync = exports.readForDisplay = exports.checkUIApproval = exports.initSecret = exports.setCurrentState = exports.getCurrentState = exports.saveAsync = exports.save = exports.load = void 0;
// ── State Manager (core) ──────────────────────────────────────────
var state_manager_1 = require("./state-manager");
// High-level API
Object.defineProperty(exports, "load", { enumerable: true, get: function () { return state_manager_1.load; } });
Object.defineProperty(exports, "save", { enumerable: true, get: function () { return state_manager_1.save; } });
Object.defineProperty(exports, "saveAsync", { enumerable: true, get: function () { return state_manager_1.saveAsync; } });
Object.defineProperty(exports, "getCurrentState", { enumerable: true, get: function () { return state_manager_1.getCurrentState; } });
Object.defineProperty(exports, "setCurrentState", { enumerable: true, get: function () { return state_manager_1.setCurrentState; } });
Object.defineProperty(exports, "initSecret", { enumerable: true, get: function () { return state_manager_1.initSecret; } });
Object.defineProperty(exports, "checkUIApproval", { enumerable: true, get: function () { return state_manager_1.checkUIApproval; } });
Object.defineProperty(exports, "readForDisplay", { enumerable: true, get: function () { return state_manager_1.readForDisplay; } });
Object.defineProperty(exports, "getReviewCommentsSync", { enumerable: true, get: function () { return state_manager_1.getReviewComments; } });
Object.defineProperty(exports, "getStateFilePath", { enumerable: true, get: function () { return state_manager_1.getStateFilePath; } });
// Low-level (for state-io.ts and testing)
Object.defineProperty(exports, "stateSecret", { enumerable: true, get: function () { return state_manager_1.stateSecret; } });
Object.defineProperty(exports, "computeHmac", { enumerable: true, get: function () { return state_manager_1.computeHmac; } });
Object.defineProperty(exports, "wrapEnvelope", { enumerable: true, get: function () { return state_manager_1.wrapEnvelope; } });
Object.defineProperty(exports, "unwrapEnvelope", { enumerable: true, get: function () { return state_manager_1.unwrapEnvelope; } });
Object.defineProperty(exports, "atomicWriteSync", { enumerable: true, get: function () { return state_manager_1.atomicWriteSync; } });
Object.defineProperty(exports, "atomicWriteAsync", { enumerable: true, get: function () { return state_manager_1.atomicWriteAsync; } });
Object.defineProperty(exports, "readStateFromDisk", { enumerable: true, get: function () { return state_manager_1.readStateFromDisk; } });
Object.defineProperty(exports, "recoverTmpFiles", { enumerable: true, get: function () { return state_manager_1.recoverTmpFiles; } });
Object.defineProperty(exports, "quarantineFile", { enumerable: true, get: function () { return state_manager_1.quarantineFile; } });
Object.defineProperty(exports, "pruneState", { enumerable: true, get: function () { return state_manager_1.pruneState; } });
Object.defineProperty(exports, "mergeUIFieldsFromDisk", { enumerable: true, get: function () { return state_manager_1.mergeUIFieldsFromDisk; } });
Object.defineProperty(exports, "applyUIPatch", { enumerable: true, get: function () { return state_manager_1.applyUIPatch; } });
// Constants
Object.defineProperty(exports, "ENVELOPE_VERSION", { enumerable: true, get: function () { return state_manager_1.ENVELOPE_VERSION; } });
Object.defineProperty(exports, "MAX_STATE_SIZE", { enumerable: true, get: function () { return state_manager_1.MAX_STATE_SIZE; } });
Object.defineProperty(exports, "PRUNE_THRESHOLD", { enumerable: true, get: function () { return state_manager_1.PRUNE_THRESHOLD; } });
// Testing
Object.defineProperty(exports, "_setStateSecret", { enumerable: true, get: function () { return state_manager_1._setStateSecret; } });
// ── Lock ──────────────────────────────────────────────────────────
var lock_1 = require("./lock");
Object.defineProperty(exports, "acquireLockAsync", { enumerable: true, get: function () { return lock_1.acquireLockAsync; } });
Object.defineProperty(exports, "acquireLockSync", { enumerable: true, get: function () { return lock_1.acquireLockSync; } });
Object.defineProperty(exports, "cleanStaleLocks", { enumerable: true, get: function () { return lock_1.cleanStaleLocks; } });
Object.defineProperty(exports, "InProcessMutex", { enumerable: true, get: function () { return lock_1.InProcessMutex; } });
Object.defineProperty(exports, "MutexTimeoutError", { enumerable: true, get: function () { return lock_1.MutexTimeoutError; } });
Object.defineProperty(exports, "_lockInternals", { enumerable: true, get: function () { return lock_1._internals; } });
// ── State I/O (async server API) ──────────────────────────────────
var state_io_1 = require("./state-io");
Object.defineProperty(exports, "getState", { enumerable: true, get: function () { return state_io_1.getState; } });
Object.defineProperty(exports, "writeStateAsync", { enumerable: true, get: function () { return state_io_1.writeStateAsync; } });
Object.defineProperty(exports, "patchUIAsync", { enumerable: true, get: function () { return state_io_1.patchUIAsync; } });
Object.defineProperty(exports, "patchUIWithGateAsync", { enumerable: true, get: function () { return state_io_1.patchUIWithGateAsync; } });
Object.defineProperty(exports, "updateAsync", { enumerable: true, get: function () { return state_io_1.updateAsync; } });
Object.defineProperty(exports, "saveReviewComments", { enumerable: true, get: function () { return state_io_1.saveReviewComments; } });
Object.defineProperty(exports, "getReviewComments", { enumerable: true, get: function () { return state_io_1.getReviewComments; } });
Object.defineProperty(exports, "_resetStartupCleanup", { enumerable: true, get: function () { return state_io_1._resetStartupCleanup; } });
//# sourceMappingURL=index.js.map