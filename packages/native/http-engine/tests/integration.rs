// =====================================================================
// http-engine — Integration Tests (Circuit Breaker)
// =====================================================================
//
// Tests: State transitions, allow_request behavior, failure counting
// with window pruning, concurrent safety, metrics tracking.
//
// These tests exercise the public API of CircuitBreaker across
// realistic multi-step scenarios.
// =====================================================================

use std::thread;
use std::time::Duration;

use http_engine::CircuitBreaker;

// ═══════════════════════════════════════════════════════════════════════
// State Transitions
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn state_transition_closed_to_open_after_threshold_failures() {
    // threshold=3, window=60s, open_timeout=100ms, half_open_max=2
    let mut cb = CircuitBreaker::new(3, 60_000, 100, 2);
    assert_eq!(cb.get_state(), "closed");

    cb.record_failure();
    assert_eq!(cb.get_state(), "closed", "One failure should stay closed");

    cb.record_failure();
    assert_eq!(cb.get_state(), "closed", "Two failures should stay closed");

    cb.record_failure();
    assert_eq!(
        cb.get_state(),
        "open",
        "Third failure should trip circuit to open"
    );
}

#[test]
fn state_transition_open_to_half_open_after_timeout() {
    // threshold=2, window=60s, open_timeout=20ms, half_open_max=1
    let mut cb = CircuitBreaker::new(2, 60_000, 20, 1);

    // Trip to open
    cb.record_failure();
    cb.record_failure();
    assert_eq!(cb.get_state(), "open");

    // Wait for open timeout to expire
    thread::sleep(Duration::from_millis(30));

    // allow_request should transition to half_open
    assert!(
        cb.allow_request(),
        "First request after timeout should be allowed (transition to half_open)"
    );
    assert_eq!(cb.get_state(), "half_open");
}

#[test]
fn state_transition_half_open_to_closed_on_enough_successes() {
    // threshold=2, window=60s, open_timeout=10ms, half_open_max=2
    let mut cb = CircuitBreaker::new(2, 60_000, 10, 2);

    // Trip to open
    cb.record_failure();
    cb.record_failure();
    assert_eq!(cb.get_state(), "open");

    // Wait and transition to half_open
    thread::sleep(Duration::from_millis(20));
    assert!(cb.allow_request()); // half_open, test_count=1
    assert_eq!(cb.get_state(), "half_open");

    // Record first success
    cb.record_success(); // successes=1, need 2 to close
    assert_eq!(
        cb.get_state(),
        "half_open",
        "One success should stay half_open when max_test=2"
    );

    // Allow another test request
    assert!(cb.allow_request()); // test_count=2

    // Record second success -- should close
    cb.record_success(); // successes=2 >= max_test=2
    assert_eq!(
        cb.get_state(),
        "closed",
        "Enough successes in half_open should close the circuit"
    );
}

#[test]
fn state_transition_half_open_to_open_on_failure() {
    // threshold=2, window=60s, open_timeout=10ms, half_open_max=3
    let mut cb = CircuitBreaker::new(2, 60_000, 10, 3);

    // Trip to open
    cb.record_failure();
    cb.record_failure();
    assert_eq!(cb.get_state(), "open");

    // Transition to half_open
    thread::sleep(Duration::from_millis(20));
    assert!(cb.allow_request());
    assert_eq!(cb.get_state(), "half_open");

    // A failure in half_open should immediately reopen
    cb.record_failure();
    assert_eq!(
        cb.get_state(),
        "open",
        "Failure in half_open should immediately reopen circuit"
    );
}

#[test]
fn full_lifecycle_closed_open_half_open_closed() {
    let mut cb = CircuitBreaker::new(2, 60_000, 10, 1);

    // Phase 1: Closed
    assert_eq!(cb.get_state(), "closed");
    assert!(cb.allow_request());

    // Phase 2: Trip to Open
    cb.record_failure();
    cb.record_failure();
    assert_eq!(cb.get_state(), "open");

    // Phase 3: Open -> Half Open
    thread::sleep(Duration::from_millis(20));
    assert!(cb.allow_request()); // transitions to half_open
    assert_eq!(cb.get_state(), "half_open");

    // Phase 4: Half Open -> Closed
    cb.record_success(); // successes=1 >= max_test=1
    assert_eq!(cb.get_state(), "closed");

    // Phase 5: Verify it's fully operational again
    assert!(cb.allow_request());
    assert_eq!(cb.get_metrics().failure_count, 0);
}

// ═══════════════════════════════════════════════════════════════════════
// allow_request Behavior
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn allow_request_returns_true_in_closed() {
    let mut cb = CircuitBreaker::new(5, 60_000, 30_000, 2);

    // Even with some failures (below threshold), requests should be allowed
    cb.record_failure();
    cb.record_failure();
    assert!(cb.allow_request(), "Closed state should always allow requests");
    assert!(cb.allow_request(), "Multiple requests in closed should all be allowed");
}

#[test]
fn allow_request_returns_false_in_open_before_timeout() {
    let mut cb = CircuitBreaker::new(2, 60_000, 5_000, 2);

    cb.record_failure();
    cb.record_failure();
    assert_eq!(cb.get_state(), "open");

    // Open with 5s timeout -- should block immediately
    assert!(
        !cb.allow_request(),
        "Open state should block requests before timeout"
    );
    assert!(
        !cb.allow_request(),
        "Multiple requests in open should all be blocked"
    );
}

#[test]
fn allow_request_returns_true_in_half_open_up_to_max_test() {
    let mut cb = CircuitBreaker::new(2, 60_000, 10, 3);

    // Trip and transition to half_open
    cb.record_failure();
    cb.record_failure();
    thread::sleep(Duration::from_millis(20));

    // First request transitions to half_open (test_count=1)
    assert!(cb.allow_request());
    assert_eq!(cb.get_state(), "half_open");

    // Second test request (test_count=2)
    assert!(cb.allow_request());

    // Third request: test_count would become 3, but 3 >= max_test=3, so deny
    assert!(
        !cb.allow_request(),
        "Half open should deny requests after max_test probes"
    );
}

// ═══════════════════════════════════════════════════════════════════════
// Failure Counting with Window Pruning
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn failures_within_window_accumulate() {
    let mut cb = CircuitBreaker::new(5, 60_000, 30_000, 2);

    cb.record_failure();
    cb.record_failure();
    cb.record_failure();
    assert_eq!(
        cb.get_metrics().failure_count,
        3,
        "Three failures within window should all be counted"
    );
    assert_eq!(cb.get_state(), "closed");
}

#[test]
fn failures_outside_window_are_pruned() {
    // Window of 50ms, threshold of 3
    let mut cb = CircuitBreaker::new(3, 50, 30_000, 2);

    cb.record_failure();
    cb.record_failure();
    assert_eq!(cb.get_metrics().failure_count, 2);

    // Wait for the window to expire
    thread::sleep(Duration::from_millis(60));

    // New failure should trigger pruning of old failures
    cb.record_failure();
    assert_eq!(
        cb.get_metrics().failure_count,
        1,
        "Old failures outside window should be pruned"
    );
    assert_eq!(
        cb.get_state(),
        "closed",
        "Should NOT trip because pruned count is below threshold"
    );
}

#[test]
fn failures_across_window_boundary_partial_prune() {
    // Window of 100ms, threshold of 4
    let mut cb = CircuitBreaker::new(4, 100, 30_000, 2);

    cb.record_failure(); // t=0ms (approx)
    cb.record_failure(); // t=0ms (approx)

    thread::sleep(Duration::from_millis(60));

    cb.record_failure(); // t=60ms (approx)

    thread::sleep(Duration::from_millis(50));

    // Now ~110ms since first two failures, ~50ms since third
    // First two should be pruned, third should remain
    cb.record_failure(); // t=110ms -- prunes first two, keeps third + this = 2
    assert_eq!(cb.get_state(), "closed", "Should still be closed with only 2 in window");
    assert!(
        cb.get_metrics().failure_count <= 3,
        "Some old failures should have been pruned"
    );
}

#[test]
fn success_in_closed_does_not_prune_failures() {
    let mut cb = CircuitBreaker::new(5, 60_000, 30_000, 2);

    cb.record_failure();
    cb.record_failure();
    cb.record_failure();
    assert_eq!(cb.get_metrics().failure_count, 3);

    // Success in closed should NOT clear failure history
    // (per design rule in circuit.rs comments)
    cb.record_success();
    assert_eq!(
        cb.get_metrics().failure_count,
        3,
        "Success in CLOSED should NOT prune failures (design rule)"
    );
}

// ═══════════════════════════════════════════════════════════════════════
// Concurrent Safety
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn concurrent_record_operations_do_not_panic() {
    // NOTE: CircuitBreaker is NOT Sync (napi struct, single-threaded usage).
    // This test verifies correctness under sequential rapid operations,
    // simulating what concurrent Node.js async tasks would do (which
    // ultimately serialize through the single JS thread).
    let mut cb = CircuitBreaker::new(10, 60_000, 10, 3);

    // Rapid interleaved operations
    for i in 0..100 {
        if i % 3 == 0 {
            cb.record_failure();
        } else {
            cb.record_success();
        }
        let _ = cb.allow_request();
        let _ = cb.get_state();
        let _ = cb.get_metrics();
    }

    // If we got here without panicking, the test passes
    let state = cb.get_state();
    assert!(
        state == "closed" || state == "open" || state == "half_open",
        "Circuit must be in a valid state after rapid operations"
    );
}

// ═══════════════════════════════════════════════════════════════════════
// Metrics Tracking
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn metrics_total_trips_increments_on_each_open() {
    let mut cb = CircuitBreaker::new(2, 60_000, 10, 1);

    // First trip
    cb.record_failure();
    cb.record_failure();
    assert_eq!(cb.get_metrics().total_trips, 1);

    // Recover
    thread::sleep(Duration::from_millis(20));
    cb.allow_request(); // half_open
    cb.record_success(); // close

    // Second trip
    cb.record_failure();
    cb.record_failure();
    assert_eq!(cb.get_metrics().total_trips, 2);

    // Recover again
    thread::sleep(Duration::from_millis(20));
    cb.allow_request();
    cb.record_success();

    // Third trip
    cb.record_failure();
    cb.record_failure();
    assert_eq!(cb.get_metrics().total_trips, 3);
}

#[test]
fn metrics_time_in_state_is_positive() {
    let cb = CircuitBreaker::new(3, 60_000, 30_000, 2);
    let metrics = cb.get_metrics();
    assert!(
        metrics.time_in_state_ms >= 0.0,
        "Time in state should be non-negative"
    );
}

#[test]
fn metrics_failure_count_zero_when_not_in_closed() {
    let mut cb = CircuitBreaker::new(2, 60_000, 30_000, 2);

    cb.record_failure();
    cb.record_failure();
    assert_eq!(cb.get_state(), "open");
    assert_eq!(
        cb.get_metrics().failure_count,
        0,
        "Failure count should be 0 when not in Closed state"
    );
}

// ═══════════════════════════════════════════════════════════════════════
// Reset
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn reset_clears_state_and_allows_requests() {
    let mut cb = CircuitBreaker::new(2, 60_000, 30_000, 2);

    cb.record_failure();
    cb.record_failure();
    assert_eq!(cb.get_state(), "open");
    assert!(!cb.allow_request());

    cb.reset();
    assert_eq!(cb.get_state(), "closed");
    assert_eq!(cb.get_metrics().failure_count, 0);
    assert!(cb.allow_request(), "After reset, requests should be allowed");
}

#[test]
fn reset_preserves_total_trips_count() {
    let mut cb = CircuitBreaker::new(2, 60_000, 30_000, 2);

    cb.record_failure();
    cb.record_failure();
    assert_eq!(cb.get_metrics().total_trips, 1);

    cb.reset();
    // total_trips is NOT cleared by reset -- it's a lifetime counter
    // (the reset only clears the state, not the metrics)
    let trips = cb.get_metrics().total_trips;
    // Note: Looking at the code, reset() does NOT reset total_trips.
    // This is correct behavior -- total_trips is a lifetime metric.
    assert_eq!(trips, 1, "total_trips should persist across reset");
}

// ═══════════════════════════════════════════════════════════════════════
// Edge Cases
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn threshold_of_one_trips_on_first_failure() {
    let mut cb = CircuitBreaker::new(1, 60_000, 30_000, 1);
    assert_eq!(cb.get_state(), "closed");

    cb.record_failure();
    assert_eq!(
        cb.get_state(),
        "open",
        "Threshold of 1 should trip on the very first failure"
    );
}

#[test]
fn half_open_max_of_one_closes_on_first_success() {
    let mut cb = CircuitBreaker::new(2, 60_000, 10, 1);

    cb.record_failure();
    cb.record_failure();
    thread::sleep(Duration::from_millis(20));

    assert!(cb.allow_request()); // half_open, test_count=1
    cb.record_success(); // successes=1 >= max_test=1

    assert_eq!(
        cb.get_state(),
        "closed",
        "half_open_max=1 should close on first success"
    );
}

#[test]
fn multiple_trip_recover_cycles() {
    let mut cb = CircuitBreaker::new(2, 60_000, 10, 1);

    for cycle in 0..5 {
        assert_eq!(cb.get_state(), "closed", "Cycle {} should start closed", cycle);

        // Trip
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.get_state(), "open");

        // Recover
        thread::sleep(Duration::from_millis(20));
        assert!(cb.allow_request());
        cb.record_success();
        assert_eq!(cb.get_state(), "closed");
    }

    assert_eq!(cb.get_metrics().total_trips, 5);
}
