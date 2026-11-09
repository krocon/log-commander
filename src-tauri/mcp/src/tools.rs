//! The tools of the MCP server (design 022): names, tiers, descriptions and input schemas. The descriptions are
//! written for the AI: what the tool is for, when to use it instead of another, an example, the limits. The limits
//! are the constants below; the frontend checks the same numbers (`features/mcp/mcp-limits.ts`, a spec compares
//! them with the snapshot `tools.snapshot.json`, test `the_schemas_match_the_snapshot`).
//! Form taken over from AppIconic `ai-mcp/src/tools.rs` (design 018 E7).

use serde_json::{json, Value};

/// Lines per `read_lines` call and the default.
pub const READ_LINES_MAX: u64 = 500;
pub const READ_LINES_DEFAULT: u64 = 50;
/// Characters per line in answers (longer lines are cut, `truncated_chars` says by how much).
pub const LINE_CHARS_MIN: u64 = 80;
pub const LINE_CHARS_MAX: u64 = 16_000;
pub const LINE_CHARS_DEFAULT: u64 = 2_000;
/// Characters of one entry (`get_entry`).
pub const ENTRY_CHARS_MIN: u64 = 1_000;
pub const ENTRY_CHARS_MAX: u64 = 262_144;
pub const ENTRY_CHARS_DEFAULT: u64 = 20_000;
/// Hits of `search` / `find_level`.
pub const HITS_MAX: u64 = 200;
pub const HITS_DEFAULT: u64 = 20;
/// Buckets of `get_timeline`.
pub const BUCKETS_MAX: u64 = 500;
pub const BUCKETS_DEFAULT: u64 = 60;
/// Rows of `run_sql` and the longest SQL (bytes, as the dashboard).
pub const SQL_ROWS_MAX: u64 = 1_000;
pub const SQL_ROWS_DEFAULT: u64 = 200;
pub const SQL_BYTES_MAX: u64 = 65_536;
/// `wait_for_lines`: seconds and lines.
pub const WAIT_SECONDS_MAX: u64 = 120;
pub const WAIT_SECONDS_DEFAULT: u64 = 30;
pub const WAIT_LINES_MAX: u64 = 50;
pub const WAIT_LINES_DEFAULT: u64 = 10;
/// Length of a note: the app keeps 2000 characters, the AI's start with "KI: ".
pub const NOTE_CHARS_MAX: u64 = 1_996;
/// Text of a search, a pattern or a filter value (as the filter tree).
pub const PATTERN_CHARS_MAX: u64 = 4_096;
/// Files of `propose_open` (as a merge).
pub const OPEN_PATHS_MAX: u64 = 16;
/// Largest arguments of a call and largest answer (bytes).
pub const ARGS_BYTES_MAX: usize = 1 << 20;
pub const ANSWER_BYTES_MAX: usize = 1 << 20;

/// What a tool may do (design 022, prompt „Stufen“).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// Reads, no visible effect.
    Read,
    /// Changes the view: visible and undone by the user.
    View,
    /// Proposes: a dialog in the window, the user confirms.
    Propose,
}

const LEVELS: &[&str] = &[
    "UNKNOWN", "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL",
];

fn tab_id() -> Value {
    json!({
        "type": "integer",
        "minimum": 0,
        "description": "Tab id from get_workspace; default: the tab in front"
    })
}

fn epoch() -> Value {
    json!({
        "type": "integer",
        "minimum": 0,
        "description": "The epoch of an earlier answer: fails with stale_view if the file was truncated, rotated without keeping or re-sorted since, so line numbers you hold no longer fit"
    })
}

fn line() -> Value {
    json!({"type": "integer", "minimum": 1, "description": "Line number of the file, 1-based (as the gutter shows it)"})
}

fn levels() -> Value {
    json!({
        "type": "array",
        "items": {"type": "string", "enum": LEVELS},
        "uniqueItems": true
    })
}

fn text(max: u64, description: &str) -> Value {
    json!({"type": "string", "minLength": 1, "maxLength": max, "description": description})
}

fn int(min: u64, max: u64, default: u64, description: &str) -> Value {
    json!({"type": "integer", "minimum": min, "maximum": max, "default": default, "description": description})
}

fn search() -> Value {
    json!({
        "type": "object",
        "description": "The search of the tab (toolbar). mode filter: only matching entries; highlight: all lines, matches marked",
        "properties": {
            "text": {"type": "string", "maxLength": PATTERN_CHARS_MAX},
            "regex": {"type": "boolean", "default": false},
            "case_sensitive": {"type": "boolean", "default": false},
            "mode": {"type": "string", "enum": ["filter", "highlight"], "default": "filter"}
        },
        "required": ["text"],
        "additionalProperties": false
    })
}

/// The filter tree of the sidebar (prompt 010), as JSON schema with `$defs` for the recursion.
pub fn filter_tree() -> Value {
    let pattern = json!({
        "type": "object",
        "properties": {
            "text": {"type": "string", "minLength": 1, "maxLength": PATTERN_CHARS_MAX},
            "isRegex": {"type": "boolean"},
            "caseSensitive": {"type": "boolean"}
        },
        "required": ["text", "isRegex", "caseSensitive"]
    });
    json!({
        "description": "Filter tree (help topic filters): a group with op and/or and children; a condition holds for an entry once one of its lines (head or stack trace) meets it. negate: NOT. At most 64 conditions, 16 levels deep.",
        "$ref": "#/$defs/group",
        "$defs": {
            "group": {
                "type": "object",
                "properties": {
                    "kind": {"const": "group"},
                    "op": {"type": "string", "enum": ["and", "or"]},
                    "negate": {"type": "boolean", "default": false},
                    "children": {"type": "array", "items": {"$ref": "#/$defs/node"}}
                },
                "required": ["kind", "op", "children"]
            },
            "node": {"oneOf": [{"$ref": "#/$defs/group"}, {"$ref": "#/$defs/cond_node"}]},
            "cond_node": {
                "type": "object",
                "properties": {
                    "kind": {"const": "cond"},
                    "negate": {"type": "boolean", "default": false},
                    "cond": {"$ref": "#/$defs/cond"}
                },
                "required": ["kind", "cond"]
            },
            "cond": {
                "oneOf": [
                    {
                        "description": "Text in the line",
                        "type": "object",
                        "properties": {
                            "type": {"const": "text"},
                            "text": {"type": "string", "minLength": 1, "maxLength": PATTERN_CHARS_MAX},
                            "isRegex": {"type": "boolean"},
                            "caseSensitive": {"type": "boolean"}
                        },
                        "required": ["type", "text", "isRegex", "caseSensitive"]
                    },
                    {
                        "description": "Level of the entry",
                        "type": "object",
                        "properties": {"type": {"const": "level"}, "levels": levels()},
                        "required": ["type", "levels"]
                    },
                    {
                        "description": "A column of the tab (get_tab columns). gt/lt/between compare numbers in base units: took > 500ms is value \"500ms\"",
                        "type": "object",
                        "properties": {
                            "type": {"const": "field"},
                            "column": {"type": "string"},
                            "op": {"type": "string", "enum": ["eq", "contains", "regex", "gt", "lt", "between"]},
                            "value": {"type": "string", "maxLength": PATTERN_CHARS_MAX},
                            "value2": {"type": ["string", "null"], "description": "Upper bound of between"},
                            "caseSensitive": {"type": "boolean"}
                        },
                        "required": ["type", "column", "op", "value"]
                    },
                    {
                        "description": "Time of the entry, ISO 8601 (without zone: local time)",
                        "type": "object",
                        "properties": {
                            "type": {"const": "time"},
                            "from": {"type": ["string", "null"]},
                            "to": {"type": ["string", "null"]}
                        },
                        "required": ["type"]
                    },
                    {
                        "description": "Section between a start and an end pattern (e.g. a request from 'begin 42' to 'end 42')",
                        "type": "object",
                        "properties": {
                            "type": {"const": "range"},
                            "start": pattern,
                            "end": {"oneOf": [pattern, {"type": "null"}]},
                            "inclusive": {"type": "boolean"}
                        },
                        "required": ["type", "start", "inclusive"]
                    },
                    {
                        "description": "Line numbers of the file, 1-based like everywhere in these tools; first or last may be null (open end)",
                        "type": "object",
                        "properties": {
                            "type": {"const": "lines"},
                            "first": {"type": ["integer", "null"]},
                            "last": {"type": ["integer", "null"]}
                        },
                        "required": ["type"]
                    }
                ]
            }
        }
    })
}

fn tool(name: &str, tier: Tier, description: &str, properties: Value, required: &[&str]) -> Value {
    let prefix = match tier {
        Tier::Read => "[read] ",
        Tier::View => "[changes the view, visible to the user] ",
        Tier::Propose => {
            "[proposal: the user confirms in a dialog, the call waits for the answer] "
        }
    };
    json!({
        "name": name,
        "description": format!("{prefix}{description}"),
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false
        },
        "annotations": {
            "readOnlyHint": tier == Tier::Read,
            "destructiveHint": false,
            "openWorldHint": false
        }
    })
}

/// Name and tier of every tool, in the order of `tools/list`.
pub fn tiers() -> Vec<(&'static str, Tier)> {
    list_with_tiers()
        .into_iter()
        .map(|(name, tier, _)| (name, tier))
        .collect()
}

/// The tools as `tools/list` returns them.
pub fn list() -> Vec<Value> {
    list_with_tiers().into_iter().map(|(_, _, t)| t).collect()
}

/// Names of all tools.
pub fn names() -> Vec<&'static str> {
    tiers().into_iter().map(|(n, _)| n).collect()
}

/// Tools the sidecar answers itself (no app needed).
pub const LOCAL_TOOLS: &[&str] = &["help"];

/// Tools that may wait long (the bridge gives them more time).
pub const LONG_TOOLS: &[&str] = &["wait_for_lines"];

/// Tools that wait for the user.
pub fn is_proposal(name: &str) -> bool {
    tiers()
        .iter()
        .any(|(n, t)| *n == name && *t == Tier::Propose)
}

fn list_with_tiers() -> Vec<(&'static str, Tier, Value)> {
    use Tier::*;
    let mut v: Vec<(&'static str, Tier, Value)> = Vec::new();
    let mut add = |name: &'static str, tier: Tier, d: &str, props: Value, req: &[&str]| {
        v.push((name, tier, tool(name, tier, d, props, req)));
    };

    // ---------------------------------------------------------------- read
    add(
        "help",
        Read,
        "Explains Log Commander for an AI: concepts (tab, view, entry, epoch), the filter tree with examples, the SQL table of the dashboard, field rules, recipes for common questions, limits and error codes. Call it once before a larger task. Works even when the app is closed.",
        json!({"topic": {"type": "string", "enum": crate::guide::TOPICS, "description": "Omit for the overview and the list of topics"}}),
        &[],
    );
    add(
        "get_workspace",
        Read,
        "The open tabs: id, title (a filter tab shows its chain 'app.log › ERROR'), kind (file, merge, source), path or source label, profile, lines in the file and in the view, frozen, following, status, and which tab is in front. Start here. Tabs the user hid from AI are not listed.",
        json!({}),
        &[],
    );
    add(
        "get_tab",
        Read,
        "One tab in detail: everything of get_workspace plus its filter (levels, search, filter tree), its columns (ids for field conditions, fields and SQL), the selected entry, bookmarks and notes, epoch and view_generation, and whether a filter job is still running.",
        json!({"tab_id": tab_id()}),
        &[],
    );
    add(
        "get_stats",
        Read,
        "Counts per level for the whole file and for the view of the tab, file size, number of entries and the time span of the file. Cheap: use it before reading any lines.",
        json!({"tab_id": tab_id()}),
        &[],
    );
    add(
        "read_lines",
        Read,
        "Lines of the tab's view (filtered as the user sees it), each with line (file, 1-based), pos (position in the view, 1-based), level, continuation (part of a stack trace) and text. Give start (view position; negative counts from the end: -50 = the last 50) or around_line (a file line; the window is centred on it). fields: true adds the columns split ({column id: value}). Never page through a whole log: locate first with get_stats, find_level, search, get_timeline or run_sql.",
        json!({
            "tab_id": tab_id(),
            "start": {"type": "integer", "description": "View position, 1-based; negative: from the end (-1 = last line). Default -count"},
            "around_line": line(),
            "count": int(1, READ_LINES_MAX, READ_LINES_DEFAULT, "Number of lines"),
            "fields": {"type": "boolean", "default": false, "description": "Add the split columns per line"},
            "max_line_chars": int(LINE_CHARS_MIN, LINE_CHARS_MAX, LINE_CHARS_DEFAULT, "Longer lines are cut"),
            "epoch": epoch()
        }),
        &[],
    );
    add(
        "get_entry",
        Read,
        "The whole entry of a line: its head and all continuation lines (stack trace, wrapped JSON), straight from the file, ignoring the filter. Use it to read an exception completely.",
        json!({
            "tab_id": tab_id(),
            "line": line(),
            "max_chars": int(ENTRY_CHARS_MIN, ENTRY_CHARS_MAX, ENTRY_CHARS_DEFAULT, "Longer entries are cut"),
            "epoch": epoch()
        }),
        &["line"],
    );
    add(
        "search",
        Read,
        "Finds lines in the tab's view containing query (text or regex), from from_line on (default the start; backwards: from the end), stops after limit hits or when it wraps around. Returns line, pos and the line text. Does not change the search of the tab – to show the result to the user use open_filter_tab.",
        json!({
            "tab_id": tab_id(),
            "query": text(PATTERN_CHARS_MAX, "Text or regex (Rust syntax)"),
            "regex": {"type": "boolean", "default": false},
            "case_sensitive": {"type": "boolean", "default": false},
            "from_line": line(),
            "backwards": {"type": "boolean", "default": false},
            "limit": int(1, HITS_MAX, HITS_DEFAULT, "Most hits"),
            "max_line_chars": int(LINE_CHARS_MIN, LINE_CHARS_MAX, 300, "Longer lines are cut"),
            "epoch": epoch()
        }),
        &["query"],
    );
    add(
        "find_level",
        Read,
        "Heads of the next entries with one of levels (default ERROR and FATAL) in the tab's view, from from_line on (default the start; backwards: from the end). Fast (uses the level index, no text scan): the best way to list errors. Follow up with get_entry for the stack trace.",
        json!({
            "tab_id": tab_id(),
            "levels": levels(),
            "from_line": line(),
            "backwards": {"type": "boolean", "default": false},
            "limit": int(1, HITS_MAX, HITS_DEFAULT, "Most hits"),
            "max_line_chars": int(LINE_CHARS_MIN, LINE_CHARS_MAX, 300, "Longer lines are cut"),
            "epoch": epoch()
        }),
        &[],
    );
    add(
        "get_timeline",
        Read,
        "Entries of the whole file over time: buckets with counts of all entries, WARN, ERROR and FATAL, plus gaps (stretches without any entry – outages, a stopped service). Without from/to the axis spans the 1st to 99th percentile of the times. Counts are approximate. Use it for 'when did it start' and 'was there an outage'.",
        json!({
            "tab_id": tab_id(),
            "from": {"type": "string", "description": "ISO 8601; without zone: local time"},
            "to": {"type": "string", "description": "ISO 8601; without zone: local time"},
            "buckets": int(1, BUCKETS_MAX, BUCKETS_DEFAULT, "Number of buckets")
        }),
        &[],
    );
    add(
        "line_at_time",
        Read,
        "The first entry at or after a time in the tab's view: its line and pos. Then read_lines around_line to see what happened.",
        json!({"tab_id": tab_id(), "time": text(64, "ISO 8601; without zone: local time")}),
        &["time"],
    );
    add(
        "report_schema",
        Read,
        "The SQL table of the tab for run_sql: columns with type and meaning (line, ts, level, source and the number fields of the format), and whether it is still being built. Builds it on first use.",
        json!({"tab_id": tab_id()}),
        &[],
    );
    add(
        "run_sql",
        Read,
        "One read-only SQLite query over the entry heads of the tab's file (help topic sql): table log(line, ts ms UTC, level, source, fields…), bucket(ts, '1m') for time series. The best tool for counting, grouping, top-N and percentiles. Never contains the message text. Example: SELECT bucket(ts, '1m') AS t, count(*) AS n FROM log WHERE level = 'ERROR' GROUP BY t ORDER BY t",
        json!({
            "tab_id": tab_id(),
            "sql": text(SQL_BYTES_MAX, "One SELECT (or WITH … SELECT)"),
            "limit": int(1, SQL_ROWS_MAX, SQL_ROWS_DEFAULT, "Most rows in the answer")
        }),
        &["sql"],
    );
    add(
        "preview_field_rule",
        Read,
        "Tries an extraction rule (a regex with exactly one group over a column) on the last lines of the tab's view and returns what it would extract per line. Saves nothing – propose_field_rule asks the user to keep it.",
        json!({
            "tab_id": tab_id(),
            "source_column": {"type": "string", "default": "message", "description": "Column id the regex runs over"},
            "pattern": text(PATTERN_CHARS_MAX, "Regex with exactly one capture group, e.g. took (\\d+ ?ms)"),
            "kind": {"type": "string", "enum": ["text", "number", "percent", "duration", "size"], "default": "number"},
            "lines": int(1, 200, 50, "How many lines from the end to try")
        }),
        &["pattern"],
    );
    add(
        "list_actions",
        Read,
        "The actions of the app run_action may run: id, name (German) and group. Only harmless view actions (next error, freeze, column view, …).",
        json!({}),
        &[],
    );
    add(
        "wait_for_lines",
        Read,
        "Waits for new lines in the tab (live tail) that match query and/or levels, up to timeout_s, and returns the first ones – or timed_out: true. Matching runs in the app (entries with stack traces count as one). Use it for 'tell me when X happens'; call it again to keep watching.",
        json!({
            "tab_id": tab_id(),
            "query": {"type": "string", "maxLength": PATTERN_CHARS_MAX},
            "regex": {"type": "boolean", "default": false},
            "case_sensitive": {"type": "boolean", "default": false},
            "levels": levels(),
            "timeout_s": int(1, WAIT_SECONDS_MAX, WAIT_SECONDS_DEFAULT, "Seconds to wait"),
            "limit": int(1, WAIT_LINES_MAX, WAIT_LINES_DEFAULT, "Most lines"),
            "max_line_chars": int(LINE_CHARS_MIN, LINE_CHARS_MAX, LINE_CHARS_DEFAULT, "Longer lines are cut")
        }),
        &[],
    );

    // ---------------------------------------------------------------- view
    add(
        "activate_tab",
        View,
        "Brings a tab to the front.",
        json!({"tab_id": tab_id()}),
        &["tab_id"],
    );
    add(
        "reveal_line",
        View,
        "Scrolls the tab to a line and selects its entry (the detail panel shows it). Use it to show the user what you are talking about.",
        json!({
            "tab_id": tab_id(),
            "line": line(),
            "select": {"type": "boolean", "default": true},
            "epoch": epoch()
        }),
        &["line"],
    );
    add(
        "set_filter",
        View,
        "Replaces the filter of a tab (level chips, search, filter tree). Prefer open_filter_tab: it leaves the user's filter alone. Omitted parts are reset (levels: all, no search, empty tree). Waits up to 30 s for the filter job.",
        json!({"tab_id": tab_id(), "levels": levels(), "search": search(), "tree": filter_tree()}),
        &[],
    );
    add(
        "open_filter_tab",
        View,
        "Opens a filter tab below a tab: it shows the parent's view AND this filter, live, titled like 'app.log › ERROR'. The preferred way to show a result. At most 8 tabs per file. Example tree for 'errors without health checks': {\"kind\":\"group\",\"op\":\"and\",\"children\":[{\"kind\":\"cond\",\"cond\":{\"type\":\"level\",\"levels\":[\"ERROR\",\"FATAL\"]}},{\"kind\":\"cond\",\"negate\":true,\"cond\":{\"type\":\"text\",\"text\":\"/health\",\"isRegex\":false,\"caseSensitive\":false}}]}",
        json!({
            "tab_id": tab_id(),
            "levels": levels(),
            "search": search(),
            "tree": filter_tree()
        }),
        &[],
    );
    add(
        "close_tab",
        View,
        "Closes a filter tab this AI connection opened. Other tabs belong to the user.",
        json!({"tab_id": tab_id()}),
        &["tab_id"],
    );
    add(
        "set_bookmark",
        View,
        "Sets a bookmark on the entry of a line (M/N jump between bookmarks, the overview ruler shows them).",
        json!({"tab_id": tab_id(), "line": line(), "epoch": epoch()}),
        &["line"],
    );
    add(
        "remove_bookmark",
        View,
        "Removes a bookmark this AI set.",
        json!({"tab_id": tab_id(), "line": line(), "epoch": epoch()}),
        &["line"],
    );
    add(
        "add_note",
        View,
        "Writes a note on the entry of a line; it is shown in the gutter, the ruler and the detail panel and starts with 'KI: '. Good for leaving findings at the place they belong.",
        json!({
            "tab_id": tab_id(),
            "line": line(),
            "text": text(NOTE_CHARS_MAX, "Short finding, plain text"),
            "epoch": epoch()
        }),
        &["line", "text"],
    );
    add(
        "remove_note",
        View,
        "Removes a note this AI wrote.",
        json!({"tab_id": tab_id(), "line": line(), "epoch": epoch()}),
        &["line"],
    );
    add(
        "set_frozen",
        View,
        "Freezes reading the file (on) or resumes it (off), like P. While frozen line numbers stay put.",
        json!({"tab_id": tab_id(), "on": {"type": "boolean"}}),
        &["on"],
    );
    add(
        "set_follow",
        View,
        "Follows the end of the log (on) or stops following (off), like Space.",
        json!({"tab_id": tab_id(), "on": {"type": "boolean"}}),
        &["on"],
    );
    add(
        "set_column_mode",
        View,
        "Shows the tab as a table with one column per field (columns) or as raw lines (raw), like T.",
        json!({"tab_id": tab_id(), "mode": {"type": "string", "enum": ["columns", "raw"]}}),
        &["mode"],
    );
    add(
        "run_action",
        View,
        "Runs an action of the app on the tab in front, by id from list_actions (e.g. NEXT_ERROR, TOGGLE_TIMELINE).",
        json!({"id": {"type": "string", "pattern": "^[A-Z][A-Z0-9_]{1,63}$"}}),
        &["id"],
    );

    // ---------------------------------------------------------------- propose
    add(
        "propose_open",
        Propose,
        "Asks the user to open log files (absolute paths) – the only way to get at a file that is not open. merge: true opens them as one tab sorted by time. Answers confirmed (with the new tab ids), cancelled or busy.",
        json!({
            "paths": {"type": "array", "minItems": 1, "maxItems": OPEN_PATHS_MAX, "items": {"type": "string", "minLength": 1, "maxLength": 4096}},
            "merge": {"type": "boolean", "default": false}
        }),
        &["paths"],
    );
    add(
        "propose_export",
        Propose,
        "Asks the user to export the tab's view, the whole file or a range of lines as txt, csv or jsonl to an absolute path (extension must fit the format). Answers confirmed (the export then runs as a job), cancelled or busy.",
        json!({
            "tab_id": tab_id(),
            "scope": {"type": "string", "enum": ["view", "file", "lines"]},
            "first_line": line(),
            "last_line": line(),
            "format": {"type": "string", "enum": ["txt", "csv", "jsonl"]},
            "path": text(4096, "Absolute target path, e.g. /Users/me/errors.csv")
        }),
        &["scope", "format", "path"],
    );
    add(
        "propose_field_rule",
        Propose,
        "Asks the user to add an extraction rule to the format of the tab: a new column (and SQL column for numbers) from a regex with one group. Try it with preview_field_rule first. Answers confirmed or cancelled.",
        json!({
            "tab_id": tab_id(),
            "name": {"type": "string", "pattern": "^[a-z][a-z0-9_]{0,39}$", "description": "Column id, must not be a column of the format"},
            "source_column": {"type": "string", "default": "message"},
            "pattern": text(PATTERN_CHARS_MAX, "Regex with exactly one capture group"),
            "kind": {"type": "string", "enum": ["text", "number", "percent", "duration", "size"], "default": "number"},
            "unit": {"type": "string", "maxLength": 8, "description": "Unit of a value written without one (ms, s, KB …)"}
        }),
        &["name", "pattern"],
    );
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Regenerate with `LC_MCP_SNAPSHOT=1 cargo test -p lc-mcp the_schemas_match_the_snapshot`.
    #[test]
    fn the_schemas_match_the_snapshot() {
        let now = serde_json::to_string_pretty(&json!({
            "limits": crate::guide::limits_json(),
            "tools": list()
        }))
        .unwrap()
            + "\n";
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tools.snapshot.json");
        if std::env::var_os("LC_MCP_SNAPSHOT").is_some() {
            std::fs::write(path, &now).unwrap();
        }
        // A Windows checkout may turn the newlines into CRLF (core.autocrlf).
        let saved = std::fs::read_to_string(path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert_eq!(
            saved, now,
            "tools changed: regenerate the snapshot (see doc comment)"
        );
    }

    #[test]
    fn names_are_unique_and_every_tool_has_a_schema() {
        let names = names();
        assert_eq!(names.iter().collect::<HashSet<_>>().len(), names.len());
        for t in list() {
            assert!(
                t["description"].as_str().unwrap().len() > 30,
                "{}",
                t["name"]
            );
            assert_eq!(t["inputSchema"]["type"], "object");
            let props = t["inputSchema"]["properties"].as_object().unwrap();
            for r in t["inputSchema"]["required"].as_array().unwrap() {
                assert!(props.contains_key(r.as_str().unwrap()), "{} {r}", t["name"]);
            }
        }
    }

    /// Stage 3 of the prompt does not exist: nothing that opens sources, touches secrets or settings.
    #[test]
    fn no_tool_reaches_what_stays_with_the_user() {
        for forbidden in [
            "open_source",
            "open_remote",
            "open_database",
            "set_settings",
            "forget_secret",
            "delete_spools",
            "write_file",
            "read_file",
            "clipboard",
            "quit",
            "set_mcp",
            "run_shell",
        ] {
            assert!(!names().contains(&forbidden), "{forbidden}");
        }
        assert!(names()
            .iter()
            .filter(|n| n.starts_with("propose_"))
            .all(|n| is_proposal(n)));
    }
}
