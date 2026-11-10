//! The sidecar's end of the bridge (AppIconic design 018 E1; from editlicious `ed-mcp`, design 016 E4): connects lazily, sends the token, forwards
//! tool calls; when the app is gone it says so clearly.

use crate::bridge::{
    self, BridgeError, Endpoint, Hello, HelloAnswer, Request, Response, MAX_LINE_BYTES,
};
use crate::server::Tools;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

/// Text when the app cannot be reached.
pub const NOT_RUNNING: &str = "Log Commander is not running, or AI control is off – start Log Commander and turn on Settings → AI control (MCP)";

pub struct BridgeClient {
    endpoint_file: Option<PathBuf>,
    conn: Option<(BufReader<TcpStream>, TcpStream)>,
    next_id: u64,
}

impl BridgeClient {
    pub fn new(endpoint_file: Option<PathBuf>) -> Self {
        Self {
            endpoint_file,
            conn: None,
            next_id: 1,
        }
    }

    fn connect(&mut self) -> Result<(), BridgeError> {
        let not_running = || BridgeError::new("not_running", NOT_RUNNING);
        let file = self.endpoint_file.clone().ok_or_else(not_running)?;
        let ep: Endpoint = bridge::read_endpoint(&file).map_err(|_| not_running())?;
        let addr = SocketAddr::from(([127, 0, 0, 1], ep.port));
        let stream =
            TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|_| not_running())?;
        let _ = stream.set_nodelay(true);
        let mut writer = stream.try_clone().map_err(|_| not_running())?;
        let mut reader = BufReader::new(stream);
        let hello = serde_json::to_string(&Hello { token: ep.token }).unwrap_or_default();
        writeln!(writer, "{hello}").map_err(|_| not_running())?;
        let mut line = String::new();
        reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_secs(5)))
            .ok();
        reader.read_line(&mut line).map_err(|_| not_running())?;
        let answer = serde_json::from_str::<HelloAnswer>(&line).ok();
        if !answer.as_ref().is_some_and(|a| a.ok) {
            if let Some(reason) = answer.and_then(|a| a.reason) {
                return Err(BridgeError::new("limit_exceeded", reason));
            }
            return Err(BridgeError::new(
                "not_running",
                "Log Commander refused the connection (token changed?) – restart the MCP client",
            ));
        }
        // tool calls may wait long (an export the user is asked about)
        reader.get_mut().set_read_timeout(None).ok();
        self.conn = Some((reader, writer));
        Ok(())
    }

    fn send(&mut self, tool: &str, args: &Value) -> Result<Value, BridgeError> {
        let id = self.next_id;
        self.next_id += 1;
        let req = serde_json::to_string(&Request {
            id,
            tool: tool.into(),
            args: args.clone(),
        })
        .unwrap_or_default();
        let lost = || BridgeError::new("not_running", NOT_RUNNING);
        let (reader, writer) = self.conn.as_mut().ok_or_else(lost)?;
        writeln!(writer, "{req}").map_err(|_| lost())?;
        let mut line = String::new();
        let n = reader
            .by_ref()
            .take(MAX_LINE_BYTES as u64)
            .read_line(&mut line)
            .map_err(|_| lost())?;
        if n == 0 {
            return Err(lost());
        }
        let resp: Response = serde_json::from_str(&line)
            .map_err(|e| BridgeError::new("io", format!("bad answer from Log Commander: {e}")))?;
        match (resp.result, resp.error) {
            (_, Some(e)) => Err(e),
            (Some(v), None) => Ok(v),
            (None, None) => Ok(Value::Null),
        }
    }
}

impl Tools for BridgeClient {
    fn call(&mut self, tool: &str, args: Value) -> Result<Value, BridgeError> {
        if self.conn.is_none() {
            self.connect()?;
        }
        match self.send(tool, &args) {
            Err(e) if e.code == "not_running" => {
                // the app restarted: one more try with a fresh connection
                self.conn = None;
                self.connect()?;
                self.send(tool, &args)
            }
            r => r,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::{new_token, write_endpoint};
    use serde_json::json;
    use std::net::TcpListener;

    /// A bridge server that answers every request with its tool name.
    fn server(token: String) -> (u16, std::thread::JoinHandle<()>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            for stream in l.incoming().take(2) {
                let stream = stream.unwrap();
                let mut w = stream.try_clone().unwrap();
                let mut r = BufReader::new(stream);
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                let hello: Hello = serde_json::from_str(&line).unwrap();
                let ok = bridge::same_token(&hello.token, &token);
                writeln!(
                    w,
                    "{}",
                    serde_json::to_string(&HelloAnswer { ok, reason: None }).unwrap()
                )
                .unwrap();
                if !ok {
                    continue;
                }
                line.clear();
                while r.read_line(&mut line).unwrap() > 0 {
                    let req: Request = serde_json::from_str(&line).unwrap();
                    let resp = Response {
                        id: req.id,
                        result: Some(json!({ "tool": req.tool })),
                        error: None,
                    };
                    writeln!(w, "{}", serde_json::to_string(&resp).unwrap()).unwrap();
                    line.clear();
                }
            }
        });
        (port, h)
    }

    #[test]
    fn calls_go_over_the_bridge_with_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let token = new_token();
        let (port, _h) = server(token.clone());
        let file = dir.path().join("mcp.json");
        write_endpoint(
            &file,
            &Endpoint {
                port,
                token,
                pid: 0,
            },
        )
        .unwrap();
        let mut c = BridgeClient::new(Some(file));
        assert_eq!(
            c.call("get_tree", json!({})).unwrap(),
            json!({"tool": "get_tree"})
        );
        assert_eq!(
            c.call("select", json!({})).unwrap(),
            json!({"tool": "select"})
        );
    }

    #[test]
    fn a_wrong_token_or_no_app_is_a_clear_error() {
        let dir = tempfile::tempdir().unwrap();
        let (port, _h) = server(new_token());
        let file = dir.path().join("mcp.json");
        write_endpoint(
            &file,
            &Endpoint {
                port,
                token: new_token(),
                pid: 0,
            },
        )
        .unwrap();
        let e = BridgeClient::new(Some(file))
            .call("x", json!({}))
            .unwrap_err();
        assert!(e.message.contains("refused"));
        let e = BridgeClient::new(Some(dir.path().join("missing.json")))
            .call("x", json!({}))
            .unwrap_err();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("not_running", NOT_RUNNING)
        );
    }
}
