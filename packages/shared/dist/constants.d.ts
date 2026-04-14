import type { StageName } from './types';
export declare const STAGES: readonly ["fetch_ticket", "explore_plan", "generate_code", "gate_code_review", "deploy_qa", "test_qa", "gate_preprod_approval", "create_preprod_mr", "gate_dual_approval", "deploy_prod", "done"];
export declare const STAGE_REQUIREMENTS: Readonly<Record<StageName, readonly string[]>>;
export declare const REQUIRED_GATES: readonly StageName[];
export declare const STAGE_CLEARS: Readonly<Record<StageName, readonly string[]>>;
export declare const ALLOWED_MR_TARGETS: readonly ["enterprise-qa", "enterprise-pre-pro", "enterprise-master"];
export type AllowedMRTarget = typeof ALLOWED_MR_TARGETS[number];
export declare const BINARY_EXTENSIONS: ReadonlySet<string>;
export declare const REFUSAL_PATTERNS: readonly RegExp[];
/** Default maximum pipeline duration in milliseconds (4 hours). */
export declare const MAX_PIPELINE_DURATION_DEFAULT: number;
/** Default maximum prompt tokens (estimated at ~4 chars per token). */
export declare const MAX_PROMPT_TOKENS_DEFAULT = 180000;
export declare const LEVEL_ORDER: {
    readonly trace: 0;
    readonly debug: 1;
    readonly info: 2;
    readonly warn: 3;
    readonly error: 4;
};
export type LogLevel = keyof typeof LEVEL_ORDER;
//# sourceMappingURL=constants.d.ts.map