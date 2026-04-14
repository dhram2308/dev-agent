import { ToolExecutor } from '../agents/tool-executor';
import type { ToolDefinition } from '../agents/tool-executor';
export interface ClaudeOptions {
    /** Model to use (default: 'claude-sonnet-4-20250514') */
    model?: string;
    /** Max tokens in response (default: 16384) */
    maxTokens?: number;
    /** Tool definitions to make available to Claude */
    tools?: ToolDefinition[];
    /** System prompt to prepend */
    systemPrompt?: string;
    /** Temperature (0-1) */
    temperature?: number;
    /** Called periodically during long operations for state updates */
    onHeartbeat?: () => void;
    /** Agent name for logging (default: 'Claude') */
    agentName?: string;
    /** Maximum number of tool-use turns before stopping (default: 25) */
    maxTurns?: number;
    /** Whether to retry on timeout (default: true) */
    retry?: boolean;
    /** Working directory for tool executor */
    projectDir?: string;
}
/**
 * HTTP request function type -- will be provided by http/client.ts.
 */
type ReqFn = (url: string, opts: {
    method: string;
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
}) => Promise<{
    status: number;
    data: unknown;
    headers?: Record<string, string>;
}>;
export declare class ClaudeService {
    private readonly apiKey;
    private readonly req;
    private toolExecutor;
    constructor(apiKey: string, req: ReqFn);
    /**
     * Set the tool executor for a specific project directory.
     * Must be called before using tools in callClaude.
     */
    setProjectDir(projectDir: string): void;
    /**
     * Call Claude via the Anthropic Messages API.
     *
     * Drop-in replacement for the old CLI-based callClaude().
     * Supports multi-turn tool use (agent loop).
     *
     * @param prompt - The user prompt to send
     * @param timeoutMs - Total timeout for the entire interaction (default: 180s)
     * @param opts - Additional options (model, maxTokens, tools, systemPrompt, etc.)
     * @returns The final text response from Claude
     */
    callClaude(prompt: string, timeoutMs?: number, opts?: ClaudeOptions): Promise<string>;
    private callClaudeOnce;
    /**
     * Make a single request to the Anthropic Messages API.
     */
    private makeApiRequest;
    /** Check if the API key is configured. */
    isConfigured(): boolean;
    /** Get the tool executor instance. */
    getToolExecutor(): ToolExecutor | null;
}
/**
 * Create a standalone callClaude function matching the original lib/claude.js API.
 *
 * Usage:
 *   const callClaude = createClaudeCaller(reqFn, { projectDir: '/path/to/repo' });
 *   const result = await callClaude('Explain this code', 180000);
 */
export declare function createClaudeCaller(req: ReqFn, defaults?: {
    apiKey?: string;
    projectDir?: string;
    model?: string;
    maxTokens?: number;
    systemPrompt?: string;
}): (prompt: string, timeoutMs?: number, opts?: ClaudeOptions) => Promise<string>;
export {};
