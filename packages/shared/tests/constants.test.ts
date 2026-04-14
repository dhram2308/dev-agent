import { describe, it, expect } from 'vitest';
import {
  STAGES, STAGE_REQUIREMENTS, REQUIRED_GATES, STAGE_CLEARS,
  ALLOWED_MR_TARGETS, BINARY_EXTENSIONS, REFUSAL_PATTERNS,
  MAX_PIPELINE_DURATION_DEFAULT, MAX_PROMPT_TOKENS_DEFAULT, LEVEL_ORDER,
} from '../src/constants';

describe('constants', () => {
  describe('STAGES', () => {
    it('has 11 stages', () => {
      expect(STAGES).toHaveLength(11);
    });

    it('starts with fetch_ticket and ends with done', () => {
      expect(STAGES[0]).toBe('fetch_ticket');
      expect(STAGES[STAGES.length - 1]).toBe('done');
    });

    it('contains all expected stages in order', () => {
      expect([...STAGES]).toEqual([
        'fetch_ticket', 'explore_plan', 'generate_code',
        'gate_code_review', 'deploy_qa', 'test_qa',
        'gate_preprod_approval', 'create_preprod_mr',
        'gate_dual_approval', 'deploy_prod', 'done',
      ]);
    });
  });

  describe('STAGE_REQUIREMENTS', () => {
    it('has an entry for every stage', () => {
      for (const stage of STAGES) {
        expect(STAGE_REQUIREMENTS).toHaveProperty(stage);
      }
    });

    it('fetch_ticket requires nothing', () => {
      expect(STAGE_REQUIREMENTS.fetch_ticket).toEqual([]);
    });

    it('generate_code requires ticket and explore_plan', () => {
      expect(STAGE_REQUIREMENTS.generate_code).toContain('ticket');
      expect(STAGE_REQUIREMENTS.generate_code).toContain('explore_plan');
    });
  });

  describe('REQUIRED_GATES', () => {
    it('does not include done', () => {
      expect(REQUIRED_GATES).not.toContain('done');
    });

    it('includes gate stages', () => {
      expect(REQUIRED_GATES).toContain('gate_code_review');
      expect(REQUIRED_GATES).toContain('gate_preprod_approval');
      expect(REQUIRED_GATES).toContain('gate_dual_approval');
    });
  });

  describe('STAGE_CLEARS', () => {
    it('has an entry for every stage', () => {
      for (const stage of STAGES) {
        expect(STAGE_CLEARS).toHaveProperty(stage);
      }
    });

    it('done clears nothing', () => {
      expect(STAGE_CLEARS.done).toEqual([]);
    });

    it('generate_code clears the most fields', () => {
      const lengths = STAGES.map(s => STAGE_CLEARS[s].length);
      expect(STAGE_CLEARS.generate_code.length).toBe(Math.max(...lengths));
    });
  });

  describe('ALLOWED_MR_TARGETS', () => {
    it('has 3 targets', () => {
      expect(ALLOWED_MR_TARGETS).toHaveLength(3);
    });

    it('contains enterprise branches', () => {
      expect(ALLOWED_MR_TARGETS).toContain('enterprise-qa');
      expect(ALLOWED_MR_TARGETS).toContain('enterprise-pre-pro');
      expect(ALLOWED_MR_TARGETS).toContain('enterprise-master');
    });
  });

  describe('BINARY_EXTENSIONS', () => {
    it('detects image extensions', () => {
      expect(BINARY_EXTENSIONS.has('.png')).toBe(true);
      expect(BINARY_EXTENSIONS.has('.jpg')).toBe(true);
    });

    it('does not include text extensions', () => {
      expect(BINARY_EXTENSIONS.has('.ts')).toBe(false);
      expect(BINARY_EXTENSIONS.has('.js')).toBe(false);
    });
  });

  describe('REFUSAL_PATTERNS', () => {
    it('matches Claude refusal phrases', () => {
      expect(REFUSAL_PATTERNS.some(p => p.test("I can't help with that"))).toBe(true);
      expect(REFUSAL_PATTERNS.some(p => p.test("I cannot assist"))).toBe(true);
      expect(REFUSAL_PATTERNS.some(p => p.test("unable to generate code"))).toBe(true);
    });

    it('does not match normal code output', () => {
      expect(REFUSAL_PATTERNS.some(p => p.test('export function hello() {}'))).toBe(false);
    });
  });

  describe('numeric constants', () => {
    it('MAX_PIPELINE_DURATION_DEFAULT is 4 hours', () => {
      expect(MAX_PIPELINE_DURATION_DEFAULT).toBe(4 * 60 * 60 * 1000);
    });

    it('MAX_PROMPT_TOKENS_DEFAULT is 180k', () => {
      expect(MAX_PROMPT_TOKENS_DEFAULT).toBe(180_000);
    });

    it('LEVEL_ORDER has correct hierarchy', () => {
      expect(LEVEL_ORDER.trace).toBeLessThan(LEVEL_ORDER.debug);
      expect(LEVEL_ORDER.debug).toBeLessThan(LEVEL_ORDER.info);
      expect(LEVEL_ORDER.info).toBeLessThan(LEVEL_ORDER.warn);
      expect(LEVEL_ORDER.warn).toBeLessThan(LEVEL_ORDER.error);
    });
  });
});
