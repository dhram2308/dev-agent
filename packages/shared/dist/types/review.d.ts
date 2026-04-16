/**
 * Severity levels for review and security issues.
 */
export type ReviewSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
/**
 * Result of a code review by the Reviewer Agent.
 */
export interface CodeReview {
    /** Raw output from the Reviewer Agent */
    rawOutput: string;
    /** Parsed verdict (PASS or FAIL) */
    verdict: 'PASS' | 'FAIL';
    /** List of identified issues */
    issues: readonly ReviewIssue[];
    /** Whether the review passed (verdict === 'PASS') */
    passed: boolean;
}
/**
 * A single issue found during code review.
 */
export interface ReviewIssue {
    /** Issue severity */
    severity: ReviewSeverity;
    /** Issue category (reuse_violation, pattern_violation, bug, unnecessary_file, etc.) */
    category: string;
    /** File path where the issue was found */
    filePath?: string;
    /** Line number (if applicable) */
    line?: number;
    /** Human-readable description of the issue */
    description: string;
    /** Suggested fix or recommendation */
    suggestion?: string;
}
/**
 * A suggestion from the Reviewer Agent.
 */
export interface ReviewSuggestion {
    /** File path the suggestion applies to */
    filePath: string;
    /** Line range for the suggestion */
    lineRange?: {
        start: number;
        end: number;
    };
    /** The suggested replacement or action */
    suggestion: string;
    /** Reason for the suggestion */
    reason: string;
}
/**
 * Result of a security review by the Security Agent.
 */
export interface SecurityReview {
    /** Raw output from the Security Agent */
    rawOutput: string;
    /** Parsed verdict (PASS or FAIL) */
    verdict: 'PASS' | 'FAIL';
    /** List of identified security issues */
    issues: readonly SecurityIssue[];
    /** Whether the security review passed */
    passed: boolean;
}
/**
 * A single security issue found during audit.
 */
export interface SecurityIssue {
    /** Issue severity */
    severity: ReviewSeverity;
    /** Security category (xss, injection, auth, secrets, input_validation, data_isolation, pii) */
    category: string;
    /** File path where the issue was found */
    filePath?: string;
    /** Line number (if applicable) */
    line?: number;
    /** Human-readable description of the vulnerability */
    description: string;
    /** OWASP or CWE reference (if applicable) */
    reference?: string;
    /** Recommended remediation */
    remediation?: string;
}
/**
 * Categorized issue for the Fixer Agent (from categorizeIssues).
 */
export interface CategorizedIssue {
    /** Issue type for priority ordering */
    type: 'COMPILATION' | 'SECURITY' | 'CODE_REVIEW' | 'LINT';
    /** Human-readable label */
    label: string;
    /** Raw content describing the issues */
    content: string;
}
//# sourceMappingURL=review.d.ts.map