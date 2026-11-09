//! Connection test of the sidecar (AppIconic prompt 086 E8): starts `log-commander-mcp` like an MCP client
//! does (stdio), runs the handshake – `initialize`, `notifications/initialized`, `tools/list` –
//! and one `get_workspace` that goes over the bridge to the running app. Every step has a time
//! limit; the child is always ended. No Tauri – the app's command only calls [`probe`].

use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;

/// How far the test got.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProbeStep {
    /// Starting the program.
    Start,
    /// `initialize`.
    Initialize,
    /// `tools/list`.
    Tools,
    /// `get_workspace` over the bridge to the app.
    App,
}

/// The result as the settings show it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// Every step worked, the app answered.
    pub ok: bool,
    /// The step that failed, or `App` when everything worked.
    pub step: ProbeStep,
    /// Why the step failed: `not_found`, `io`, `timeout`, `invalid_request` (no MCP answer),
    /// `not_running` (the app is closed or AI control is off) …
    pub code: Option<String>,
    pub server: Option<String>,
    pub version: Option<String>,
    pub protocol: Option<String>,
    pub tools: usize,
    /// The app answered over the bridge.
    pub app: bool,
    pub tabs: Option<usize>,
}

impl Probe {
    fn new() -> Self {
        Self {
            ok: false,
            step: ProbeStep::Start,
            code: None,
            server: None,
            version: None,
            protocol: None,
            tools: 0,
            app: false,
            tabs: None,
        }
    }

    fn fail(mut self, step: ProbeStep, code: &str) -> Self {
        self.step = step;
        self.code = Some(code.to_owned());
        self
    }
}

struct Session {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    timeout: Duration,
}

impl Session {
    fn send(&mut self, msg: &Value) -> Result<(), &'static str> {
        let stdin = self.stdin.as_mut().ok_or("io")?;
        writeln!(stdin, "{msg}").map_err(|_| "io")?;
        stdin.flush().map_err(|_| "io")
    }

    /// The answer to `id` (other lines are skipped), or the error code.
    fn answer(&mut self, id: u64) -> Result<Value, &'static str> {
        loop {
            let line = match self.lines.recv_timeout(self.timeout) {
                Ok(l) => l,
                Err(RecvTimeoutError::Timeout) => return Err("timeout"),
                Err(RecvTimeoutError::Disconnected) => return Err("io"),
            };
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                return Err("invalid_request");
            };
            if v.get("id") == Some(&json!(id)) {
                return if v.get("jsonrpc") == Some(&json!("2.0")) && v.get("result").is_some() {
                    Ok(v["result"].clone())
                } else {
                    Err("invalid_request")
                };
            }
            if v.get("jsonrpc") != Some(&json!("2.0")) {
                return Err("invalid_request");
            }
        }
    }

    fn call(&mut self, id: u64, method: &str, params: Value) -> Result<Value, &'static str> {
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;
        self.answer(id)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stdin = None; // EOF: the server ends by itself
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Runs the test against `program` with `step_timeout` per step.
pub fn probe(program: &Path, step_timeout: Duration) -> Probe {
    let p = Probe::new();
    let mut child = match Command::new(program)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return p.fail(ProbeStep::Start, "not_found");
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return p.fail(ProbeStep::Start, "permission_denied");
        }
        Err(_) => return p.fail(ProbeStep::Start, "io"),
    };
    let stdout = child.stdout.take();
    let stdin = child.stdin.take();
    let (tx, rx) = channel();
    if let Some(out) = stdout {
        thread::spawn(move || {
            for line in BufReader::new(out).lines() {
                let Ok(l) = line else { break };
                if tx.send(l).is_err() {
                    break;
                }
            }
        });
    }
    let mut s = Session {
        child,
        stdin,
        lines: rx,
        timeout: step_timeout,
    };
    run(&mut s, p)
}

fn run(s: &mut Session, mut p: Probe) -> Probe {
    let init = match s.call(
        1,
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "log-commander-setup", "version": env!("CARGO_PKG_VERSION")}
        }),
    ) {
        Ok(v) => v,
        Err(code) => return p.fail(ProbeStep::Initialize, code),
    };
    let Some(protocol) = init["protocolVersion"].as_str() else {
        return p.fail(ProbeStep::Initialize, "invalid_request");
    };
    p.protocol = Some(protocol.to_owned());
    p.server = init["serverInfo"]["name"].as_str().map(str::to_owned);
    p.version = init["serverInfo"]["version"].as_str().map(str::to_owned);
    if s.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        .is_err()
    {
        return p.fail(ProbeStep::Initialize, "io");
    }
    match s.call(2, "tools/list", json!({})) {
        Ok(v) => match v["tools"].as_array() {
            Some(t) => p.tools = t.len(),
            None => return p.fail(ProbeStep::Tools, "invalid_request"),
        },
        Err(code) => return p.fail(ProbeStep::Tools, code),
    }
    let r = match s.call(
        3,
        "tools/call",
        json!({"name": "get_workspace", "arguments": {}}),
    ) {
        Ok(v) => v,
        Err(code) => return p.fail(ProbeStep::App, code),
    };
    if r["isError"] == json!(true) {
        // "<code>: <message>" (server.rs)
        let text = r["content"][0]["text"].as_str().unwrap_or("");
        let code = text.split(':').next().unwrap_or("io").trim();
        let code = if code.is_empty() || code.contains(' ') {
            "io"
        } else {
            code
        };
        return p.fail(ProbeStep::App, code);
    }
    p.app = true;
    p.tabs = r["structuredContent"]["tabs"].as_array().map(Vec::len);
    p.step = ProbeStep::App;
    p.ok = true;
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_program_fails_at_the_start() {
        let p = probe(
            Path::new("/no/such/log-commander-mcp"),
            Duration::from_secs(1),
        );
        assert!(!p.ok);
        assert_eq!(p.step, ProbeStep::Start);
        assert_eq!(p.code.as_deref(), Some("not_found"));
    }

    #[cfg(unix)]
    #[test]
    fn a_program_that_is_no_mcp_server_is_named() {
        // cat echoes the request: a message without result
        let p = probe(Path::new("/bin/cat"), Duration::from_secs(2));
        assert_eq!(p.step, ProbeStep::Initialize);
        assert_eq!(p.code.as_deref(), Some("invalid_request"));
    }

    #[cfg(unix)]
    #[test]
    fn a_silent_program_times_out() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("silent.sh");
        std::fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let t = std::time::Instant::now();
        let mut p = probe(&script, Duration::from_millis(300));
        // a fresh script may be "text file busy" while another test thread forks
        for _ in 0..5 {
            if p.step != ProbeStep::Start {
                break;
            }
            thread::sleep(Duration::from_millis(100));
            p = probe(&script, Duration::from_millis(300));
        }
        assert_eq!(p.step, ProbeStep::Initialize);
        assert_eq!(p.code.as_deref(), Some("timeout"));
        assert!(t.elapsed() < Duration::from_secs(5), "the child is killed");
    }

    #[test]
    fn serialises_camel_case() {
        let p = Probe::new().fail(ProbeStep::Tools, "timeout");
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["step"], "tools");
        assert_eq!(v["code"], "timeout");
        assert_eq!(v["tabs"], Value::Null);
    }
}
