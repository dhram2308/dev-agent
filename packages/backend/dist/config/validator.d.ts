export declare enum Severity {
    FATAL = "FATAL",
    ERROR = "ERROR",
    WARN = "WARN",
    INFO = "INFO"
}
export interface ValidationResult {
    field: string;
    severity: Severity;
    message: string;
    group: string;
}
export interface ValidationOutput {
    valid: boolean;
    results: ValidationResult[];
}
export type ErrorFn = (msg: string) => void;
export type InfoFn = (msg: string) => void;
export type WarnFn = (msg: string) => void;
/**
 * Validate ALL config variables from the environment.
 *
 * Checks:
 *   - Required fields present (TICKET, JIRA_TOKEN, GITLAB_TOKEN, etc.)
 *   - Numeric fields valid (GITLAB_PROJECT_ID, timeouts)
 *   - URL format checks (JIRA_BASE_URL, GITLAB_URL)
 *   - Cross-field validation (OWNER_JIRA_ID != QA_JIRA_ID)
 *   - Boolean flags (RUN_BUILD_CHECK, BROWSER_VERIFY, etc.)
 *   - Port range ordering
 *   - Timeout ordering
 *   - QA credential presence
 *
 * @param env - The environment record (defaults to process.env)
 * @returns Structured validation output
 */
export declare function validateAllConfig(env?: Record<string, string | undefined>): ValidationOutput;
/**
 * Format validation results for console output.
 * Groups results by severity with color-coded output.
 */
export declare function formatValidationResults(results: ValidationResult[]): string;
/**
 * Backward-compatible wrapper: validates config using callback functions.
 *
 * When called with (errFn, infoFn, warnFn):
 *   - Logs errors via errFn
 *   - Calls process.exit(1) on fatal/error
 *   - Logs warnings via warnFn
 *
 * When called with no arguments:
 *   - Returns { valid, results } for programmatic use
 */
export declare function validateConfig(errFn?: ErrorFn, infoFn?: InfoFn, warnFn?: WarnFn): ValidationOutput | void;
