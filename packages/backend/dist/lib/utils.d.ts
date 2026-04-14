import type { PipelineState } from '@shared/types';
/** Returns a Promise that resolves after the given number of milliseconds. */
export declare function sleep(ms: number): Promise<void>;
/**
 * Wraps user-supplied text in `<user_content>` tags and strips any
 * XML-like tags that could hijack the Claude system/assistant/human roles.
 */
export declare function sanitizeForPrompt(text: string): string;
/** Returns true if the file extension indicates a binary format (image, font, archive, etc.). */
export declare function isBinaryFile(filePath: string): boolean;
/**
 * Returns true if the content string appears to contain binary data.
 * Checks the first 512 characters for null bytes.
 */
export declare function isBinaryContent(content: string): boolean;
/**
 * Throws if Claude's output is empty or shorter than `minChars`.
 * This catches cases where the prompt was too large or Claude hit a safety filter.
 *
 * @param output - Raw Claude output string
 * @param agentName - Name of the calling agent (for error messages)
 * @param minChars - Minimum acceptable character count (default 50)
 */
export declare function validateClaudeOutput(output: string, agentName: string, minChars?: number): void;
/**
 * Checks the first 500 chars of Claude's output against known refusal patterns.
 * Throws if a refusal is detected.
 *
 * Uses basic pattern matching (the enhanced confidence-scoring detector
 * can be injected via `setEnhancedRefusalDetector` for the full 30+ pattern set).
 *
 * @param output - Raw Claude output string
 * @param agentName - Name of the calling agent (for error messages)
 */
export declare function detectClaudeRefusal(output: string, agentName: string): void;
type EnhancedRefusalDetectorFn = (output: string, agentName: string) => void;
/**
 * Register an enhanced refusal detector (from refusal-detection module).
 * When set, `detectClaudeRefusal` delegates to it instead of basic patterns.
 */
export declare function setEnhancedRefusalDetector(fn: EnhancedRefusalDetectorFn): void;
/**
 * Throws if Claude's output is empty or contains fewer than 20 characters.
 * Catches silent CLI failures.
 *
 * @param output - Raw Claude output string
 * @param agentName - Name of the calling agent (for error messages)
 */
export declare function validateClaudeNotEmpty(output: string, agentName: string): void;
/** Escapes backticks and dollar signs for safe use in MR descriptions / shell contexts. */
export declare function sanitizeMRText(text: string): string;
/**
 * Validates and progressively truncates a Claude prompt if it exceeds
 * the token limit (estimated at ~4 chars per token).
 *
 * Truncation levels (applied in order until under limit):
 *   1. URL content blocks to 10KB each
 *   2. Jira comments to newest 50
 *   3. Linked issues to 10
 *   4. File contexts to 4000 chars each
 *   5. Hard truncation as last resort
 *
 * @param prompt - The prompt string to validate
 * @param agentName - Agent name for warning messages
 * @param maxPromptTokens - Override the token limit (defaults to MAX_PROMPT_TOKENS_DEFAULT)
 * @returns The (possibly truncated) prompt string
 */
export declare function validatePromptSize(prompt: string, agentName: string, maxPromptTokens?: number): string;
/**
 * Appends a warning to the pipeline state's `_warnings` array.
 * Caps at 200 entries (drops oldest).
 */
export declare function addWarning(state: PipelineState, stage: string, message: string): void;
/**
 * Truncates content to `maxLen` characters with a human-readable indicator
 * showing both the truncation point and the original length.
 */
export declare function truncateWithIndicator(content: string, maxLen: number): string;
/**
 * Checks if `word` appears as a whole word in `text`, excluding any
 * matches that also match one of the `negatives` patterns.
 * Used for detecting approval/rejection keywords in comments.
 */
export declare function matchApprovalWord(text: string, word: string, negatives?: string[]): boolean;
/**
 * Extracts a JSON object from Claude's text output.
 *
 * Tries in order:
 *   1. Parse the entire string as JSON
 *   2. Extract from markdown ```json``` fences
 *   3. Brace-matching with string-literal awareness
 *   4. First `{` to last `}` fallback
 *   5. Repair truncated JSON (close missing brackets/braces)
 *
 * @throws Error if no valid JSON object can be found
 */
export declare function extractJson(text: string): Record<string, unknown>;
export {};
