//! sse-engine: Circular buffer and broadcast for SSE server
//!
//! Native addon for MI Dev Agent SSE event management.
//! Provides StringCircularBuffer as a napi-rs class for Node.js.

#[macro_use]
extern crate napi_derive;

pub mod circular;

// Re-export the StringCircularBuffer so napi-rs picks it up from the crate root
pub use circular::StringCircularBuffer;
