// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- Environment Variable Credential Backend
//
// Read-only backend that decodes a base64-encoded JSON bundle
// from $MI_DEV_AGENT_OAUTH_TOKENS.
//
// Intended for CI/CD and containerized deployments where secrets
// are injected as environment variables and should not be
// mutated by the application.
//
// Bundle format (before base64 encoding):
//   { "jira": { kind, accessToken, ... }, "gitlab": { ... } }
// ═══════════════════════════════════════════════════════════════

import type {
  CredentialStore,
  TokenSet,
  ProviderStatus,
  ConnectorStatus,
} from './types';
import { CredentialStoreError } from './types';

const ENV_KEY = 'MI_DEV_AGENT_OAUTH_TOKENS';
const READ_ONLY_CODE = 'CRED_STORE_READ_ONLY';

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Decode and parse the env bundle.
 * Returns an empty object when the env var is unset or empty.
 * Throws a typed error on malformed data.
 */
function decodeBundle(): Record<string, TokenSet> {
  const raw = process.env[ENV_KEY];
  if (!raw) return {};

  try {
    const json = Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, TokenSet>;
  } catch (err) {
    throw new CredentialStoreError(
      `Failed to decode ${ENV_KEY}: ${(err as Error).message}`,
      'CRED_ENV_DECODE_ERROR',
    );
  }
}

/**
 * Derive {@link ConnectorStatus} from a token set.
 */
function deriveStatus(ts: TokenSet): ConnectorStatus {
  if (ts.expiresAt !== undefined && ts.expiresAt <= Date.now()) {
    return ts.refreshToken ? 'RE_AUTH_REQUIRED' : 'REVOKED';
  }
  return 'CONNECTED';
}

// ═══════════════════════════════════════════════════════════════
// EnvVarBackend
// ═══════════════════════════════════════════════════════════════

export class EnvVarBackend implements CredentialStore {
  public readonly backendName = 'env-var';

  async get(provider: string): Promise<TokenSet | null> {
    const bundle = decodeBundle();
    return bundle[provider] ?? null;
  }

  async set(_provider: string, _tokenSet: TokenSet): Promise<never> {
    throw new CredentialStoreError(
      'EnvVarBackend is read-only — credentials are managed via $MI_DEV_AGENT_OAUTH_TOKENS',
      READ_ONLY_CODE,
      _provider,
    );
  }

  async delete(_provider: string): Promise<never> {
    throw new CredentialStoreError(
      'EnvVarBackend is read-only — credentials are managed via $MI_DEV_AGENT_OAUTH_TOKENS',
      READ_ONLY_CODE,
      _provider,
    );
  }

  async list(): Promise<ProviderStatus[]> {
    const bundle = decodeBundle();

    return Object.entries(bundle).map(([provider, ts]) => ({
      provider,
      kind: ts.kind,
      status: deriveStatus(ts),
      hasRefreshToken: !!ts.refreshToken,
      expiresAt: ts.expiresAt,
      metadata: ts.metadata,
    }));
  }
}
