//! lc-mcp – the MCP side of Log Commander (design 022): a stdio MCP server (`log-commander-mcp`) that forwards tool
//! calls over a local bridge to the running app, and the bridge server the app runs. Taken over from AppIconic
//! `ai-mcp` (design 018, same author, MIT) and cut to Log Commander.
//!
//! - [`bridge`]    messages between sidecar and app, the endpoint file, token check
//! - [`tools`]     the tools, their tiers and JSON schemas (snapshot `tools.snapshot.json`)
//! - [`guide`]     what the AI learns: `instructions`, the `help` topics (`guide/*.md`), the MCP prompts
//! - [`server`]    JSON-RPC 2.0 / MCP over lines
//! - [`client`]    the bridge client of the sidecar (TCP to 127.0.0.1)
//! - [`host`]      the bridge server of the app (token, line limit, connections, rate limit)
//! - [`probe`]     connection test: start the sidecar, MCP handshake, one call to the app

pub mod bridge;
pub mod client;
pub mod guide;
pub mod host;
pub mod probe;
pub mod server;
pub mod tools;
