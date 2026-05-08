// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- OAuth 2.0 Provider Adapter Registry
//
// Defines the ProviderAdapter interface and a simple in-memory
// registry for OAuth providers (Google, GitLab, Jira, Slack, etc.).
//
// Each provider adapter normalizes the differences between OAuth
// implementations: token response shapes, refresh body formats,
// extra authorize params, and revocation endpoints.
// ═══════════════════════════════════════════════════════════════

import type { TokenSet } from '../credentials/types';

/**
 * Adapter that normalizes OAuth2 behavior for a specific provider.
 *
 * Implementations must handle provider-specific quirks such as:
 * - Google requiring `access_type=offline` for refresh tokens
 * - GitLab using `token` (not `access_token`) in some flows
 * - Slack returning bot tokens in a nested structure
 */
export interface ProviderAdapter {
  /** Unique identifier for this provider (e.g. `google`, `gitlab`). */
  name: string;

  /** Full URL for the authorization endpoint. */
  authorizeUrl: string;

  /** Full URL for the token exchange endpoint. */
  tokenUrl: string;

  /** URL for token refresh; defaults to `tokenUrl` if omitted. */
  refreshUrl?: string;

  /** URL for token revocation (RFC 7009). Omit if unsupported. */
  revokeUrl?: string;

  /** Default OAuth scopes requested when none are specified. */
  defaultScopes: string[];

  /** OAuth client ID. */
  clientId: string;

  /** OAuth client secret (absent for public clients using PKCE only). */
  clientSecret?: string;

  /**
   * How client credentials are sent to the token endpoint.
   *   - `'body'` (default): client_id/client_secret in the form body.
   *   - `'basic'`: HTTP Basic auth header. Required by Figma.
   */
  tokenAuthMode?: 'body' | 'basic';

  /**
   * Extra query parameters to include in the authorization URL.
   * Common examples:
   * - `{ access_type: 'offline' }` for Google (to get refresh tokens)
   * - `{ prompt: 'consent' }` to force re-consent
   */
  extraAuthorizeParams?: Record<string, string>;

  /**
   * Parse a provider-specific token response body into a partial TokenSet.
   *
   * The engine will merge the result with computed fields (`expiresAt`,
   * `kind: 'oauth'`) and persist the final TokenSet.
   *
   * @param body - The parsed JSON response from the token endpoint.
   * @returns Partial TokenSet with at least `accessToken`.
   */
  parseTokenResponse(body: Record<string, unknown>): Partial<TokenSet>;

  /**
   * Build the form body for a token refresh request.
   *
   * Must include at minimum `grant_type=refresh_token` and the
   * refresh token. Provider-specific fields (client_id, etc.) may
   * also be included.
   *
   * @param refreshToken - The stored refresh token.
   * @returns URL-encoded key-value pairs for the POST body.
   */
  buildRefreshBody(refreshToken: string): Record<string, string>;

  /**
   * Build the form body for a token revocation request.
   *
   * @param token - The token to revoke (access or refresh).
   * @returns URL-encoded key-value pairs for the POST body.
   */
  buildRevokeBody?(token: string): Record<string, string>;
}

// ═══════════════════════════════════════════════════════════════
// Provider Registry
// ═══════════════════════════════════════════════════════════════

const providers = new Map<string, ProviderAdapter>();

/**
 * Register a provider adapter.
 *
 * Overwrites any existing adapter with the same name.
 * Typically called during application bootstrap.
 *
 * @param adapter - The provider adapter to register.
 */
export function registerProvider(adapter: ProviderAdapter): void {
  providers.set(adapter.name, adapter);
}

/**
 * Retrieve a registered provider adapter by name.
 *
 * @param name - The provider identifier (e.g. `google`).
 * @returns The adapter, or `undefined` if not registered.
 */
export function getProvider(name: string): ProviderAdapter | undefined {
  return providers.get(name);
}

/**
 * List all registered provider names.
 *
 * Useful for the settings UI to show available connectors.
 *
 * @returns Array of registered provider identifiers.
 */
export function getRegisteredProviders(): string[] {
  return Array.from(providers.keys());
}
