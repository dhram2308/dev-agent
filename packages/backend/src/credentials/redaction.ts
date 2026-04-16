// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- Credential Redaction Helper
//
// Lightweight masking for token strings in log output.
// Shows only the last 4 characters to aid debugging while
// keeping the full secret out of logs / UI responses.
// ═══════════════════════════════════════════════════════════════

/**
 * Mask a secret string for safe logging.
 *
 * - Secrets shorter than 8 characters are fully masked as `****`.
 * - Longer secrets show `****` followed by the last 4 characters.
 *
 * @example
 * maskSecret('ghp_abc123xyz789')  // '****z789'
 * maskSecret('short')             // '****'
 * maskSecret('')                  // '****'
 */
export function maskSecret(secret: string): string {
  if (!secret || secret.length < 8) return '****';
  return '****' + secret.slice(-4);
}
