//! sse-engine: Typed event buffer, client registry, and broadcast for SSE server
//!
//! Native addon for MI Dev Agent SSE event management.
//!
//! Exports:
//!   - StringCircularBuffer  (legacy — string-only circular buffer)
//!   - SseEvent              (typed event struct)
//!   - TypedCircularBuffer   (SseEvent circular buffer with replay)
//!   - ClientRegistry        (connected client tracking)
//!   - ClientInfo            (client metadata struct)
//!   - next_id()             (atomic monotonic ID counter)
//!   - reset_id_counter()    (reset counter — testing only)
//!   - format_sse_frame()    (SSE wire-protocol frame formatter)

#[macro_use]
extern crate napi_derive;

pub mod circular;
pub mod event;
pub mod event_hub;
pub mod ids;
pub mod registry;

// Re-export all public types so napi-rs picks them up from the crate root
pub use circular::StringCircularBuffer;
pub use event::SseEvent;
pub use event_hub::TypedCircularBuffer;
pub use ids::{format_sse_frame, next_id, reset_id_counter};
pub use registry::{ClientInfo, ClientRegistry};
