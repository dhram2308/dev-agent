/**
 * env-parser.ts -- Robust .env file parser for MI Dev Agent
 *
 * Converted from lib/env-parser.js (zero functional changes).
 *
 * Fixes all known bugs:
 *   #5: Strips surrounding quotes (single and double)
 *   #6: Strips inline comments (respects quoted values)
 *   #7: Supports multiline values (backslash continuation + heredoc-style)
 *   - Handles Windows \r\n line endings
 *   - Skips empty lines and comments
 *   - Warns on duplicate keys
 *   - Does NOT override existing process.env unless told to
 */
/** Options for parseEnvContent */
export interface ParseEnvOptions {
    /** Called with warning messages */
    onWarning?: (msg: string) => void;
    /** If false (default), warns on duplicate keys */
    allowDuplicates?: boolean;
}
/** Options for loadEnvFile and loadAndApplyEnv */
export interface LoadEnvOptions {
    /** If true, overwrite existing process.env values */
    override?: boolean;
    /** Called with warning messages */
    onWarning?: (msg: string) => void;
}
/**
 * Parse .env file content into a key-value object.
 */
export declare function parseEnvContent(content: string, options?: ParseEnvOptions): Record<string, string>;
/**
 * Load and parse a .env file from disk.
 *
 * @param envPath - Path to .env file (defaults to project root .env)
 * @param options - Load options
 * @returns Parsed key-value pairs (not yet applied to process.env)
 */
export declare function loadEnvFile(envPath?: string, options?: LoadEnvOptions): Record<string, string>;
/**
 * Load .env file and apply to process.env.
 * Respects existing values (won't override unless override=true).
 *
 * @param envPath - Path to .env file
 * @param options - Load options
 * @returns The parsed key-value pairs
 */
export declare function loadAndApplyEnv(envPath?: string, options?: LoadEnvOptions): Record<string, string>;
//# sourceMappingURL=env-parser.d.ts.map