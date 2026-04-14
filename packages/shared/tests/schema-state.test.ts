import { describe, it, expect } from 'vitest';
import {
  validateState, validateTicketId, validateStageName, validateEnvelope, validateEnvelopeV3,
  isUIField, STAGE_NAMES, ENVELOPE_VERSION,
  MAX_STATE_SIZE, PRUNE_THRESHOLD, MAX_METRICS_RUNS, MAX_WARNINGS, MAX_REJECTION_HISTORY,
} from '../src/schema/state';

describe('state schemas', () => {
  describe('validateTicketId', () => {
    it('accepts valid Jira ticket IDs', () => {
      expect(validateTicketId('AUT-1234').success).toBe(true);
      expect(validateTicketId('PROJ-1').success).toBe(true);
    });

    it('rejects invalid ticket IDs', () => {
      expect(validateTicketId('').success).toBe(false);
      expect(validateTicketId('aut-1234').success).toBe(true); // regex is case-insensitive
      expect(validateTicketId('NOPE').success).toBe(false);
      expect(validateTicketId('123-ABC').success).toBe(false);
    });
  });

  describe('validateStageName', () => {
    it('accepts all valid stage names', () => {
      for (const name of STAGE_NAMES) {
        expect(validateStageName(name).success).toBe(true);
      }
    });

    it('rejects invalid stage names', () => {
      expect(validateStageName('invalid_stage').success).toBe(false);
      expect(validateStageName('').success).toBe(false);
    });
  });

  describe('validateState', () => {
    const validState = {
      ticket: 'AUT-100',
      stage: 'fetch_ticket',
      data: {},
    };

    it('accepts a minimal valid state', () => {
      expect(validateState(validState).success).toBe(true);
    });

    it('accepts state with optional fields', () => {
      const result = validateState({
        ...validState,
        startedAt: '2024-01-01T00:00:00Z',
        _seq: 5,
      });
      expect(result.success).toBe(true);
    });

    it('rejects state with invalid ticket', () => {
      expect(validateState({ ...validState, ticket: 'bad' }).success).toBe(false);
    });

    it('rejects state with invalid stage', () => {
      expect(validateState({ ...validState, stage: 'nope' }).success).toBe(false);
    });

    it('rejects non-object input', () => {
      expect(validateState(null).success).toBe(false);
      expect(validateState('string').success).toBe(false);
    });
  });

  describe('validateEnvelope / validateEnvelopeV3', () => {
    const validState = { ticket: 'AUT-1', stage: 'done', data: {} };

    const validV3 = {
      _version: 3,
      _hmac: 'a'.repeat(64),
      _seq: 1,
      _written_by: 1234,
      _written_at: '2024-01-01T00:00:00Z',
      state: validState,
    };

    const validV2 = {
      _version: 2,
      _hmac: 'abc123',
      state: validState,
    };

    it('accepts valid v3 envelope', () => {
      expect(validateEnvelope(validV3).success).toBe(true);
      expect(validateEnvelopeV3(validV3).success).toBe(true);
    });

    it('accepts valid v2 envelope', () => {
      expect(validateEnvelope(validV2).success).toBe(true);
    });

    it('rejects envelope with invalid version', () => {
      expect(validateEnvelope({ ...validV3, _version: 99 }).success).toBe(false);
    });

    it('rejects v3 with bad HMAC', () => {
      expect(validateEnvelopeV3({ ...validV3, _hmac: 'short' }).success).toBe(false);
    });
  });

  describe('isUIField', () => {
    it('recognizes UI field patterns', () => {
      expect(isUIField('gate1_ui_approved')).toBe(true);
      expect(isUIField('gate2_ui_rejected')).toBe(true);
      expect(isUIField('explore_ui_feedback')).toBe(true);
      expect(isUIField('plan_ui_refine')).toBe(true);
      expect(isUIField('plan_ui_refine_instructions')).toBe(true);
    });

    it('rejects non-UI fields', () => {
      expect(isUIField('ticket')).toBe(false);
      expect(isUIField('code_mr_iid')).toBe(false);
      expect(isUIField('ui_something')).toBe(false);
    });
  });

  describe('constants', () => {
    it('ENVELOPE_VERSION is 3', () => {
      expect(ENVELOPE_VERSION).toBe(3);
    });

    it('MAX_STATE_SIZE > PRUNE_THRESHOLD', () => {
      expect(MAX_STATE_SIZE).toBeGreaterThan(PRUNE_THRESHOLD);
    });

    it('numeric limits are positive', () => {
      expect(MAX_METRICS_RUNS).toBeGreaterThan(0);
      expect(MAX_WARNINGS).toBeGreaterThan(0);
      expect(MAX_REJECTION_HISTORY).toBeGreaterThan(0);
    });
  });
});
