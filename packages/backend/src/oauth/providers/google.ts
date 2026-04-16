// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- Google Drive OAuth 2.0 Provider Adapter
//
// Google-specific OAuth quirks:
//   - Requires `access_type=offline` + `prompt=consent` to get
//     refresh tokens on the initial flow.
//   - Refresh responses may omit the refresh_token when the user
//     has already granted offline access — we preserve the
//     existing refresh token in that case.
//   - Revocation takes a bare `token` parameter (no type hint).
//   - Supports incremental auth via `include_granted_scopes`.
//
// Registers itself on import via registerProvider().
// ═══════════════════════════════════════════════════════════════

import type { ProviderAdapter } from '../provider';
import { registerProvider } from '../provider';
import type { TokenSet } from '../../credentials/types';

// ── Adapter ─────────────────────────────────────────────────────

const google: ProviderAdapter = {
  name: 'google',

  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',

  defaultScopes: [
    'https://www.googleapis.com/auth/drive.readonly',
    'openid',
    'email',
  ],

  clientId: process.env.OAUTH_GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.OAUTH_GOOGLE_CLIENT_SECRET || undefined,

  extraAuthorizeParams: {
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  },

  /**
   * Parse the Google token endpoint response into a partial TokenSet.
   *
   * Google's refresh response may omit `refresh_token` when the user
   * has already consented to offline access. The engine handles
   * merging with the existing stored token, but we include what
   * the response provides.
   */
  parseTokenResponse(body: Record<string, unknown>): Partial<TokenSet> {
    const partial: Partial<TokenSet> = {
      accessToken: body.access_token as string,
      scopes: typeof body.scope === 'string'
        ? (body.scope as string).split(' ').filter(Boolean)
        : undefined,
      metadata: {},
    };

    // Refresh token — may be absent on refresh responses.
    if (body.refresh_token) {
      partial.refreshToken = body.refresh_token as string;
    }

    // Compute expiresAt from expires_in (seconds).
    if (typeof body.expires_in === 'number') {
      partial.expiresAt = Date.now() + (body.expires_in as number) * 1000;
    }

    // Capture id_token payload for user info (email, sub) if present.
    if (typeof body.id_token === 'string') {
      try {
        // Decode the JWT payload (second segment) without verification —
        // we only use it for display metadata, not for auth decisions.
        const payloadB64 = (body.id_token as string).split('.')[1];
        const payload = JSON.parse(
          Buffer.from(payloadB64, 'base64url').toString('utf-8'),
        ) as Record<string, unknown>;
        if (payload.email) {
          partial.metadata!.email = String(payload.email);
        }
        if (payload.sub) {
          partial.metadata!.accountId = String(payload.sub);
        }
      } catch {
        // id_token decoding is best-effort — don't fail the flow.
      }
    }

    return partial;
  },

  /**
   * Build the form body for a Google refresh token request.
   */
  buildRefreshBody(refreshToken: string): Record<string, string> {
    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: google.clientId,
    };
    if (google.clientSecret) {
      body.client_secret = google.clientSecret;
    }
    return body;
  },

  /**
   * Build the form body for Google token revocation.
   * Google expects a single `token` parameter (access or refresh).
   */
  buildRevokeBody(token: string): Record<string, string> {
    return { token };
  },
};

// ── Self-registration ───────────────────────────────────────────

registerProvider(google);
