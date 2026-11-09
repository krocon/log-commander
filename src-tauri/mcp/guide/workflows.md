# Recipes

**What went wrong in the last N minutes?** `get_stats` → `get_timeline` with `from` = now − N → `run_sql` errors per
minute → `find_level` from `line_at_time(now − N)` → `get_entry` of distinct errors → group by cause in your answer,
cite lines. Optionally `open_filter_tab` with level ERROR and a time condition, `add_note` on the first occurrence.

**Explain the selected entry.** `get_tab` → `selection.line` → `get_entry` → `read_lines around_line` (context 30
lines) → explain; `search` for the same exception class to see how often it happens.

**When did it start / was there an outage?** `get_timeline` (gaps are outages) → `line_at_time` at the first bucket
with errors → `read_lines around_line`.

**Tell me when X happens.** `wait_for_lines` with `query` or `levels` and `timeout_s`; on `timed_out` call it again.
Report the line and `reveal_line` it.

**Slow requests.** `get_tab` columns → if there is no duration column: `preview_field_rule` → `propose_field_rule` →
`run_sql` top 10 → `open_filter_tab` with a field condition `gt`.

**Compare two files.** Ask the user, or `propose_open` with `merge: true`: one tab sorted by time, `source` per line.

Show results in the app where it helps (filter tab, note, bookmark, reveal) and say which lines you used.
