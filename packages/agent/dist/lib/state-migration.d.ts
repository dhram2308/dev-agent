/**
 * state-migration.ts — Migration bridge from dual-write to unified state
 *
 * Converted from lib/state-migration.js (zero functional changes).
 *
 * This module provides drop-in replacement exports that match the old
 * lib/state.js and server/state-io.js APIs while delegating to the
 * new unified state-unified.js module under the hood.
 *
 * Migration steps:
 *   Phase 0 (this file): Both old files replaced with shims that call unified module
 *   Phase 1: Update all importers to use state-unified.js directly
 *   Phase 2: Remove this bridge file and old state.js / state-io.js
 *
 * Usage:
 *   // In lib/state.js (replace entire contents):
 *   module.exports = require("./state-migration").agentAPI;
 *
 *   // In server/state-io.js (replace entire contents):
 *   module.exports = require("../lib/state-migration").serverAPI;
 */
declare function stateFilePath(ticket?: string): string;
declare function getCurrentState(): any;
declare function setCurrentState(s: any): void;
declare function loadState(): any;
declare function save(state: any): void;
declare function checkUIApproval(state: any, gatePrefix: string): any;
/**
 * Save state, then throw the original error.
 * If save() fails, log the save error as warning and still throw original.
 */
declare function saveAndThrow(state: any, error: Error): never;
declare const agentAPI: {
    loadState: typeof loadState;
    save: typeof save;
    saveAndThrow: typeof saveAndThrow;
    stateSecret: () => string;
    checkUIApproval: typeof checkUIApproval;
    getCurrentState: typeof getCurrentState;
    setCurrentState: typeof setCurrentState;
};
declare function unwrapStateEnvelope(parsed: any): any;
declare function getState(ticket: string): any;
declare function writeStateAsync(f: string, data: any): Promise<void>;
declare function readStateAsync(f: string): Promise<any>;
declare function _saveReviewComments(ticket: string, comments: any): Promise<void>;
declare function _getReviewComments(ticket: string): any;
declare function loadEnv(): Record<string, string>;
declare const serverAPI: {
    unwrapStateEnvelope: typeof unwrapStateEnvelope;
    getState: typeof getState;
    writeStateAsync: typeof writeStateAsync;
    readStateAsync: typeof readStateAsync;
    saveReviewComments: typeof _saveReviewComments;
    getReviewComments: typeof _getReviewComments;
    loadEnv: typeof loadEnv;
    patchUIAsync: (ticket: string, gate: string, uiFields: any) => Promise<void>;
    updateAsync: (ticket: string, mutator: (state: any) => any) => Promise<void>;
};
export { agentAPI, serverAPI, stateFilePath, };
//# sourceMappingURL=state-migration.d.ts.map