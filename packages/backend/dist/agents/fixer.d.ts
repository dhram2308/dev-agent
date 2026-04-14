/**
 * Parse VERDICT from structured agent output (fallback to legacy keyword check).
 *
 * Checks for structured "VERDICT: PASS|FAIL" first, then falls back to
 * legacy keyword matching with negation detection.
 *
 * @param output - Agent output text
 * @param legacyPassWord - Legacy keyword to check if no VERDICT found (e.g., "lgtm", "secure")
 * @returns true if passed
 */
export declare function parseVerdict(output: string, legacyPassWord: string): boolean;
