//! http-engine: Circuit breaker, retry, dedup, and rate limiting
//!
//! Native addon for MI Dev Agent HTTP client resilience patterns.
//! Provides the CircuitBreaker as a napi-rs class for Node.js.

#[macro_use]
extern crate napi_derive;

pub mod circuit;

// Re-export the CircuitBreaker so napi-rs picks it up from the crate root
pub use circuit::CircuitBreaker;
pub use circuit::CircuitBreakerMetrics;
