/**
 * redaction.ts — Comprehensive Redaction Engine for MI Dev Agent
 *
 * Converted from lib/redaction.js (zero functional changes).
 *
 * Features:
 * - Named pattern registry with severity levels (critical/high/medium)
 * - All regexes compiled once at module load
 * - Replacement format: [REDACTED:{pattern_name}]
 * - Whitelist support for known-safe strings
 * - Performance: single pass per pattern, patterns ordered by likelihood
 * - Handles non-string input gracefully
 */
interface PatternDef {
    name: string;
    pattern: RegExp;
    severity: string;
    description: string;
}
interface CompiledPattern {
    name: string;
    regex: RegExp;
    severity: string;
    description: string;
}
declare const COMPILED_PATTERNS: CompiledPattern[];
/**
 * Add a string to the whitelist (will not be redacted even if it matches a pattern).
 */
declare function addToWhitelist(safeString: string): void;
/**
 * Remove a string from the whitelist.
 */
declare function removeFromWhitelist(safeString: string): void;
/**
 * Clear the entire whitelist.
 */
declare function clearWhitelist(): void;
/**
 * Get a copy of the current whitelist (for debugging/audit).
 */
declare function getWhitelist(): string[];
interface RedactOptions {
    minSeverity?: string;
}
/**
 * Redact all known secret patterns from the input string.
 */
declare function redact(input: any, options?: RedactOptions): any;
interface SecretFinding {
    name: string;
    severity: string;
    count: number;
    description: string;
}
/**
 * Check if a string contains any detectable secrets.
 */
declare function detectSecrets(input: string): SecretFinding[];
/**
 * Get a summary of all registered patterns (for diagnostics/startup logging).
 */
declare function getPatternSummary(): Array<{
    name: string;
    severity: string;
    description: string;
}>;
/**
 * Add a custom pattern at runtime.
 */
declare function addPattern(def: PatternDef): void;
/**
 * Redact environment variables from a string.
 */
declare function redactEnvValues(input: any): any;
/**
 * Full redaction pipeline: pattern-based + env-value-based.
 */
declare function redactAll(input: any): any;
export { redact, redactAll, detectSecrets, getPatternSummary, addPattern, addToWhitelist, removeFromWhitelist, clearWhitelist, getWhitelist, redactEnvValues, COMPILED_PATTERNS as _COMPILED_PATTERNS, };
//# sourceMappingURL=redaction.d.ts.map