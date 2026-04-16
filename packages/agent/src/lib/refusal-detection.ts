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

// Hub file not yet converted — use require
const { logWarn, logInfo, logDebug } = require("./logging") as {
  logWarn: (msg: string) => void;
  logInfo: (msg: string) => void;
  logDebug: (msg: string) => void;
};

// ── Refusal pattern categories ──────────────────────────────────────

interface WeightedPattern {
  pattern: RegExp;
  weight: number;
}

/**
 * HARD refusal patterns - Claude explicitly refuses the request.
 * High confidence (0.85+)
 */
const HARD_REFUSAL_PATTERNS: WeightedPattern[] = [
  { pattern: /\bI can'?t\s+(assist|help|generate|create|write|provide|do\s+that|fulfill|complete|comply)\b/i, weight: 0.9 },
  { pattern: /\bI cannot\s+(assist|help|generate|create|write|provide|do\s+that|fulfill|complete|comply)\b/i, weight: 0.9 },
  { pattern: /\bI'?m unable to\s+(assist|help|generate|create|write|provide|fulfill|complete|comply)\b/i, weight: 0.9 },
  { pattern: /\bI am unable to\s+(assist|help|generate|create|write|provide|fulfill|complete|comply)\b/i, weight: 0.9 },
  { pattern: /\bI must (refuse|decline)\b/i, weight: 0.95 },
  { pattern: /\bI must decline\b/i, weight: 0.95 },
  { pattern: /\bI won'?t\s+(be able to|generate|create|write|provide|help with|assist)\b/i, weight: 0.9 },
  { pattern: /\bI shouldn'?t\s+(generate|create|write|provide|help with|assist)\b/i, weight: 0.85 },
  { pattern: /\bI should not\s+(generate|create|write|provide|help with|assist)\b/i, weight: 0.85 },
  { pattern: /\bI'?m not able to\b/i, weight: 0.85 },
  { pattern: /\bit would be inappropriate\b/i, weight: 0.85 },
  { pattern: /\bgoes against my guidelines\b/i, weight: 0.95 },
  { pattern: /\bagainst my (guidelines|policies|principles|safety)\b/i, weight: 0.9 },
  { pattern: /\bI need to flag\b/i, weight: 0.7 },
  { pattern: /\bviolates?\s+(my\s+)?(guidelines|policies|terms|safety)/i, weight: 0.9 },
  { pattern: /\bI'?m not comfortable\s+(with|generating|creating|writing|providing)\b/i, weight: 0.85 },
  { pattern: /\bethical\s+(concerns?|considerations?|guidelines?|reasons?)\b/i, weight: 0.7 },
  { pattern: /\bsafety\s+(concerns?|guidelines?|reasons?|policy|policies)\b/i, weight: 0.75 },
  { pattern: /^I'?m sorry,?\s+(but\s+)?I\s+(can'?t|cannot|won'?t|am unable|must decline)/i, weight: 0.95 },
  { pattern: /^Unfortunately,?\s+I\s+(can'?t|cannot|won'?t|am unable|must decline)/i, weight: 0.9 },
  { pattern: /^I apologize,?\s+(but\s+)?I\s+(can'?t|cannot|won'?t|am unable)/i, weight: 0.9 },
];

/**
 * SOFT refusal patterns - Claude wants more info or suggests alternatives.
 * Lower confidence (0.4-0.7)
 */
const SOFT_REFUSAL_PATTERNS: WeightedPattern[] = [
  { pattern: /\bI'd need more (context|information|details|clarification)\b/i, weight: 0.4 },
  { pattern: /\bcould you (clarify|provide|share|explain)\b/i, weight: 0.3 },
  { pattern: /\bI'?m not sure (what|how|if) you'?re asking\b/i, weight: 0.4 },
  { pattern: /\bthe (request|task|prompt) (is|seems) (unclear|ambiguous|vague)\b/i, weight: 0.4 },
  { pattern: /\binstead,?\s+I (can|could|would|suggest)\b/i, weight: 0.5 },
  { pattern: /\bI'?d recommend\s+(a different|an alternative)\b/i, weight: 0.45 },
];

/**
 * FALSE POSITIVE patterns - phrases that look like refusals but aren't.
 */
const FALSE_POSITIVE_PATTERNS: RegExp[] = [
  /\bI can'?t\s+find\b/i,
  /\bI can'?t\s+tell\s+from\b/i,
  /\bI can'?t\s+reproduce\b/i,
  /\bI can'?t\s+see\b/i,
  /\bI can'?t\s+determine\b/i,
  /\bunable to (find|locate|access|read|parse|determine)/i,
  /\bI won'?t\s+go into\s+detail\b/i,
  /\bI won'?t\s+list\s+every\b/i,
  /code.*I can'?t/i,
  /file.*unable/i,
  /\bthe (system|server|api|service) (is|was) unable/i,
];

// ── Semantic checks (multi-signal) ──────────────────────────────────

interface StructuralSignal {
  check: (text: string) => boolean;
  weight: number;
  name: string;
}

const REFUSAL_STRUCTURAL_SIGNALS: StructuralSignal[] = [
  { check: (text) => !text.includes("```"), weight: 0.15, name: "no_code_blocks" },
  { check: (text) => text.length < 500, weight: 0.1, name: "very_short_output" },
  { check: (text) => /^(I'?m sorry|I apologize|Unfortunately)/i.test(text.trim()), weight: 0.2, name: "starts_with_apology" },
  { check: (text) => !(text.includes("/") || text.includes("\\") || text.includes("import ") || text.includes("require(")), weight: 0.1, name: "no_file_paths" },
];

// ── Main detection function ─────────────────────────────────────────

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
function detectRefusal(output: string | null | undefined, agentName: string = "Claude"): RefusalResult {
  if (!output || typeof output !== "string") {
    return { isRefusal: false, confidence: 0, type: "NONE", matchedPatterns: [], details: "Empty output" };
  }

  const checkRegion = output.substring(0, 1000);
  let totalScore = 0;
  const matchedPatterns: string[] = [];
  let isHard = false;

  // 1. Check false positive patterns first
  let falsePositiveReduction = 0;
  for (const fp of FALSE_POSITIVE_PATTERNS) {
    if (fp.test(checkRegion)) {
      falsePositiveReduction += 0.3;
    }
  }

  // 2. Check hard refusal patterns
  for (const { pattern, weight } of HARD_REFUSAL_PATTERNS) {
    if (pattern.test(checkRegion)) {
      totalScore += weight;
      matchedPatterns.push(pattern.toString());
      isHard = true;
    }
  }

  // 3. Check soft refusal patterns
  for (const { pattern, weight } of SOFT_REFUSAL_PATTERNS) {
    if (pattern.test(checkRegion)) {
      totalScore += weight;
      matchedPatterns.push(pattern.toString());
    }
  }

  // 4. Apply structural signals
  for (const signal of REFUSAL_STRUCTURAL_SIGNALS) {
    if (signal.check(output)) {
      totalScore += signal.weight;
      matchedPatterns.push(`[structural: ${signal.name}]`);
    }
  }

  // 5. Apply false positive reduction
  totalScore = Math.max(0, totalScore - falsePositiveReduction);

  // 6. Normalize confidence to 0-1
  const confidence = Math.min(1.0, totalScore);

  // 7. Determine result
  const isRefusal = confidence >= 0.6;
  const type: "HARD" | "SOFT" | "NONE" = isRefusal ? (isHard ? "HARD" : "SOFT") : "NONE";

  if (isRefusal) {
    logWarn(`[Refusal] ${agentName} refusal detected (confidence: ${(confidence * 100).toFixed(0)}%, type: ${type})`);
    logDebug(`[Refusal] Matched patterns: ${matchedPatterns.join(", ")}`);
  }

  return {
    isRefusal,
    confidence,
    type,
    matchedPatterns,
    details: isRefusal
      ? `${agentName} appears to have refused the request (${(confidence * 100).toFixed(0)}% confidence, ${type}): "${checkRegion.substring(0, 200)}..."`
      : "No refusal detected",
  };
}

/**
 * Enhanced replacement for the existing detectClaudeRefusal() in utils.js.
 * Throws an error if a high-confidence refusal is detected.
 */
function detectClaudeRefusalEnhanced(output: string | null | undefined, agentName: string): void {
  if (!output) return;

  const result = detectRefusal(output, agentName);

  if (result.isRefusal && result.confidence >= 0.7) {
    throw new Error(
      `${agentName} refused the request (${(result.confidence * 100).toFixed(0)}% confidence, ${result.type}): ` +
      `"${output.substring(0, 200)}...". Review the prompt for policy violations or overly sensitive content.`
    );
  }

  if (result.confidence >= 0.4 && result.confidence < 0.7) {
    logWarn(`[Refusal] ${agentName}: possible refusal detected (${(result.confidence * 100).toFixed(0)}% confidence) — proceeding with caution`);
  }
}

/**
 * Get all refusal patterns (combined) for external use.
 */
function getAllRefusalPatterns(): RegExp[] {
  return [
    ...HARD_REFUSAL_PATTERNS.map((p) => p.pattern),
    ...SOFT_REFUSAL_PATTERNS.map((p) => p.pattern),
  ];
}

export {
  HARD_REFUSAL_PATTERNS,
  SOFT_REFUSAL_PATTERNS,
  FALSE_POSITIVE_PATTERNS,
  REFUSAL_STRUCTURAL_SIGNALS,
  detectRefusal,
  detectClaudeRefusalEnhanced,
  getAllRefusalPatterns,
};
