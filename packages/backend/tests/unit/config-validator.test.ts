// =====================================================================
// config-validator.test.ts -- Unit tests for config validation
// =====================================================================
//
// Tests: required fields, numeric validation, cross-field checks,
//        URL format, boolean parsing, enum validation, port ranges
// =====================================================================

import { describe, it, expect } from 'vitest';
import {
  validateAllConfig,
  Severity,
  type ValidationResult,
} from '../../src/config/validator';

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a minimal valid env config. */
function minimalValidEnv(): Record<string, string> {
  return {
    TICKET: 'AUT-1234',
    JIRA_TOKEN: 'some-token',
    JIRA_EMAIL: 'user@example.com',
    GITLAB_TOKEN: 'glpat-xxxx',
    GITLAB_PROJECT_ID: '42',
    OWNER_JIRA_ID: 'owner-id',
    QA_JIRA_ID: 'qa-id',
    JIRA_BASE_URL: 'https://example.atlassian.net',
    GITLAB_URL: 'https://gitlab.example.com',
  };
}

/** Find results matching a field name. */
function findByField(results: ValidationResult[], field: string): ValidationResult[] {
  return results.filter((r) => r.field === field);
}

/** Find results matching a severity. */
function findBySeverity(results: ValidationResult[], severity: Severity): ValidationResult[] {
  return results.filter((r) => r.severity === severity);
}

// ═══════════════════════════════════════════════════════════════════════
// Required Fields Tests
// ═══════════════════════════════════════════════════════════════════════

describe('required fields', () => {
  it('passes validation when all required fields are present', () => {
    const env = minimalValidEnv();
    const output = validateAllConfig(env);

    const fatals = findBySeverity(output.results, Severity.FATAL);
    expect(fatals).toHaveLength(0);
    expect(output.valid).toBe(true);
  });

  it('reports FATAL when TICKET is missing', () => {
    const env = minimalValidEnv();
    delete env.TICKET;

    const output = validateAllConfig(env);
    const ticketErrors = findByField(output.results, 'TICKET');

    expect(ticketErrors.some((r) => r.severity === Severity.FATAL)).toBe(true);
    expect(output.valid).toBe(false);
  });

  it('reports FATAL when JIRA_TOKEN is missing', () => {
    const env = minimalValidEnv();
    delete env.JIRA_TOKEN;

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'JIRA_TOKEN');

    expect(errors.some((r) => r.severity === Severity.FATAL)).toBe(true);
  });

  it('reports FATAL when JIRA_EMAIL is missing', () => {
    const env = minimalValidEnv();
    delete env.JIRA_EMAIL;

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'JIRA_EMAIL');

    expect(errors.some((r) => r.severity === Severity.FATAL)).toBe(true);
  });

  it('reports FATAL when GITLAB_TOKEN is missing', () => {
    const env = minimalValidEnv();
    delete env.GITLAB_TOKEN;

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'GITLAB_TOKEN');

    expect(errors.some((r) => r.severity === Severity.FATAL)).toBe(true);
  });

  it('reports FATAL when GITLAB_PROJECT_ID is missing', () => {
    const env = minimalValidEnv();
    delete env.GITLAB_PROJECT_ID;

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'GITLAB_PROJECT_ID');

    expect(errors.some((r) => r.severity === Severity.FATAL)).toBe(true);
  });

  it('treats empty string as missing', () => {
    const env = minimalValidEnv();
    env.TICKET = '';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'TICKET');

    expect(errors.some((r) => r.severity === Severity.FATAL)).toBe(true);
  });

  it('treats whitespace-only string as missing', () => {
    const env = minimalValidEnv();
    env.JIRA_TOKEN = '   ';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'JIRA_TOKEN');

    expect(errors.some((r) => r.severity === Severity.FATAL)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Ticket Format Validation
// ═══════════════════════════════════════════════════════════════════════

describe('ticket format', () => {
  it('accepts valid ticket format like AUT-1234', () => {
    const env = minimalValidEnv();
    env.TICKET = 'AUT-1234';

    const output = validateAllConfig(env);
    const ticketErrors = findByField(output.results, 'TICKET')
      .filter((r) => r.severity === Severity.ERROR);

    expect(ticketErrors).toHaveLength(0);
  });

  it('rejects invalid ticket format', () => {
    const env = minimalValidEnv();
    env.TICKET = 'invalid-format';

    const output = validateAllConfig(env);
    const ticketErrors = findByField(output.results, 'TICKET')
      .filter((r) => r.severity === Severity.ERROR);

    expect(ticketErrors.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Numeric Validation Tests
// ═══════════════════════════════════════════════════════════════════════

describe('numeric validation', () => {
  it('accepts valid numeric GITLAB_PROJECT_ID', () => {
    const env = minimalValidEnv();
    env.GITLAB_PROJECT_ID = '42';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'GITLAB_PROJECT_ID')
      .filter((r) => r.severity === Severity.ERROR || r.severity === Severity.FATAL);

    // Only the "required" check should not trigger since it's present
    expect(errors.filter((r) => r.message.includes('Invalid numeric'))).toHaveLength(0);
  });

  it('rejects non-numeric GITLAB_PROJECT_ID', () => {
    const env = minimalValidEnv();
    env.GITLAB_PROJECT_ID = 'not-a-number';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'GITLAB_PROJECT_ID');

    expect(errors.some((r) => r.message.includes('Invalid numeric'))).toBe(true);
  });

  it('rejects POLL_INTERVAL below minimum (5000)', () => {
    const env = minimalValidEnv();
    env.POLL_INTERVAL = '100';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'POLL_INTERVAL');

    expect(errors.some((r) => r.message.includes('below minimum'))).toBe(true);
  });

  it('rejects POLL_INTERVAL above maximum (300000)', () => {
    const env = minimalValidEnv();
    env.POLL_INTERVAL = '500000';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'POLL_INTERVAL');

    expect(errors.some((r) => r.message.includes('above maximum'))).toBe(true);
  });

  it('accepts POLL_INTERVAL within range', () => {
    const env = minimalValidEnv();
    env.POLL_INTERVAL = '30000';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'POLL_INTERVAL')
      .filter((r) => r.severity === Severity.ERROR);

    expect(errors).toHaveLength(0);
  });

  it('skips numeric validation when field is not set', () => {
    const env = minimalValidEnv();
    // Don't set POLL_INTERVAL at all

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'POLL_INTERVAL')
      .filter((r) => r.severity === Severity.ERROR);

    expect(errors).toHaveLength(0);
  });

  it('rejects port number above 65535', () => {
    const env = minimalValidEnv();
    env.PORT = '70000';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'PORT');

    expect(errors.some((r) => r.message.includes('out of range'))).toBe(true);
  });

  it('rejects negative port number', () => {
    const env = minimalValidEnv();
    env.PORT = '-1';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'PORT');

    expect(errors.some((r) => r.message.includes('out of range'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// URL Format Tests
// ═══════════════════════════════════════════════════════════════════════

describe('URL format validation', () => {
  it('accepts valid HTTPS URL', () => {
    const env = minimalValidEnv();
    env.JIRA_BASE_URL = 'https://example.atlassian.net';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'JIRA_BASE_URL')
      .filter((r) => r.severity === Severity.ERROR);

    expect(errors).toHaveLength(0);
  });

  it('accepts valid HTTP URL', () => {
    const env = minimalValidEnv();
    env.GITLAB_URL = 'http://10.200.11.32';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'GITLAB_URL')
      .filter((r) => r.severity === Severity.ERROR);

    expect(errors).toHaveLength(0);
  });

  it('rejects URL without protocol', () => {
    const env = minimalValidEnv();
    env.JIRA_BASE_URL = 'example.atlassian.net';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'JIRA_BASE_URL');

    expect(errors.some((r) => r.message.includes('must start with http'))).toBe(true);
  });

  it('rejects URL with ftp protocol', () => {
    const env = minimalValidEnv();
    env.GITLAB_URL = 'ftp://gitlab.example.com';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'GITLAB_URL');

    expect(errors.some((r) => r.message.includes('must start with http'))).toBe(true);
  });

  it('warns about HTTP GitLab URL (unencrypted)', () => {
    const env = minimalValidEnv();
    env.GITLAB_URL = 'http://gitlab.example.com';

    const output = validateAllConfig(env);
    const warns = findByField(output.results, 'GITLAB_URL')
      .filter((r) => r.severity === Severity.WARN);

    expect(warns.some((r) => r.message.includes('HTTP'))).toBe(true);
  });

  it('skips URL validation when field is empty', () => {
    const env = minimalValidEnv();
    delete env.JIRA_BASE_URL;

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'JIRA_BASE_URL')
      .filter((r) => r.severity === Severity.ERROR);

    expect(errors).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Cross-Field Validation Tests
// ═══════════════════════════════════════════════════════════════════════

describe('cross-field validation', () => {
  it('warns when OWNER_JIRA_ID equals QA_JIRA_ID', () => {
    const env = minimalValidEnv();
    env.OWNER_JIRA_ID = 'same-id';
    env.QA_JIRA_ID = 'same-id';

    const output = validateAllConfig(env);
    const warns = output.results.filter(
      (r) => r.field === 'OWNER_JIRA_ID/QA_JIRA_ID' && r.severity === Severity.WARN,
    );

    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0].message).toContain('same');
  });

  it('does not warn when OWNER_JIRA_ID differs from QA_JIRA_ID', () => {
    const env = minimalValidEnv();
    env.OWNER_JIRA_ID = 'owner-123';
    env.QA_JIRA_ID = 'qa-456';

    const output = validateAllConfig(env);
    const warns = output.results.filter(
      (r) =>
        r.field === 'OWNER_JIRA_ID/QA_JIRA_ID' &&
        r.severity === Severity.WARN &&
        r.message.includes('same'),
    );

    expect(warns).toHaveLength(0);
  });

  it('reports FATAL when both approver IDs empty and ALLOW_ANY_APPROVER is false', () => {
    const env = minimalValidEnv();
    delete env.OWNER_JIRA_ID;
    delete env.QA_JIRA_ID;
    // Don't set ALLOW_ANY_APPROVER (defaults to false)

    const output = validateAllConfig(env);
    const fatals = output.results.filter(
      (r) =>
        r.field === 'OWNER_JIRA_ID/QA_JIRA_ID' &&
        r.severity === Severity.FATAL,
    );

    expect(fatals.length).toBeGreaterThan(0);
  });

  it('does not report FATAL when ALLOW_ANY_APPROVER=true and both IDs empty', () => {
    const env = minimalValidEnv();
    delete env.OWNER_JIRA_ID;
    delete env.QA_JIRA_ID;
    env.ALLOW_ANY_APPROVER = 'true';

    const output = validateAllConfig(env);
    const fatals = output.results.filter(
      (r) =>
        r.field === 'OWNER_JIRA_ID/QA_JIRA_ID' &&
        r.severity === Severity.FATAL,
    );

    expect(fatals).toHaveLength(0);
  });

  it('warns when port range START > END', () => {
    const env = minimalValidEnv();
    env.NX_SERVE_PORT_RANGE_START = '4300';
    env.NX_SERVE_PORT_RANGE_END = '4200';

    const output = validateAllConfig(env);
    const errors = output.results.filter(
      (r) =>
        r.field === 'NX_SERVE_PORT_RANGE_START/END' &&
        r.severity === Severity.ERROR,
    );

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('invalid');
  });

  it('warns when APPROVAL_REMINDER_1H >= APPROVAL_REMINDER_4H', () => {
    const env = minimalValidEnv();
    env.APPROVAL_REMINDER_1H = '20000000';
    env.APPROVAL_REMINDER_4H = '10000000';

    const output = validateAllConfig(env);
    const warns = output.results.filter(
      (r) =>
        r.field === 'APPROVAL_REMINDER_1H/4H' &&
        r.severity === Severity.WARN,
    );

    expect(warns.length).toBeGreaterThan(0);
  });

  it('warns when MAX_APPROVAL_TIMEOUT >= MAX_PIPELINE_DURATION', () => {
    const env = minimalValidEnv();
    env.MAX_APPROVAL_TIMEOUT = '100000000';
    env.MAX_PIPELINE_DURATION = '50000000';

    const output = validateAllConfig(env);
    const warns = output.results.filter(
      (r) =>
        r.field === 'MAX_APPROVAL_TIMEOUT' &&
        r.severity === Severity.WARN,
    );

    expect(warns.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Boolean Validation Tests
// ═══════════════════════════════════════════════════════════════════════

describe('boolean field validation', () => {
  it('accepts "true" as valid boolean', () => {
    const env = minimalValidEnv();
    env.RUN_BUILD_CHECK = 'true';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'RUN_BUILD_CHECK')
      .filter((r) => r.severity === Severity.ERROR);

    expect(errors).toHaveLength(0);
  });

  it('accepts "1" as valid boolean', () => {
    const env = minimalValidEnv();
    env.RUN_BUILD_CHECK = '1';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'RUN_BUILD_CHECK')
      .filter((r) => r.severity === Severity.ERROR);

    expect(errors).toHaveLength(0);
  });

  it('accepts "yes" as valid boolean', () => {
    const env = minimalValidEnv();
    env.BROWSER_VERIFY = 'yes';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'BROWSER_VERIFY')
      .filter((r) => r.severity === Severity.ERROR);

    expect(errors).toHaveLength(0);
  });

  it('rejects invalid boolean value', () => {
    const env = minimalValidEnv();
    env.RUN_BUILD_CHECK = 'maybe';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'RUN_BUILD_CHECK');

    expect(errors.some((r) => r.message.includes('Invalid boolean'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Enum Validation Tests
// ═══════════════════════════════════════════════════════════════════════

describe('enum field validation', () => {
  it('accepts valid LOG_LEVEL', () => {
    const env = minimalValidEnv();
    env.LOG_LEVEL = 'debug';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'LOG_LEVEL')
      .filter((r) => r.severity === Severity.ERROR);

    expect(errors).toHaveLength(0);
  });

  it('rejects invalid LOG_LEVEL', () => {
    const env = minimalValidEnv();
    env.LOG_LEVEL = 'verbose';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'LOG_LEVEL');

    expect(errors.some((r) => r.message.includes('Invalid value'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Email Validation Tests
// ═══════════════════════════════════════════════════════════════════════

describe('email validation', () => {
  it('accepts valid email', () => {
    const env = minimalValidEnv();
    env.JIRA_EMAIL = 'user@example.com';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'JIRA_EMAIL')
      .filter((r) => r.severity === Severity.ERROR);

    expect(errors).toHaveLength(0);
  });

  it('rejects non-email JIRA_EMAIL', () => {
    const env = minimalValidEnv();
    env.JIRA_EMAIL = 'not-an-email';

    const output = validateAllConfig(env);
    const errors = findByField(output.results, 'JIRA_EMAIL');

    expect(errors.some((r) => r.message.includes('Expected email'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Overall Validity Tests
// ═══════════════════════════════════════════════════════════════════════

describe('overall validity', () => {
  it('valid is true when no FATAL results', () => {
    const env = minimalValidEnv();
    const output = validateAllConfig(env);

    expect(output.valid).toBe(true);
  });

  it('valid is false when any FATAL result exists', () => {
    const env = minimalValidEnv();
    delete env.TICKET; // Missing required field

    const output = validateAllConfig(env);

    expect(output.valid).toBe(false);
  });

  it('valid is true even with ERROR/WARN results (only FATAL affects validity)', () => {
    const env = minimalValidEnv();
    env.POLL_INTERVAL = '1'; // Below minimum -> ERROR, not FATAL

    const output = validateAllConfig(env);
    const errors = findBySeverity(output.results, Severity.ERROR);

    expect(errors.length).toBeGreaterThan(0);
    expect(output.valid).toBe(true); // ERROR alone does not make it invalid
  });
});
