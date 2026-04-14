"use strict";
// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — State Zod Schemas
// ═══════════════════════════════════════════════════════════════
//
// Ported from:
//   - lib/state-unified.js  (envelope format: wrapEnvelope / unwrapEnvelope)
//   - lib/constants.js      (STAGES array for stage name enum)
//
// NOTE: zod is listed as a dependency but may not be installed yet.
// It will resolve once `npm install` runs against the workspace package.json.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_REJECTION_HISTORY = exports.MAX_WARNINGS = exports.MAX_METRICS_RUNS = exports.PRUNE_THRESHOLD = exports.MAX_STATE_SIZE = exports.UI_FIELD_SUFFIXES = exports.ENVELOPE_VERSION = exports.stateEnvelopeSchema = exports.stateEnvelopeV2Schema = exports.stateEnvelopeV3Schema = exports.pipelineStateSchema = exports.ticketIdSchema = exports.STAGE_NAMES = exports.stageNameSchema = void 0;
exports.isUIField = isUIField;
exports.validateState = validateState;
exports.validateTicketId = validateTicketId;
exports.validateStageName = validateStageName;
exports.validateEnvelope = validateEnvelope;
exports.validateEnvelopeV3 = validateEnvelopeV3;
const zod_1 = require("zod");
// ═══════════════════════════════════════════════════════════════
// Stage name enum
// ═══════════════════════════════════════════════════════════════
// Source: lib/constants.js STAGES array
exports.stageNameSchema = zod_1.z.enum([
    'fetch_ticket',
    'explore_plan',
    'generate_code',
    'gate_code_review',
    'deploy_qa',
    'test_qa',
    'gate_preprod_approval',
    'create_preprod_mr',
    'gate_dual_approval',
    'deploy_prod',
    'done',
]);
/** All valid stage names as a readonly array */
exports.STAGE_NAMES = exports.stageNameSchema.options;
// ═══════════════════════════════════════════════════════════════
// Ticket ID format
// ═══════════════════════════════════════════════════════════════
exports.ticketIdSchema = zod_1.z
    .string()
    .regex(/^[A-Z]+-\d+$/i, 'Must match Jira ticket format (e.g., AUT-1234)');
// ═══════════════════════════════════════════════════════════════
// Pipeline state schema — the inner state object
// ═══════════════════════════════════════════════════════════════
// This is what the agent and server read/write. It lives inside
// the envelope's `state` field on disk.
//
// Source: lib/state-unified.js loadSync() fresh state shape:
//   { stage, ticket, data: {}, startedAt, _seq: 1 }
exports.pipelineStateSchema = zod_1.z.object({
    /** Jira ticket key this pipeline is running for */
    ticket: exports.ticketIdSchema,
    /** Current pipeline stage */
    stage: exports.stageNameSchema,
    /**
     * Arbitrary stage data accumulator.
     * Each stage writes its outputs here (ticket context, code changes,
     * MR IIDs, test results, UI approval fields, etc.).
     */
    data: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()),
    /** ISO 8601 timestamp when this pipeline run started */
    startedAt: zod_1.z.string().datetime().optional(),
    /** Monotonic sequence number — incremented on every write (CAS guard) */
    _seq: zod_1.z.number().int().nonnegative().optional(),
});
// ═══════════════════════════════════════════════════════════════
// State envelope — on-disk format
// ═══════════════════════════════════════════════════════════════
// Source: lib/state-unified.js wrapEnvelope() / unwrapEnvelope()
//
// v3 envelope format (current):
//   { _version: 3, _hmac, _seq, _written_by, _written_at, state }
//
// v2 envelope format (legacy, read-only compat):
//   { _version: 2, _hmac, state }
exports.stateEnvelopeV3Schema = zod_1.z.object({
    /** Envelope format version */
    _version: zod_1.z.literal(3),
    /** HMAC-SHA256 of the serialized state payload */
    _hmac: zod_1.z.string().regex(/^[0-9a-f]{64}$/, 'Must be a 64-char hex HMAC-SHA256'),
    /** Monotonic sequence number — mirrors state._seq */
    _seq: zod_1.z.number().int().nonnegative(),
    /** PID of the process that wrote this envelope */
    _written_by: zod_1.z.number().int().positive(),
    /** ISO 8601 timestamp of write */
    _written_at: zod_1.z.string().datetime(),
    /** The actual pipeline state */
    state: exports.pipelineStateSchema,
});
exports.stateEnvelopeV2Schema = zod_1.z.object({
    /** Envelope format version */
    _version: zod_1.z.literal(2),
    /** HMAC-SHA256 of the serialized state payload */
    _hmac: zod_1.z.string(),
    /** The actual pipeline state */
    state: exports.pipelineStateSchema,
});
/**
 * State envelope schema — accepts both v2 (legacy) and v3 (current).
 * On write, always produce v3.
 */
exports.stateEnvelopeSchema = zod_1.z.discriminatedUnion('_version', [
    exports.stateEnvelopeV3Schema,
    exports.stateEnvelopeV2Schema,
]);
/** Current envelope version (always write this version) */
exports.ENVELOPE_VERSION = 3;
// ═══════════════════════════════════════════════════════════════
// UI field pattern
// ═══════════════════════════════════════════════════════════════
// Source: lib/state-unified.js UI_FIELD_PATTERN
//
// UI fields follow the pattern: *_ui_(approved|rejected|feedback|refine|refine_instructions)
// These are the only fields the server/UI is allowed to write.
exports.UI_FIELD_SUFFIXES = [
    '_ui_approved',
    '_ui_rejected',
    '_ui_feedback',
    '_ui_refine',
    '_ui_refine_instructions',
];
const UI_FIELD_REGEX = /^.*_ui_(approved|rejected|feedback|refine|refine_instructions)$/;
/** Check if a state data key is a UI-owned field */
function isUIField(key) {
    return UI_FIELD_REGEX.test(key);
}
// ═══════════════════════════════════════════════════════════════
// Validation functions
// ═══════════════════════════════════════════════════════════════
/** Validate a pipeline state object */
function validateState(data) {
    return exports.pipelineStateSchema.safeParse(data);
}
/** Validate a ticket ID string */
function validateTicketId(id) {
    return exports.ticketIdSchema.safeParse(id);
}
/** Validate a stage name string */
function validateStageName(name) {
    return exports.stageNameSchema.safeParse(name);
}
/** Validate a state envelope (v2 or v3) */
function validateEnvelope(data) {
    return exports.stateEnvelopeSchema.safeParse(data);
}
/** Validate a v3 envelope specifically */
function validateEnvelopeV3(data) {
    return exports.stateEnvelopeV3Schema.safeParse(data);
}
// ═══════════════════════════════════════════════════════════════
// State size limits (from state-unified.js)
// ═══════════════════════════════════════════════════════════════
/** Hard limit for state file size in bytes (10MB) */
exports.MAX_STATE_SIZE = 10_000_000;
/** Threshold that triggers state pruning (8MB) */
exports.PRUNE_THRESHOLD = 8_000_000;
/** Max number of metrics runs to keep per stage */
exports.MAX_METRICS_RUNS = 5;
/** Max number of warnings to keep in state */
exports.MAX_WARNINGS = 200;
/** Max number of rejection history entries */
exports.MAX_REJECTION_HISTORY = 20;
//# sourceMappingURL=state.js.map