//! SSE Event — Typed event struct for the replay buffer and NAPI boundary.
//!
//! This replaces raw strings with a structured event containing ID, type,
//! data, and timestamp. The `#[napi(object)]` attribute exports it as a
//! plain JS object (not a class), so JS code can create them with `{ id, eventType, data, timestamp }`.

use napi_derive::napi;

/// A single SSE event with metadata.
///
/// Exported to JS as a plain object:
/// ```js
/// { id: 42, eventType: "log", data: "{\"line\":\"hello\"}", timestamp: 1713200000000 }
/// ```
#[napi(object)]
#[derive(Clone, Debug)]
pub struct SseEvent {
    /// Monotonic event ID (wrapping u32 for JS compatibility)
    pub id: u32,
    /// SSE event type (e.g., "log", "status", "error")
    pub event_type: String,
    /// JSON-serialized event data
    pub data: String,
    /// Timestamp in milliseconds since epoch (JS Date.now() compatible)
    pub timestamp: f64,
}
