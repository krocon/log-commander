# Error codes

| code | meaning – what to do |
|---|---|
| `not_running` | the app is closed or AI control is off – ask the user to start it and turn on Settings → AI control |
| `tab_not_found` | no such tab (closed, or hidden from AI) – call `get_workspace` |
| `stale_view` | line numbers changed (truncated, rotated, re-sorted) – fetch lines again, use the new `epoch` |
| `invalid_args` | an argument is missing, of the wrong type or out of range – the message names it |
| `invalid_filter` | the filter tree has an unusable node or too many conditions |
| `invalid_search` | a regex does not compile (the message names the node) |
| `invalid_query` | SQL refused: not a single read-only statement, unknown column, syntax |
| `report_building` | the SQL table is still being built – wait a few seconds and try again |
| `too_many_views` | 8 tabs per file reached – close a filter tab (yours: `close_tab`) |
| `limit_exceeded` | too large an answer, too many calls per second or connections – ask for less |
| `busy` | another proposal is waiting for the user – wait for it |
| `denied` | not allowed for an AI (e.g. closing a tab of the user) |
| `cancelled` | the user said no to a proposal – do not ask again right away |
| `timeout` | the app did not answer in time, or the user did not decide within 5 minutes |
