/**
 * Unit tests for Gap G — Claude auth error classification. The original
 * AUT-8648 incident burned ~90 min retrying after a Claude org-access
 * outage because the specific error message
 *   "Your organization does not have access to Claude. Please login
 *    again or contact your administrator."
 * didn't match any AUTH_PATTERNS regex in error-recovery.ts, so the
 * classifier fell through to TRANSIENT and the recovery loop kept
 * retrying. These tests pin the new pattern coverage.
 */

import { describe, it, expect } from 'vitest';

const { classifyError, ERROR_CLASS } = require('../src/lib/error-recovery');

describe('Gap G — Claude auth error classification', () => {
  it('classifies the exact AUT-8648 org-access message as AUTH', () => {
    const err = new Error(
      'Claude CLI error (1): Your organization does not have access to Claude. ' +
      'Please login again or contact your administrator.',
    );
    const result = classifyError(err);
    expect(result.class).toBe(ERROR_CLASS.AUTH);
    expect(result.retryable).toBe(false);
  });

  it('classifies "does not have access to Claude" alone as AUTH', () => {
    const err = new Error('Claude CLI error (1): does not have access to Claude');
    expect(classifyError(err).class).toBe(ERROR_CLASS.AUTH);
  });

  it('classifies "Please login again" as AUTH', () => {
    const err = new Error('Some Claude error: Please login again to continue');
    expect(classifyError(err).class).toBe(ERROR_CLASS.AUTH);
  });

  it('classifies "contact your administrator" as AUTH', () => {
    const err = new Error('Permission revoked — contact your administrator');
    expect(classifyError(err).class).toBe(ERROR_CLASS.AUTH);
  });

  it('classifies "Your organization does not have access" as AUTH (no Claude keyword)', () => {
    const err = new Error('Error: Your organization does not have access to this feature');
    expect(classifyError(err).class).toBe(ERROR_CLASS.AUTH);
  });

  it('still classifies existing patterns (401, 403, unauthorized, forbidden) as AUTH', () => {
    expect(classifyError(new Error('HTTP 401 Unauthorized')).class).toBe(ERROR_CLASS.AUTH);
    expect(classifyError(new Error('403 Forbidden')).class).toBe(ERROR_CLASS.AUTH);
    expect(classifyError(new Error('Token expired')).class).toBe(ERROR_CLASS.AUTH);
    expect(classifyError(new Error('Access Denied')).class).toBe(ERROR_CLASS.AUTH);
  });

  it('does NOT classify generic transient errors as AUTH', () => {
    expect(classifyError(new Error('ECONNRESET')).class).not.toBe(ERROR_CLASS.AUTH);
    expect(classifyError(new Error('Claude CLI timed out after 600s')).class).not.toBe(ERROR_CLASS.AUTH);
    expect(classifyError(new Error('Reached max turns (75)')).class).not.toBe(ERROR_CLASS.AUTH);
  });

  it('AUTH classification is high-confidence and not retryable', () => {
    const result = classifyError(new Error('Please login again'));
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.retryable).toBe(false);
  });

  it('does not match auth keywords appearing inside business content (false positive guard)', () => {
    // These appear in some architect outputs describing the FEATURE being
    // built (e.g. "the login screen must show a 'login again' button").
    // They should only fire when they're in a real error message context.
    // We can't perfectly disambiguate at the regex layer — the test
    // documents that the patterns DO fire on these strings, which is
    // acceptable because they only enter classifyError when the Claude
    // CLI itself wrote them as an error message (in which case auth IS
    // the right classification).
    const businessLikePhrase = new Error('the user must Please login again to access the dashboard');
    expect(classifyError(businessLikePhrase).class).toBe(ERROR_CLASS.AUTH);
    // This is a documented trade-off — accepted because the false-
    // positive cost (one extra halt) is much smaller than the false-
    // negative cost (90 min wasted on retries during a real outage).
  });
});
