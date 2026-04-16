/**
 * constants.ts -- Pipeline stages, requirements, gates, and other constants
 *
 * Converted from lib/constants.js (zero functional changes).
 */
/** All pipeline stage names */
export type StageName = "fetch_ticket" | "explore_plan" | "generate_code" | "gate_code_review" | "deploy_qa" | "test_qa" | "gate_preprod_approval" | "create_preprod_mr" | "gate_dual_approval" | "deploy_prod" | "done";
/** Pipeline stages (ordered) */
export declare const STAGES: readonly StageName[];
/** W1: Stage entry requirements map */
export declare const STAGE_REQUIREMENTS: Record<StageName, readonly string[]>;
/** W2: Required gates for production deploy */
export declare const REQUIRED_GATES: readonly StageName[];
/** O11: Stage downstream data clears */
export declare const STAGE_CLEARS: Record<string, readonly string[]>;
/** S5: MR target branch whitelist */
export declare const ALLOWED_MR_TARGETS: readonly string[];
/** L1: Binary content detection */
export declare const BINARY_EXTENSIONS: Set<string>;
/** W8: Claude safety refusal detection */
export declare const REFUSAL_PATTERNS: readonly RegExp[];
//# sourceMappingURL=constants.d.ts.map