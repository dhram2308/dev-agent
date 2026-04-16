//! Atomic ID counter and SSE frame formatter.
//!
//! Provides a global AtomicU64 counter for generating monotonic message IDs,
//! and a helper to format SSE wire-protocol frames as byte vectors.

use std::sync::atomic::{AtomicU64, Ordering};

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// Global atomic counter for message IDs.
/// Thread-safe, lock-free. Wraps at u64::MAX (practically never).
static COUNTER: AtomicU64 = AtomicU64::new(1);

/// Get the next monotonic message ID.
///
/// Thread-safe and lock-free (uses AtomicU64 with Relaxed ordering).
/// Returns a u32 by wrapping the internal u64 counter for JS compatibility
/// (JS numbers are safe up to 2^53, but u32 keeps the SSE id: field compact).
///
/// ```js
/// const id = nextId(); // 1, 2, 3, ...
/// ```
#[napi]
pub fn next_id() -> u32 {
    // fetch_add returns the previous value; we want the new value
    let val = COUNTER.fetch_add(1, Ordering::Relaxed);
    val as u32
}

/// Reset the counter to 1. Intended for testing only.
///
/// ```js
/// resetIdCounter(); // resets to 1
/// ```
#[napi]
pub fn reset_id_counter() {
    COUNTER.store(1, Ordering::Relaxed);
}

/// Format an SSE wire-protocol frame as bytes.
///
/// Produces the standard SSE format:
/// ```text
/// id: 42
/// event: log
/// data: {"line":"hello"}
///
/// ```
///
/// Returns a Buffer (Node.js Buffer / Uint8Array) for direct res.write().
///
/// ```js
/// const frame = formatSseFrame(42, "log", '{"line":"hello"}');
/// res.write(frame); // writes raw bytes, no string encoding overhead
/// ```
#[napi]
pub fn format_sse_frame(id: u32, event: String, data: String) -> Buffer {
    let formatted = format!("id: {}\nevent: {}\ndata: {}\n\n", id, event, data);
    Buffer::from(formatted.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_sse_frame_basic() {
        let frame = format_sse_frame(1, "log".to_string(), r#"{"line":"hello"}"#.to_string());
        let s = String::from_utf8(frame.to_vec()).unwrap();
        assert_eq!(s, "id: 1\nevent: log\ndata: {\"line\":\"hello\"}\n\n");
    }

    #[test]
    fn test_format_sse_frame_empty_data() {
        let frame = format_sse_frame(0, "ping".to_string(), "".to_string());
        let s = String::from_utf8(frame.to_vec()).unwrap();
        assert_eq!(s, "id: 0\nevent: ping\ndata: \n\n");
    }

    #[test]
    fn test_format_sse_frame_large_id() {
        let frame = format_sse_frame(u32::MAX, "test".to_string(), "data".to_string());
        let s = String::from_utf8(frame.to_vec()).unwrap();
        assert!(s.starts_with("id: 4294967295\n"));
    }
}
