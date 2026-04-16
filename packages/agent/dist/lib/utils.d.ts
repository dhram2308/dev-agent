/**
 * utils.ts -- Utility functions for MI Dev Agent
 *
 * Converted from lib/utils.js (zero functional changes).
 */
export declare function redactSecrets(text: string): string;
export declare function sanitizeForPrompt(text: string | null | undefined): string;
export declare function isBinaryFile(filename: string | null | undefined): boolean;
export declare function isBinaryContent(str: string | null | undefined): boolean;
export declare function validateClaudeOutput(output: string | null | undefined, agentName: string, minChars?: number): void;
export declare function detectClaudeRefusal(output: string | null | undefined, agentName: string): void;
export declare function validateClaudeNotEmpty(output: string | null | undefined, agentName: string): void;
export declare function sanitizeMRText(text: string | null | undefined): string;
export declare function validatePromptSize(prompt: string | unknown, agentName?: string): string | unknown;
interface WarningEntry {
    stage: string;
    message: string;
    timestamp: string;
}
interface StateWithWarnings {
    data?: {
        _warnings?: WarningEntry[];
        [key: string]: any;
    };
    [key: string]: any;
}
export declare function addWarning(state: StateWithWarnings | null | undefined, stage: string, message: string): void;
export declare function truncateWithIndicator(content: string | null | undefined, maxLen: number): string | null | undefined;
export declare function matchApprovalWord(text: string, word: string, negatives?: string[]): boolean;
export declare function extractJson(text: string): Record<string, any>;
export {};
//# sourceMappingURL=utils.d.ts.map