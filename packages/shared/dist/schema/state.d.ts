import { z } from 'zod';
export declare const stageNameSchema: z.ZodEnum<{
    fetch_ticket: "fetch_ticket";
    explore_plan: "explore_plan";
    generate_code: "generate_code";
    gate_code_review: "gate_code_review";
    deploy_qa: "deploy_qa";
    test_qa: "test_qa";
    gate_preprod_approval: "gate_preprod_approval";
    create_preprod_mr: "create_preprod_mr";
    gate_dual_approval: "gate_dual_approval";
    deploy_prod: "deploy_prod";
    done: "done";
}>;
/** Stage name type inferred from the Zod enum (compatible with StageName in types/) */
export type StageNameZod = z.infer<typeof stageNameSchema>;
/** All valid stage names as a readonly array */
export declare const STAGE_NAMES: ("fetch_ticket" | "explore_plan" | "generate_code" | "gate_code_review" | "deploy_qa" | "test_qa" | "gate_preprod_approval" | "create_preprod_mr" | "gate_dual_approval" | "deploy_prod" | "done")[];
export declare const ticketIdSchema: z.ZodString;
/** Ticket ID type inferred from the Zod schema */
export type TicketId = z.infer<typeof ticketIdSchema>;
export declare const pipelineStateSchema: z.ZodObject<{
    ticket: z.ZodString;
    stage: z.ZodEnum<{
        fetch_ticket: "fetch_ticket";
        explore_plan: "explore_plan";
        generate_code: "generate_code";
        gate_code_review: "gate_code_review";
        deploy_qa: "deploy_qa";
        test_qa: "test_qa";
        gate_preprod_approval: "gate_preprod_approval";
        create_preprod_mr: "create_preprod_mr";
        gate_dual_approval: "gate_dual_approval";
        deploy_prod: "deploy_prod";
        done: "done";
    }>;
    data: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    startedAt: z.ZodOptional<z.ZodString>;
    _seq: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
/** Pipeline state type inferred from Zod (compatible with PipelineState in types/) */
export type PipelineStateZod = z.infer<typeof pipelineStateSchema>;
export declare const stateEnvelopeV3Schema: z.ZodObject<{
    _version: z.ZodLiteral<3>;
    _hmac: z.ZodString;
    _seq: z.ZodNumber;
    _written_by: z.ZodNumber;
    _written_at: z.ZodString;
    state: z.ZodObject<{
        ticket: z.ZodString;
        stage: z.ZodEnum<{
            fetch_ticket: "fetch_ticket";
            explore_plan: "explore_plan";
            generate_code: "generate_code";
            gate_code_review: "gate_code_review";
            deploy_qa: "deploy_qa";
            test_qa: "test_qa";
            gate_preprod_approval: "gate_preprod_approval";
            create_preprod_mr: "create_preprod_mr";
            gate_dual_approval: "gate_dual_approval";
            deploy_prod: "deploy_prod";
            done: "done";
        }>;
        data: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        startedAt: z.ZodOptional<z.ZodString>;
        _seq: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const stateEnvelopeV2Schema: z.ZodObject<{
    _version: z.ZodLiteral<2>;
    _hmac: z.ZodString;
    state: z.ZodObject<{
        ticket: z.ZodString;
        stage: z.ZodEnum<{
            fetch_ticket: "fetch_ticket";
            explore_plan: "explore_plan";
            generate_code: "generate_code";
            gate_code_review: "gate_code_review";
            deploy_qa: "deploy_qa";
            test_qa: "test_qa";
            gate_preprod_approval: "gate_preprod_approval";
            create_preprod_mr: "create_preprod_mr";
            gate_dual_approval: "gate_dual_approval";
            deploy_prod: "deploy_prod";
            done: "done";
        }>;
        data: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        startedAt: z.ZodOptional<z.ZodString>;
        _seq: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
}, z.core.$strip>;
/**
 * State envelope schema — accepts both v2 (legacy) and v3 (current).
 * On write, always produce v3.
 */
export declare const stateEnvelopeSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    _version: z.ZodLiteral<3>;
    _hmac: z.ZodString;
    _seq: z.ZodNumber;
    _written_by: z.ZodNumber;
    _written_at: z.ZodString;
    state: z.ZodObject<{
        ticket: z.ZodString;
        stage: z.ZodEnum<{
            fetch_ticket: "fetch_ticket";
            explore_plan: "explore_plan";
            generate_code: "generate_code";
            gate_code_review: "gate_code_review";
            deploy_qa: "deploy_qa";
            test_qa: "test_qa";
            gate_preprod_approval: "gate_preprod_approval";
            create_preprod_mr: "create_preprod_mr";
            gate_dual_approval: "gate_dual_approval";
            deploy_prod: "deploy_prod";
            done: "done";
        }>;
        data: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        startedAt: z.ZodOptional<z.ZodString>;
        _seq: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    _version: z.ZodLiteral<2>;
    _hmac: z.ZodString;
    state: z.ZodObject<{
        ticket: z.ZodString;
        stage: z.ZodEnum<{
            fetch_ticket: "fetch_ticket";
            explore_plan: "explore_plan";
            generate_code: "generate_code";
            gate_code_review: "gate_code_review";
            deploy_qa: "deploy_qa";
            test_qa: "test_qa";
            gate_preprod_approval: "gate_preprod_approval";
            create_preprod_mr: "create_preprod_mr";
            gate_dual_approval: "gate_dual_approval";
            deploy_prod: "deploy_prod";
            done: "done";
        }>;
        data: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        startedAt: z.ZodOptional<z.ZodString>;
        _seq: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
}, z.core.$strip>], "_version">;
export type StateEnvelopeV3 = z.infer<typeof stateEnvelopeV3Schema>;
export type StateEnvelopeV2 = z.infer<typeof stateEnvelopeV2Schema>;
export type StateEnvelope = z.infer<typeof stateEnvelopeSchema>;
/** Current envelope version (always write this version) */
export declare const ENVELOPE_VERSION: 3;
export declare const UI_FIELD_SUFFIXES: readonly ["_ui_approved", "_ui_rejected", "_ui_feedback", "_ui_refine", "_ui_refine_instructions"];
/** Check if a state data key is a UI-owned field */
export declare function isUIField(key: string): boolean;
/** Validate a pipeline state object */
export declare function validateState(data: unknown): z.ZodSafeParseResult<{
    ticket: string;
    stage: "fetch_ticket" | "explore_plan" | "generate_code" | "gate_code_review" | "deploy_qa" | "test_qa" | "gate_preprod_approval" | "create_preprod_mr" | "gate_dual_approval" | "deploy_prod" | "done";
    data: Record<string, unknown>;
    startedAt?: string | undefined;
    _seq?: number | undefined;
}>;
/** Validate a ticket ID string */
export declare function validateTicketId(id: string): z.ZodSafeParseResult<string>;
/** Validate a stage name string */
export declare function validateStageName(name: string): z.ZodSafeParseResult<"fetch_ticket" | "explore_plan" | "generate_code" | "gate_code_review" | "deploy_qa" | "test_qa" | "gate_preprod_approval" | "create_preprod_mr" | "gate_dual_approval" | "deploy_prod" | "done">;
/** Validate a state envelope (v2 or v3) */
export declare function validateEnvelope(data: unknown): z.ZodSafeParseResult<{
    _version: 3;
    _hmac: string;
    _seq: number;
    _written_by: number;
    _written_at: string;
    state: {
        ticket: string;
        stage: "fetch_ticket" | "explore_plan" | "generate_code" | "gate_code_review" | "deploy_qa" | "test_qa" | "gate_preprod_approval" | "create_preprod_mr" | "gate_dual_approval" | "deploy_prod" | "done";
        data: Record<string, unknown>;
        startedAt?: string | undefined;
        _seq?: number | undefined;
    };
} | {
    _version: 2;
    _hmac: string;
    state: {
        ticket: string;
        stage: "fetch_ticket" | "explore_plan" | "generate_code" | "gate_code_review" | "deploy_qa" | "test_qa" | "gate_preprod_approval" | "create_preprod_mr" | "gate_dual_approval" | "deploy_prod" | "done";
        data: Record<string, unknown>;
        startedAt?: string | undefined;
        _seq?: number | undefined;
    };
}>;
/** Validate a v3 envelope specifically */
export declare function validateEnvelopeV3(data: unknown): z.ZodSafeParseResult<{
    _version: 3;
    _hmac: string;
    _seq: number;
    _written_by: number;
    _written_at: string;
    state: {
        ticket: string;
        stage: "fetch_ticket" | "explore_plan" | "generate_code" | "gate_code_review" | "deploy_qa" | "test_qa" | "gate_preprod_approval" | "create_preprod_mr" | "gate_dual_approval" | "deploy_prod" | "done";
        data: Record<string, unknown>;
        startedAt?: string | undefined;
        _seq?: number | undefined;
    };
}>;
/** Hard limit for state file size in bytes (10MB) */
export declare const MAX_STATE_SIZE = 10000000;
/** Threshold that triggers state pruning (8MB) */
export declare const PRUNE_THRESHOLD = 8000000;
/** Max number of metrics runs to keep per stage */
export declare const MAX_METRICS_RUNS = 5;
/** Max number of warnings to keep in state */
export declare const MAX_WARNINGS = 200;
/** Max number of rejection history entries */
export declare const MAX_REJECTION_HISTORY = 20;
//# sourceMappingURL=state.d.ts.map