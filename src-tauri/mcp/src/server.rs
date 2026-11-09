//! MCP over stdio (design 022; from AppIconic `ai-mcp`, design 018 E2): JSON-RPC 2.0, one message per line. Only what
//! this server needs: `initialize`, `ping`, `tools/list`, `tools/call`, `prompts/list`, `prompts/get`;
//! notifications are ignored. `help` is answered here, every other tool goes to the app.

use crate::bridge::BridgeError;
use crate::{guide, tools};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

/// Protocol versions this server speaks (newest first).
pub const VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// Whatever runs the tools – the bridge to the app, a fake in tests.
pub trait Tools {
    fn call(&mut self, tool: &str, args: Value) -> Result<Value, BridgeError>;
}

/// Answers one JSON-RPC message; `None` for notifications.
pub fn handle(msg: &Value, tools_impl: &mut dyn Tools) -> Option<Value> {
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let id = msg.get("id").cloned()?; // a notification (no id): nothing to answer
    let result = match method {
        "initialize" => {
            let asked = msg["params"]["protocolVersion"].as_str().unwrap_or("");
            let version = if VERSIONS.contains(&asked) {
                asked
            } else {
                VERSIONS[0]
            };
            Ok(json!({
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": false}, "prompts": {"listChanged": false}},
                "serverInfo": {"name": "log-commander", "title": "Log Commander", "version": env!("CARGO_PKG_VERSION")},
                "instructions": guide::INSTRUCTIONS
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools::list()})),
        "prompts/list" => Ok(guide::prompts_list()),
        "prompts/get" => guide::prompts_get(&msg["params"]).map_err(|m| (-32602, m)),
        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or("");
            if !tools::names().contains(&name) {
                Err((-32602, format!("unknown tool {name}")))
            } else {
                let args = msg["params"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let answer = if tools::LOCAL_TOOLS.contains(&name) {
                    guide::help(&args).map_err(|(code, m)| BridgeError::new(&code, m))
                } else {
                    tools_impl.call(name, args)
                };
                Ok(match answer {
                    Ok(v) => success(v),
                    Err(e) => json!({
                        "content": [{"type": "text", "text": format!("{}: {}", e.code, e.message)}],
                        "isError": true
                    }),
                })
            }
        }
        _ => Err((-32601, format!("method not found: {method}"))),
    };
    Some(match result {
        Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
        Err((code, message)) => {
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
        }
    })
}

/// A tool result as MCP content: the JSON as text (a `text` field of the help as it is) and as structured content.
fn success(v: Value) -> Value {
    let text = match (&v, v.get("text")) {
        (_, Some(Value::String(t))) if v.get("topic").is_some() => t.clone(),
        (Value::String(s), _) => s.clone(),
        _ => serde_json::to_string_pretty(&v).unwrap_or_default(),
    };
    json!({
        "content": [{"type": "text", "text": text}],
        "structuredContent": if v.is_object() { v.clone() } else { json!({ "result": v }) },
        "isError": false
    })
}

/// Reads messages from `input` until it ends, answers on `output`.
pub fn serve(
    input: &mut dyn BufRead,
    output: &mut dyn Write,
    tools_impl: &mut dyn Tools,
) -> std::io::Result<()> {
    let mut line = String::new();
    loop {
        line.clear();
        if input.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let text = line.trim();
        if text.is_empty() {
            continue;
        }
        let answer = match serde_json::from_str::<Value>(text) {
            Ok(Value::Array(batch)) => {
                let out: Vec<Value> = batch.iter().filter_map(|m| handle(m, tools_impl)).collect();
                (!out.is_empty()).then_some(Value::Array(out))
            }
            Ok(msg) => handle(&msg, tools_impl),
            Err(e) => Some(json!({
                "jsonrpc": "2.0", "id": null,
                "error": {"code": -32700, "message": format!("parse error: {e}")}
            })),
        };
        if let Some(a) = answer {
            writeln!(output, "{a}")?;
            output.flush()?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake(Vec<(String, Value)>);

    impl Tools for Fake {
        fn call(&mut self, tool: &str, args: Value) -> Result<Value, BridgeError> {
            self.0.push((tool.into(), args.clone()));
            match tool {
                "get_workspace" => Ok(json!({"tabs": [{"id": 1}], "active": 1})),
                _ => Err(BridgeError::new("stale_view", "the file was truncated")),
            }
        }
    }

    fn run(lines: &[Value]) -> (Vec<Value>, Fake) {
        let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
        let mut out = Vec::new();
        let mut fake = Fake(Vec::new());
        serve(&mut input.as_bytes(), &mut out, &mut fake).unwrap();
        let answers = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        (answers, fake)
    }

    #[test]
    fn a_session_like_claude_code_runs_it() {
        let (a, fake) = run(&[
            json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_workspace","arguments":{}}}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_lines","arguments":{"epoch":1}}}),
            json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"help","arguments":{"topic":"filters"}}}),
            json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"run_shell"}}),
            json!({"jsonrpc":"2.0","id":6,"method":"resources/list"}),
            json!({"jsonrpc":"2.0","id":7,"method":"prompts/list"}),
            json!({"jsonrpc":"2.0","id":8,"method":"prompts/get","params":{"name":"watch_for","arguments":{"pattern":"OutOfMemory"}}}),
            json!({"jsonrpc":"2.0","id":9,"method":"ping"}),
        ]);
        assert_eq!(a.len(), 10, "the notification gets no answer");
        assert_eq!(a[0]["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(a[0]["result"]["serverInfo"]["name"], "log-commander");
        assert!(a[0]["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("get_workspace"));
        assert_eq!(
            a[1]["result"]["tools"].as_array().unwrap().len(),
            tools::names().len()
        );
        assert_eq!(a[2]["result"]["isError"], false);
        assert_eq!(a[2]["result"]["structuredContent"]["active"], 1);
        assert_eq!(a[3]["result"]["isError"], true);
        assert_eq!(
            a[3]["result"]["content"][0]["text"],
            "stale_view: the file was truncated"
        );
        // help is answered by the sidecar itself, as Markdown text
        assert!(a[4]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("# Filters"));
        assert_eq!(a[5]["error"]["code"], -32602);
        assert_eq!(a[6]["error"]["code"], -32601);
        assert!(a[7]["result"]["prompts"].as_array().unwrap().len() >= 5);
        assert!(a[8]["result"]["messages"][0]["content"]["text"]
            .as_str()
            .unwrap()
            .contains("OutOfMemory"));
        assert_eq!(a[9]["result"], json!({}));
        assert_eq!(
            fake.0.len(),
            2,
            "help and unknown tools never reach the app"
        );
        assert_eq!(fake.0[1], ("read_lines".into(), json!({"epoch": 1})));
    }

    #[test]
    fn unknown_versions_get_the_newest_and_bad_json_an_error() {
        let (a, _) = run(&[
            json!({"jsonrpc":"2.0","id":"a","method":"initialize","params":{"protocolVersion":"1999-01-01"}}),
        ]);
        assert_eq!(a[0]["result"]["protocolVersion"], VERSIONS[0]);
        assert_eq!(a[0]["id"], "a");
        let mut out = Vec::new();
        serve(&mut "{nope\n".as_bytes(), &mut out, &mut Fake(vec![])).unwrap();
        assert!(String::from_utf8(out).unwrap().contains("-32700"));
    }

    #[test]
    fn batches_are_answered_as_a_batch() {
        let (a, _) = run(&[json!([
            {"jsonrpc":"2.0","id":1,"method":"ping"},
            {"jsonrpc":"2.0","method":"notifications/initialized"},
            {"jsonrpc":"2.0","id":2,"method":"ping"}
        ])]);
        assert_eq!(a[0].as_array().unwrap().len(), 2);
    }
}
