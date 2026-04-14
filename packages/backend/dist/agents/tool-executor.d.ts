export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
}
export interface ToolDefinition {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}
export declare const TOOL_DEFINITIONS: readonly ToolDefinition[];
export declare class ToolExecutor {
    private readonly projectDir;
    constructor(projectDir: string);
    /**
     * Execute a tool by name with the given input.
     * Returns a ToolResult with success status and output/error.
     */
    execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult>;
    /**
     * Resolve a path and validate it is within the project directory.
     * Prevents path traversal and symlink escape attacks.
     */
    private resolveSafePath;
    private readFile;
    private writeFile;
    private editFile;
    private bash;
    private glob;
    private grepTool;
    private listDir;
    /**
     * Validates a bash command against the whitelist and blocklist.
     * Returns an error message if the command is not allowed, or null if OK.
     */
    private validateBashCommand;
    private validateSingleCommand;
    private extractGitSubcommand;
    /**
     * Execute a shell command with stdout/stderr limits and timeout.
     */
    private execCommand;
    /** Get the project directory this executor is bound to. */
    getProjectDir(): string;
    /** Get the list of tool definitions in Anthropic API format. */
    static getToolDefinitions(): readonly ToolDefinition[];
}
