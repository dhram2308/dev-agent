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
export interface ActiveAgent {
    name: string;
    team: string;
    startedAt: number;
    phase: 'running';
}
export interface HistoryAgent {
    name: string;
    team: string;
    startedAt: number;
    durationMs: number;
    phase: 'complete' | 'failed';
    outputChars?: number;
    required: boolean;
    errorMessage?: string;
}
//# sourceMappingURL=agents-team.d.ts.map