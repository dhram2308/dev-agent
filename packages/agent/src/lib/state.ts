/**
 * state.ts -- Agent-side state API (unified)
 *
 * Thin shim that delegates ALL state operations to the unified state manager
 * via the migration bridge (state-migration.ts).
 *
 * Exports are 100% backward-compatible with the old state.js API:
 *   loadState, save, stateSecret, checkUIApproval, getCurrentState, setCurrentState
 */

const { agentAPI } = require('./state-migration') as {
  agentAPI: {
    loadState: (...args: any[]) => any;
    save: (state: any) => void;
    saveAndThrow: (state: any, error: Error) => never;
    stateSecret: () => string;
    checkUIApproval: (state: any, prefix: string) => any;
    getCurrentState: () => any;
    setCurrentState: (state: any) => void;
  };
};

module.exports = agentAPI;
