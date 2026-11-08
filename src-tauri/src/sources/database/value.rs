//! Values of a result row and the spool line built from them (prompt 019).
//!
//! One JSON object per row: the time column as `timestamp`, the level column as `level` (so the
//! JSON profile finds them), then the other columns in the order of the query. Times as ISO 8601
//! (with zone when the column has one, in local time), numbers as numbers, binary data as a hint
//! instead of its bytes, text escaped like the other spools (016/018) so a row stays one line and
//! nothing in it can act on the display. Values from the database are untrusted: every text is cut
//! at `MAX_TEXT_CHARS`, a whole line at `MAX_LINE_BYTES`.

use crate::sources::syslog::TRUNCATED_MARK;
use crate::sources::winevent::line::push_str;
use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
use std::hash::{Hash, Hasher};

/// Characters of one text value in the line.
pub const MAX_TEXT_CHARS: usize = 32 * 1024;
/// A line longer than this gets its remaining texts cut.
pub const MAX_LINE_BYTES: usize = 256 * 1024;
/// Columns of a result at most.
pub const MAX_COLUMNS: usize = 200;

/// Text from a driver, copied only up to one character more than the line keeps (so it is still
/// cut and marked there). The drivers hold the whole row in memory already (sqlx and tiberius read
/// a row at once); this keeps a huge value from being copied again in full.
pub fn text(s: &str) -> String {
    match s.char_indices().nth(MAX_TEXT_CHARS + 1) {
        Some((end, _)) => s[..end].to_string(),
        None => s.to_string(),
    }
}

/// Like `text` for bytes that should be UTF-8 (invalid sequences become U+FFFD).
pub fn text_bytes(b: &[u8]) -> String {
    let max = (MAX_TEXT_CHARS + 1) * 4;
    text(&String::from_utf8_lossy(&b[..b.len().min(max)]))
}

/// What a column holds, as far as the line and the key care.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ColKind {
    Int,
    Float,
    /// Exact numbers (NUMERIC, DECIMAL, MONEY): written as they come.
    Decimal,
    Bool,
    Text,
    Bytes,
    /// Date and time without zone.
    Timestamp,
    /// Date and time with zone (an instant).
    TimestampTz,
    Date,
    Time,
    Json,
    Uuid,
    Other,
}

impl ColKind {
    /// Can order rows and be compared with `>=` reliably.
    pub fn sortable(self) -> bool {
        matches!(
            self,
            ColKind::Int
                | ColKind::Float
                | ColKind::Text
                | ColKind::Timestamp
                | ColKind::TimestampTz
                | ColKind::Date
        )
    }

    pub fn is_time(self) -> bool {
        matches!(
            self,
            ColKind::Timestamp
                | ColKind::TimestampTz
                | ColKind::Date
                | ColKind::Text
                | ColKind::Int
        )
    }
}

/// A column of the result.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    /// The database's type name (`INT8`, `datetime2`, …).
    pub type_name: String,
    pub kind: ColKind,
}

/// A value of a row.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    I64(i64),
    U64(u64),
    F64(f64),
    /// Digits as the database wrote them.
    Decimal(String),
    Text(String),
    /// Binary data: only its length.
    Bytes(usize),
    Ts(NaiveDateTime),
    TsTz(DateTime<FixedOffset>),
    Date(NaiveDate),
    Time(NaiveTime),
    /// JSON text of a JSON column (kept as a string in the line).
    Json(String),
    /// A type that is not read; its name.
    Other(String),
}

impl Value {
    /// Rough memory of the value, for the bytes per batch.
    pub fn size(&self) -> usize {
        match self {
            Value::Decimal(s) | Value::Text(s) | Value::Json(s) | Value::Other(s) => s.len() + 24,
            _ => 24,
        }
    }

    /// The key this value is as the key column; None: NULL or not usable as a key.
    pub fn key(&self) -> Option<Key> {
        Some(match self {
            Value::I64(v) => Key::I64(*v),
            Value::U64(v) => Key::U64(*v),
            Value::F64(v) if v.is_finite() => Key::F64(*v),
            Value::Text(v) => Key::Text(v.clone()),
            Value::Ts(v) => Key::Ts(*v),
            Value::TsTz(v) => Key::TsTz(*v),
            Value::Date(v) => Key::Date(*v),
            _ => return None,
        })
    }
}

/// The last key: bound as the parameter of the next batch.
#[derive(Debug, Clone, PartialEq)]
pub enum Key {
    I64(i64),
    U64(u64),
    F64(f64),
    Text(String),
    Ts(NaiveDateTime),
    TsTz(DateTime<FixedOffset>),
    Date(NaiveDate),
}

/// How the columns of a result become keys of the line.
#[derive(Debug, Clone, PartialEq)]
pub struct Shape {
    /// Output order: (column index, JSON key).
    pub fields: Vec<(usize, String)>,
    pub key: usize,
}

impl Shape {
    /// `time` and `level` become `timestamp` and `level` and come first; other columns keep
    /// their names (a second one of the same name, or one that collides with the renamed ones,
    /// gets `_2`, `_3`, …).
    pub fn new(columns: &[Column], key: usize, time: Option<usize>, level: Option<usize>) -> Self {
        let mut fields: Vec<(usize, String)> = Vec::new();
        let mut taken: Vec<String> = Vec::new();
        let take = |name: &str, taken: &mut Vec<String>| {
            let mut n = 1;
            let mut candidate = name.to_string();
            while taken.iter().any(|t| t.eq_ignore_ascii_case(&candidate)) {
                n += 1;
                candidate = format!("{name}_{n}");
            }
            taken.push(candidate.clone());
            candidate
        };
        if let Some(t) = time {
            fields.push((t, take("timestamp", &mut taken)));
        }
        if let Some(l) = level.filter(|l| Some(*l) != time) {
            fields.push((l, take("level", &mut taken)));
        }
        for (i, c) in columns.iter().enumerate() {
            if Some(i) == time || Some(i) == level {
                continue;
            }
            let name = if c.name.is_empty() {
                format!("column{}", i + 1)
            } else {
                c.name.clone()
            };
            fields.push((i, take(&name, &mut taken)));
        }
        Self { fields, key }
    }
}

/// Writes the line of a row into `out`; true if a text was cut.
pub fn json_line<Tz: TimeZone>(shape: &Shape, row: &[Value], zone: &Tz, out: &mut String) -> bool
where
    Tz::Offset: std::fmt::Display,
{
    out.clear();
    out.push('{');
    let mut cut = false;
    for (n, (i, name)) in shape.fields.iter().enumerate() {
        if n > 0 {
            out.push(',');
        }
        push_str(out, name);
        out.push(':');
        let room = MAX_LINE_BYTES.saturating_sub(out.len());
        cut |= push_value(out, row.get(*i).unwrap_or(&Value::Null), zone, room);
    }
    out.push('}');
    cut
}

fn push_value<Tz: TimeZone>(out: &mut String, value: &Value, zone: &Tz, room: usize) -> bool
where
    Tz::Offset: std::fmt::Display,
{
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::I64(v) => out.push_str(&v.to_string()),
        Value::U64(v) => out.push_str(&v.to_string()),
        Value::F64(v) if v.is_finite() => out.push_str(
            &serde_json::Number::from_f64(*v).map_or_else(|| v.to_string(), |n| n.to_string()),
        ),
        Value::F64(v) => push_str(out, &v.to_string()),
        Value::Decimal(s) if is_json_number(s) => out.push_str(s),
        Value::Decimal(s) => return push_capped(out, s, room),
        Value::Text(s) | Value::Json(s) => return push_capped(out, s, room),
        Value::Bytes(len) => push_str(out, &format!("(binär, {len} Byte)")),
        Value::Ts(t) => push_str(out, &t.format("%Y-%m-%dT%H:%M:%S%.3f").to_string()),
        Value::TsTz(t) => push_str(
            out,
            &t.with_timezone(zone)
                .format("%Y-%m-%dT%H:%M:%S%.3f%:z")
                .to_string(),
        ),
        Value::Date(d) => push_str(out, &d.format("%Y-%m-%d").to_string()),
        Value::Time(t) => push_str(out, &t.format("%H:%M:%S%.3f").to_string()),
        Value::Other(name) => push_str(out, &format!("(Typ {name})")),
    }
    false
}

/// Text, cut at `MAX_TEXT_CHARS` or what is left of the line (an escaped char takes up to 6
/// bytes, so the room is divided by 6 to stay under the line limit).
fn push_capped(out: &mut String, text: &str, room: usize) -> bool {
    let max = MAX_TEXT_CHARS.min(room / 6);
    match text.char_indices().nth(max) {
        Some((end, _)) => {
            push_str(out, &format!("{}{TRUNCATED_MARK}", &text[..end]));
            true
        }
        None => {
            push_str(out, text);
            false
        }
    }
}

/// `-12.5e3` style: what JSON takes as a number unchanged.
pub fn is_json_number(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    if b.first() == Some(&b'-') {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_len = i - int_start;
    if int_len == 0 || (int_len > 1 && b[int_start] == b'0') {
        return false;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == b.len() && s.len() <= 64
}

/// PostgreSQL's binary NUMERIC (ndigits, weight, sign, dscale, base-10000 digits) as text.
pub fn pg_numeric(bytes: &[u8]) -> Option<String> {
    let word = |i: usize| -> Option<i16> {
        Some(i16::from_be_bytes([*bytes.get(i)?, *bytes.get(i + 1)?]))
    };
    let ndigits = word(0)? as usize;
    let weight = word(2)? as i32;
    let sign = word(4)? as u16;
    let dscale = word(6)? as usize;
    match sign {
        0xC000 => return Some("NaN".into()),
        0xD000 => return Some("Infinity".into()),
        0xF000 => return Some("-Infinity".into()),
        0x0000 | 0x4000 => {}
        _ => return None,
    }
    if bytes.len() != 8 + ndigits * 2 || dscale > 1000 || ndigits > 1000 {
        return None;
    }
    let digits: Vec<u16> = (0..ndigits)
        .map(|k| word(8 + k * 2).map(|d| d as u16))
        .collect::<Option<_>>()?;
    if digits.iter().any(|&d| d > 9999) {
        return None;
    }
    let mut int = String::new();
    for w in 0..=weight.max(-1) {
        let d = digits.get(w as usize).copied().unwrap_or(0);
        if int.is_empty() {
            if d != 0 {
                int.push_str(&d.to_string());
            }
        } else {
            int.push_str(&format!("{d:04}"));
        }
    }
    if int.is_empty() {
        int.push('0');
    }
    let mut frac = String::new();
    let mut w = weight + 1;
    while frac.len() < dscale {
        let d = if w < 0 {
            0
        } else {
            digits.get(w as usize).copied().unwrap_or(0)
        };
        frac.push_str(&format!("{d:04}"));
        w += 1;
    }
    frac.truncate(dscale);
    let mut s = String::new();
    if sign == 0x4000 && (int != "0" || frac.chars().any(|c| c != '0')) {
        s.push('-');
    }
    s.push_str(&int);
    if !frac.is_empty() {
        s.push('.');
        s.push_str(&frac);
    }
    Some(s)
}

/// Rows at the edge: those already written whose key equals the last key. The next batch asks for
/// `key >= last` and skips them, so rows with the same key (times) are neither lost nor doubled
/// (prompt 019, item 3). A multiset of line hashes: identical rows count separately.
#[derive(Debug, Default, Clone)]
pub struct Edge {
    last: Option<Key>,
    seen: std::collections::HashMap<u64, u32>,
    len: usize,
}

/// More rows than this with one key: the edge is dropped and the next batch asks for `key > last`
/// (counted as a possible gap).
pub const MAX_EDGE: usize = 100_000;

impl Edge {
    pub fn last(&self) -> Option<&Key> {
        self.last.as_ref()
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Starts at a key (start „letzte N“): rows with it are new.
    pub fn start_at(key: Key) -> Self {
        Self {
            last: Some(key),
            ..Self::default()
        }
    }

    /// A row of a batch with its key and line: true if it is new (to be written). Batches come
    /// in key order.
    pub fn admit(&mut self, key: &Key, line: &str) -> bool {
        let hash = line_hash(line);
        if self.last.as_ref() == Some(key) {
            if let Some(n) = self.seen.get_mut(&hash) {
                // Seen before: skip once.
                if *n > 0 {
                    *n -= 1;
                    if *n == 0 {
                        self.seen.remove(&hash);
                    }
                    self.len -= 1;
                    return false;
                }
            }
        }
        true
    }

    /// After `admit` said yes and the line was written.
    pub fn written(&mut self, key: Key, line: &str) {
        if self.last.as_ref() != Some(&key) {
            self.last = Some(key);
            self.seen.clear();
            self.len = 0;
        }
        *self.seen.entry(line_hash(line)).or_insert(0) += 1;
        self.len += 1;
    }

    /// The end of a batch: the skipped edge rows are written again into the edge (they are still
    /// there), so the next batch skips them again.
    pub fn restore(&mut self, skipped: &[(Key, String)]) {
        for (key, line) in skipped {
            if self.last.as_ref() == Some(key) {
                *self.seen.entry(line_hash(line)).or_insert(0) += 1;
                self.len += 1;
            }
        }
    }

    /// Too many rows with one key: forget them, ask for `key > last` once.
    pub fn overflowed(&self) -> bool {
        self.len > MAX_EDGE
    }

    pub fn clear_rows(&mut self) {
        self.seen.clear();
        self.len = 0;
    }
}

fn line_hash(line: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    line.hash(&mut h);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, kind: ColKind) -> Column {
        Column {
            name: name.into(),
            type_name: format!("{kind:?}"),
            kind,
        }
    }

    fn cet() -> FixedOffset {
        FixedOffset::east_opt(3600).unwrap()
    }

    #[test]
    fn values_become_json() {
        let columns = [
            col("id", ColKind::Int),
            col("created", ColKind::TimestampTz),
            col("sev", ColKind::Text),
            col("msg", ColKind::Text),
            col("data", ColKind::Bytes),
            col("amount", ColKind::Decimal),
            col("ratio", ColKind::Float),
            col("ok", ColKind::Bool),
            col("day", ColKind::Date),
            col("at", ColKind::Timestamp),
            col("meta", ColKind::Json),
            col("level", ColKind::Int),
            col("geo", ColKind::Other),
            col("", ColKind::Int),
        ];
        let shape = Shape::new(&columns, 0, Some(1), Some(2));
        let t = DateTime::parse_from_rfc3339("2026-11-08T09:15:30.123456Z").unwrap();
        let row = vec![
            Value::I64(42),
            Value::TsTz(t),
            Value::Text("ERROR".into()),
            Value::Text("Grüße 🎉\n\"zitiert\"\u{202E}\u{1b}[31m".into()),
            Value::Bytes(16),
            Value::Decimal("-12.50".into()),
            Value::F64(0.25),
            Value::Bool(true),
            Value::Date(NaiveDate::from_ymd_opt(2026, 11, 8).unwrap()),
            Value::Ts(
                NaiveDateTime::parse_from_str("2026-11-08 10:00:00.5", "%Y-%m-%d %H:%M:%S%.f")
                    .unwrap(),
            ),
            Value::Json("{\"a\":1}".into()),
            Value::I64(7),
            Value::Other("geometry".into()),
            Value::Null,
        ];
        let mut out = String::new();
        assert!(!json_line(&shape, &row, &cet(), &mut out));
        assert_eq!(
            out,
            "{\"timestamp\":\"2026-11-08T10:15:30.123+01:00\",\"level\":\"ERROR\",\"id\":42,\
             \"msg\":\"Grüße 🎉\\n\\\"zitiert\\\"\\u202E\\u001B[31m\",\"data\":\"(binär, 16 Byte)\",\
             \"amount\":-12.50,\"ratio\":0.25,\"ok\":true,\"day\":\"2026-11-08\",\
             \"at\":\"2026-11-08T10:00:00.500\",\"meta\":\"{\\\"a\\\":1}\",\"level_2\":7,\
             \"geo\":\"(Typ geometry)\",\"column14\":null}"
        );
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["msg"], "Grüße 🎉\n\"zitiert\"\u{202E}\u{1b}[31m");
        assert!(!out.contains('\n'));
        // Odd numbers stay text; NaN is text.
        let shape = Shape::new(&columns[..1], 0, None, None);
        for (v, text) in [
            (Value::Decimal("1e5".into()), "1e5"),
            (Value::Decimal("NaN".into()), "\"NaN\""),
            (Value::Decimal("007".into()), "\"007\""),
            (Value::F64(f64::NAN), "\"NaN\""),
            (Value::U64(u64::MAX), "18446744073709551615"),
        ] {
            json_line(&shape, &[v], &cet(), &mut out);
            assert_eq!(out, format!("{{\"id\":{text}}}"));
        }
    }

    #[test]
    fn long_texts_and_lines_are_cut_and_marked() {
        let columns: Vec<Column> = (0..20)
            .map(|i| col(&format!("c{i}"), ColKind::Text))
            .collect();
        let shape = Shape::new(&columns, 0, None, None);
        let big = "ä".repeat(MAX_TEXT_CHARS + 10);
        let row: Vec<Value> = (0..20).map(|_| Value::Text(big.clone())).collect();
        let mut out = String::new();
        assert!(json_line(&shape, &row, &cet(), &mut out));
        assert!(out.len() <= MAX_LINE_BYTES + 1024, "{}", out.len());
        assert!(out.contains(TRUNCATED_MARK));
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed.as_object().unwrap().len(), 20);
        assert_eq!(
            parsed["c0"].as_str().unwrap().chars().count(),
            MAX_TEXT_CHARS + TRUNCATED_MARK.chars().count()
        );
    }

    #[test]
    fn huge_values_are_copied_only_as_far_as_the_line_takes() {
        let big = "ä".repeat(MAX_TEXT_CHARS * 4);
        assert_eq!(text(&big).chars().count(), MAX_TEXT_CHARS + 1);
        assert_eq!(text("kurz"), "kurz");
        let bytes = vec![b'x'; 10 * 1024 * 1024];
        assert_eq!(text_bytes(&bytes).len(), MAX_TEXT_CHARS + 1);
        assert_eq!(text_bytes(&[0xff, b'a']), "\u{fffd}a");
        // Still cut and marked in the line.
        let columns = [Column {
            name: "m".into(),
            type_name: "TEXT".into(),
            kind: ColKind::Text,
        }];
        let mut out = String::new();
        assert!(json_line(
            &Shape::new(&columns, 0, None, None),
            &[Value::Text(text(&big))],
            &FixedOffset::east_opt(0).unwrap(),
            &mut out
        ));
    }

    #[test]
    fn numerics_of_postgres() {
        let enc = |ndigits: i16, weight: i16, sign: u16, dscale: i16, digits: &[i16]| {
            let mut b = Vec::new();
            for w in [ndigits, weight, sign as i16, dscale] {
                b.extend_from_slice(&w.to_be_bytes());
            }
            for d in digits {
                b.extend_from_slice(&d.to_be_bytes());
            }
            b
        };
        assert_eq!(
            pg_numeric(&enc(2, 0, 0, 2, &[12, 5000])).as_deref(),
            Some("12.50")
        );
        assert_eq!(
            pg_numeric(&enc(3, 1, 0x4000, 0, &[1, 2345, 0])).as_deref(),
            Some("-12345")
        );
        assert_eq!(
            pg_numeric(&enc(1, -1, 0, 4, &[5])).as_deref(),
            Some("0.0005")
        );
        assert_eq!(pg_numeric(&enc(0, 0, 0, 0, &[])).as_deref(), Some("0"));
        assert_eq!(
            pg_numeric(&enc(1, 2, 0, 0, &[7])).as_deref(),
            Some("700000000")
        );
        assert_eq!(
            pg_numeric(&enc(0, 0, 0xC000, 0, &[])).as_deref(),
            Some("NaN")
        );
        assert!(pg_numeric(&[1, 2, 3]).is_none());
        assert!(pg_numeric(&enc(1, 0, 0, 0, &[10000])).is_none());
    }

    #[test]
    fn json_numbers() {
        for good in ["0", "-1", "12.5", "1e10", "-0.5E-3"] {
            assert!(is_json_number(good), "{good}");
        }
        for bad in ["", "-", "01", "1.", ".5", "1e", "+1", "NaN", "1,5", "0x10"] {
            assert!(!is_json_number(bad), "{bad}");
        }
    }

    #[test]
    fn rows_with_the_same_key_are_neither_lost_nor_doubled() {
        // Rows (key, text) in the table; batches of 3 with `key >= last`, the limit grows by the edge.
        let mut table: Vec<(i64, &str)> = vec![(1, "a"), (2, "b"), (2, "c"), (2, "c"), (3, "d")];
        let mut edge = Edge::default();
        let mut written: Vec<(i64, String)> = Vec::new();
        let round =
            |table: &Vec<(i64, &str)>, edge: &mut Edge, written: &mut Vec<(i64, String)>| {
                let mut rows: Vec<(i64, &str)> = table
                    .iter()
                    .filter(|(k, _)| edge.last().is_none_or(|l| Key::I64(*k) >= *l))
                    .cloned()
                    .collect();
                // Ties come in any order.
                rows.sort_by_key(|(k, t)| (*k, std::cmp::Reverse(t.to_string())));
                rows.truncate(3 + edge.len());
                let mut skipped = Vec::new();
                for (k, t) in rows {
                    let key = Key::I64(k);
                    if edge.admit(&key, t) {
                        edge.written(key, t);
                        written.push((k, t.to_string()));
                    } else {
                        skipped.push((key, t.to_string()));
                    }
                }
                edge.restore(&skipped);
            };
        for _ in 0..4 {
            round(&table, &mut edge, &mut written);
        }
        assert_eq!(written.len(), 5, "{written:?}");
        // New rows with the last key and later ones arrive.
        table.push((3, "e"));
        table.push((3, "d"));
        table.push((4, "f"));
        for _ in 0..3 {
            round(&table, &mut edge, &mut written);
        }
        let mut texts: Vec<_> = written.iter().map(|(k, t)| format!("{k}{t}")).collect();
        texts.sort();
        assert_eq!(texts, ["1a", "2b", "2c", "2c", "3d", "3d", "3e", "4f"]);
    }

    impl PartialOrd for Key {
        fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
            match (self, other) {
                (Key::I64(a), Key::I64(b)) => a.partial_cmp(b),
                _ => None,
            }
        }
    }

    #[test]
    fn shapes_rename_and_keep_order() {
        let columns = [
            col("timestamp", ColKind::Text),
            col("t", ColKind::TimestampTz),
            col("id", ColKind::Int),
            col("id", ColKind::Int),
        ];
        let s = Shape::new(&columns, 2, Some(1), None);
        let names: Vec<_> = s.fields.iter().map(|(i, n)| format!("{i}:{n}")).collect();
        assert_eq!(names, ["1:timestamp", "0:timestamp_2", "2:id", "3:id_2"]);
        // Time and level the same column: only once, as the time.
        let s = Shape::new(&columns, 2, Some(1), Some(1));
        assert_eq!(s.fields.len(), 4);
        assert!(
            ColKind::Timestamp.sortable()
                && !ColKind::Bytes.sortable()
                && !ColKind::Bool.sortable()
        );
    }
}
