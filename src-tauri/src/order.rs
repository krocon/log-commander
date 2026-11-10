//! Order of the commands that change a session (prompt 023).
//!
//! Tauri runs every `async` command as a task of its own, so two calls sent one after the other
//! may run in either order. Two things follow from that:
//!
//! - **Last one wins:** the caller numbers its calls (`seq`, rising per webview). A call that
//!   arrives after a newer one of the same kind is refused as `superseded` and changes nothing;
//!   the frontend ignores that answer.
//! - **One change at a time:** the lock around an [`Order`] is held while a command compiles and
//!   writes, so it never builds on a state another command replaces in between.
//!
//! The tail worker and the background jobs never take that lock.

use crate::error::{AppError, AppResult, ErrorCode};
use std::collections::HashMap;

/// The highest sequence number seen per kind of call.
#[derive(Debug, Default)]
pub struct Order {
    seen: HashMap<String, u64>,
}

impl Order {
    /// Lets a call of kind `key` pass unless a newer one came first. `None` (tests, callers
    /// without numbers) always passes and says nothing about later calls.
    pub fn admit(&mut self, key: &str, seq: Option<u64>) -> AppResult<()> {
        let Some(seq) = seq else { return Ok(()) };
        match self.seen.get_mut(key) {
            Some(newest) if seq < *newest => Err(AppError::new(
                ErrorCode::Superseded,
                format!("a newer call of {key} came first"),
            )),
            Some(newest) => {
                *newest = seq;
                Ok(())
            }
            None => {
                self.seen.insert(key.to_string(), seq);
                Ok(())
            }
        }
    }

    /// Forgets a kind (a closed view): its id is not used again, the entry would only stay.
    pub fn forget(&mut self, key: &str) {
        self.seen.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_older_call_after_a_newer_one_is_refused() {
        let mut order = Order::default();
        order.admit("frozen", Some(7)).unwrap();
        let error = order.admit("frozen", Some(6)).unwrap_err();
        assert_eq!(error.code, ErrorCode::Superseded);
        // The refused call changes nothing: the next newer one still passes.
        order.admit("frozen", Some(8)).unwrap();
    }

    #[test]
    fn kinds_do_not_know_each_other_and_calls_without_a_number_pass() {
        let mut order = Order::default();
        order.admit("filter:1", Some(9)).unwrap();
        order.admit("filter:2", Some(3)).unwrap();
        order.admit("filter:1", None).unwrap();
        assert!(order.admit("filter:1", Some(8)).is_err());
        order.forget("filter:1");
        order.admit("filter:1", Some(1)).unwrap();
    }
}
