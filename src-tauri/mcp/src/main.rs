//! `log-commander-mcp` – MCP server (stdio) for the running Log Commander (design 022).
//!
//! Claude Code: `claude mcp add log-commander -- /path/to/log-commander-mcp`
//! The app must run with Settings → AI control (MCP) on. Logs nothing of the logs.

use lc_mcp::bridge;
use lc_mcp::client::BridgeClient;
use lc_mcp::server;
use std::io::{stdin, stdout, BufReader};

fn main() {
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("log-commander-mcp {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let mut tools = BridgeClient::new(bridge::endpoint_path());
    let mut input = BufReader::new(stdin().lock());
    let mut output = stdout().lock();
    if let Err(e) = server::serve(&mut input, &mut output, &mut tools) {
        eprintln!("log-commander-mcp: {e}");
        std::process::exit(1);
    }
}
