# Fields

A recognised format splits each line into columns (`get_tab` → `columns`). Values inside the message (durations,
sizes, ids) become columns through **extraction rules**: a regex with exactly one capture group over one column
(default `message`), the first match per line. Kinds: `text`, `number`, `percent`, `duration`, `size`. Durations and
sizes are compared and stored in base units (seconds, bytes; `KB` = 1024). A number written without a unit takes the
rule's `unit`.

Workflow: `preview_field_rule` on the last lines → adjust the regex → `propose_field_rule` (the user confirms; the new
column appears in the table, in field conditions and – for numbers – in SQL). Rules belong to the format (profile),
not to one file. At most 32 rules per profile, names of 40 characters, `[a-z][a-z0-9_]*`, not a column of the format.

Examples: `took (\d+(?:\.\d+)? ?m?s)` (duration), `size=(\d+(?:\.\d+)?\s?[KMG]?B)` (size), `user=(\w+)` (text).
