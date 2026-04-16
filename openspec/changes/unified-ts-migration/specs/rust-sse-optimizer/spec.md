# Rust SSE Optimizer Spec

## Domain: packages/native/src/ (SSE engine)

## Status: ADDED

## Overview
Typed SSE event handling in Rust with atomic message IDs, pre-formatted frame caching,
and a client registry. Follows the "Rust brain + JS hands" pattern: Rust owns data
structures and formatting, JS owns all I/O (res.write, drain, keepalive).

## Requirements

### ADDED: SseEvent Struct
- WHEN the Rust SSE engine is loaded THEN the `SseEvent` struct stores `id` (u32), `event_type` (String), and `data` (String).
- WHEN an event is created THEN all three fields are required (no Option types for core fields).
- WHEN the struct is serialized for NAPI THEN it implements `napi::bindgen_prelude::ToNapiValue`.

### ADDED: Atomic Message ID
- WHEN a message is broadcast THEN an atomic message ID increments via `AtomicU64` with `Ordering::Relaxed`.
- WHEN the ID is read from JS THEN it returns the current counter value as a JavaScript `BigInt` or `number`.
- WHEN the engine restarts THEN the counter resets to 0 (no persistence across process restarts).

### ADDED: Pre-Formatted SSE Frame Cache
- WHEN an SSE frame is formatted THEN it is formatted once as `Vec<u8>` containing `id: {id}\nevent: {type}\ndata: {data}\n\n`.
- WHEN the formatted frame is shared across clients THEN it is wrapped in `Arc<Vec<u8>>` to avoid per-client copies.
- WHEN JS receives the frame bytes THEN it gets a Node.js `Buffer` (zero-copy via NAPI) for use with `res.write()`.

### ADDED: NAPI Version and ThreadsafeFunction
- WHEN napi is used THEN version 8+ with `ThreadsafeFunction` support is available.
- WHEN Rust needs to call back into JS THEN it uses `ThreadsafeFunction` to safely cross the thread boundary.
- WHEN the native addon is built THEN it targets `napi8` or higher in `Cargo.toml` napi features.

### ADDED: Client Registry (Query Only)
- WHEN the client registry is queried THEN Rust returns `client_count` (u32) and per-client `backpressure` state (bool).
- WHEN a client connects THEN JS calls `registry_add(client_id)` to register in Rust.
- WHEN a client disconnects THEN JS calls `registry_remove(client_id)` to deregister.
- WHEN backpressure is detected by JS (drain event) THEN JS calls `registry_set_backpressure(client_id, true)`.

### ADDED: Broadcast Flow
- WHEN JS calls `broadcast(event_type, data)` THEN Rust creates the `SseEvent`, increments the ID, formats the frame, and returns the `Buffer`.
- WHEN the Buffer is returned THEN JS iterates connected clients and calls `res.write(buffer)` for each.
- WHEN a client write returns false (backpressure) THEN JS pauses writes to that client and waits for drain.

### ADDED: JS Fallback
- WHEN the Rust native addon fails to load (e.g., missing binary, architecture mismatch) THEN `fallback.js` provides equivalent functionality in pure JavaScript.
- WHEN fallback is active THEN it uses the same API surface: `broadcast()`, `registry_add()`, `registry_remove()`, `registry_set_backpressure()`.
- WHEN fallback is active THEN a warning is logged: "Native SSE engine unavailable, using JS fallback".
