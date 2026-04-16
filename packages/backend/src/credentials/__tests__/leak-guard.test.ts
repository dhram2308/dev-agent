// =====================================================================
// leak-guard.test.ts -- CI guard: scan for full-token leaks in output
// =====================================================================
//
// Safety-net test that ensures known credential patterns never appear
// in log output or SSE broadcasts.  Intended to run in CI on every push.
//
// Patterns covered:
//   ghp_   (GitHub PAT)
//   gho_   (GitHub OAuth)
//   glpat- (GitLab PAT)
//   xoxb-  (Slack bot token)
//   xoxp-  (Slack user token)
//   ya29.  (Google OAuth access token)
//   fig_   (Figma token prefix, if present)
//   Long base64-like strings (>40 chars, no spaces -- generic catch-all)
// =====================================================================

import { describe, it, expect } from 'vitest';
import { maskSecret } from '../redaction';

// ── Token Pattern Definitions ────────────────────────────────────────

/**
 * Known credential prefixes/patterns that must NEVER appear verbatim
 * in logs, SSE output, or API responses.
 *
 * Each entry is a tuple of [label, RegExp].
 * The regex uses word-boundary-like anchoring where sensible, but the
 * primary goal is detecting *full* tokens, not fragments.
 */
const TOKEN_PATTERNS: Array<[string, RegExp]> = [
  ['GitHub PAT',            /ghp_[A-Za-z0-9]{20,}/],
  ['GitHub OAuth',          /gho_[A-Za-z0-9]{20,}/],
  ['GitLab PAT',            /glpat-[A-Za-z0-9\-_]{20,}/],
  ['Slack bot token',       /xoxb-[0-9]+-[0-9A-Za-z\-]+/],
  ['Slack user token',      /xoxp-[0-9]+-[0-9A-Za-z\-]+/],
  ['Google OAuth',          /ya29\.[A-Za-z0-9\-_]{20,}/],
  ['Figma token',           /fig_[A-Za-z0-9\-_]{20,}/],
  ['Generic long base64',   /[A-Za-z0-9+/=]{41,}/],
];

// ── scanForTokenLeaks helper ─────────────────────────────────────────

/**
 * Scan a string for known token patterns.
 *
 * @returns Array of human-readable descriptions for every match found.
 *          Empty array means the text is clean.
 */
function scanForTokenLeaks(text: string): string[] {
  const leaks: string[] = [];
  for (const [label, pattern] of TOKEN_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      leaks.push(`${label}: matched "${match[0].substring(0, 12)}..."`);
    }
  }
  return leaks;
}

// ── Sample tokens for testing ────────────────────────────────────────

const SAMPLE_TOKENS: Record<string, string> = {
  githubPat:    'ghp_abc123xyz789abc123xyz789abc1',
  githubOAuth:  'gho_OAuthTokenValue1234567890ab',
  gitlabPat:    'glpat-xY7z9AbCdEf1234567890abcd',
  slackBot:     'xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx',
  slackUser:    'xoxp-123456789012-123456789012-1234567890123-abcdef1234567890abcdef1234567890',
  googleOAuth:  'ya29.a0AfH6SMBx_long_google_oauth_token_abcdefg12345',
  figmaToken:   'fig_LiveTokenXyz1234567890abcde',
  genericLong:  'TG9uZ0Jhc2U2NFRva2VuVGhhdElzRGVmaW5pdGVseU1vcmVUaGFuNDBDaGFyYWN0ZXJz',
};

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe('scanForTokenLeaks', () => {
  // ── Positive detection ──────────────────────────────────────────────

  it('detects a GitHub PAT in raw text', () => {
    const leaks = scanForTokenLeaks(`Cloning with token ${SAMPLE_TOKENS.githubPat}`);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks.some(l => l.includes('GitHub PAT'))).toBe(true);
  });

  it('detects a GitHub OAuth token', () => {
    const leaks = scanForTokenLeaks(`auth: ${SAMPLE_TOKENS.githubOAuth}`);
    expect(leaks.some(l => l.includes('GitHub OAuth'))).toBe(true);
  });

  it('detects a GitLab PAT', () => {
    const leaks = scanForTokenLeaks(`PRIVATE-TOKEN: ${SAMPLE_TOKENS.gitlabPat}`);
    expect(leaks.some(l => l.includes('GitLab PAT'))).toBe(true);
  });

  it('detects a Slack bot token', () => {
    const leaks = scanForTokenLeaks(`Bot token: ${SAMPLE_TOKENS.slackBot}`);
    expect(leaks.some(l => l.includes('Slack bot'))).toBe(true);
  });

  it('detects a Slack user token', () => {
    const leaks = scanForTokenLeaks(`User token: ${SAMPLE_TOKENS.slackUser}`);
    expect(leaks.some(l => l.includes('Slack user'))).toBe(true);
  });

  it('detects a Google OAuth access token', () => {
    const leaks = scanForTokenLeaks(`Authorization: Bearer ${SAMPLE_TOKENS.googleOAuth}`);
    expect(leaks.some(l => l.includes('Google OAuth'))).toBe(true);
  });

  it('detects a Figma token', () => {
    const leaks = scanForTokenLeaks(`X-Figma-Token: ${SAMPLE_TOKENS.figmaToken}`);
    expect(leaks.some(l => l.includes('Figma'))).toBe(true);
  });

  it('detects a generic long base64 string', () => {
    const leaks = scanForTokenLeaks(`secret=${SAMPLE_TOKENS.genericLong}`);
    expect(leaks.some(l => l.includes('Generic long base64'))).toBe(true);
  });

  // ── Clean text ──────────────────────────────────────────────────────

  it('returns empty array for text with no tokens', () => {
    const leaks = scanForTokenLeaks('Pipeline stage: fetch-ticket completed in 1.2s');
    expect(leaks).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(scanForTokenLeaks('')).toEqual([]);
  });

  it('does not flag short alphanumeric strings', () => {
    const leaks = scanForTokenLeaks('commit abc123 merged into branch main');
    expect(leaks).toEqual([]);
  });

  it('does not flag masked values (****XXXX format)', () => {
    const leaks = scanForTokenLeaks('Using token: ****z789');
    expect(leaks).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// maskSecret integration: masked output must be leak-free
// ═══════════════════════════════════════════════════════════════════════

describe('maskSecret output is leak-free', () => {
  for (const [name, token] of Object.entries(SAMPLE_TOKENS)) {
    it(`maskSecret(${name}) produces no token leaks`, () => {
      const masked = maskSecret(token);
      const leaks = scanForTokenLeaks(masked);
      expect(leaks).toEqual([]);
    });

    it(`maskSecret(${name}) does not contain the original token`, () => {
      const masked = maskSecret(token);
      expect(masked).not.toContain(token);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Simulated log lines through redaction
// ═══════════════════════════════════════════════════════════════════════

describe('redacted log lines are leak-free', () => {
  /**
   * Simulate what the agent does before logging: replace raw tokens
   * with their masked form in a log line.
   */
  function redactLogLine(line: string, secrets: string[]): string {
    let redacted = line;
    for (const secret of secrets) {
      if (secret) {
        redacted = redacted.replaceAll(secret, maskSecret(secret));
      }
    }
    return redacted;
  }

  it('redacts a GitHub PAT from a log line', () => {
    const raw = `[gitlab] Pushing with token ${SAMPLE_TOKENS.githubPat} to remote`;
    const redacted = redactLogLine(raw, [SAMPLE_TOKENS.githubPat]);
    const leaks = scanForTokenLeaks(redacted);
    expect(leaks).toEqual([]);
    expect(redacted).not.toContain(SAMPLE_TOKENS.githubPat);
    expect(redacted).toContain('****');
  });

  it('redacts multiple tokens in a single line', () => {
    const raw = `auth: gitlab=${SAMPLE_TOKENS.gitlabPat} slack=${SAMPLE_TOKENS.slackBot}`;
    const redacted = redactLogLine(raw, [SAMPLE_TOKENS.gitlabPat, SAMPLE_TOKENS.slackBot]);
    const leaks = scanForTokenLeaks(redacted);
    expect(leaks).toEqual([]);
  });

  it('redacts a Google OAuth token embedded in JSON', () => {
    const raw = JSON.stringify({
      event: 'api_call',
      headers: { Authorization: `Bearer ${SAMPLE_TOKENS.googleOAuth}` },
    });
    const redacted = redactLogLine(raw, [SAMPLE_TOKENS.googleOAuth]);
    const leaks = scanForTokenLeaks(redacted);
    expect(leaks).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════

describe('edge cases', () => {
  it('handles null/undefined coerced to string gracefully', () => {
    expect(scanForTokenLeaks(String(null))).toEqual([]);
    expect(scanForTokenLeaks(String(undefined))).toEqual([]);
  });

  it('does not flag already-masked values regardless of length', () => {
    // A masked value is "****" + last 4 chars -- always 8 chars total.
    const masked = '****abcd';
    expect(scanForTokenLeaks(masked)).toEqual([]);
  });

  it('does not flag the literal prefix without a full token body', () => {
    // These are just prefixes, not full tokens (too short after prefix).
    expect(scanForTokenLeaks('ghp_short')).toEqual([]);
    expect(scanForTokenLeaks('glpat-short')).toEqual([]);
    expect(scanForTokenLeaks('xoxb-')).toEqual([]);
    expect(scanForTokenLeaks('ya29.')).toEqual([]);
    expect(scanForTokenLeaks('gho_tiny')).toEqual([]);
    expect(scanForTokenLeaks('fig_tiny')).toEqual([]);
  });

  it('flags a token even if surrounded by JSON punctuation', () => {
    const json = `{"token":"${SAMPLE_TOKENS.githubPat}"}`;
    const leaks = scanForTokenLeaks(json);
    expect(leaks.length).toBeGreaterThan(0);
  });

  it('flags a token on a line with other content', () => {
    const line = `2026-04-16T10:00:00Z INFO  Using PAT ${SAMPLE_TOKENS.gitlabPat} for auth`;
    const leaks = scanForTokenLeaks(line);
    expect(leaks.some(l => l.includes('GitLab PAT'))).toBe(true);
  });

  it('maskSecret returns **** for empty string (no leak possible)', () => {
    const masked = maskSecret('');
    expect(masked).toBe('****');
    expect(scanForTokenLeaks(masked)).toEqual([]);
  });

  it('maskSecret returns **** for very short secret (no leak possible)', () => {
    const masked = maskSecret('abc');
    expect(masked).toBe('****');
    expect(scanForTokenLeaks(masked)).toEqual([]);
  });

  it('does not flag common base64 values under 41 chars', () => {
    // e.g. a short JWT segment or base64 hash (40 chars is under threshold)
    const shortB64 = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXox'; // 38 chars
    expect(scanForTokenLeaks(shortB64)).toEqual([]);
  });
});
