// ═══════════════════════════════════════════════════════════════════════
// Circuit Breaker — Rust enum-based state machine
// ═══════════════════════════════════════════════════════════════════════
//
// Three states modeled as a Rust enum so the compiler enforces exhaustive
// matching. Impossible to forget a state transition.
//
// Key design rule: prune old failures ONLY on state transitions (CLOSED->OPEN,
// OPEN->HALF_OPEN), NOT on every recordSuccess in CLOSED state.
// ═══════════════════════════════════════════════════════════════════════

use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Internal circuit state — Rust enum guarantees exhaustive match.
enum CircuitState {
    Closed {
        /// Timestamps of recent failures within the rolling window
        failures: Vec<Instant>,
        /// Rolling window duration
        window: Duration,
    },
    Open {
        /// When the circuit was opened
        opened_at: Instant,
        /// How long to wait before probing (transitioning to HalfOpen)
        timeout: Duration,
    },
    HalfOpen {
        /// Number of consecutive successes observed in half-open
        successes: u32,
        /// Number of test requests allowed through so far
        test_count: u32,
        /// Max test requests before deciding to close
        max_test: u32,
    },
}

/// Metrics snapshot returned by get_metrics()
#[napi(object)]
pub struct CircuitBreakerMetrics {
    /// Current number of failures tracked (only meaningful in Closed state)
    pub failure_count: u32,
    /// Current state as a string: "closed", "open", "half_open"
    pub state: String,
    /// Milliseconds spent in the current state
    pub time_in_state_ms: f64,
    /// Total number of times the circuit has tripped open
    pub total_trips: u32,
}

/// Circuit breaker for protecting against cascading failures.
///
/// Tracks failure rates within a rolling window. When failures exceed
/// the threshold, the circuit "opens" and rejects all requests for a
/// cooldown period. After the cooldown, it enters "half-open" state
/// and allows a limited number of test requests through to probe
/// whether the downstream service has recovered.
#[napi]
pub struct CircuitBreaker {
    state: CircuitState,
    /// Failure count threshold to trip the circuit
    failure_threshold: u32,
    /// Rolling window for failure tracking (ms, stored as Duration)
    window_ms: u64,
    /// Cooldown timeout when open (ms, stored as Duration)
    open_timeout_ms: u64,
    /// Max test requests in half-open before closing
    half_open_max: u32,
    /// When the current state was entered
    state_entered_at: Instant,
    /// Total number of times the circuit has tripped
    total_trips: u32,
}

#[napi]
impl CircuitBreaker {
    /// Create a new circuit breaker.
    ///
    /// - `failure_threshold`: Number of failures in the window to trip the circuit.
    /// - `window_ms`: Rolling window duration in milliseconds.
    /// - `open_timeout_ms`: How long to stay open before probing (half-open).
    /// - `half_open_max`: Number of successful test requests needed to close.
    #[napi(constructor)]
    pub fn new(
        failure_threshold: u32,
        window_ms: u32,
        open_timeout_ms: u32,
        half_open_max: u32,
    ) -> Self {
        let now = Instant::now();
        CircuitBreaker {
            state: CircuitState::Closed {
                failures: Vec::new(),
                window: Duration::from_millis(window_ms as u64),
            },
            failure_threshold,
            window_ms: window_ms as u64,
            open_timeout_ms: open_timeout_ms as u64,
            half_open_max,
            state_entered_at: now,
            total_trips: 0,
        }
    }

    /// Check if a request is allowed through the circuit.
    ///
    /// - CLOSED: always allows.
    /// - OPEN: blocks until cooldown expires, then transitions to HALF_OPEN
    ///   and allows the first test request.
    /// - HALF_OPEN: allows up to `half_open_max` test requests.
    #[napi]
    pub fn allow_request(&mut self) -> bool {
        // Determine action without holding a borrow on self.state.
        // We read the needed values first, then mutate.
        enum Action {
            Allow,
            Deny,
            TransitionToHalfOpen,
            IncrementTestCount,
        }

        let action = match &self.state {
            CircuitState::Closed { .. } => Action::Allow,

            CircuitState::Open { opened_at, timeout } => {
                if opened_at.elapsed() >= *timeout {
                    Action::TransitionToHalfOpen
                } else {
                    Action::Deny
                }
            }

            CircuitState::HalfOpen {
                test_count,
                max_test,
                ..
            } => {
                if *test_count < *max_test {
                    Action::IncrementTestCount
                } else {
                    Action::Deny
                }
            }
        };

        match action {
            Action::Allow => true,
            Action::Deny => false,
            Action::TransitionToHalfOpen => {
                self.state = CircuitState::HalfOpen {
                    successes: 0,
                    test_count: 1, // This request counts as the first test
                    max_test: self.half_open_max,
                };
                self.state_entered_at = Instant::now();
                true
            }
            Action::IncrementTestCount => {
                if let CircuitState::HalfOpen {
                    ref mut test_count, ..
                } = self.state
                {
                    *test_count += 1;
                }
                true
            }
        }
    }

    /// Record a successful request.
    ///
    /// - CLOSED: no-op (no pruning in CLOSED state per design rule).
    /// - HALF_OPEN: increment success count; transition to CLOSED when
    ///   enough successes have been observed.
    /// - OPEN: no-op (shouldn't happen — requests are blocked in OPEN).
    #[napi]
    pub fn record_success(&mut self) {
        // Determine action without holding a borrow on self.state.
        enum SuccessAction {
            Noop,
            CloseCircuit,
            IncrementSuccesses(u32),
        }

        let action = match &self.state {
            CircuitState::Closed { .. } => {
                // Design rule: do NOT prune failures on success in CLOSED state.
                SuccessAction::Noop
            }

            CircuitState::HalfOpen {
                successes,
                max_test,
                ..
            } => {
                let new_successes = successes + 1;
                if new_successes >= *max_test {
                    SuccessAction::CloseCircuit
                } else {
                    SuccessAction::IncrementSuccesses(new_successes)
                }
            }

            CircuitState::Open { .. } => {
                // Shouldn't happen — requests are blocked in OPEN.
                SuccessAction::Noop
            }
        };

        match action {
            SuccessAction::Noop => {}
            SuccessAction::CloseCircuit => {
                self.state = CircuitState::Closed {
                    failures: Vec::new(),
                    window: Duration::from_millis(self.window_ms),
                };
                self.state_entered_at = Instant::now();
            }
            SuccessAction::IncrementSuccesses(new_val) => {
                if let CircuitState::HalfOpen {
                    ref mut successes, ..
                } = self.state
                {
                    *successes = new_val;
                }
            }
        }
    }

    /// Record a failed request.
    ///
    /// - CLOSED: add failure timestamp, prune old ones outside the window,
    ///   and trip to OPEN if threshold is reached.
    /// - HALF_OPEN: immediately transition back to OPEN.
    /// - OPEN: no-op (shouldn't happen — requests are blocked in OPEN).
    #[napi]
    pub fn record_failure(&mut self) {
        // Determine action without holding a borrow on self.state.
        enum FailAction {
            Noop,
            AddFailureAndMaybeTrip,
            ReopenFromHalfOpen,
        }

        let action = match &self.state {
            CircuitState::Closed { .. } => FailAction::AddFailureAndMaybeTrip,
            CircuitState::HalfOpen { .. } => FailAction::ReopenFromHalfOpen,
            CircuitState::Open { .. } => FailAction::Noop,
        };

        match action {
            FailAction::Noop => {}

            FailAction::AddFailureAndMaybeTrip => {
                // We know state is Closed; get mutable access to failures
                if let CircuitState::Closed {
                    ref mut failures,
                    window,
                } = self.state
                {
                    let now = Instant::now();
                    failures.push(now);

                    // Prune failures outside the rolling window
                    let cutoff = now - *window;
                    failures.retain(|t| *t >= cutoff);

                    if failures.len() as u32 >= self.failure_threshold {
                        // Need to trip — but we can't assign self.state here
                        // because `failures` is still borrowed. Instead, we
                        // check the condition and break out to do the assignment.
                    } else {
                        return;
                    }
                }
                // If we reach here, the threshold was exceeded. Trip the circuit.
                self.state = CircuitState::Open {
                    opened_at: Instant::now(),
                    timeout: Duration::from_millis(self.open_timeout_ms),
                };
                self.state_entered_at = Instant::now();
                self.total_trips += 1;
            }

            FailAction::ReopenFromHalfOpen => {
                self.state = CircuitState::Open {
                    opened_at: Instant::now(),
                    timeout: Duration::from_millis(self.open_timeout_ms),
                };
                self.state_entered_at = Instant::now();
                self.total_trips += 1;
            }
        }
    }

    /// Get the current state as a string.
    ///
    /// Returns one of: "closed", "open", "half_open".
    #[napi]
    pub fn get_state(&self) -> String {
        match &self.state {
            CircuitState::Closed { .. } => "closed".to_string(),
            CircuitState::Open { .. } => "open".to_string(),
            CircuitState::HalfOpen { .. } => "half_open".to_string(),
        }
    }

    /// Get metrics snapshot for monitoring/health endpoints.
    #[napi]
    pub fn get_metrics(&self) -> CircuitBreakerMetrics {
        let failure_count = match &self.state {
            CircuitState::Closed { failures, .. } => failures.len() as u32,
            _ => 0,
        };

        CircuitBreakerMetrics {
            failure_count,
            state: self.get_state(),
            time_in_state_ms: self.state_entered_at.elapsed().as_secs_f64() * 1000.0,
            total_trips: self.total_trips,
        }
    }

    /// Manually reset the circuit to CLOSED state.
    /// Useful after credential rotation or manual intervention.
    #[napi]
    pub fn reset(&mut self) {
        self.state = CircuitState::Closed {
            failures: Vec::new(),
            window: Duration::from_millis(self.window_ms),
        };
        self.state_entered_at = Instant::now();
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Pure Rust unit tests (cargo test)
// ═══════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn test_new_circuit_is_closed() {
        let cb = CircuitBreaker::new(3, 60_000, 30_000, 2);
        assert_eq!(cb.get_state(), "closed");
    }

    #[test]
    fn test_closed_allows_requests() {
        let mut cb = CircuitBreaker::new(3, 60_000, 30_000, 2);
        assert!(cb.allow_request());
        assert!(cb.allow_request());
        assert!(cb.allow_request());
    }

    #[test]
    fn test_trips_after_threshold_failures() {
        let mut cb = CircuitBreaker::new(3, 60_000, 30_000, 2);
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.get_state(), "closed");
        cb.record_failure();
        assert_eq!(cb.get_state(), "open");
    }

    #[test]
    fn test_open_blocks_requests() {
        let mut cb = CircuitBreaker::new(2, 60_000, 30_000, 2);
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.get_state(), "open");
        assert!(!cb.allow_request());
        assert!(!cb.allow_request());
    }

    #[test]
    fn test_open_to_half_open_after_timeout() {
        // Use very short timeout for testing
        let mut cb = CircuitBreaker::new(2, 60_000, 10, 2);
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.get_state(), "open");

        // Wait for timeout
        thread::sleep(Duration::from_millis(20));

        assert!(cb.allow_request());
        assert_eq!(cb.get_state(), "half_open");
    }

    #[test]
    fn test_half_open_closes_on_enough_successes() {
        let mut cb = CircuitBreaker::new(2, 60_000, 10, 2);
        cb.record_failure();
        cb.record_failure();

        thread::sleep(Duration::from_millis(20));
        assert!(cb.allow_request()); // transitions to half_open, test_count=1

        cb.record_success(); // successes=1
        assert_eq!(cb.get_state(), "half_open");

        // Need to allow another request for the second test
        assert!(cb.allow_request()); // test_count=2
        cb.record_success(); // successes=2 >= max_test=2 -> close
        assert_eq!(cb.get_state(), "closed");
    }

    #[test]
    fn test_half_open_reopens_on_failure() {
        let mut cb = CircuitBreaker::new(2, 60_000, 10, 2);
        cb.record_failure();
        cb.record_failure();

        thread::sleep(Duration::from_millis(20));
        assert!(cb.allow_request()); // half_open

        cb.record_failure(); // probe failed -> back to open
        assert_eq!(cb.get_state(), "open");
    }

    #[test]
    fn test_success_in_closed_is_noop() {
        let mut cb = CircuitBreaker::new(3, 60_000, 30_000, 2);
        cb.record_failure();
        cb.record_failure();
        let metrics_before = cb.get_metrics();
        assert_eq!(metrics_before.failure_count, 2);

        // Success should NOT prune failures in CLOSED state
        cb.record_success();
        let metrics_after = cb.get_metrics();
        assert_eq!(metrics_after.failure_count, 2);
        assert_eq!(cb.get_state(), "closed");
    }

    #[test]
    fn test_old_failures_pruned_on_record_failure() {
        // Window of 50ms
        let mut cb = CircuitBreaker::new(3, 50, 30_000, 2);
        cb.record_failure();
        cb.record_failure();

        // Wait for the window to expire
        thread::sleep(Duration::from_millis(60));

        // This failure should prune the old ones and NOT trip
        cb.record_failure();
        assert_eq!(cb.get_state(), "closed");
        assert_eq!(cb.get_metrics().failure_count, 1);
    }

    #[test]
    fn test_metrics_tracks_total_trips() {
        let mut cb = CircuitBreaker::new(2, 60_000, 10, 1);
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.get_metrics().total_trips, 1);

        // Let it recover
        thread::sleep(Duration::from_millis(20));
        cb.allow_request();
        cb.record_success();
        assert_eq!(cb.get_state(), "closed");

        // Trip again
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.get_metrics().total_trips, 2);
    }

    #[test]
    fn test_reset_clears_everything() {
        let mut cb = CircuitBreaker::new(2, 60_000, 30_000, 2);
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.get_state(), "open");

        cb.reset();
        assert_eq!(cb.get_state(), "closed");
        assert_eq!(cb.get_metrics().failure_count, 0);
        assert!(cb.allow_request());
    }

    #[test]
    fn test_half_open_limits_test_requests() {
        let mut cb = CircuitBreaker::new(2, 60_000, 10, 3);
        cb.record_failure();
        cb.record_failure();

        thread::sleep(Duration::from_millis(20));

        // First allow transitions to half_open (test_count=1)
        assert!(cb.allow_request());
        assert_eq!(cb.get_state(), "half_open");

        // Second test request (test_count=2)
        assert!(cb.allow_request());

        // Third test request (test_count=3 == max_test)
        // At this point test_count is NOT < max_test, so should be rejected
        assert!(!cb.allow_request());
    }
}
