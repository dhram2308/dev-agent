// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- Credential Store Types
//
// Shared type definitions for the credential storage subsystem.
// All backends implement the CredentialStore interface.
// ═══════════════════════════════════════════════════════════════

/**
 * Authentication mode used by a connector.
 *
 * - `oauth`           Full OAuth2 flow with access + refresh tokens
 * - `pat`             Personal access token (GitLab, Jira, etc.)
 * - `service_account` Machine-to-machine credentials (GCP, AWS)
 * - `webhook`         Inbound webhook secret (Slack, Jira webhooks)
 * - `api_key`         Simple API key (Postman, Figma)
 */
export type AuthMode =
  | 'oauth'
  | 'pat'
  | 'service_account'
  | 'webhook'
  | 'api_key';

/**
 * Connector health status.
 *
 * - `CONNECTED`        Token is valid and usable
 * - `REFRESHING`       Token refresh is in progress
 * - `RE_AUTH_REQUIRED`  Refresh failed; user must re-authenticate
 * - `REVOKED`          Token was explicitly revoked
 * - `NOT_CONNECTED`    No credentials stored for this provider
 */
export type ConnectorStatus =
  | 'CONNECTED'
  | 'REFRESHING'
  | 'RE_AUTH_REQUIRED'
  | 'REVOKED'
  | 'NOT_CONNECTED';

/**
 * A set of credentials for a single provider.
 */
export interface TokenSet {
  /** Authentication mode that produced these credentials. */
  kind: AuthMode;

  /** Primary access credential. */
  accessToken: string;

  /** OAuth2 refresh token (absent for PAT / API key modes). */
  refreshToken?: string;

  /** Millisecond epoch when `accessToken` expires.  Undefined = non-expiring. */
  expiresAt?: number;

  /** OAuth2 scopes granted. */
  scopes?: string[];

  /**
   * Arbitrary string metadata attached by the connector.
   * Common keys: `baseUrl`, `email`, `accountId`, `instanceUrl`.
   */
  metadata?: Record<string, string>;
}

/**
 * Summary status of a single provider's credentials.
 * Returned by {@link CredentialStore.list} for the settings UI.
 */
export interface ProviderStatus {
  /** Provider identifier (e.g. `jira`, `gitlab`, `slack`). */
  provider: string;

  /** How the credentials were obtained. */
  kind: AuthMode;

  /** Current health of the credential set. */
  status: ConnectorStatus;

  /** Whether a refresh token is available. */
  hasRefreshToken: boolean;

  /** When the access token expires (ms epoch). */
  expiresAt?: number;

  /** When the token was last refreshed (ms epoch). */
  lastRefreshAt?: number;

  /** Subset of metadata safe to expose in the UI. */
  metadata?: Record<string, string>;
}

/**
 * Credential storage backend interface.
 *
 * Three implementations exist:
 * - {@link KeychainBackend}      OS keychain via `cross-keychain`
 * - {@link EncryptedFileBackend} AES-256-GCM encrypted file
 * - {@link EnvVarBackend}        Read-only env var bundle
 */
export interface CredentialStore {
  /**
   * Retrieve credentials for a provider.
   * Returns `null` when no credentials are stored.
   */
  get(provider: string): Promise<TokenSet | null>;

  /**
   * Store or overwrite credentials for a provider.
   * @throws On read-only backends (error code `CRED_STORE_READ_ONLY`).
   */
  set(provider: string, tokenSet: TokenSet): Promise<void>;

  /**
   * Remove credentials for a provider.
   * @throws On read-only backends (error code `CRED_STORE_READ_ONLY`).
   */
  delete(provider: string): Promise<void>;

  /**
   * List status of all known providers.
   * Callers should never cache this — it reads live state.
   */
  list(): Promise<ProviderStatus[]>;

  /** Name of the active backend for logging / diagnostics. */
  readonly backendName: string;
}

// ═══════════════════════════════════════════════════════════════
// Typed error for credential store failures
// ═══════════════════════════════════════════════════════════════

export class CredentialStoreError extends Error {
  public readonly code: string;
  public readonly provider?: string;

  constructor(message: string, code: string, provider?: string) {
    super(message);
    this.name = 'CredentialStoreError';
    this.code = code;
    this.provider = provider;
    // Restore prototype chain (required for instanceof with TS + CommonJS)
    Object.setPrototypeOf(this, CredentialStoreError.prototype);
  }
}
