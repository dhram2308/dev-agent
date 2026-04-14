//! state-engine: HMAC, file locking, and atomic write for MI Dev Agent.
//!
//! This crate provides native (Rust) implementations of safety-critical operations
//! that benefit from compile-time guarantees:
//!
//! - **HMAC-SHA256** (`hmac.rs`): Constant-time verification via `ring::hmac::verify`.
//!   Replaces `crypto.createHmac` + `crypto.timingSafeEqual` in state-unified.js.
//!
//! - **File Lock** (`file_lock.rs`): RAII lock using O_EXCL with Drop-based cleanup.
//!   Replaces `acquireLockSync`/`acquireLockAsync` in state-lock.js.
//!   Lock is ALWAYS released, even on panic.
//!
//! - **Atomic Write** (`atomic_write.rs`): temp -> fsync -> rename with Drop guard
//!   for fd/temp-file cleanup. Replaces `atomicWriteSync` in state-unified.js.
//!
//! # Node.js API
//!
//! All functions are exported via napi-rs and can be used from JavaScript:
//!
//! ```js
//! const {
//!   computeHmacNapi,    // (secret: Buffer, data: string) -> Buffer
//!   verifyHmacNapi,     // (secret: Buffer, data: string, expected: Buffer) -> boolean
//!   acquireFileLock,     // (path: string, timeoutMs: number) -> FileLockHandle
//!   atomicWriteSync,     // (path: string, data: string) -> void
//! } = require('./state-engine');
//! ```
//!
//! # Fallback
//!
//! If the native addon fails to load (wrong platform, missing build), the
//! TypeScript wrapper in `packages/backend/src/state/` falls back to the
//! JS implementations. A WARNING is logged.

#[macro_use]
extern crate napi_derive;

pub mod hmac;
pub mod file_lock;
pub mod atomic_write;

pub use hmac::*;
pub use file_lock::*;
pub use atomic_write::*;
