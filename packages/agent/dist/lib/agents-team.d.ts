/**
 * agents-team.ts -- Parallel Claude Agent Orchestration
 *
 * Converted from lib/agents-team.js (zero functional changes).
 *
 * Features:
 * - Promise.allSettled -- one failure does NOT abort siblings
 * - Each agent has `required: boolean` -- required failure aborts whole team
 * - Built-in checkpoint/resume via `checkpointKey` -- completed agents skip on restart
 * - Caller-defined `merge()` callback for combining results
 * - Integrates with existing `callClaude()` -- no changes to lib/claude.js
 */
export {};
//# sourceMappingURL=agents-team.d.ts.map