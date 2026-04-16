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

import type { PipelineState } from '@mi/shared';

// TODO: Replace with proper typed import once state-migration.ts is converted
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stateMigration = require("../lib/state-migration") as {
  serverAPI: {
    unwrapStateEnvelope: (raw: any) => any;
    getState: (ticket: string) => PipelineState | null;
    writeStateAsync: (ticket: string, state: PipelineState) => Promise<void>;
    readStateAsync: (ticket: string) => Promise<PipelineState | null>;
    saveReviewComments: (ticket: string, comments: Record<string, any>) => Promise<boolean>;
    getReviewComments: (ticket: string) => Record<string, any>;
    loadEnv: () => Record<string, string>;
    patchUIAsync: (ticket: string, gate: string, patch: Record<string, any>) => Promise<void>;
    updateAsync: (ticket: string, mutator: (state: PipelineState) => Promise<PipelineState>) => Promise<PipelineState>;
  };
};

const {
  unwrapStateEnvelope,
  getState,
  writeStateAsync,
  readStateAsync,
  saveReviewComments,
  getReviewComments,
  loadEnv,
  patchUIAsync,
  updateAsync,
} = stateMigration.serverAPI;

export {
  unwrapStateEnvelope,
  getState,
  writeStateAsync,
  readStateAsync,
  saveReviewComments,
  getReviewComments,
  loadEnv,
  patchUIAsync,
  updateAsync,
};
