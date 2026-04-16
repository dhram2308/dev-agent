// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- OAuth 2.0 PKCE Helpers
//
// Implements Proof Key for Code Exchange (RFC 7636).
// Uses only Node.js built-in `crypto` module.
// ═══════════════════════════════════════════════════════════════

import * as crypto from 'crypto';

/**
 * Characters allowed in a PKCE code verifier (RFC 7636 §4.1).
 * Unreserved URI characters: A-Z a-z 0-9 - . _ ~
 */
const UNRESERVED_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/**
 * Generate a cryptographically random code verifier.
 *
 * Returns a 64-character string composed of unreserved URI characters,
 * suitable for PKCE `code_verifier` parameter.
 */
export function generateVerifier(): string {
  const bytes = crypto.randomBytes(64);
  const chars: string[] = new Array(64);
  for (let i = 0; i < 64; i++) {
    chars[i] = UNRESERVED_CHARS[bytes[i] % UNRESERVED_CHARS.length];
  }
  return chars.join('');
}

/**
 * Derive a PKCE code challenge from a code verifier.
 *
 * Computes `BASE64URL(SHA256(verifier))` as specified in RFC 7636 §4.2
 * using the S256 challenge method.
 *
 * @param verifier - The code verifier string.
 * @returns The base64url-encoded SHA-256 hash (no padding).
 */
export function challengeFromVerifier(verifier: string): string {
  const hash = crypto.createHash('sha256').update(verifier, 'ascii').digest();
  return hash
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generate a cryptographically random state parameter.
 *
 * Returns a 32-character hex string (128 bits of entropy) used as
 * the `state` parameter to prevent CSRF attacks during OAuth flows.
 */
export function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}
