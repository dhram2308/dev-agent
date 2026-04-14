export type RedactionSeverity = 'critical' | 'high' | 'medium';
export interface RedactionPattern {
    name: string;
    severity: RedactionSeverity;
    regex: RegExp;
    description: string;
}
export interface SecretDetection {
    name: string;
    severity: RedactionSeverity;
    count: number;
    description: string;
}
export interface RedactOptions {
    /** Only redact patterns at this severity or higher.
     *  "medium" = all, "high" = high+critical, "critical" = critical only */
    minSeverity?: RedactionSeverity;
}
/** Add a string to the whitelist (will not be redacted even if it matches a pattern). */
export declare function addToWhitelist(safeString: string): void;
/** Remove a string from the whitelist. */
export declare function removeFromWhitelist(safeString: string): void;
/** Clear the entire whitelist. */
export declare function clearWhitelist(): void;
/** Get a copy of the current whitelist (for debugging/audit). */
export declare function getWhitelist(): string[];
/**
 * Redact all known secret patterns from the input string.
 *
 * Non-string input is returned as-is. Empty strings pass through unchanged.
 *
 * @param input - The string to redact.
 * @param options - Optional filtering by minimum severity.
 * @returns The redacted string.
 */
export declare function redact(input: string, options?: RedactOptions): string;
/**
 * Check if a string contains any detectable secrets.
 * Returns an array of { name, severity, count, description } for each pattern that matched.
 */
export declare function detectSecrets(input: string): SecretDetection[];
/**
 * Get a summary of all registered patterns (for diagnostics/startup logging).
 */
export declare function getPatternSummary(): Array<{
    name: string;
    severity: RedactionSeverity;
    description: string;
}>;
/**
 * Add a custom pattern at runtime.
 *
 * @param def - Pattern definition with name, pattern, severity, description.
 * @throws If name or pattern is missing, or if name is already registered.
 */
export declare function addPattern(def: {
    name: string;
    pattern: RegExp;
    severity?: RedactionSeverity;
    description?: string;
}): void;
/**
 * Redact environment variable values from a string.
 *
 * Scans a known list of env var keys for values that are at least 8 characters,
 * and replaces every occurrence in the input.
 *
 * @param input - The string to redact env values from.
 * @param env - The environment record to read values from (defaults to process.env).
 * @returns The redacted string.
 */
export declare function redactEnvValues(input: string, env?: Record<string, string | undefined>): string;
/**
 * Full redaction pipeline: pattern-based + env-value-based.
 * This is the primary function to use throughout the codebase.
 *
 * @param input - The string to redact.
 * @param env - Optional env record (defaults to process.env).
 * @returns The fully redacted string.
 */
export declare function redactAll(input: string, env?: Record<string, string | undefined>): string;
/** Expose compiled patterns for testing. */
export declare const _COMPILED_PATTERNS: RedactionPattern[];
