//! Event Hub — TypedCircularBuffer<SseEvent> for the SSE replay buffer.
//!
//! Replaces the old StringCircularBuffer with a typed version that stores
//! full SseEvent structs. Supports replay-from-ID for reconnecting clients.
//!
//! Exported to Node.js via napi-rs as a class with methods:
//!   - new TypedCircularBuffer(capacity)
//!   - push(event: SseEvent)
//!   - replay(sinceId: number) -> SseEvent[]
//!   - toArray() -> SseEvent[]
//!   - len() -> number
//!   - clear()

use napi_derive::napi;

use crate::event::SseEvent;

/// Fixed-size circular buffer of SseEvent structs.
///
/// Used as the SSE replay buffer. When full, the oldest event is silently
/// discarded to make room for the new one. O(1) push, O(n) replay.
#[napi]
pub struct TypedCircularBuffer {
    /// Backing store
    buf: Vec<Option<SseEvent>>,
    /// Index of the oldest element
    head: usize,
    /// Index of the next write position
    tail: usize,
    /// Number of elements currently stored
    count: usize,
    /// Maximum capacity
    capacity: usize,
}

#[napi]
impl TypedCircularBuffer {
    /// Create a new typed circular buffer with the given capacity.
    ///
    /// ```js
    /// const buf = new TypedCircularBuffer(100);
    /// ```
    #[napi(constructor)]
    pub fn new(capacity: u32) -> Self {
        let cap = if capacity == 0 { 1 } else { capacity as usize };
        let mut buf = Vec::with_capacity(cap);
        for _ in 0..cap {
            buf.push(None);
        }
        TypedCircularBuffer {
            buf,
            head: 0,
            tail: 0,
            count: 0,
            capacity: cap,
        }
    }

    /// Push an SseEvent into the buffer. Overwrites oldest if full. O(1).
    #[napi]
    pub fn push(&mut self, event: SseEvent) {
        self.buf[self.tail] = Some(event);
        self.tail = (self.tail + 1) % self.capacity;

        if self.count < self.capacity {
            self.count += 1;
        } else {
            // Buffer full — oldest element overwritten, advance head
            self.head = (self.head + 1) % self.capacity;
        }
    }

    /// Replay all events with ID strictly greater than `since_id`.
    ///
    /// Returns events in chronological order (oldest to newest).
    /// Used for SSE reconnection via Last-Event-ID.
    ///
    /// ```js
    /// const missed = buf.replay(42); // all events after ID 42
    /// ```
    #[napi]
    pub fn replay(&self, since_id: u32) -> Vec<SseEvent> {
        let mut result = Vec::new();
        for i in 0..self.count {
            let idx = (self.head + i) % self.capacity;
            if let Some(ref event) = self.buf[idx] {
                if event.id > since_id {
                    result.push(event.clone());
                }
            }
        }
        result
    }

    /// Returns all events as an array, ordered oldest to newest.
    ///
    /// ```js
    /// const all = buf.toArray();
    /// ```
    #[napi(ts_return_type = "SseEvent[]")]
    pub fn to_array(&self) -> Vec<SseEvent> {
        let mut result = Vec::with_capacity(self.count);
        for i in 0..self.count {
            let idx = (self.head + i) % self.capacity;
            if let Some(ref event) = self.buf[idx] {
                result.push(event.clone());
            }
        }
        result
    }

    /// Number of events currently stored.
    #[napi]
    pub fn len(&self) -> u32 {
        self.count as u32
    }

    /// Clear all events from the buffer.
    #[napi]
    pub fn clear(&mut self) {
        for slot in self.buf.iter_mut() {
            *slot = None;
        }
        self.head = 0;
        self.tail = 0;
        self.count = 0;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Pure Rust unit tests
// ═══════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn make_event(id: u32, event_type: &str, data: &str) -> SseEvent {
        SseEvent {
            id,
            event_type: event_type.to_string(),
            data: data.to_string(),
            timestamp: id as f64 * 1000.0,
        }
    }

    #[test]
    fn test_new_buffer_is_empty() {
        let buf = TypedCircularBuffer::new(5);
        assert_eq!(buf.len(), 0);
        assert!(buf.to_array().is_empty());
    }

    #[test]
    fn test_push_and_len() {
        let mut buf = TypedCircularBuffer::new(5);
        buf.push(make_event(1, "log", "a"));
        buf.push(make_event(2, "log", "b"));
        buf.push(make_event(3, "log", "c"));
        assert_eq!(buf.len(), 3);
    }

    #[test]
    fn test_to_array_order() {
        let mut buf = TypedCircularBuffer::new(5);
        buf.push(make_event(1, "log", "first"));
        buf.push(make_event(2, "log", "second"));
        buf.push(make_event(3, "log", "third"));

        let items = buf.to_array();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].id, 1);
        assert_eq!(items[1].id, 2);
        assert_eq!(items[2].id, 3);
    }

    #[test]
    fn test_overwrite_oldest_when_full() {
        let mut buf = TypedCircularBuffer::new(3);
        buf.push(make_event(1, "log", "a"));
        buf.push(make_event(2, "log", "b"));
        buf.push(make_event(3, "log", "c"));
        buf.push(make_event(4, "log", "d"));

        assert_eq!(buf.len(), 3);
        let items = buf.to_array();
        assert_eq!(items[0].id, 2);
        assert_eq!(items[1].id, 3);
        assert_eq!(items[2].id, 4);
    }

    #[test]
    fn test_replay_since_id() {
        let mut buf = TypedCircularBuffer::new(10);
        buf.push(make_event(1, "log", "a"));
        buf.push(make_event(2, "log", "b"));
        buf.push(make_event(3, "status", "c"));
        buf.push(make_event(4, "log", "d"));
        buf.push(make_event(5, "log", "e"));

        let replayed = buf.replay(3);
        assert_eq!(replayed.len(), 2);
        assert_eq!(replayed[0].id, 4);
        assert_eq!(replayed[1].id, 5);
    }

    #[test]
    fn test_replay_since_zero_returns_all() {
        let mut buf = TypedCircularBuffer::new(5);
        buf.push(make_event(1, "log", "a"));
        buf.push(make_event(2, "log", "b"));

        let replayed = buf.replay(0);
        assert_eq!(replayed.len(), 2);
    }

    #[test]
    fn test_replay_since_high_id_returns_empty() {
        let mut buf = TypedCircularBuffer::new(5);
        buf.push(make_event(1, "log", "a"));
        buf.push(make_event(2, "log", "b"));

        let replayed = buf.replay(100);
        assert!(replayed.is_empty());
    }

    #[test]
    fn test_clear_resets() {
        let mut buf = TypedCircularBuffer::new(5);
        buf.push(make_event(1, "log", "a"));
        buf.push(make_event(2, "log", "b"));
        buf.clear();

        assert_eq!(buf.len(), 0);
        assert!(buf.to_array().is_empty());
        assert!(buf.replay(0).is_empty());
    }

    #[test]
    fn test_zero_capacity_becomes_one() {
        let mut buf = TypedCircularBuffer::new(0);
        buf.push(make_event(1, "log", "only"));
        assert_eq!(buf.len(), 1);

        buf.push(make_event(2, "log", "replaced"));
        assert_eq!(buf.len(), 1);
        assert_eq!(buf.to_array()[0].id, 2);
    }

    #[test]
    fn test_wraparound_replay() {
        let mut buf = TypedCircularBuffer::new(3);
        // Push 5 events into capacity-3 buffer
        for i in 1..=5 {
            buf.push(make_event(i, "log", &format!("msg-{}", i)));
        }

        // Buffer should contain events 3, 4, 5
        assert_eq!(buf.len(), 3);
        let all = buf.to_array();
        assert_eq!(all[0].id, 3);
        assert_eq!(all[2].id, 5);

        // Replay since ID 3 should return events 4, 5
        let replayed = buf.replay(3);
        assert_eq!(replayed.len(), 2);
        assert_eq!(replayed[0].id, 4);
        assert_eq!(replayed[1].id, 5);
    }
}
