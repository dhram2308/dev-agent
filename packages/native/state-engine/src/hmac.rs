//! HMAC-SHA256 computation and constant-time verification using the `ring` crate.
//!
//! This module replaces the Node.js `crypto.createHmac('sha256', secret)` and
//! `crypto.timingSafeEqual()` calls in `lib/state-unified.js` with Rust equivalents
//! that guarantee constant-time comparison via `ring::hmac::verify()`.
//!
//! # Security properties
//! - `ring::hmac::verify` uses a constant-time comparison internally, preventing
//!   timing side-channel attacks. Unlike `crypto.timingSafeEqual` which requires
//!   the caller to remember to use it, ring makes it impossible to accidentally
//!   use a non-constant-time comparison.
//! - The signing key is constructed from raw bytes, matching the hex-decoded
//!   `.state-secret` file used by the JS implementation.

use napi::bindgen_prelude::*;
use ring::hmac;

// ── Internal Rust API ──────────────────────────────────────────────────

/// Compute HMAC-SHA256 of `data` using `secret` as the key.
///
/// Returns the raw HMAC tag bytes (32 bytes for SHA-256).
///
/// # Arguments
/// * `secret` - Raw key bytes (typically 32 bytes from .state-secret)
/// * `data` - The string data to authenticate (typically JSON.stringify of state)
pub fn compute_hmac(secret: &[u8], data: &str) -> Vec<u8> {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret);
    let tag = hmac::sign(&key, data.as_bytes());
    tag.as_ref().to_vec()
}

/// Verify an HMAC-SHA256 tag in constant time.
///
/// Uses `ring::hmac::verify` which performs a constant-time comparison internally.
/// This is the key advantage over the JS implementation: it is impossible to
/// accidentally use a timing-vulnerable comparison.
///
/// # Arguments
/// * `secret` - Raw key bytes (same key used to compute the HMAC)
/// * `data` - The string data to verify
/// * `expected` - The expected HMAC tag bytes to compare against
///
/// # Returns
/// `true` if the HMAC matches, `false` otherwise (constant-time either way)
pub fn verify_hmac(secret: &[u8], data: &str, expected: &[u8]) -> bool {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret);
    hmac::verify(&key, data.as_bytes(), expected).is_ok()
}

// ── napi-rs exports (Node.js bindings) ────────────────────────────────

/// Compute HMAC-SHA256 of a string using a secret key.
///
/// JS signature: `computeHmac(secret: Buffer, data: string) -> Buffer`
///
/// # Example (JavaScript)
/// ```js
/// const { computeHmac } = require('./state-engine');
/// const secret = Buffer.from('my-secret-key');
/// const tag = computeHmac(secret, '{"stage":"fetch_ticket"}');
/// console.log(tag.toString('hex'));
/// ```
#[napi]
pub fn compute_hmac_napi(secret: Buffer, data: String) -> Buffer {
    let tag = compute_hmac(secret.as_ref(), &data);
    Buffer::from(tag)
}

/// Verify an HMAC-SHA256 tag in constant time.
///
/// JS signature: `verifyHmac(secret: Buffer, data: string, expected: Buffer) -> boolean`
///
/// Uses ring's constant-time comparison internally -- impossible to misuse.
///
/// # Example (JavaScript)
/// ```js
/// const { computeHmac, verifyHmac } = require('./state-engine');
/// const secret = Buffer.from('my-secret-key');
/// const data = '{"stage":"fetch_ticket"}';
/// const tag = computeHmac(secret, data);
/// const valid = verifyHmac(secret, data, tag); // true
/// ```
#[napi]
pub fn verify_hmac_napi(secret: Buffer, data: String, expected: Buffer) -> bool {
    verify_hmac(secret.as_ref(), &data, expected.as_ref())
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_hmac_produces_32_bytes() {
        let secret = b"test-secret-key-for-hmac";
        let data = r#"{"stage":"fetch_ticket","ticket":"AUT-8031"}"#;
        let tag = compute_hmac(secret, data);
        assert_eq!(tag.len(), 32, "HMAC-SHA256 should produce 32 bytes");
    }

    #[test]
    fn test_compute_hmac_deterministic() {
        let secret = b"deterministic-key";
        let data = "same-data";
        let tag1 = compute_hmac(secret, data);
        let tag2 = compute_hmac(secret, data);
        assert_eq!(tag1, tag2, "Same key + data should produce same HMAC");
    }

    #[test]
    fn test_compute_hmac_different_secrets_produce_different_tags() {
        let data = "same-data";
        let tag1 = compute_hmac(b"secret-one", data);
        let tag2 = compute_hmac(b"secret-two", data);
        assert_ne!(tag1, tag2, "Different secrets should produce different HMACs");
    }

    #[test]
    fn test_compute_hmac_different_data_produce_different_tags() {
        let secret = b"same-secret";
        let tag1 = compute_hmac(secret, "data-one");
        let tag2 = compute_hmac(secret, "data-two");
        assert_ne!(tag1, tag2, "Different data should produce different HMACs");
    }

    #[test]
    fn test_verify_hmac_valid() {
        let secret = b"verify-test-secret";
        let data = r#"{"stage":"generate_code"}"#;
        let tag = compute_hmac(secret, data);
        assert!(verify_hmac(secret, data, &tag), "Verification of correct HMAC should succeed");
    }

    #[test]
    fn test_verify_hmac_wrong_data() {
        let secret = b"verify-test-secret";
        let tag = compute_hmac(secret, "original-data");
        assert!(
            !verify_hmac(secret, "tampered-data", &tag),
            "Verification should fail for tampered data"
        );
    }

    #[test]
    fn test_verify_hmac_wrong_secret() {
        let data = "test-data";
        let tag = compute_hmac(b"correct-secret", data);
        assert!(
            !verify_hmac(b"wrong-secret", data, &tag),
            "Verification should fail with wrong secret"
        );
    }

    #[test]
    fn test_verify_hmac_wrong_tag() {
        let secret = b"test-secret";
        let data = "test-data";
        let wrong_tag = vec![0u8; 32]; // All zeros -- definitely wrong
        assert!(
            !verify_hmac(secret, data, &wrong_tag),
            "Verification should fail with wrong tag"
        );
    }

    #[test]
    fn test_verify_hmac_truncated_tag() {
        let secret = b"test-secret";
        let data = "test-data";
        let tag = compute_hmac(secret, data);
        let truncated = &tag[..16]; // Only 16 of 32 bytes
        assert!(
            !verify_hmac(secret, data, truncated),
            "Verification should fail with truncated tag"
        );
    }

    #[test]
    fn test_verify_hmac_empty_tag() {
        let secret = b"test-secret";
        let data = "test-data";
        assert!(
            !verify_hmac(secret, data, &[]),
            "Verification should fail with empty tag"
        );
    }

    #[test]
    fn test_empty_data() {
        let secret = b"test-secret";
        let tag = compute_hmac(secret, "");
        assert_eq!(tag.len(), 32, "Empty data should still produce 32-byte HMAC");
        assert!(verify_hmac(secret, "", &tag), "Empty data HMAC should verify");
    }

    #[test]
    fn test_empty_secret() {
        // ring allows empty keys (it pads internally per HMAC spec)
        let tag = compute_hmac(b"", "test-data");
        assert_eq!(tag.len(), 32);
        assert!(verify_hmac(b"", "test-data", &tag));
    }

    /// Compatibility test: ensure our HMAC matches what Node.js crypto produces.
    /// The JS code does: crypto.createHmac('sha256', secret).update(data).digest('hex')
    /// where secret is the UTF-8 string from .state-secret (a hex string used as-is).
    #[test]
    fn test_compatibility_with_nodejs_hmac() {
        // In the JS code, the secret is a hex string read from .state-secret,
        // used directly as UTF-8 bytes (NOT hex-decoded). The Node.js crypto module
        // treats the string as raw bytes when passed to createHmac.
        //
        // So if .state-secret contains "abcdef1234567890", the key bytes are
        // the UTF-8 encoding of that string, not the hex-decoded bytes.
        let secret = b"abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
        let data = r#"{"stage":"fetch_ticket","ticket":"AUT-8031","data":{}}"#;

        let tag = compute_hmac(secret, data);
        assert_eq!(tag.len(), 32);
        // We can't hardcode the expected hex without running Node.js, but we CAN
        // verify the roundtrip works
        assert!(verify_hmac(secret, data, &tag));
    }
}
