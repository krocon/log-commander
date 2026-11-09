# Filters

A tab's filter has three parts, combined with AND: **level chips** (`levels`), the **search** (`search`: text or
regex; mode `filter` hides non-matching entries, `highlight` only marks) and the **filter tree** (`tree`).

The tree is a group `{"kind":"group","op":"and"|"or","negate":false,"children":[…]}` whose children are groups or
conditions `{"kind":"cond","negate":false,"cond":{…}}`. A condition holds for an entry if one of its lines meets it.

Conditions (`cond.type`):

| type | fields | example |
|---|---|---|
| `text` | `text`, `isRegex`, `caseSensitive` | `{"type":"text","text":"timeout","isRegex":false,"caseSensitive":false}` |
| `level` | `levels` | `{"type":"level","levels":["ERROR","FATAL"]}` |
| `field` | `column`, `op` (eq, contains, regex, gt, lt, between), `value`, `value2` | `{"type":"field","column":"took","op":"gt","value":"500ms"}` |
| `time` | `from`, `to` (ISO 8601 or `HH:MM`, local time without zone) | `{"type":"time","from":"2026-11-09 14:00","to":"2026-11-09 14:30"}` |
| `range` | `start`, `end` (patterns like `text`), `inclusive` | section from `begin req 42` to `end req 42` |
| `lines` | `first`, `last` (1-based, null = open) | `{"type":"lines","first":1000,"last":2000}` |

Numbers in `field` conditions compare in base units: seconds and bytes (`500ms`, `1.5 s`, `10KB` = 10240 bytes).

Examples:

Errors without health checks:
```json
{"kind":"group","op":"and","children":[
  {"kind":"cond","cond":{"type":"level","levels":["ERROR","FATAL"]}},
  {"kind":"cond","negate":true,"cond":{"type":"text","text":"/health","isRegex":false,"caseSensitive":false}}]}
```

Slow requests or 5xx status:
```json
{"kind":"group","op":"or","children":[
  {"kind":"cond","cond":{"type":"field","column":"took","op":"gt","value":"500ms"}},
  {"kind":"cond","cond":{"type":"field","column":"status","op":"regex","value":"^5\\d\\d$"}}]}
```

Everything of one request id between 14:00 and 14:10:
```json
{"kind":"group","op":"and","children":[
  {"kind":"cond","cond":{"type":"text","text":"req-4711","isRegex":false,"caseSensitive":true}},
  {"kind":"cond","cond":{"type":"time","from":"14:00","to":"14:10"}}]}
```

Use `open_filter_tab` to show a filter (the user's own filter stays). A tab with a filter tree reports it in
`get_tab`. Limits: 64 conditions, 16 levels, 4096 characters per text; an invalid regex fails with `invalid_search`
and names the node.
