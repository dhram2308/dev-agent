// ═══════════════════════════════════════════════════════════════════════
// Circular Buffer — Fixed-size ring buffer with O(1) push
// ═══════════════════════════════════════════════════════════════════════
//
// Generic implementation with head/tail index pointers. When full,
// the oldest element is overwritten. Iterator yields items from
// oldest to newest.
//
// Exported to Node.js via napi-rs as StringCircularBuffer (string
// specialization for SSE replay buffer).
// ═══════════════════════════════════════════════════════════════════════

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Generic circular buffer with fixed capacity.
///
/// Uses a pre-allocated Vec<Option<T>> as the backing store with head/tail
/// index pointers. `head` points to the oldest element, `tail` points to
/// the next write position. When the buffer is full, push overwrites the
/// oldest element and advances `head`.
pub struct CircularBuffer<T> {
    /// Backing store
    buf: Vec<Option<T>>,
    /// Index of the oldest element
    head: usize,
    /// Index of the next write position
    tail: usize,
    /// Number of elements currently stored
    count: usize,
    /// Maximum capacity
    capacity: usize,
}

impl<T: Clone> CircularBuffer<T> {
    /// Create a new circular buffer with the given capacity.
    ///
    /// Panics if capacity is 0.
    pub fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "CircularBuffer capacity must be > 0");
        let mut buf = Vec::with_capacity(capacity);
        for _ in 0..capacity {
            buf.push(None);
        }
        CircularBuffer {
            buf,
            head: 0,
            tail: 0,
            count: 0,
            capacity,
        }
    }

    /// Push an item into the buffer. O(1).
    ///
    /// If the buffer is full, the oldest item is overwritten and head
    /// advances.
    pub fn push(&mut self, item: T) {
        self.buf[self.tail] = Some(item);
        self.tail = (self.tail + 1) % self.capacity;

        if self.count < self.capacity {
            self.count += 1;
        } else {
            // Buffer was full — oldest element overwritten, advance head
            self.head = (self.head + 1) % self.capacity;
        }
    }

    /// Number of elements currently stored.
    pub fn len(&self) -> usize {
        self.count
    }

    /// Whether the buffer is empty.
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// Clear all elements.
    pub fn clear(&mut self) {
        for slot in self.buf.iter_mut() {
            *slot = None;
        }
        self.head = 0;
        self.tail = 0;
        self.count = 0;
    }

    /// Iterate from oldest to newest.
    ///
    /// Returns an iterator that yields references to stored items in
    /// chronological order (head -> tail).
    pub fn iter(&self) -> CircularBufferIter<'_, T> {
        CircularBufferIter {
            buf: &self.buf,
            capacity: self.capacity,
            current: self.head,
            remaining: self.count,
        }
    }

    /// Collect all items into a Vec, ordered oldest to newest.
    pub fn to_vec(&self) -> Vec<T> {
        self.iter().cloned().collect()
    }
}

/// Iterator over CircularBuffer elements from oldest to newest.
pub struct CircularBufferIter<'a, T> {
    buf: &'a Vec<Option<T>>,
    capacity: usize,
    current: usize,
    remaining: usize,
}

impl<'a, T> Iterator for CircularBufferIter<'a, T> {
    type Item = &'a T;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining == 0 {
            return None;
        }
        let item = self.buf[self.current].as_ref();
        self.current = (self.current + 1) % self.capacity;
        self.remaining -= 1;
        item
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        (self.remaining, Some(self.remaining))
    }
}

impl<'a, T> ExactSizeIterator for CircularBufferIter<'a, T> {}

// ═══════════════════════════════════════════════════════════════════════
// napi-rs export: StringCircularBuffer
// ═══════════════════════════════════════════════════════════════════════
//
// Specialized for String since napi-rs cannot directly export generic
// types. This is the primary type used by the SSE replay buffer.

/// Fixed-size circular buffer of strings, exported to Node.js.
///
/// Used as the SSE replay buffer. When full, the oldest message is
/// silently discarded to make room for the new one. O(1) push.
#[napi]
pub struct StringCircularBuffer {
    inner: CircularBuffer<String>,
}

#[napi]
impl StringCircularBuffer {
    /// Create a new buffer with the given capacity.
    ///
    /// ```js
    /// const buf = new StringCircularBuffer(100);
    /// ```
    #[napi(constructor)]
    pub fn new(capacity: u32) -> Self {
        let cap = if capacity == 0 { 1 } else { capacity as usize };
        StringCircularBuffer {
            inner: CircularBuffer::new(cap),
        }
    }

    /// Push a string into the buffer. Overwrites oldest if full.
    #[napi]
    pub fn push(&mut self, item: String) {
        self.inner.push(item);
    }

    /// Returns all items as an array, ordered oldest to newest.
    ///
    /// ```js
    /// const items = buf.toArray(); // ["oldest", ..., "newest"]
    /// ```
    #[napi(ts_return_type = "string[]")]
    pub fn to_array(&self) -> Vec<String> {
        self.inner.to_vec()
    }

    /// Number of items currently stored.
    #[napi]
    pub fn len(&self) -> u32 {
        self.inner.len() as u32
    }

    /// Clear all items from the buffer.
    #[napi]
    pub fn clear(&mut self) {
        self.inner.clear();
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Pure Rust unit tests
// ═══════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_buffer_is_empty() {
        let buf: CircularBuffer<String> = CircularBuffer::new(5);
        assert_eq!(buf.len(), 0);
        assert!(buf.is_empty());
        assert_eq!(buf.to_vec().len(), 0);
    }

    #[test]
    fn test_push_and_len() {
        let mut buf: CircularBuffer<i32> = CircularBuffer::new(5);
        buf.push(1);
        buf.push(2);
        buf.push(3);
        assert_eq!(buf.len(), 3);
        assert!(!buf.is_empty());
    }

    #[test]
    fn test_order_oldest_to_newest() {
        let mut buf: CircularBuffer<i32> = CircularBuffer::new(5);
        buf.push(10);
        buf.push(20);
        buf.push(30);
        let items: Vec<&i32> = buf.iter().collect();
        assert_eq!(items, vec![&10, &20, &30]);
    }

    #[test]
    fn test_overwrite_oldest_when_full() {
        let mut buf: CircularBuffer<i32> = CircularBuffer::new(3);
        buf.push(1);
        buf.push(2);
        buf.push(3);
        assert_eq!(buf.len(), 3);

        // This should overwrite 1
        buf.push(4);
        assert_eq!(buf.len(), 3);
        assert_eq!(buf.to_vec(), vec![2, 3, 4]);
    }

    #[test]
    fn test_overwrite_multiple_wraps() {
        let mut buf: CircularBuffer<i32> = CircularBuffer::new(3);
        // Fill: [1, 2, 3]
        buf.push(1);
        buf.push(2);
        buf.push(3);
        // Overwrite 1: [2, 3, 4]
        buf.push(4);
        // Overwrite 2: [3, 4, 5]
        buf.push(5);
        // Overwrite 3: [4, 5, 6]
        buf.push(6);
        assert_eq!(buf.to_vec(), vec![4, 5, 6]);
    }

    #[test]
    fn test_clear_resets_everything() {
        let mut buf: CircularBuffer<i32> = CircularBuffer::new(3);
        buf.push(1);
        buf.push(2);
        buf.push(3);
        buf.clear();
        assert_eq!(buf.len(), 0);
        assert!(buf.is_empty());
        assert_eq!(buf.to_vec().len(), 0);
    }

    #[test]
    fn test_push_after_clear() {
        let mut buf: CircularBuffer<i32> = CircularBuffer::new(3);
        buf.push(1);
        buf.push(2);
        buf.push(3);
        buf.clear();
        buf.push(10);
        buf.push(20);
        assert_eq!(buf.to_vec(), vec![10, 20]);
    }

    #[test]
    fn test_capacity_one() {
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
    fn test_large_buffer() {
        let mut buf: CircularBuffer<i32> = CircularBuffer::new(100);
        for i in 0..150 {
            buf.push(i);
        }
        assert_eq!(buf.len(), 100);
        let items = buf.to_vec();
        assert_eq!(items[0], 50);
        assert_eq!(items[99], 149);
    }

    #[test]
    fn test_string_circular_buffer_napi() {
        let mut buf = StringCircularBuffer::new(3);
        buf.push("a".to_string());
        buf.push("b".to_string());
        buf.push("c".to_string());
        assert_eq!(buf.len(), 3);
        assert_eq!(buf.to_array(), vec!["a", "b", "c"]);

        buf.push("d".to_string());
        assert_eq!(buf.to_array(), vec!["b", "c", "d"]);
    }

    #[test]
    fn test_string_buffer_clear() {
        let mut buf = StringCircularBuffer::new(5);
        buf.push("x".to_string());
        buf.push("y".to_string());
        buf.clear();
        assert_eq!(buf.len(), 0);
        assert_eq!(buf.to_array().len(), 0);
    }

    #[test]
    fn test_zero_capacity_becomes_one() {
        let mut buf = StringCircularBuffer::new(0);
        buf.push("a".to_string());
        assert_eq!(buf.len(), 1);
        assert_eq!(buf.to_array(), vec!["a"]);
    }

    #[test]
    fn test_iterator_exact_size() {
        let mut buf: CircularBuffer<i32> = CircularBuffer::new(5);
        buf.push(1);
        buf.push(2);
        buf.push(3);
        let iter = buf.iter();
        assert_eq!(iter.len(), 3);
    }

    #[test]
    fn test_iterator_empty_buffer() {
        let buf: CircularBuffer<i32> = CircularBuffer::new(5);
        let items: Vec<&i32> = buf.iter().collect();
        assert!(items.is_empty());
    }

    #[test]
    #[should_panic(expected = "capacity must be > 0")]
    fn test_zero_capacity_panics_on_generic() {
        let _buf: CircularBuffer<i32> = CircularBuffer::new(0);
    }
}
