import { describe, it, expect } from 'vitest';
import {
  validateFrozenConfig, validateFreshConfig, validateFlatConfig,
  isFrozenField, isFreshField, FROZEN_FIELD_NAMES, FRESH_FIELD_NAMES,
} from '../src/schema/config';

// Minimal valid frozen config (only required fields, rest use defaults)
const minFrozen = {
  TICKET: 'AUT-100',
  GITLAB_PROJECT_ID: 42,
  GITLAB_TOKEN: 'glpat-xxx',
  JIRA_EMAIL: 'test@example.com',
  JIRA_TOKEN: 'jira-tok',
};

describe('config schemas', () => {
  describe('validateFrozenConfig', () => {
    it('accepts minimal valid frozen config', () => {
      const result = validateFrozenConfig(minFrozen);
      expect(result.success).toBe(true);
    });

    it('fills defaults for optional fields', () => {
      const result = validateFrozenConfig(minFrozen);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.BRANCH_TS).toBe('enterprise-ts');
        expect(result.data.PORT).toBe(3000);
        expect(result.data.PLAYWRIGHT_BROWSER).toBe('chromium');
      }
    });

    it('rejects invalid ticket format', () => {
      expect(validateFrozenConfig({ ...minFrozen, TICKET: 'bad' }).success).toBe(false);
    });

    it('rejects invalid email', () => {
      expect(validateFrozenConfig({ ...minFrozen, JIRA_EMAIL: 'not-email' }).success).toBe(false);
    });

    it('rejects missing required fields', () => {
      expect(validateFrozenConfig({}).success).toBe(false);
    });
  });

  describe('validateFreshConfig', () => {
    it('accepts empty object (all have defaults)', () => {
      const result = validateFreshConfig({});
      expect(result.success).toBe(true);
    });

    it('fills timeout defaults', () => {
      const result = validateFreshConfig({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.CLAUDE_TIMEOUT).toBe(180_000);
        expect(result.data.MAX_REJECTIONS).toBe(3);
        expect(result.data.LOG_LEVEL).toBe('info');
      }
    });

    it('rejects out-of-range timeout', () => {
      expect(validateFreshConfig({ CLAUDE_TIMEOUT: 1 }).success).toBe(false);
    });
  });

  describe('validateFlatConfig — cross-field validation', () => {
    const validFlat = {
      ...minFrozen,
      // Override default HTTP URL to avoid cross-field #7 warning
      GITLAB_URL: 'https://gitlab.example.com',
      // Ensure port ranges are valid
      NX_SERVE_PORT_RANGE_START: 4200,
      NX_SERVE_PORT_RANGE_END: 4299,
      VITE_PREVIEW_PORT_START: 4300,
      VITE_PREVIEW_PORT_END: 4399,
      // Ensure reminders are ordered
      APPROVAL_REMINDER_1H: 3_600_000,
      APPROVAL_REMINDER_4H: 14_400_000,
      // Ensure approval < pipeline
      MAX_APPROVAL_TIMEOUT: 28_800_000,
      MAX_PIPELINE_DURATION: 86_400_000,
      // Cross-field #6: need at least one approver or ALLOW_ANY_APPROVER
      ALLOW_ANY_APPROVER: true,
    };

    it('accepts valid flat config', () => {
      expect(validateFlatConfig(validFlat).success).toBe(true);
    });

    it('rejects inverted NX port range', () => {
      const result = validateFlatConfig({
        ...validFlat,
        NX_SERVE_PORT_RANGE_START: 5000,
        NX_SERVE_PORT_RANGE_END: 4000,
      });
      expect(result.success).toBe(false);
    });

    it('rejects inverted Vite port range', () => {
      const result = validateFlatConfig({
        ...validFlat,
        VITE_PREVIEW_PORT_START: 5000,
        VITE_PREVIEW_PORT_END: 4000,
      });
      expect(result.success).toBe(false);
    });

    it('rejects first reminder >= second reminder', () => {
      const result = validateFlatConfig({
        ...validFlat,
        APPROVAL_REMINDER_1H: 20_000_000,
        APPROVAL_REMINDER_4H: 14_400_000,
      });
      expect(result.success).toBe(false);
    });

    it('rejects approval timeout >= pipeline duration', () => {
      const result = validateFlatConfig({
        ...validFlat,
        MAX_APPROVAL_TIMEOUT: 100_000_000,
        MAX_PIPELINE_DURATION: 86_400_000,
      });
      expect(result.success).toBe(false);
    });

    it('rejects duplicate approver IDs', () => {
      const result = validateFlatConfig({
        ...validFlat,
        OWNER_JIRA_ID: 'same-id',
        QA_JIRA_ID: 'same-id',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('field classification', () => {
    it('TICKET is frozen', () => {
      expect(isFrozenField('TICKET')).toBe(true);
      expect(isFreshField('TICKET')).toBe(false);
    });

    it('MAX_REJECTIONS is fresh', () => {
      expect(isFreshField('MAX_REJECTIONS')).toBe(true);
      expect(isFrozenField('MAX_REJECTIONS')).toBe(false);
    });

    it('frozen and fresh sets do not overlap', () => {
      for (const name of FROZEN_FIELD_NAMES) {
        expect(FRESH_FIELD_NAMES.has(name)).toBe(false);
      }
    });
  });
});
