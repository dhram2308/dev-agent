// =====================================================================
// backends.test.ts -- Unit tests for credential store backends
// =====================================================================
//
// Tests: EncryptedFileBackend (write/read/delete/list, atomic safety,
//          cross-machine decryption failure),
//        EnvVarBackend (read-only, base64 JSON parsing),
//        maskSecret (redaction helper)
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EncryptedFileBackend } from '../encrypted-file-backend';
import { EnvVarBackend } from '../env-backend';
import { maskSecret } from '../redaction';
import { CredentialStoreError } from '../types';
import type { TokenSet } from '../types';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a minimal valid TokenSet for testing.
 */
function makeTokenSet(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    kind: 'oauth',
    accessToken: 'access_token_abc123xyz789',
    refreshToken: 'refresh_token_def456uvw012',
    expiresAt: Date.now() + 3_600_000, // 1 hour from now
    scopes: ['read', 'write'],
    metadata: { baseUrl: 'https://example.com' },
    ...overrides,
  };
}

/**
 * Build a base64-encoded JSON bundle suitable for MI_DEV_AGENT_OAUTH_TOKENS.
 */
function encodeBundle(bundle: Record<string, TokenSet>): string {
  return Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64');
}

// ═══════════════════════════════════════════════════════════════════════
// EncryptedFileBackend Tests
// ═══════════════════════════════════════════════════════════════════════

describe('EncryptedFileBackend', () => {
  let tmpDir: string;
  let credFile: string;
  let backend: EncryptedFileBackend;

  beforeEach(() => {
    // Create a real temp directory for each test to get full
    // encrypt/decrypt coverage without mocking crypto.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-cred-test-'));
    credFile = path.join(tmpDir, 'credentials.enc');
    backend = new EncryptedFileBackend(credFile);
  });

  afterEach(() => {
    // Clean up temp directory.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── backendName ────────────────────────────────────────────────────

  it('exposes backendName as "encrypted-file"', () => {
    expect(backend.backendName).toBe('encrypted-file');
  });

  // ── get() ──────────────────────────────────────────────────────────

  it('returns null for a provider that was never stored', async () => {
    const result = await backend.get('jira');
    expect(result).toBeNull();
  });

  it('returns null when the credential file does not exist', async () => {
    // The file doesn't exist yet — should not throw.
    const result = await backend.get('nonexistent');
    expect(result).toBeNull();
  });

  // ── set() + get() round-trip ───────────────────────────────────────

  it('stores and retrieves a token set', async () => {
    const token = makeTokenSet();
    await backend.set('jira', token);

    const retrieved = await backend.get('jira');
    expect(retrieved).toEqual(token);
  });

  it('stores multiple providers independently', async () => {
    const jiraToken = makeTokenSet({ accessToken: 'jira_token_12345678' });
    const gitlabToken = makeTokenSet({
      kind: 'pat',
      accessToken: 'gitlab_token_87654321',
      refreshToken: undefined,
    });

    await backend.set('jira', jiraToken);
    await backend.set('gitlab', gitlabToken);

    expect(await backend.get('jira')).toEqual(jiraToken);
    expect(await backend.get('gitlab')).toEqual(gitlabToken);
  });

  it('overwrites an existing provider token set', async () => {
    const original = makeTokenSet({ accessToken: 'original_token_1234' });
    const updated = makeTokenSet({ accessToken: 'updated_token_5678' });

    await backend.set('slack', original);
    await backend.set('slack', updated);

    const retrieved = await backend.get('slack');
    expect(retrieved).toEqual(updated);
    expect(retrieved!.accessToken).toBe('updated_token_5678');
  });

  // ── delete() ───────────────────────────────────────────────────────

  it('deletes a stored provider', async () => {
    await backend.set('jira', makeTokenSet());
    await backend.delete('jira');

    const result = await backend.get('jira');
    expect(result).toBeNull();
  });

  it('is a no-op when deleting a non-existent provider', async () => {
    // Should not throw even with no credential file.
    await expect(backend.delete('nonexistent')).resolves.toBeUndefined();
  });

  it('does not affect other providers when deleting one', async () => {
    const jiraToken = makeTokenSet({ accessToken: 'jira_access_12345678' });
    const slackToken = makeTokenSet({ accessToken: 'slack_access_87654321' });

    await backend.set('jira', jiraToken);
    await backend.set('slack', slackToken);
    await backend.delete('jira');

    expect(await backend.get('jira')).toBeNull();
    expect(await backend.get('slack')).toEqual(slackToken);
  });

  // ── list() ─────────────────────────────────────────────────────────

  it('returns an empty array when no credentials exist', async () => {
    const result = await backend.list();
    expect(result).toEqual([]);
  });

  it('lists all stored providers with correct status fields', async () => {
    const futureExpiry = Date.now() + 3_600_000;
    await backend.set(
      'jira',
      makeTokenSet({
        kind: 'oauth',
        refreshToken: 'refresh_abcdef12',
        expiresAt: futureExpiry,
        metadata: { baseUrl: 'https://jira.example.com' },
      }),
    );
    await backend.set(
      'gitlab',
      makeTokenSet({
        kind: 'pat',
        refreshToken: undefined,
        expiresAt: undefined,
      }),
    );

    const list = await backend.list();
    expect(list).toHaveLength(2);

    const jira = list.find((p) => p.provider === 'jira')!;
    expect(jira.kind).toBe('oauth');
    expect(jira.status).toBe('CONNECTED');
    expect(jira.hasRefreshToken).toBe(true);
    expect(jira.expiresAt).toBe(futureExpiry);
    expect(jira.metadata).toEqual({ baseUrl: 'https://jira.example.com' });

    const gitlab = list.find((p) => p.provider === 'gitlab')!;
    expect(gitlab.kind).toBe('pat');
    expect(gitlab.status).toBe('CONNECTED');
    expect(gitlab.hasRefreshToken).toBe(false);
    expect(gitlab.expiresAt).toBeUndefined();
  });

  it('reports RE_AUTH_REQUIRED for expired tokens with refresh token', async () => {
    const expiredWithRefresh = makeTokenSet({
      expiresAt: Date.now() - 60_000, // expired 1 minute ago
      refreshToken: 'refresh_xyz',
    });
    await backend.set('jira', expiredWithRefresh);

    const list = await backend.list();
    expect(list[0].status).toBe('RE_AUTH_REQUIRED');
  });

  it('reports REVOKED for expired tokens without refresh token', async () => {
    const expiredNoRefresh = makeTokenSet({
      expiresAt: Date.now() - 60_000,
      refreshToken: undefined,
    });
    await backend.set('gitlab', expiredNoRefresh);

    const list = await backend.list();
    expect(list[0].status).toBe('REVOKED');
  });

  // ── Atomic write safety ────────────────────────────────────────────

  it('creates the credential file with correct permissions (0o600)', async () => {
    await backend.set('jira', makeTokenSet());

    const stat = fs.statSync(credFile);
    // Check file permissions (mask off file type bits).
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('uses atomic write (tmp file is cleaned up)', async () => {
    await backend.set('jira', makeTokenSet());

    const tmpFile = credFile + '.tmp';
    expect(fs.existsSync(tmpFile)).toBe(false);
    expect(fs.existsSync(credFile)).toBe(true);
  });

  it('preserves existing data if a write is interrupted before rename', async () => {
    // Store initial data.
    const originalToken = makeTokenSet({ accessToken: 'original_access_1234' });
    await backend.set('jira', originalToken);

    // Simulate an interrupted write: create a .tmp file but don't rename it.
    // The original .enc file should remain intact.
    const tmpFile = credFile + '.tmp';
    fs.writeFileSync(tmpFile, 'corrupted partial write');

    // Original data should still be readable.
    const result = await backend.get('jira');
    expect(result).toEqual(originalToken);

    // Clean up the orphaned tmp file.
    fs.unlinkSync(tmpFile);
  });

  // ── Cross-machine decryption failure ───────────────────────────────

  it('fails to decrypt when machine ID changes (different key)', async () => {
    // Write data with the current backend.
    await backend.set('jira', makeTokenSet());

    // Now tamper with the encrypted file to simulate a different machine.
    // Replace 1 byte of the auth tag to simulate wrong key/machine-id.
    const raw = fs.readFileSync(credFile);
    const tampered = Buffer.from(raw);
    tampered[0] = tampered[0] ^ 0xff; // flip all bits in first byte
    fs.writeFileSync(credFile, tampered);

    // Reading should throw a decryption error.
    await expect(backend.get('jira')).rejects.toThrow(CredentialStoreError);
    await expect(backend.get('jira')).rejects.toThrow(/decrypt/i);
  });

  it('throws CRED_FILE_CORRUPT for truncated files', async () => {
    // Write a file that is too short (less than authTag + iv + 1 byte).
    fs.writeFileSync(credFile, Buffer.alloc(10));

    try {
      await backend.get('jira');
      expect.fail('Expected CredentialStoreError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialStoreError);
      expect((err as CredentialStoreError).code).toBe('CRED_FILE_CORRUPT');
    }
  });

  // ── Credential file is actual encrypted binary ─────────────────────

  it('writes encrypted (non-JSON) binary data to disk', async () => {
    await backend.set('jira', makeTokenSet());

    const raw = fs.readFileSync(credFile);
    // The file should not contain recognizable JSON.
    const asString = raw.toString('utf8');
    expect(asString).not.toContain('"accessToken"');
    expect(asString).not.toContain('"kind"');
    // It should be binary with enough length for authTag(16) + iv(12) + data.
    expect(raw.length).toBeGreaterThan(28);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// EnvVarBackend Tests
// ═══════════════════════════════════════════════════════════════════════

describe('EnvVarBackend', () => {
  let backend: EnvVarBackend;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.MI_DEV_AGENT_OAUTH_TOKENS;
    backend = new EnvVarBackend();
  });

  afterEach(() => {
    // Restore the original env var state.
    if (originalEnv === undefined) {
      delete process.env.MI_DEV_AGENT_OAUTH_TOKENS;
    } else {
      process.env.MI_DEV_AGENT_OAUTH_TOKENS = originalEnv;
    }
  });

  // ── backendName ────────────────────────────────────────────────────

  it('exposes backendName as "env-var"', () => {
    expect(backend.backendName).toBe('env-var');
  });

  // ── Read-only enforcement ──────────────────────────────────────────

  it('throws CRED_STORE_READ_ONLY on set()', async () => {
    try {
      await backend.set('jira', makeTokenSet());
      expect.fail('Expected CredentialStoreError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialStoreError);
      expect((err as CredentialStoreError).code).toBe('CRED_STORE_READ_ONLY');
      expect((err as CredentialStoreError).provider).toBe('jira');
    }
  });

  it('throws CRED_STORE_READ_ONLY on delete()', async () => {
    try {
      await backend.delete('gitlab');
      expect.fail('Expected CredentialStoreError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialStoreError);
      expect((err as CredentialStoreError).code).toBe('CRED_STORE_READ_ONLY');
      expect((err as CredentialStoreError).provider).toBe('gitlab');
    }
  });

  // ── get() when env is unset ────────────────────────────────────────

  it('returns null when MI_DEV_AGENT_OAUTH_TOKENS is unset', async () => {
    delete process.env.MI_DEV_AGENT_OAUTH_TOKENS;
    const result = await backend.get('jira');
    expect(result).toBeNull();
  });

  it('returns null when MI_DEV_AGENT_OAUTH_TOKENS is empty string', async () => {
    process.env.MI_DEV_AGENT_OAUTH_TOKENS = '';
    const result = await backend.get('jira');
    expect(result).toBeNull();
  });

  // ── get() with valid bundle ────────────────────────────────────────

  it('decodes a base64 JSON bundle and returns the matching provider', async () => {
    const jiraToken = makeTokenSet({ accessToken: 'jira_env_token_1234' });
    process.env.MI_DEV_AGENT_OAUTH_TOKENS = encodeBundle({ jira: jiraToken });

    const result = await backend.get('jira');
    expect(result).toEqual(jiraToken);
  });

  it('returns null for a provider not in the bundle', async () => {
    const jiraToken = makeTokenSet();
    process.env.MI_DEV_AGENT_OAUTH_TOKENS = encodeBundle({ jira: jiraToken });

    const result = await backend.get('slack');
    expect(result).toBeNull();
  });

  it('handles a multi-provider bundle', async () => {
    const jiraToken = makeTokenSet({ accessToken: 'jira_access_12345678' });
    const gitlabToken = makeTokenSet({
      kind: 'pat',
      accessToken: 'gitlab_access_87654321',
    });
    const slackToken = makeTokenSet({
      kind: 'webhook',
      accessToken: 'slack_webhook_secret99',
    });

    process.env.MI_DEV_AGENT_OAUTH_TOKENS = encodeBundle({
      jira: jiraToken,
      gitlab: gitlabToken,
      slack: slackToken,
    });

    expect(await backend.get('jira')).toEqual(jiraToken);
    expect(await backend.get('gitlab')).toEqual(gitlabToken);
    expect(await backend.get('slack')).toEqual(slackToken);
  });

  // ── list() ─────────────────────────────────────────────────────────

  it('returns empty array when env var is unset', async () => {
    delete process.env.MI_DEV_AGENT_OAUTH_TOKENS;
    const result = await backend.list();
    expect(result).toEqual([]);
  });

  it('lists all providers from the bundle with derived status', async () => {
    const futureExpiry = Date.now() + 3_600_000;
    const pastExpiry = Date.now() - 60_000;

    process.env.MI_DEV_AGENT_OAUTH_TOKENS = encodeBundle({
      jira: makeTokenSet({ expiresAt: futureExpiry, refreshToken: 'r1' }),
      gitlab: makeTokenSet({
        kind: 'pat',
        expiresAt: pastExpiry,
        refreshToken: undefined,
      }),
      slack: makeTokenSet({
        expiresAt: pastExpiry,
        refreshToken: 'r2',
      }),
    });

    const list = await backend.list();
    expect(list).toHaveLength(3);

    const jira = list.find((p) => p.provider === 'jira')!;
    expect(jira.status).toBe('CONNECTED');
    expect(jira.hasRefreshToken).toBe(true);

    const gitlab = list.find((p) => p.provider === 'gitlab')!;
    expect(gitlab.status).toBe('REVOKED');
    expect(gitlab.hasRefreshToken).toBe(false);

    const slack = list.find((p) => p.provider === 'slack')!;
    expect(slack.status).toBe('RE_AUTH_REQUIRED');
    expect(slack.hasRefreshToken).toBe(true);
  });

  // ── Malformed bundle ───────────────────────────────────────────────

  it('throws CRED_ENV_DECODE_ERROR for invalid base64', async () => {
    process.env.MI_DEV_AGENT_OAUTH_TOKENS = '!!!not-valid-base64!!!';

    // Invalid base64 decodes to garbage that won't parse as JSON.
    try {
      await backend.get('jira');
      expect.fail('Expected CredentialStoreError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialStoreError);
      expect((err as CredentialStoreError).code).toBe('CRED_ENV_DECODE_ERROR');
    }
  });

  it('throws CRED_ENV_DECODE_ERROR for base64-encoded non-JSON', async () => {
    // Valid base64 but the decoded content is not JSON.
    process.env.MI_DEV_AGENT_OAUTH_TOKENS = Buffer.from(
      'this is not json',
    ).toString('base64');

    try {
      await backend.get('jira');
      expect.fail('Expected CredentialStoreError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialStoreError);
      expect((err as CredentialStoreError).code).toBe('CRED_ENV_DECODE_ERROR');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// maskSecret Tests (Redaction Helper)
// ═══════════════════════════════════════════════════════════════════════

describe('maskSecret', () => {
  it('returns "****" for empty string', () => {
    expect(maskSecret('')).toBe('****');
  });

  it('returns "****" for short secrets (< 8 chars)', () => {
    expect(maskSecret('abc')).toBe('****');
    expect(maskSecret('1234567')).toBe('****'); // 7 chars, still short
  });

  it('returns "****" for exactly 7-character secret', () => {
    expect(maskSecret('abcdefg')).toBe('****');
  });

  it('shows last 4 chars for secrets >= 8 characters', () => {
    expect(maskSecret('abcdefgh')).toBe('****efgh'); // 8 chars
    expect(maskSecret('ghp_abc123xyz789')).toBe('****z789');
  });

  it('handles typical OAuth access tokens', () => {
    const token = 'ya29.a0AfH6SMBx_long_google_oauth_token_abcd';
    const masked = maskSecret(token);
    expect(masked).toBe('****abcd');
    expect(masked).not.toContain('ya29');
    expect(masked).not.toContain('oauth');
  });

  it('handles typical personal access tokens', () => {
    expect(maskSecret('glpat-xY7z9AbCdEf12345')).toBe('****2345');
  });

  it('preserves exactly "****" prefix plus 4 trailing characters', () => {
    const secret = 'some_very_long_secret_value_ending_in_WXYZ';
    const masked = maskSecret(secret);
    expect(masked).toBe('****WXYZ');
    expect(masked.length).toBe(8); // "****" (4) + last4 (4)
  });

  it('returns "****" for null/undefined input (falsy guard)', () => {
    // The function checks !secret first, so falsy values are fully masked.
    expect(maskSecret(null as unknown as string)).toBe('****');
    expect(maskSecret(undefined as unknown as string)).toBe('****');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CredentialStoreError Tests
// ═══════════════════════════════════════════════════════════════════════

describe('CredentialStoreError', () => {
  it('is an instance of Error', () => {
    const err = new CredentialStoreError('test', 'TEST_CODE');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CredentialStoreError);
  });

  it('stores code and provider properties', () => {
    const err = new CredentialStoreError('msg', 'SOME_CODE', 'jira');
    expect(err.code).toBe('SOME_CODE');
    expect(err.provider).toBe('jira');
    expect(err.message).toBe('msg');
    expect(err.name).toBe('CredentialStoreError');
  });

  it('leaves provider undefined when not supplied', () => {
    const err = new CredentialStoreError('msg', 'CODE');
    expect(err.provider).toBeUndefined();
  });
});
