# Concepts

- **Tab** (`tab_id`): one file, a merge of files or a source. A **filter tab** sits below another tab and shows its
  view AND its own filter; its title is the chain, e.g. `app.log › ERROR › 4711`. Tab ids stay the same while the tab
  is open. Tabs the user hid from AI do not exist for you.
- **Line** (`line`): line number of the file, 1-based, as in the gutter. Stable while lines are only appended.
- **View** and **position** (`pos`): the lines a tab shows after its filter, 1-based. `read_lines start` counts
  positions; `line` stays the file's number.
- **Entry**: a head line and its continuation lines (indented lines, `at …`, `Caused by:`, tracebacks). Filters and
  levels apply to the whole entry: a stack trace is never cut apart. `continuation: true` marks such a line.
- **Level**: UNKNOWN, TRACE, DEBUG, INFO, WARN, ERROR, FATAL, detected per entry by the tab's profile.
- **Columns**: a recognised format splits lines into columns (`timestamp`, `level`, `logger`, `message`, JSON keys …,
  plus extracted fields). `get_tab` lists them; field conditions, `fields: true` and SQL use their ids.
- **epoch**: changes when line numbers start over (file truncated, rotated without keeping old lines, merge re-sorted).
  Pass the epoch you got with line numbers; on `stale_view` fetch again.
- **view_generation**: changes with every new filter of a tab; a view position is only valid within one generation.
- **Frozen**: reading is on hold; the file grows on disk, the view does not. **Following**: the view sticks to the end.
- **Merge**: several files as one tab sorted by time; `source` says which file a line came from.
- **Sources without a file**: syslog receiver, file on a server (SFTP), Windows event log, database table – their lines
  are written to a spool file the tab follows, so every tool works the same.
