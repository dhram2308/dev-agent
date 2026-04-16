// =====================================================================
// sse-engine -- Integration Tests
// =====================================================================
//
// Tests: CircularBuffer push & iterate, wraparound, clear, single
// item, empty buffer, StringCircularBuffer (napi wrapper),
// TypedCircularBuffer, SseEvent, ClientRegistry, format_sse_frame,
// next_id / reset_id_counter.
//
// These tests exercise the PUBLIC API across module boundaries.
// The inline #[cfg(test)] unit tests in each module test internals.
// =====================================================================

use sse_engine::circular::{CircularBuffer, StringCircularBuffer};
use sse_engine::event::SseEvent;
use sse_engine::event_hub::TypedCircularBuffer;
use sse_engine::ids::{format_sse_frame, next_id, reset_id_counter};
use sse_engine::registry::ClientRegistry;

// ═══════════════════════════════════════════════════════════════════════
// Push & Iterate Tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn push_three_items_iterate_oldest_to_newest() {
    let mut buf: CircularBuffer<i32> = CircularBuffer::new(5);
    buf.push(10);
    buf.push(20);
    buf.push(30);

    let items: Vec<&i32> = buf.iter().collect();
    assert_eq!(items, vec![&10, &20, &30]);
    assert_eq!(buf.len(), 3);
    assert!(!buf.is_empty());
}

#[test]
fn push_fills_exactly_to_capacity() {
    let mut buf: CircularBuffer<i32> = CircularBuffer::new(4);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);

    assert_eq!(buf.len(), 4);
    assert_eq!(buf.to_vec(), vec![1, 2, 3, 4]);
}

#[test]
fn to_vec_returns_correct_order() {
    let mut buf: CircularBuffer<String> = CircularBuffer::new(3);
    buf.push("alpha".to_string());
    buf.push("bravo".to_string());
    buf.push("charlie".to_string());

    assert_eq!(buf.to_vec(), vec!["alpha", "bravo", "charlie"]);
}

// ═══════════════════════════════════════════════════════════════════════
// Wraparound Tests (push more than capacity)
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn wraparound_overwrites_oldest_element() {
    let mut buf: CircularBuffer<i32> = CircularBuffer::new(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    // Buffer full: [1, 2, 3]. Push 4 overwrites 1.
    buf.push(4);

    assert_eq!(buf.len(), 3);
    assert_eq!(buf.to_vec(), vec![2, 3, 4]);
}

#[test]
fn wraparound_multiple_full_cycles() {
    let mut buf: CircularBuffer<i32> = CircularBuffer::new(3);
    // Push 9 items into capacity-3 buffer (3 full cycles)
    for i in 1..=9 {
        buf.push(i);
    }

    assert_eq!(buf.len(), 3);
    // Only the last 3 should remain: [7, 8, 9]
    assert_eq!(buf.to_vec(), vec![7, 8, 9]);
}

#[test]
fn wraparound_preserves_chronological_order() {
    let mut buf: CircularBuffer<i32> = CircularBuffer::new(4);
    // Push 7 items into capacity-4: head wraps around
    for i in 0..7 {
        buf.push(i * 10);
    }

    // Last 4: 30, 40, 50, 60
    let items: Vec<i32> = buf.iter().cloned().collect();
    assert_eq!(items, vec![30, 40, 50, 60]);
}

#[test]
fn wraparound_large_buffer_150_into_100() {
    let mut buf: CircularBuffer<i32> = CircularBuffer::new(100);
    for i in 0..150 {
        buf.push(i);
    }

    assert_eq!(buf.len(), 100);
    let items = buf.to_vec();
    // First item should be 50 (the 51st pushed), last should be 149
    assert_eq!(items[0], 50);
    assert_eq!(items[99], 149);
}

// ═══════════════════════════════════════════════════════════════════════
// Clear Tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn clear_resets_to_empty_state() {
    let mut buf: CircularBuffer<i32> = CircularBuffer::new(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);

    buf.clear();

    assert_eq!(buf.len(), 0);
    assert!(buf.is_empty());
    assert!(buf.to_vec().is_empty());
}

#[test]
fn clear_after_wraparound_then_push_again() {
    let mut buf: CircularBuffer<i32> = CircularBuffer::new(3);
    // Fill and wrap
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    buf.push(5);
    assert_eq!(buf.to_vec(), vec![3, 4, 5]);

    // Clear
    buf.clear();
    assert!(buf.is_empty());

    // Push new items after clear
    buf.push(100);
    buf.push(200);
    assert_eq!(buf.to_vec(), vec![100, 200]);
    assert_eq!(buf.len(), 2);
}

#[test]
fn double_clear_is_idempotent() {
    let mut buf: CircularBuffer<i32> = CircularBuffer::new(3);
    buf.push(1);
    buf.clear();
    buf.clear();

    assert_eq!(buf.len(), 0);
    assert!(buf.is_empty());
}

// ═══════════════════════════════════════════════════════════════════════
// Single Item (capacity = 1) Tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn single_capacity_holds_one_item() {
    let mut buf: CircularBuffer<i32> = CircularBuffer::new(1);
    buf.push(42);

    assert_eq!(buf.len(), 1);
    assert_eq!(buf.to_vec(), vec![42]);
}

#[test]
fn single_capacity_overwrites_on_each_push() {
    let mut buf: CircularBuffer<i32> = CircularBuffer::new(1);
    buf.push(1);
    assert_eq!(buf.to_vec(), vec![1]);

    buf.push(2);
    assert_eq!(buf.to_vec(), vec![2]);

    buf.push(3);
    assert_eq!(buf.to_vec(), vec![3]);

    assert_eq!(buf.len(), 1);
}

#[test]
fn single_capacity_clear_then_push() {
    let mut buf: CircularBuffer<i32> = CircularBuffer::new(1);
    buf.push(99);
    buf.clear();
    assert!(buf.is_empty());

    buf.push(77);
    assert_eq!(buf.to_vec(), vec![77]);
}

// ═══════════════════════════════════════════════════════════════════════
// Empty Buffer Tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn empty_buffer_has_zero_length() {
    let buf: CircularBuffer<i32> = CircularBuffer::new(10);
    assert_eq!(buf.len(), 0);
    assert!(buf.is_empty());
}

#[test]
fn empty_buffer_iterator_yields_nothing() {
    let buf: CircularBuffer<String> = CircularBuffer::new(5);
    let items: Vec<&String> = buf.iter().collect();
    assert!(items.is_empty());
}

#[test]
fn empty_buffer_to_vec_returns_empty_vec() {
    let buf: CircularBuffer<i32> = CircularBuffer::new(3);
    assert!(buf.to_vec().is_empty());
}

#[test]
fn empty_buffer_iterator_exact_size_is_zero() {
    let buf: CircularBuffer<i32> = CircularBuffer::new(5);
    let iter = buf.iter();
    assert_eq!(iter.len(), 0);
}

// ═══════════════════════════════════════════════════════════════════════
// Iterator ExactSizeIterator Tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn iterator_size_hint_matches_count() {
    let mut buf: CircularBuffer<i32> = CircularBuffer::new(10);
    buf.push(1);
    buf.push(2);
    buf.push(3);

    let iter = buf.iter();
    assert_eq!(iter.len(), 3);
    let (lower, upper) = iter.size_hint();
    assert_eq!(lower, 3);
    assert_eq!(upper, Some(3));
}

#[test]
fn iterator_size_decreases_as_items_consumed() {
    let mut buf: CircularBuffer<i32> = CircularBuffer::new(5);
    buf.push(10);
    buf.push(20);
    buf.push(30);

    let mut iter = buf.iter();
    assert_eq!(iter.len(), 3);

    iter.next();
    assert_eq!(iter.len(), 2);

    iter.next();
    assert_eq!(iter.len(), 1);

    iter.next();
    assert_eq!(iter.len(), 0);

    // After exhaustion, next returns None
    assert!(iter.next().is_none());
}

// ═══════════════════════════════════════════════════════════════════════
// StringCircularBuffer (napi wrapper) Tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn string_buffer_push_and_to_array() {
    let mut buf = StringCircularBuffer::new(3);
    buf.push("hello".to_string());
    buf.push("world".to_string());

    assert_eq!(buf.len(), 2);
    assert_eq!(buf.to_array(), vec!["hello", "world"]);
}

#[test]
fn string_buffer_wraparound() {
    let mut buf = StringCircularBuffer::new(2);
    buf.push("a".to_string());
    buf.push("b".to_string());
    buf.push("c".to_string());

    assert_eq!(buf.len(), 2);
    assert_eq!(buf.to_array(), vec!["b", "c"]);
}

#[test]
fn string_buffer_clear() {
    let mut buf = StringCircularBuffer::new(5);
    buf.push("x".to_string());
    buf.push("y".to_string());
    buf.push("z".to_string());

    buf.clear();
    assert_eq!(buf.len(), 0);
    assert!(buf.to_array().is_empty());
}

#[test]
fn string_buffer_zero_capacity_becomes_one() {
    // The napi wrapper clamps capacity 0 to 1
    let mut buf = StringCircularBuffer::new(0);
    buf.push("only".to_string());
    assert_eq!(buf.len(), 1);
    assert_eq!(buf.to_array(), vec!["only"]);

    buf.push("replaced".to_string());
    assert_eq!(buf.len(), 1);
    assert_eq!(buf.to_array(), vec!["replaced"]);
}

// ═══════════════════════════════════════════════════════════════════════
// Panic Test: Generic CircularBuffer with zero capacity
// ═══════════════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "capacity must be > 0")]
fn generic_zero_capacity_panics() {
    let _buf: CircularBuffer<i32> = CircularBuffer::new(0);
}

// ═══════════════════════════════════════════════════════════════════════
// TypedCircularBuffer Integration Tests
// ═══════════════════════════════════════════════════════════════════════

fn make_event(id: u32, event_type: &str, data: &str) -> SseEvent {
    SseEvent {
        id,
        event_type: event_type.to_string(),
        data: data.to_string(),
        timestamp: id as f64 * 1000.0,
    }
}

#[test]
fn typed_buffer_push_and_to_array() {
    let mut buf = TypedCircularBuffer::new(5);
    buf.push(make_event(1, "log", "hello"));
    buf.push(make_event(2, "status", "running"));

    assert_eq!(buf.len(), 2);
    let items = buf.to_array();
    assert_eq!(items[0].id, 1);
    assert_eq!(items[0].event_type, "log");
    assert_eq!(items[1].id, 2);
    assert_eq!(items[1].event_type, "status");
}

#[test]
fn typed_buffer_wraparound_discards_oldest() {
    let mut buf = TypedCircularBuffer::new(3);
    for i in 1..=5 {
        buf.push(make_event(i, "log", &format!("msg-{}", i)));
    }

    assert_eq!(buf.len(), 3);
    let items = buf.to_array();
    assert_eq!(items[0].id, 3);
    assert_eq!(items[1].id, 4);
    assert_eq!(items[2].id, 5);
}

#[test]
fn typed_buffer_replay_returns_events_after_id() {
    let mut buf = TypedCircularBuffer::new(10);
    for i in 1..=5 {
        buf.push(make_event(i, "log", "data"));
    }

    let replayed = buf.replay(3);
    assert_eq!(replayed.len(), 2);
    assert_eq!(replayed[0].id, 4);
    assert_eq!(replayed[1].id, 5);
}

#[test]
fn typed_buffer_replay_zero_returns_all() {
    let mut buf = TypedCircularBuffer::new(10);
    buf.push(make_event(1, "log", "a"));
    buf.push(make_event(2, "log", "b"));

    let replayed = buf.replay(0);
    assert_eq!(replayed.len(), 2);
}

#[test]
fn typed_buffer_replay_high_id_returns_empty() {
    let mut buf = TypedCircularBuffer::new(5);
    buf.push(make_event(1, "log", "a"));

    assert!(buf.replay(999).is_empty());
}

#[test]
fn typed_buffer_clear_and_reuse() {
    let mut buf = TypedCircularBuffer::new(5);
    buf.push(make_event(1, "log", "a"));
    buf.push(make_event(2, "log", "b"));
    buf.clear();

    assert_eq!(buf.len(), 0);
    assert!(buf.to_array().is_empty());

    buf.push(make_event(10, "status", "new"));
    assert_eq!(buf.len(), 1);
    assert_eq!(buf.to_array()[0].id, 10);
}

// ═══════════════════════════════════════════════════════════════════════
// ClientRegistry Integration Tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn registry_add_remove_clients() {
    let mut reg = ClientRegistry::new();
    reg.add_client("c1".to_string(), 1000.0, 0);
    reg.add_client("c2".to_string(), 2000.0, 5);

    assert_eq!(reg.get_client_count(), 2);
    assert!(reg.has_client("c1".to_string()));
    assert!(reg.has_client("c2".to_string()));

    assert!(reg.remove_client("c1".to_string()));
    assert_eq!(reg.get_client_count(), 1);
    assert!(!reg.has_client("c1".to_string()));
}

#[test]
fn registry_update_last_event_id() {
    let mut reg = ClientRegistry::new();
    reg.add_client("c1".to_string(), 1000.0, 0);

    assert!(reg.update_last_event_id("c1".to_string(), 42));
    assert!(!reg.update_last_event_id("nonexistent".to_string(), 10));

    let clients = reg.get_clients();
    assert_eq!(clients[0].last_event_id, 42);
}

#[test]
fn registry_clear_removes_all() {
    let mut reg = ClientRegistry::new();
    for i in 0..5 {
        reg.add_client(format!("c{}", i), i as f64 * 100.0, 0);
    }

    reg.clear();
    assert_eq!(reg.get_client_count(), 0);
}

// ═══════════════════════════════════════════════════════════════════════
// format_sse_frame Integration Tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn format_sse_frame_produces_valid_sse() {
    let frame = format_sse_frame(42, "log".to_string(), r#"{"line":"test"}"#.to_string());
    let s = String::from_utf8(frame.to_vec()).unwrap();
    assert_eq!(s, "id: 42\nevent: log\ndata: {\"line\":\"test\"}\n\n");
}

#[test]
fn format_sse_frame_ends_with_double_newline() {
    let frame = format_sse_frame(1, "ping".to_string(), "".to_string());
    let s = String::from_utf8(frame.to_vec()).unwrap();
    assert!(s.ends_with("\n\n"));
}

// ═══════════════════════════════════════════════════════════════════════
// next_id / reset_id_counter Integration Tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn next_id_is_monotonically_increasing() {
    reset_id_counter();
    let a = next_id();
    let b = next_id();
    let c = next_id();

    assert!(b > a);
    assert!(c > b);
}

#[test]
fn reset_id_counter_restarts_from_one() {
    // Call next_id a few times to advance the counter
    next_id();
    next_id();

    reset_id_counter();
    let id = next_id();
    assert_eq!(id, 1);
}
