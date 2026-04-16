/**
 * refusal-detection.ts — Claude Refusal Detection with Confidence Scoring
 *
 * Converted from lib/refusal-detection.js (zero functional changes).
 *
 * Solves problem #16:
 * - Current REFUSAL_PATTERNS miss several patterns
 * - Extended regex patterns + semantic checks
 * - Confidence scoring (0.0 - 1.0)
 * - Checks first 1000 chars (refusals are always at the start)
 * - Distinguishes between hard refusal (won't do it) and soft (needs clarification)
 */
interface WeightedPattern {
    pattern: RegExp;
    weight: number;
}
/**
 * HARD refusal patterns - Claude explicitly refuses the request.
 * High confidence (0.85+)
 */
declare const HARD_REFUSAL_PATTERNS: WeightedPattern[];
/**
 * SOFT refusal patterns - Claude wants more info or suggests alternatives.
 * Lower confidence (0.4-0.7)
 */
declare const SOFT_REFUSAL_PATTERNS: WeightedPattern[];
/**
 * FALSE POSITIVE patterns - phrases that look like refusals but aren't.
 */
declare const FALSE_POSITIVE_PATTERNS: RegExp[];
interface StructuralSignal {
    check: (text: string) => boolean;
    weight: number;
    name: string;
}
declare const REFUSAL_STRUCTURAL_SIGNALS: StructuralSignal[];
interface RefusalResult {
    isRefusal: boolean;
    confidence: number;
    type: "HARD" | "SOFT" | "NONE";
    matchedPatterns: string[];
    details: string;
}
/**
 * Detect Claude refusal with confidence scoring.
 */
declare function detectRefusal(output: string | null | undefined, agentName?: string): RefusalResult;
/**
 * Enhanced replacement for the existing detectClaudeRefusal() in utils.js.
 * Throws an error if a high-confidence refusal is detected.
 */
declare function detectClaudeRefusalEnhanced(output: string | null | undefined, agentName: string): void;
/**
 * Get all refusal patterns (combined) for external use.
 */
declare function getAllRefusalPatterns(): RegExp[];
export { HARD_REFUSAL_PATTERNS, SOFT_REFUSAL_PATTERNS, FALSE_POSITIVE_PATTERNS, REFUSAL_STRUCTURAL_SIGNALS, detectRefusal, detectClaudeRefusalEnhanced, getAllRefusalPatterns, };
//# sourceMappingURL=refusal-detection.d.ts.map