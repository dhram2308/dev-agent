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

import { z } from 'zod';

// ═══════════════════════════════════════════════════════════════
// Stage name enum
// ═══════════════════════════════════════════════════════════════
// Source: lib/constants.js STAGES array

export const stageNameSchema = z.enum([
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

/** Stage name type inferred from the Zod enum (compatible with StageName in types/) */
export type StageNameZod = z.infer<typeof stageNameSchema>;

/** All valid stage names as a readonly array */
export const STAGE_NAMES = stageNameSchema.options;

// ═══════════════════════════════════════════════════════════════
// Ticket ID format
// ═══════════════════════════════════════════════════════════════

export const ticketIdSchema = z
  .string()
  .regex(/^[A-Z]+-\d+$/i, 'Must match Jira ticket format (e.g., AUT-1234)');

/** Ticket ID type inferred from the Zod schema */
export type TicketId = z.infer<typeof ticketIdSchema>;

// ═══════════════════════════════════════════════════════════════
// Pipeline state schema — the inner state object
// ═══════════════════════════════════════════════════════════════
// This is what the agent and server read/write. It lives inside
// the envelope's `state` field on disk.
//
// Source: lib/state-unified.js loadSync() fresh state shape:
//   { stage, ticket, data: {}, startedAt, _seq: 1 }

export const pipelineStateSchema = z.object({
  /** Jira ticket key this pipeline is running for */
  ticket: ticketIdSchema,

  /** Current pipeline stage */
  stage: stageNameSchema,

  /**
   * Arbitrary stage data accumulator.
   * Each stage writes its outputs here (ticket context, code changes,
   * MR IIDs, test results, UI approval fields, etc.).
   */
  data: z.record(z.string(), z.unknown()),

  /** ISO 8601 timestamp when this pipeline run started */
  startedAt: z.string().datetime().optional(),

  /** Monotonic sequence number — incremented on every write (CAS guard) */
  _seq: z.number().int().nonnegative().optional(),
});

/** Pipeline state type inferred from Zod (compatible with PipelineState in types/) */
export type PipelineStateZod = z.infer<typeof pipelineStateSchema>;

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

export const stateEnvelopeV3Schema = z.object({
  /** Envelope format version */
  _version: z.literal(3),

  /** HMAC-SHA256 of the serialized state payload */
  _hmac: z.string().regex(/^[0-9a-f]{64}$/, 'Must be a 64-char hex HMAC-SHA256'),

  /** Monotonic sequence number — mirrors state._seq */
  _seq: z.number().int().nonnegative(),

  /** PID of the process that wrote this envelope */
  _written_by: z.number().int().positive(),

  /** ISO 8601 timestamp of write */
  _written_at: z.string().datetime(),

  /** The actual pipeline state */
  state: pipelineStateSchema,
});

export const stateEnvelopeV2Schema = z.object({
  /** Envelope format version */
  _version: z.literal(2),

  /** HMAC-SHA256 of the serialized state payload */
  _hmac: z.string(),

  /** The actual pipeline state */
  state: pipelineStateSchema,
});

/**
 * State envelope schema — accepts both v2 (legacy) and v3 (current).
 * On write, always produce v3.
 */
export const stateEnvelopeSchema = z.discriminatedUnion('_version', [
  stateEnvelopeV3Schema,
  stateEnvelopeV2Schema,
]);

export type StateEnvelopeV3 = z.infer<typeof stateEnvelopeV3Schema>;
export type StateEnvelopeV2 = z.infer<typeof stateEnvelopeV2Schema>;
export type StateEnvelope = z.infer<typeof stateEnvelopeSchema>;

/** Current envelope version (always write this version) */
export const ENVELOPE_VERSION = 3 as const;

// ═══════════════════════════════════════════════════════════════
// UI field pattern
// ═══════════════════════════════════════════════════════════════
// Source: lib/state-unified.js UI_FIELD_PATTERN
//
// UI fields follow the pattern: *_ui_(approved|rejected|feedback|refine|refine_instructions)
// These are the only fields the server/UI is allowed to write.

export const UI_FIELD_SUFFIXES = [
  '_ui_approved',
  '_ui_rejected',
  '_ui_feedback',
  '_ui_refine',
  '_ui_refine_instructions',
] as const;

const UI_FIELD_REGEX = /^.*_ui_(approved|rejected|feedback|refine|refine_instructions)$/;

/** Check if a state data key is a UI-owned field */
export function isUIField(key: string): boolean {
  return UI_FIELD_REGEX.test(key);
}

// ═══════════════════════════════════════════════════════════════
// Validation functions
// ═══════════════════════════════════════════════════════════════

/** Validate a pipeline state object */
export function validateState(data: unknown) {
  return pipelineStateSchema.safeParse(data);
}

/** Validate a ticket ID string */
export function validateTicketId(id: string) {
  return ticketIdSchema.safeParse(id);
}

/** Validate a stage name string */
export function validateStageName(name: string) {
  return stageNameSchema.safeParse(name);
}

/** Validate a state envelope (v2 or v3) */
export function validateEnvelope(data: unknown) {
  return stateEnvelopeSchema.safeParse(data);
}

/** Validate a v3 envelope specifically */
export function validateEnvelopeV3(data: unknown) {
  return stateEnvelopeV3Schema.safeParse(data);
}

// ═══════════════════════════════════════════════════════════════
// State size limits (from state-unified.js)
// ═══════════════════════════════════════════════════════════════

/** Hard limit for state file size in bytes (10MB) */
export const MAX_STATE_SIZE = 10_000_000;

/** Threshold that triggers state pruning (8MB) */
export const PRUNE_THRESHOLD = 8_000_000;

/** Max number of metrics runs to keep per stage */
export const MAX_METRICS_RUNS = 5;

/** Max number of warnings to keep in state */
export const MAX_WARNINGS = 200;

/** Max number of rejection history entries */
export const MAX_REJECTION_HISTORY = 20;
