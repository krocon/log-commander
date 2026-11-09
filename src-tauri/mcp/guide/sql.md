# SQL (run_sql)

Each tab's file has an SQLite table built on first use (`report_schema` shows it and the build progress). One row per
entry head – never the message text.

Table `log`:

| column | meaning |
|---|---|
| `line` | line number of the head, 1-based (use it with `read_lines around_line` / `get_entry`) |
| `ts` | time in milliseconds, UTC (NULL without a time) |
| `level` | `TRACE` … `FATAL`, `UNKNOWN` |
| `source` | file index of a merge (table `sources(source, name)`) |
| further | number fields of the format and extracted fields (durations in seconds, sizes in bytes) |

Helpers: `bucket(ts, '1m')` – start of the minute (`'30s'`, `'5m'`, `'1h'`, `'1d'` local days); readable times with
`datetime(ts / 1000, 'unixepoch', 'localtime')`.

Only one read-only statement, 10 s, at most 10 000 rows (the answer keeps `limit`).

Examples:
```sql
-- errors per minute
SELECT bucket(ts, '1m') AS t, count(*) AS n FROM log WHERE level IN ('ERROR','FATAL') GROUP BY t ORDER BY t;
-- error rate per 5 minutes in percent
SELECT bucket(ts, '5m') AS t, round(100.0 * sum(level IN ('ERROR','FATAL')) / count(*), 2) AS pct
  FROM log GROUP BY t ORDER BY t;
-- the 20 latest errors with their lines
SELECT line, datetime(ts / 1000, 'unixepoch', 'localtime') AS time, level FROM log
  WHERE level IN ('ERROR','FATAL') ORDER BY ts DESC LIMIT 20;
-- slowest requests (needs a duration field such as took)
SELECT line, took FROM log WHERE took IS NOT NULL ORDER BY took DESC LIMIT 10;
```
