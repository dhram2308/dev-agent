// ===================================================================
// MI Dev Agent -- State Module Barrel Export
//
// Re-exports all state management functionality:
//   - state-manager.ts: Core HMAC, envelope, atomic write, load/save
//   - lock.ts:          Two-layer locking (in-process mutex + OS file lock)
//   - state-io.ts:      Async server-side state operations
// ===================================================================

// ── State Manager (core) ──────────────────────────────────────────
export {
  // High-level API
  load,
  save,
  saveAsync,
  getCurrentState,
  setCurrentState,
  initSecret,
  checkUIApproval,
  readForDisplay,
  getReviewComments as getReviewCommentsSync,
  getStateFilePath,

  // Low-level (for state-io.ts and testing)
  stateSecret,
  computeHmac,
  wrapEnvelope,
  unwrapEnvelope,
  atomicWriteSync,
  atomicWriteAsync,
  readStateFromDisk,
  recoverTmpFiles,
  quarantineFile,
  pruneState,
  mergeUIFieldsFromDisk,
  applyUIPatch,

  // Constants
  ENVELOPE_VERSION,
  MAX_STATE_SIZE,
  PRUNE_THRESHOLD,

  // Types
  type StateEnvelopeV3,
  type StateEnvelopeV2,
  type UnwrapResult,
  type ReadResult,
  type ReadOpts,
  type SaveOpts,
  type StateDefaults,
  type RecoveredFile,

  // Testing
  _setStateSecret,
} from './state-manager';

// ── Lock ──────────────────────────────────────────────────────────
export {
  acquireLockAsync,
  acquireLockSync,
  cleanStaleLocks,
  InProcessMutex,
  MutexTimeoutError,
  _internals as _lockInternals,
} from './lock';

// ── State I/O (async server API) ──────────────────────────────────
export {
  getState,
  writeStateAsync,
  patchUIAsync,
  patchUIWithGateAsync,
  updateAsync,
  saveReviewComments,
  getReviewComments,
  _resetStartupCleanup,
} from './state-io';
