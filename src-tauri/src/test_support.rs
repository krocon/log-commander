//! Waiting in tests. One file for all of them: unit tests of this crate get it as a module,
//! integration tests and `lc-mcp` include it with `#[path = "…/src/test_support.rs"]`.
//!
//! Rules (see `CLAUDE.md`, "Arbeitsweise"):
//! - Never sleep and then assume what another thread has done. Wait for the state itself.
//! - The condition must be false before the action whose effect it shows. Otherwise the wait
//!   passes on the old state and the assertion after it reads too early.
//! - The time limit only catches a hang. It is generous on purpose and proves nothing about speed.
#![allow(dead_code)]

use std::time::{Duration, Instant};

/// Pause between two looks at the condition.
const POLL: Duration = Duration::from_millis(5);

/// How long a wait may take before the test fails: 60 s, or `LC_TEST_TIMEOUT` in seconds.
pub fn timeout() -> Duration {
    let seconds = std::env::var("LC_TEST_TIMEOUT")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|seconds| *seconds > 0)
        .unwrap_or(60);
    Duration::from_secs(seconds)
}

/// Waits until `done` holds, panics with `what` after [`timeout`].
#[track_caller]
pub fn wait_until(what: &str, done: impl FnMut() -> bool) {
    wait_until_or(what, String::new, done);
}

/// Like [`wait_until`]; `state` describes what the test saw last, for the message.
#[track_caller]
pub fn wait_until_or(what: &str, state: impl Fn() -> String, mut done: impl FnMut() -> bool) {
    let limit = timeout();
    if !holds_within(limit, &mut done) {
        let state = state();
        let separator = if state.is_empty() { "" } else { ": " };
        panic!(
            "timeout after {} s waiting for {what}{separator}{state}",
            limit.as_secs()
        );
    }
}

/// Whether `done` holds within `limit`. For the rare test that goes on either way.
pub fn holds_within(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    loop {
        if done() {
            return true;
        }
        if start.elapsed() >= limit {
            return false;
        }
        std::thread::sleep(POLL);
    }
}

/// Whether `broken` stays false for `span`. A check that something does *not* happen cannot be
/// waited for; call this only after the positive signal (for example "the bytes are pending")
/// has been waited for, so that the span is not what the test relies on.
pub fn stays_false(span: Duration, mut broken: impl FnMut() -> bool) -> bool {
    !holds_within(span, &mut broken)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn a_condition_that_holds_returns_at_once() {
        let looks = AtomicU32::new(0);
        wait_until("nothing", || looks.fetch_add(1, Ordering::Relaxed) == 0);
        assert_eq!(looks.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn a_condition_is_looked_at_until_it_holds() {
        let looks = AtomicU32::new(0);
        wait_until("the third look", || {
            looks.fetch_add(1, Ordering::Relaxed) == 2
        });
        assert_eq!(looks.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn the_limit_ends_a_wait_and_is_checked_after_a_last_look() {
        assert!(!holds_within(Duration::from_millis(20), || false));
        assert!(holds_within(Duration::ZERO, || true));
        assert!(stays_false(Duration::from_millis(20), || false));
        assert!(!stays_false(Duration::from_millis(20), || true));
    }
}
