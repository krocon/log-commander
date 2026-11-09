//! AI control over MCP, the app's side (prompt 022, design A3): tool calls of the `log-commander-mcp` sidecar arrive
//! over the bridge ([`lc_mcp::host`]); the [`Router`] checks name, size and concurrency and hands each call to the
//! frontend, which runs it on its tabs (`features/mcp/mcp.service.ts`) and answers with `mcp_reply`. Free of Tauri:
//! the [`Frontend`] of the app is in `commands.rs`, tests use a fake. After AppIconic `src-tauri/src/mcp.rs`.

use lc_mcp::bridge::BridgeError;
use lc_mcp::tools;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

/// Time for an ordinary call (filters and SQL wait up to 30 s in the frontend, design E3).
pub const CALL_TIMEOUT: Duration = Duration::from_secs(45);
/// `wait_for_lines` waits up to `WAIT_SECONDS_MAX`.
/// The frontend first waits up to 30 s for the matches already there, then up to `WAIT_SECONDS_MAX` (review 022 #6).
pub const LONG_TIMEOUT: Duration = Duration::from_secs(30 + tools::WAIT_SECONDS_MAX + 15);
/// A proposal waits up to 5 minutes for the user (design E6).
pub const PROPOSAL_TIMEOUT: Duration = Duration::from_secs(300 + 15);
/// Long polls at a time (design E4).
pub const MAX_LONG_CALLS: usize = 2;

pub type CallResult = Result<Value, BridgeError>;

pub fn err(code: &str, message: impl Into<String>) -> BridgeError {
    BridgeError::new(code, message)
}

/// What the router needs from the app.
pub trait Frontend: Send + Sync + 'static {
    /// Hands call `id` to the frontend; `false` if no frontend listens.
    fn send(&self, id: u64, tool: &str, args: &Value) -> bool;
}

/// Calls waiting for the frontend's answer.
#[derive(Default)]
pub struct Calls {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, Sender<CallResult>>>,
}

impl Calls {
    pub fn begin(&self) -> (u64, Receiver<CallResult>) {
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, tx);
        (id, rx)
    }

    /// The frontend's answer; `false` for an unknown call (timed out). Answers over the limit become an error.
    pub fn complete(&self, id: u64, result: CallResult) -> bool {
        let Some(tx) = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id)
        else {
            return false;
        };
        let result = result.and_then(|v| {
            let n = serde_json::to_string(&v).map_or(0, |s| s.len());
            if n > tools::ANSWER_BYTES_MAX {
                Err(err(
                    "limit_exceeded",
                    format!(
                        "the answer has {n} bytes, limit {} – ask for fewer lines or characters",
                        tools::ANSWER_BYTES_MAX
                    ),
                ))
            } else {
                Ok(v)
            }
        });
        tx.send(result).is_ok()
    }

    pub fn cancel(&self, id: u64) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    }

    /// Every open call fails (the frontend went away, AI control was turned off).
    pub fn fail_all(&self, code: &str, message: &str) {
        for (_, tx) in self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
        {
            let _ = tx.send(Err(err(code, message)));
        }
    }

    pub fn wait(&self, id: u64, rx: &Receiver<CallResult>, timeout: Duration) -> CallResult {
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(_) => {
                self.cancel(id);
                Err(err(
                    "timeout",
                    format!(
                        "Log Commander did not answer within {} s",
                        timeout.as_secs()
                    ),
                ))
            }
        }
    }
}

/// Checks a call and runs it in the frontend.
pub struct Router<F: Frontend> {
    pub frontend: F,
    pub calls: std::sync::Arc<Calls>,
    long: AtomicUsize,
}

impl<F: Frontend> Router<F> {
    pub fn new(frontend: F, calls: std::sync::Arc<Calls>) -> Self {
        Self {
            frontend,
            calls,
            long: AtomicUsize::new(0),
        }
    }

    pub fn call(&self, tool: &str, args: &Value) -> CallResult {
        // Only the tools of the list reach the frontend; `help` is the sidecar's own (design A4).
        if !tools::names().contains(&tool) || tools::LOCAL_TOOLS.contains(&tool) {
            return Err(err("unknown_tool", format!("unknown tool {tool}")));
        }
        let args = match args {
            Value::Null => Value::Object(Default::default()),
            Value::Object(_) => args.clone(),
            _ => return Err(err("invalid_args", "the arguments must be an object")),
        };
        let size = serde_json::to_string(&args).map_or(0, |s| s.len());
        if size > tools::ARGS_BYTES_MAX {
            return Err(err(
                "limit_exceeded",
                format!(
                    "the arguments have {size} bytes, limit {}",
                    tools::ARGS_BYTES_MAX
                ),
            ));
        }
        let long = tools::LONG_TOOLS.contains(&tool);
        if long && self.long.fetch_add(1, Ordering::SeqCst) >= MAX_LONG_CALLS {
            self.long.fetch_sub(1, Ordering::SeqCst);
            return Err(err(
                "limit_exceeded",
                format!("at most {MAX_LONG_CALLS} waits at a time"),
            ));
        }
        let timeout = if long {
            LONG_TIMEOUT
        } else if tools::is_proposal(tool) {
            PROPOSAL_TIMEOUT
        } else {
            CALL_TIMEOUT
        };
        let (id, rx) = self.calls.begin();
        let result = if self.frontend.send(id, tool, &args) {
            self.calls.wait(id, &rx, timeout)
        } else {
            self.calls.cancel(id);
            Err(err(
                "not_running",
                "the window of Log Commander is not ready – try again in a moment",
            ))
        };
        if long {
            self.long.fetch_sub(1, Ordering::SeqCst);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    /// Answers every call at once from another thread, like the window does.
    struct Echo {
        calls: Arc<Calls>,
        sent: Mutex<Vec<(String, Value)>>,
        listening: bool,
        delay: Duration,
    }

    impl Frontend for Echo {
        fn send(&self, id: u64, tool: &str, args: &Value) -> bool {
            if !self.listening {
                return false;
            }
            self.sent
                .lock()
                .unwrap()
                .push((tool.to_owned(), args.clone()));
            let calls = self.calls.clone();
            let tool = tool.to_owned();
            let delay = self.delay;
            std::thread::spawn(move || {
                std::thread::sleep(delay);
                let answer = match tool.as_str() {
                    "get_workspace" => Ok(json!({"tabs": []})),
                    "read_lines" => Ok(json!({"text": "x".repeat(tools::ANSWER_BYTES_MAX + 1)})),
                    _ => Err(err("tab_not_found", "no tab 9")),
                };
                calls.complete(id, answer);
            });
            true
        }
    }

    fn router(listening: bool, delay: Duration) -> Arc<Router<Echo>> {
        let calls = Arc::new(Calls::default());
        Arc::new(Router::new(
            Echo {
                calls: calls.clone(),
                sent: Mutex::new(Vec::new()),
                listening,
                delay,
            },
            calls,
        ))
    }

    #[test]
    fn calls_go_to_the_frontend_and_back() {
        let r = router(true, Duration::ZERO);
        assert_eq!(
            r.call("get_workspace", &Value::Null).unwrap(),
            json!({"tabs": []})
        );
        assert_eq!(
            r.call("get_tab", &json!({"tab_id": 9})).unwrap_err().code,
            "tab_not_found"
        );
        let sent = r.frontend.sent.lock().unwrap();
        assert_eq!(sent[0], ("get_workspace".into(), json!({})));
    }

    #[test]
    fn only_listed_tools_and_object_arguments_pass() {
        let r = router(true, Duration::ZERO);
        for tool in ["run_shell", "open_source", "help", "set_settings"] {
            assert_eq!(r.call(tool, &json!({})).unwrap_err().code, "unknown_tool");
        }
        assert_eq!(
            r.call("get_tab", &json!([1])).unwrap_err().code,
            "invalid_args"
        );
        let huge = json!({"sql": "x".repeat(tools::ARGS_BYTES_MAX)});
        assert_eq!(r.call("run_sql", &huge).unwrap_err().code, "limit_exceeded");
        assert!(r.frontend.sent.lock().unwrap().is_empty());
    }

    #[test]
    fn a_too_large_answer_is_an_error_and_no_frontend_is_not_running() {
        let r = router(true, Duration::ZERO);
        assert_eq!(
            r.call("read_lines", &json!({})).unwrap_err().code,
            "limit_exceeded"
        );
        let r = router(false, Duration::ZERO);
        assert_eq!(
            r.call("get_workspace", &json!({})).unwrap_err().code,
            "not_running"
        );
    }

    #[test]
    fn at_most_two_waits_at_a_time() {
        let r = router(true, Duration::from_millis(300));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let r = r.clone();
                std::thread::spawn(move || r.call("wait_for_lines", &json!({})))
            })
            .collect();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            r.call("wait_for_lines", &json!({})).unwrap_err().code,
            "limit_exceeded"
        );
        for h in handles {
            let _ = h.join();
        }
        // free again
        assert_eq!(
            r.call("wait_for_lines", &json!({})).unwrap_err().code,
            "tab_not_found"
        );
    }

    #[test]
    fn late_answers_are_dropped_and_turning_off_fails_open_calls() {
        let calls = Calls::default();
        let (id, rx) = calls.begin();
        assert!(calls.wait(id, &rx, Duration::from_millis(10)).is_err());
        assert!(!calls.complete(id, Ok(json!(1))), "timed out: forgotten");
        let (id, rx) = calls.begin();
        calls.fail_all("not_running", "off");
        assert_eq!(
            calls
                .wait(id, &rx, Duration::from_secs(1))
                .unwrap_err()
                .code,
            "not_running"
        );
    }
}
