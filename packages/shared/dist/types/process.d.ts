/**
 * Options passed to the Claude CLI invocation.
 * Maps to the `opts` parameter in callClaude / _callClaudeOnce.
 */
export interface ClaudeCallOptions {
    /** Human-readable name for this agent invocation (e.g. "Developer Agent") */
    agentName?: string;
    /** Max conversation turns the CLI should execute */
    maxTurns?: number;
    /** Working directory for the spawned Claude process */
    cwd?: string;
    /** Whether to retry on timeout (default: true) */
    retry?: boolean;
    /** Allowed MCP tools for the Claude CLI session */
    allowedTools?: readonly string[];
    /** Additional dynamic options */
    [key: string]: unknown;
}
/**
 * Result returned from a Claude CLI call.
 * Currently a trimmed stdout string; will evolve to structured output.
 */
export type ClaudeResponse = string;
/**
 * Structured message from Claude CLI (future structured output mode).
 */
export interface ClaudeMessage {
    /** Role of the message sender */
    role: 'user' | 'assistant' | 'system';
    /** Text content of the message */
    content: string;
    /** Timestamp of the message */
    timestamp?: string;
    /** Optional tool use metadata */
    toolUse?: {
        name: string;
        input: Record<string, unknown>;
        output?: string;
    };
}
/**
 * Information about a running agent child process.
 * Tracked in the agentProcs map in server/agent-process.js.
 */
export interface AgentProcessInfo {
    /** The Jira ticket ID this agent is working on */
    ticket: string;
    /** PID of the spawned Node.js child process */
    pid: number;
    /** Whether the process is currently alive */
    alive: boolean;
    /** Exit code if process has exited (null if still running) */
    exitCode: number | null;
    /** Reason for non-alive status */
    reason?: 'no_process' | 'exited' | 'unreachable';
    /** Path to the per-ticket worktree (if created) */
    worktreePath?: string | null;
}
/**
 * Handle returned by wrapProcessOutput for redacted I/O interception.
 */
export interface ProcessRedactorHandle {
    /** Call to detach listeners and clean up the redactor */
    cleanup: () => void;
}
/**
 * Per-stage data field mapping — defines which state fields
 * belong to each stage and should be cleared on re-entry.
 */
export type StageDataMap = Record<string, readonly string[]>;
/**
 * Result of a process health check (checkProcessHealth).
 */
export interface ProcessHealthCheck {
    /** Whether the child process is alive */
    alive: boolean;
    /** PID of the process (if known) */
    pid?: number;
    /** Reason for non-alive status */
    reason?: 'no_process' | 'exited' | 'unreachable';
    /** Exit code if process has exited */
    exitCode?: number;
}
/**
 * Result of starting an agent process.
 */
export interface AgentStartResult {
    /** Whether the agent started successfully */
    ok: boolean;
    /** Error message if start failed */
    error?: string;
}
/**
 * Result of stopping an agent process.
 */
export interface AgentStopResult {
    /** Whether the agent was stopped successfully */
    ok: boolean;
    /** Error message if stop failed */
    error?: string;
}
//# sourceMappingURL=process.d.ts.map