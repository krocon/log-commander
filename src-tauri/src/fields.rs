//! Fields of a line: a `FieldParser` built from a profile and a sample of the file splits a line into
//! spans `[start, end)` in UTF-16 code units over the text `get_lines` sends, one per column. Nothing
//! is stored per line: parsing happens when lines are delivered, the index stays at 16 bytes per line.
//!
//! Layouts are regexes with named groups (`Profile::layouts`). JSON Lines, logfmt, FIX and W3C have
//! scanners of their own, because a regex or `serde_json` cannot give the spans. A file that fits no
//! layout gets an inferred one (`infer_layout`), and if that fails too, a single column `message`.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::extract::{ExtractRule, Extractors};
use crate::level::{LevelDetector, PrevLine};
use crate::profile::{Profile, Structure, GENERIC_PROFILE};
use crate::timestamp::{self, TsFormat};
use regex::{Regex, RegexBuilder};
use serde::Serialize;
use std::collections::HashMap;

/// Only this much of a line is split; the rest goes into the last field.
pub const MAX_PARSE_BYTES: usize = 16 * 1024;
/// A detected format needs this share of the entry heads of the sample.
pub const MIN_CONFIDENCE: f32 = 0.8;
/// Below this an inferred layout is not worth showing: the line stays one `message`.
const MIN_INFERRED_CONFIDENCE: f32 = 0.5;
/// Columns from JSON keys, logfmt keys or FIX tags, the message included.
pub const MAX_KEY_COLUMNS: usize = 12;
/// A format needs at least this many entry heads in the sample (fewer if the sample is shorter), so
/// one matching line followed by text the profile takes for its continuation does not win.
const MIN_HEADS: usize = 2;
const LAYOUT_SIZE_LIMIT: usize = 4 * 1024 * 1024;
/// Delimiters the inference tries, and the field count they need on this share of the lines.
const DELIMITERS: [(char, usize); 3] = [('\t', 2), ('|', 3), (';', 3)];
const DELIMITED_SHARE: f64 = 0.95;
/// A column is a number if this share of its values is one.
const NUMBER_SHARE: f64 = 0.9;
const LEVEL_WORDS: &str = "TRACE|TRC|VRB|VERBOSE|DEBUG|DBG|INFO|INF|INFORMATION|NOTICE|WARN|WRN|WARNING|ERROR|ERR|FATAL|FTL|CRITICAL|CRIT|SEVERE|ALERT|EMERG|PANIC";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnKind {
    Timestamp,
    Level,
    Text,
    Number,
    /// Extracted values (prompt 011): numbers with a unit, compared in their base unit.
    Percent,
    Duration,
    Size,
}

impl ColumnKind {
    pub fn is_numeric(self) -> bool {
        matches!(
            self,
            ColumnKind::Number | ColumnKind::Percent | ColumnKind::Duration | ColumnKind::Size
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub id: String,
    pub label: String,
    pub kind: ColumnKind,
    /// Unit of an extracted value written without one (prompt 011).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    /// The extraction rule of the column, if it is one (prompt 011).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
}

impl Column {
    /// Known names get a kind and a German label; anything else is text under its own name.
    pub fn named(id: &str) -> Self {
        let (label, kind) = match id {
            "timestamp" => ("Zeit", ColumnKind::Timestamp),
            "date" => ("Datum", ColumnKind::Timestamp),
            "time" => ("Uhrzeit", ColumnKind::Timestamp),
            "thread" => ("Thread", ColumnKind::Text),
            "level" => ("Level", ColumnKind::Level),
            "logger" => ("Logger", ColumnKind::Text),
            "message" => ("Nachricht", ColumnKind::Text),
            // Received syslog (prompt 016).
            "sender" => ("Absender", ColumnKind::Text),
            "sent" => ("Gesendet", ColumnKind::Text),
            other => (other, ColumnKind::Text),
        };
        Self {
            id: id.into(),
            label: label.into(),
            kind,
            unit: None,
            rule: None,
        }
    }

    fn labelled(id: &str, label: &str, kind: ColumnKind) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            kind,
            unit: None,
            rule: None,
        }
    }
}

#[derive(Clone)]
struct Layout {
    regex: Regex,
    /// Capture group index → column.
    slots: Vec<Option<usize>>,
}

/// Keys (JSON, logfmt) or tags (FIX) → column.
#[derive(Clone)]
struct KeyMap {
    columns: HashMap<String, usize>,
}

impl KeyMap {
    fn get(&self, key: &str) -> Option<usize> {
        self.columns.get(key).copied()
    }
}

#[derive(Clone)]
enum Kind {
    MessageOnly,
    Regex(Vec<Layout>),
    Json(KeyMap),
    Logfmt(KeyMap),
    Fix {
        tags: KeyMap,
        /// Column for the text before `8=FIX`, if the sample has one.
        prefix: Option<usize>,
        /// Column for the whole FIX message.
        message: usize,
    },
    W3c,
}

/// Splits lines into the columns of one format, and takes fields out of them (prompt 011): the
/// columns of the format come first (`base_len`), the extracted ones after them.
#[derive(Clone)]
pub struct FieldParser {
    columns: Vec<Column>,
    /// Where a line goes that does not fit: `message`, or the last column.
    fallback: usize,
    kind: Kind,
    base_len: usize,
    extract: Extractors,
}

impl std::fmt::Debug for FieldParser {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FieldParser")
            .field("columns", &self.columns)
            .finish_non_exhaustive()
    }
}

impl Default for FieldParser {
    fn default() -> Self {
        Self::message_only()
    }
}

impl FieldParser {
    pub fn message_only() -> Self {
        Self {
            columns: vec![Column::named("message")],
            fallback: 0,
            kind: Kind::MessageOnly,
            base_len: 1,
            extract: Extractors::default(),
        }
    }

    /// The same format with the extraction rules of its profile; rules from before are replaced.
    pub fn with_rules(&self, rules: &[ExtractRule]) -> Self {
        let mut parser = self.clone();
        parser.columns.truncate(parser.base_len);
        parser.extract = Extractors::build(rules, &parser.columns);
        let extracted: Vec<Column> = parser.extract.columns().collect();
        parser.columns.extend(extracted);
        parser
    }

    /// The columns of the format, without the extracted ones.
    pub fn base_columns(&self) -> &[Column] {
        &self.columns[..self.base_len]
    }

    /// The column a line goes to that does not fit (`message`, mostly): what extraction reads.
    pub fn fallback_column(&self) -> &Column {
        &self.columns[self.fallback]
    }

    /// The parser a profile describes; JSON, logfmt, FIX and W3C take their columns from the sample.
    /// A regex profile without layouts gives a single `message` (the inference is `format_for`).
    pub fn for_profile(profile: &Profile, sample: &[&str]) -> AppResult<Self> {
        let mut parser = match profile.structure {
            Structure::Regex if profile.layouts.is_empty() => return Ok(Self::message_only()),
            Structure::Regex => {
                // Columns come from the layouts the sample uses, so a Logback file does not get
                // the `pid` of Spring Boot.
                let all = compile_layouts(profile)?;
                let used: Vec<Regex> = all
                    .iter()
                    .filter(|r| sample.iter().any(|line| r.is_match(line)))
                    .cloned()
                    .collect();
                let mut parser = Self::regex(if used.is_empty() { &all } else { &used });
                parser.drop_empty_columns(sample);
                parser
            }
            Structure::Json => Self::keyed(sample, true),
            Structure::Logfmt => Self::keyed(sample, false),
            Structure::Fix => Self::fix(sample),
            Structure::W3c => Self::w3c(sample),
        };
        parser.detect_numbers(sample);
        Ok(parser)
    }

    pub fn columns(&self) -> &[Column] {
        &self.columns
    }

    fn regex(layouts: &[Regex]) -> Self {
        let mut columns: Vec<Column> = Vec::new();
        let mut compiled = Vec::with_capacity(layouts.len());
        for regex in layouts {
            let slots = regex
                .capture_names()
                .map(|name| {
                    let name = name?;
                    Some(match columns.iter().position(|c| c.id == name) {
                        Some(i) => i,
                        None => {
                            columns.push(Column::named(name));
                            columns.len() - 1
                        }
                    })
                })
                .collect();
            compiled.push(Layout {
                regex: regex.clone(),
                slots,
            });
        }
        Self::with_fallback(columns, Kind::Regex(compiled))
    }

    fn with_fallback(columns: Vec<Column>, kind: Kind) -> Self {
        let fallback = columns
            .iter()
            .position(|c| c.id == "message")
            .unwrap_or(columns.len().saturating_sub(1));
        if columns.is_empty() {
            return Self::message_only();
        }
        Self {
            base_len: columns.len(),
            columns,
            fallback,
            kind,
            extract: Extractors::default(),
        }
    }

    /// JSON Lines or logfmt: the top-level keys of the sample, `timestamp`, `level` and `message`
    /// first (aliases fold into one column), the others by frequency.
    fn keyed(sample: &[&str], json: bool) -> Self {
        let mut counts: Vec<(String, usize)> = Vec::new();
        for line in sample {
            let mut seen =
                |key: &str, _: usize, _: usize| match counts.iter_mut().find(|(k, _)| k == key) {
                    Some((_, n)) => *n += 1,
                    None => counts.push((key.to_string(), 1)),
                };
            if json {
                scan_json(line, false, &mut seen);
            } else if scan_logfmt(line, &mut |_, _, _| {}) >= 2 {
                scan_logfmt(line, &mut seen);
            }
        }
        let (columns, map) = key_columns(counts);
        let map = KeyMap { columns: map };
        Self::with_fallback(
            columns,
            if json {
                Kind::Json(map)
            } else {
                Kind::Logfmt(map)
            },
        )
    }

    fn fix(sample: &[&str]) -> Self {
        let mut counts: Vec<(String, usize)> = Vec::new();
        let mut with_prefix = 0usize;
        let mut prefix_is_time = 0usize;
        let mut fix_lines = 0usize;
        for line in sample {
            let Some(start) = fix_start(line) else {
                continue;
            };
            fix_lines += 1;
            if let Some((s, e)) = fix_prefix(line, start) {
                with_prefix += 1;
                if timestamp::recognise(&line[s..e]).is_some_and(|(_, len)| len == e - s) {
                    prefix_is_time += 1;
                }
            }
            scan_fix(
                line,
                start,
                &mut |tag, _, _| match counts.iter_mut().find(|(k, _)| k == tag) {
                    Some((_, n)) => *n += 1,
                    None => counts.push((tag.to_string(), 1)),
                },
            );
        }
        let mut columns = Vec::new();
        let prefix = (fix_lines > 0 && with_prefix * 2 >= fix_lines).then(|| {
            columns.push(if prefix_is_time * 2 >= with_prefix {
                Column::named("timestamp")
            } else {
                Column::labelled("prefix", "Präfix", ColumnKind::Text)
            });
            columns.len() - 1
        });
        // Header and trailer say nothing about the message.
        counts.retain(|(tag, _)| !matches!(tag.as_str(), "8" | "9" | "10"));
        let order = |tag: &str| {
            FIX_ORDER
                .iter()
                .position(|t| *t == tag)
                .unwrap_or(usize::MAX)
        };
        counts.sort_by(|(a, na), (b, nb)| order(a).cmp(&order(b)).then(nb.cmp(na)));
        let room = MAX_KEY_COLUMNS - 1 - columns.len();
        let mut tags = HashMap::new();
        for (tag, _) in counts.into_iter().take(room) {
            tags.insert(tag.clone(), columns.len());
            columns.push(fix_column(&tag));
        }
        columns.push(Column::labelled("message", "Nachricht", ColumnKind::Text));
        let message = columns.len() - 1;
        Self {
            fallback: message,
            base_len: columns.len(),
            extract: Extractors::default(),
            columns,
            kind: Kind::Fix {
                tags: KeyMap { columns: tags },
                prefix,
                message,
            },
        }
    }

    /// W3C extended log (IIS): the names come from the `#Fields:` directive of the sample.
    fn w3c(sample: &[&str]) -> Self {
        let Some(names) = sample
            .iter()
            .find_map(|line| line.strip_prefix("#Fields:"))
            .map(|rest| rest.split_whitespace().collect::<Vec<_>>())
            .filter(|names| !names.is_empty())
        else {
            return Self::message_only();
        };
        let mut columns: Vec<Column> = Vec::new();
        for name in names {
            let id = match name {
                "date" | "time" => name.to_string(),
                _ => name
                    .chars()
                    .map(|c| {
                        if c.is_ascii_alphanumeric() {
                            c.to_ascii_lowercase()
                        } else {
                            '_'
                        }
                    })
                    .collect(),
            };
            let mut column = Column::named(&id);
            if !matches!(name, "date" | "time") {
                column.label = name.to_string();
            }
            columns.push(column);
        }
        Self::with_fallback(columns, Kind::W3c)
    }

    /// Optional groups the sample never fills (Spring Boot's application name, say) are no
    /// columns. The message stays, and nothing changes without a sample.
    fn drop_empty_columns(&mut self, sample: &[&str]) {
        let Kind::Regex(layouts) = &self.kind else {
            return;
        };
        let n = self.columns.len();
        let mut filled = vec![false; n];
        let mut spans = vec![[0usize; 2]; n];
        let mut any = false;
        for line in sample {
            spans.fill([0, 0]);
            if self.fill(line, false, &mut spans) {
                any = true;
                for (i, [s, e]) in spans.iter().enumerate() {
                    filled[i] |= e > s;
                }
            }
        }
        if !any {
            return;
        }
        let mut new_index = vec![None; n];
        let mut columns = Vec::new();
        for (i, column) in self.columns.iter().enumerate() {
            if filled[i] || column.id == "message" {
                new_index[i] = Some(columns.len());
                columns.push(column.clone());
            }
        }
        let layouts = layouts
            .iter()
            .map(|layout| Layout {
                regex: layout.regex.clone(),
                slots: layout
                    .slots
                    .iter()
                    .map(|slot| slot.and_then(|i| new_index[i]))
                    .collect(),
            })
            .collect();
        *self = Self::with_fallback(columns, Kind::Regex(layouts));
    }

    /// Columns without a kind of their own become numbers if the sample says so.
    fn detect_numbers(&mut self, sample: &[&str]) {
        if matches!(self.kind, Kind::MessageOnly) {
            return;
        }
        let n = self.columns.len();
        let mut numbers = vec![(0usize, 0usize); n];
        let mut spans = vec![[0usize; 2]; n];
        for line in sample {
            spans.fill([0, 0]);
            if !self.fill(line, false, &mut spans) {
                continue;
            }
            for (i, [s, e]) in spans.iter().enumerate() {
                let value = line[*s..*e].trim();
                if value.is_empty() {
                    continue;
                }
                numbers[i].1 += 1;
                if value.parse::<f64>().is_ok_and(f64::is_finite) {
                    numbers[i].0 += 1;
                }
            }
        }
        for (column, (numeric, values)) in self.columns.iter_mut().zip(numbers) {
            if column.kind == ColumnKind::Text
                && column.id != "message"
                && values > 0
                && numeric as f64 >= values as f64 * NUMBER_SHARE
            {
                column.kind = ColumnKind::Number;
            }
        }
    }

    /// Field spans in UTF-16 code units, in the order of the columns, an empty field as `[0, 0]`.
    /// `truncated`: the text is cut short (128 KB display limit), an open value runs to its end.
    pub fn parse(&self, text: &str, truncated: bool) -> Vec<[u32; 2]> {
        let mut spans = vec![[0usize; 2]; self.columns.len()];
        let cut = text.len() > MAX_PARSE_BYTES;
        let part = if cut {
            &text[..floor_char_boundary(text, MAX_PARSE_BYTES)]
        } else {
            text
        };
        let (base, extracted) = spans.split_at_mut(self.base_len);
        let fits = self.fill(part, truncated || cut, base);
        if !fits {
            base.fill([0, 0]);
            base[self.fallback] = [0, text.len()];
        }
        // Extracted spans may overlap the column they come from; the value stays in the message too.
        self.extract.fill(text, base, MAX_PARSE_BYTES, extracted);
        if fits && cut {
            // The rest of a long line goes into the last field.
            if let Some(last) = base.iter_mut().filter(|s| s[1] > 0).max_by_key(|s| s[1]) {
                last[1] = text.len();
            }
        }
        to_utf16(text, &spans)
    }

    /// Spans of a line that is not split (a continuation): all of it in `message`.
    pub fn whole_line(&self, text: &str) -> Vec<[u32; 2]> {
        let mut spans = vec![[0u32; 2]; self.columns.len()];
        spans[self.fallback] = [0, text.encode_utf16().count() as u32];
        spans
    }

    /// The text of one field of a line (bytes, not UTF-16), for filter conditions (prompt 010). A line
    /// that does not fit has only its fallback column (`message`), which is all of it.
    pub fn field<'a>(&self, text: &'a str, column: usize) -> Option<&'a str> {
        if column >= self.columns.len() {
            return None;
        }
        let part = &text[..floor_char_boundary(text, MAX_PARSE_BYTES)];
        let mut spans = vec![[0usize; 2]; self.base_len];
        let fits = self.fill(part, part.len() < text.len(), &mut spans);
        if column < self.base_len {
            return if fits {
                let [start, end] = spans[column];
                part.get(start..end)
            } else {
                (column == self.fallback).then_some(text)
            };
        }
        if !fits {
            spans.fill([0, 0]);
            spans[self.fallback] = [0, text.len()];
        }
        self.extract
            .value(column - self.base_len, text, &spans, MAX_PARSE_BYTES)
    }

    /// Several fields of a line at once, with one pass of the layout (the dashboard of prompt 012
    /// reads every entry head). Same values as `field` for each column.
    pub fn fields<'a>(&self, text: &'a str, wanted: &[usize]) -> Vec<Option<&'a str>> {
        let part = &text[..floor_char_boundary(text, MAX_PARSE_BYTES)];
        let mut spans = vec![[0usize; 2]; self.base_len];
        let fits = self.fill(part, part.len() < text.len(), &mut spans);
        let base: Vec<Option<&'a str>> = (0..self.base_len)
            .map(|column| {
                if fits {
                    let [start, end] = spans[column];
                    part.get(start..end)
                } else {
                    (column == self.fallback).then_some(text)
                }
            })
            .collect();
        if !fits {
            spans.fill([0, 0]);
            spans[self.fallback] = [0, text.len()];
        }
        wanted
            .iter()
            .map(|&column| {
                if column < self.base_len {
                    base[column]
                } else if column < self.columns.len() {
                    self.extract
                        .value(column - self.base_len, text, &spans, MAX_PARSE_BYTES)
                } else {
                    None
                }
            })
            .collect()
    }

    /// Whether a line fits the format completely.
    pub fn matches(&self, text: &str) -> bool {
        let mut spans = vec![[0usize; 2]; self.base_len];
        let part = &text[..floor_char_boundary(text, MAX_PARSE_BYTES)];
        self.fill(part, part.len() < text.len(), &mut spans)
    }

    /// Byte spans of one line; false if it does not fit.
    fn fill(&self, text: &str, truncated: bool, spans: &mut [[usize; 2]]) -> bool {
        match &self.kind {
            Kind::MessageOnly => false,
            Kind::Regex(layouts) => layouts.iter().any(|layout| {
                let mut locations = layout.regex.capture_locations();
                if layout.regex.captures_read(&mut locations, text).is_none() {
                    return false;
                }
                for (group, slot) in layout.slots.iter().enumerate() {
                    if let (Some(column), Some((s, e))) = (slot, locations.get(group)) {
                        spans[*column] = [s, e];
                    }
                }
                true
            }),
            Kind::Json(keys) => scan_json(text, truncated, &mut |key, s, e| {
                if let Some(column) = keys.get(key) {
                    if spans[column] == [0, 0] {
                        spans[column] = [s, e];
                    }
                }
            }),
            Kind::Logfmt(keys) => {
                let pairs = scan_logfmt(text, &mut |key, s, e| {
                    if let Some(column) = keys.get(key) {
                        if spans[column] == [0, 0] {
                            spans[column] = [s, e];
                        }
                    }
                });
                pairs >= 2
            }
            Kind::Fix {
                tags,
                prefix,
                message,
            } => {
                let Some(start) = fix_start(text) else {
                    return false;
                };
                if let (Some(column), Some((s, e))) = (prefix, fix_prefix(text, start)) {
                    spans[*column] = [s, e];
                }
                spans[*message] = [start, text.len()];
                scan_fix(text, start, &mut |tag, s, e| {
                    if let Some(column) = tags.get(tag) {
                        if spans[column] == [0, 0] {
                            spans[column] = [s, e];
                        }
                    }
                });
                true
            }
            Kind::W3c => {
                if text.starts_with('#') || text.is_empty() {
                    return false;
                }
                let n = spans.len();
                let mut start = 0usize;
                let mut fields = 0usize;
                for (i, part) in text.split(' ').enumerate() {
                    if i >= n {
                        return false;
                    }
                    spans[i] = [start, start + part.len()];
                    start += part.len() + 1;
                    fields += 1;
                }
                fields == n
            }
        }
    }
}

fn floor_char_boundary(text: &str, at: usize) -> usize {
    if at >= text.len() {
        return text.len();
    }
    (0..=at)
        .rev()
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(0)
}

/// Byte offsets → UTF-16 code units, the unit of `LogLine.matches` and of JavaScript strings.
fn to_utf16(text: &str, spans: &[[usize; 2]]) -> Vec<[u32; 2]> {
    if text.is_ascii() {
        return spans.iter().map(|[s, e]| [*s as u32, *e as u32]).collect();
    }
    let mut points: Vec<(usize, usize)> = spans
        .iter()
        .flatten()
        .enumerate()
        .map(|(i, b)| (*b, i))
        .collect();
    points.sort_unstable();
    let mut units = vec![0u32; points.len()];
    let (mut byte, mut unit) = (0usize, 0u32);
    for (at, i) in points {
        unit += text[byte..at].encode_utf16().count() as u32;
        byte = at;
        units[i] = unit;
    }
    units.chunks(2).map(|c| [c[0], c[1]]).collect()
}

/// Compiles the layouts of a profile; the error names the profile, like the level patterns.
pub fn compile_layouts(profile: &Profile) -> AppResult<Vec<Regex>> {
    profile
        .layouts
        .iter()
        .map(|layout| {
            RegexBuilder::new(layout)
                .size_limit(LAYOUT_SIZE_LIMIT)
                .build()
                .map_err(|e| {
                    AppError::new(ErrorCode::InvalidProfile, format!("{}: {e}", profile.name))
                })
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// JSON and logfmt

const TIMESTAMP_KEYS: [&str; 5] = ["timestamp", "@timestamp", "time", "ts", "@t"];
const LEVEL_KEYS: [&str; 4] = ["level", "severity", "lvl", "@l"];
const MESSAGE_KEYS: [&str; 4] = ["message", "msg", "@m", "@mt"];

/// Columns from key counts: aliases fold into `timestamp`, `level`, `message` up front, the rest
/// by frequency, at most `MAX_KEY_COLUMNS`.
fn key_columns(counts: Vec<(String, usize)>) -> (Vec<Column>, HashMap<String, usize>) {
    let mut columns: Vec<Column> = Vec::new();
    let mut map = HashMap::new();
    for (id, aliases) in [
        ("timestamp", &TIMESTAMP_KEYS[..]),
        ("level", &LEVEL_KEYS[..]),
        ("message", &MESSAGE_KEYS[..]),
    ] {
        let present: Vec<&String> = counts
            .iter()
            .filter(|(k, _)| aliases.contains(&k.as_str()))
            .map(|(k, _)| k)
            .collect();
        if present.is_empty() {
            continue;
        }
        for key in present {
            map.insert(key.clone(), columns.len());
        }
        columns.push(Column::named(id));
    }
    let mut rest: Vec<(String, usize)> = counts
        .into_iter()
        .filter(|(k, _)| !map.contains_key(k))
        .collect();
    // Stable: equal counts keep the order of first appearance.
    rest.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    for (key, _) in rest {
        if columns.len() >= MAX_KEY_COLUMNS {
            break;
        }
        // A key that happens to be called like a known column keeps its own name.
        let mut column = Column::named(&key);
        column.label = key.clone();
        map.insert(key, columns.len());
        columns.push(column);
    }
    // `message` stays last among the leading three only if it exists; the fallback finds it.
    (columns, map)
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while b.get(i).is_some_and(u8::is_ascii_whitespace) {
        i += 1;
    }
    i
}

/// Index of the closing quote of a string whose content starts at `i`.
fn string_end(b: &[u8], mut i: usize) -> Option<usize> {
    loop {
        let found = memchr::memchr2(b'"', b'\\', &b[i.min(b.len())..])?;
        let at = i + found;
        if b[at] == b'"' {
            return Some(at);
        }
        i = at + 2;
    }
}

/// End (exclusive) of a nested object or array starting at `i`.
fn nested_end(b: &[u8], i: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut j = i;
    while j < b.len() {
        match b[j] {
            b'"' => j = string_end(b, j + 1)?,
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(j + 1);
                }
            }
            _ => {}
        }
        j += 1;
    }
    None
}

/// Top-level members of one JSON object: the raw key (escapes as written) and the span of the raw
/// value, strings without their quotes. False if the text is not one object. With `open_end` a
/// value cut off by the end of the text runs to the end.
fn scan_json(text: &str, open_end: bool, member: &mut dyn FnMut(&str, usize, usize)) -> bool {
    let b = text.as_bytes();
    let mut i = skip_ws(b, 0);
    if b.get(i) != Some(&b'{') {
        return false;
    }
    i += 1;
    loop {
        i = skip_ws(b, i);
        match b.get(i) {
            Some(b'}') => return skip_ws(b, i + 1) == b.len(),
            Some(b'"') => {}
            None => return open_end,
            Some(_) => return false,
        }
        let Some(key_end) = string_end(b, i + 1) else {
            return open_end;
        };
        let key = &text[i + 1..key_end];
        i = skip_ws(b, key_end + 1);
        match b.get(i) {
            Some(b':') => {}
            None => return open_end,
            Some(_) => return false,
        }
        i = skip_ws(b, i + 1);
        let (start, end, next) = match b.get(i) {
            None => return open_end,
            Some(b'"') => match string_end(b, i + 1) {
                Some(e) => (i + 1, e, e + 1),
                None if open_end => (i + 1, b.len(), b.len()),
                None => return false,
            },
            Some(b'{' | b'[') => match nested_end(b, i) {
                Some(e) => (i, e, e),
                None if open_end => (i, b.len(), b.len()),
                None => return false,
            },
            Some(_) => {
                let e = (i..b.len())
                    .find(|j| matches!(b[*j], b',' | b'}' | b']') || b[*j].is_ascii_whitespace())
                    .unwrap_or(b.len());
                if e == i {
                    return false;
                }
                (i, e, e)
            }
        };
        member(key, start, end);
        i = skip_ws(b, next);
        match b.get(i) {
            Some(b',') => i += 1,
            Some(b'}') => {}
            None => return open_end,
            Some(_) => return false,
        }
    }
}

/// `key=value key="quoted value"`: calls `member` per pair and returns the number of pairs, or 0 if
/// a token is not a pair.
fn scan_logfmt(text: &str, member: &mut dyn FnMut(&str, usize, usize)) -> usize {
    let b = text.as_bytes();
    let mut i = 0usize;
    let mut pairs = 0usize;
    loop {
        i = skip_ws(b, i);
        if i >= b.len() {
            return pairs;
        }
        let key_start = i;
        while i < b.len() && b[i] != b'=' && !b[i].is_ascii_whitespace() && b[i] != b'"' {
            i += 1;
        }
        if i == key_start || b.get(i) != Some(&b'=') {
            return 0;
        }
        let key = &text[key_start..i];
        i += 1;
        let (start, end) = if b.get(i) == Some(&b'"') {
            let end = string_end(b, i + 1).unwrap_or(b.len());
            let span = (i + 1, end);
            i = (end + 1).min(b.len());
            span
        } else {
            let start = i;
            while i < b.len() && !b[i].is_ascii_whitespace() {
                i += 1;
            }
            (start, i)
        };
        member(key, start, end);
        pairs += 1;
    }
}

// ---------------------------------------------------------------------------------------------
// FIX

/// Tags shown first, in this order.
const FIX_ORDER: [&str; 12] = [
    "52", "35", "49", "56", "34", "11", "55", "54", "38", "44", "39", "150",
];

fn fix_column(tag: &str) -> Column {
    let (name, kind) = match tag {
        "52" => ("SendingTime", ColumnKind::Timestamp),
        "35" => ("MsgType", ColumnKind::Text),
        "49" => ("SenderCompID", ColumnKind::Text),
        "56" => ("TargetCompID", ColumnKind::Text),
        "34" => ("MsgSeqNum", ColumnKind::Number),
        "11" => ("ClOrdID", ColumnKind::Text),
        "37" => ("OrderID", ColumnKind::Text),
        "17" => ("ExecID", ColumnKind::Text),
        "55" => ("Symbol", ColumnKind::Text),
        "54" => ("Side", ColumnKind::Text),
        "38" => ("OrderQty", ColumnKind::Number),
        "40" => ("OrdType", ColumnKind::Text),
        "44" => ("Price", ColumnKind::Number),
        "39" => ("OrdStatus", ColumnKind::Text),
        "150" => ("ExecType", ColumnKind::Text),
        "58" => ("Text", ColumnKind::Text),
        "60" => ("TransactTime", ColumnKind::Timestamp),
        "1" => ("Account", ColumnKind::Text),
        "14" => ("CumQty", ColumnKind::Number),
        "151" => ("LeavesQty", ColumnKind::Number),
        "6" => ("AvgPx", ColumnKind::Number),
        "31" => ("LastPx", ColumnKind::Number),
        "32" => ("LastQty", ColumnKind::Number),
        _ => {
            return Column::labelled(
                &format!("tag{tag}"),
                &format!("Tag {tag}"),
                ColumnKind::Text,
            )
        }
    };
    Column::labelled(&format!("tag{tag}"), name, kind)
}

fn fix_start(text: &str) -> Option<usize> {
    let window = &text.as_bytes()[..text.len().min(512)];
    memchr::memmem::find(window, b"8=FIX")
}

/// The text before `8=FIX`, without the separators around it.
fn fix_prefix(text: &str, start: usize) -> Option<(usize, usize)> {
    let head = &text[..start];
    let trimmed = head
        .trim_end_matches(|c: char| c.is_whitespace() || matches!(c, ':' | '|' | '-' | '>' | '<'));
    let lead = trimmed.len() - trimmed.trim_start().len();
    (trimmed.len() > lead).then_some((lead, trimmed.len()))
}

/// `tag=value` pairs after `start`, separated by SOH (`\x01`, shown as `|`) or `|`.
fn scan_fix(text: &str, start: usize, member: &mut dyn FnMut(&str, usize, usize)) {
    let b = text.as_bytes();
    let mut i = start;
    while i < b.len() {
        let end = (i..b.len())
            .find(|j| matches!(b[*j], 0x01 | b'|'))
            .unwrap_or(b.len());
        let pair = &text[i..end];
        if let Some(eq) = pair.find('=') {
            let tag = &pair[..eq];
            if !tag.is_empty() && tag.bytes().all(|c| c.is_ascii_digit()) {
                member(tag, i + eq + 1, end);
            }
        }
        i = end + 1;
    }
}

// ---------------------------------------------------------------------------------------------
// Detection

/// Result of the format detection for a session.
#[derive(Debug, Clone)]
pub struct FormatGuess {
    /// The profile whose layout fits, or the generic one for an inferred layout.
    pub profile_id: String,
    /// The regex the inference built, for taking it over into a custom profile.
    pub inferred_layout: Option<String>,
    /// Share of the entry heads of the sample that fit completely.
    pub confidence: f32,
    pub parser: FieldParser,
}

impl FormatGuess {
    /// The same format with the extraction rules of its profile (prompt 011).
    pub fn with_rules(&self, rules: &[ExtractRule]) -> Self {
        Self {
            profile_id: self.profile_id.clone(),
            inferred_layout: self.inferred_layout.clone(),
            confidence: self.confidence,
            parser: self.parser.with_rules(rules),
        }
    }

    pub fn none() -> Self {
        Self {
            profile_id: GENERIC_PROFILE.into(),
            inferred_layout: None,
            confidence: 0.0,
            parser: FieldParser::message_only(),
        }
    }
}

/// Share of the entry heads that fit the parser. Continuation lines (stack traces) do not count,
/// in the sense of the profile's own level detection.
pub fn confidence(parser: &FieldParser, detector: &LevelDetector, sample: &[&str]) -> f32 {
    let mut prev = PrevLine::default();
    let (mut heads, mut fitting, mut lines) = (0usize, 0usize, 0usize);
    for line in sample.iter().filter(|l| !l.is_empty()) {
        lines += 1;
        let (_, continuation) = detector.classify(line.as_bytes(), &mut prev);
        // Directives of W3C logs are no entries.
        if continuation
            || line.starts_with("#Fields:")
            || line.starts_with("#Software:")
            || line.starts_with("#Version:")
            || line.starts_with("#Date:")
        {
            continue;
        }
        heads += 1;
        if parser.matches(line) {
            fitting += 1;
        }
    }
    if heads == 0 || heads < MIN_HEADS.min(lines) {
        return 0.0;
    }
    fitting as f32 / heads as f32
}

/// The format of a file from a sample of its first lines: the best built-in layout if it fits at
/// least `MIN_CONFIDENCE`, otherwise an inferred one, otherwise a single `message`.
pub fn detect_format(sample: &[&str], profiles: &[Profile]) -> FormatGuess {
    let mut best = FormatGuess::none();
    for profile in profiles {
        if profile.id == GENERIC_PROFILE {
            continue;
        }
        let guess = format_of(profile, sample);
        if guess.confidence > best.confidence {
            best = guess;
        }
    }
    if best.confidence >= MIN_CONFIDENCE {
        return best;
    }
    let inferred = inferred_format(sample);
    let pick = if inferred.confidence >= best.confidence {
        inferred
    } else {
        best
    };
    if pick.confidence >= MIN_INFERRED_CONFIDENCE {
        pick
    } else {
        FormatGuess::none()
    }
}

/// The format for a profile the user chose: its own layout, or the inference if it has none.
pub fn format_for(profile: &Profile, sample: &[&str]) -> AppResult<FormatGuess> {
    if profile.structure == Structure::Regex && profile.layouts.is_empty() {
        let mut guess = inferred_format(sample);
        if guess.confidence < MIN_INFERRED_CONFIDENCE {
            guess = FormatGuess::none();
        }
        guess.profile_id = profile.id.clone();
        return Ok(guess);
    }
    let parser = FieldParser::for_profile(profile, sample)?;
    let detector = profile.detector()?;
    Ok(FormatGuess {
        profile_id: profile.id.clone(),
        inferred_layout: None,
        confidence: confidence(&parser, &detector, sample),
        parser,
    })
}

/// A profile's layout tried on one line, for the settings dialog. Checks the profile first.
pub fn preview(profile: &Profile, line: &str) -> AppResult<crate::model::FieldPreview> {
    profile.detector()?;
    let parser = FieldParser::for_profile(profile, &[line])?;
    Ok(crate::model::FieldPreview {
        columns: parser.columns().to_vec(),
        fields: parser.parse(line, false),
        matched: parser.matches(line),
    })
}

fn format_of(profile: &Profile, sample: &[&str]) -> FormatGuess {
    if profile.structure == Structure::Regex && profile.layouts.is_empty() {
        return FormatGuess::none();
    }
    format_for(profile, sample).unwrap_or_else(|_| FormatGuess::none())
}

fn generic_detector() -> LevelDetector {
    crate::profile::builtin_profiles()
        .into_iter()
        .find(|p| p.id == GENERIC_PROFILE)
        .and_then(|p| p.detector().ok())
        .expect("the generic profile is valid")
}

fn inferred_format(sample: &[&str]) -> FormatGuess {
    let Some(layout) = infer_layout(sample) else {
        return FormatGuess::none();
    };
    let Ok(regex) = RegexBuilder::new(&layout)
        .size_limit(LAYOUT_SIZE_LIMIT)
        .build()
    else {
        return FormatGuess::none();
    };
    let mut parser = FieldParser::regex(&[regex]);
    parser.detect_numbers(sample);
    let confidence = confidence(&parser, &generic_detector(), sample);
    FormatGuess {
        profile_id: GENERIC_PROFILE.into(),
        inferred_layout: Some(layout),
        confidence,
        parser,
    }
}

// ---------------------------------------------------------------------------------------------
// Inference

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Part {
    Timestamp(TsFormat, bool),
    Level(bool),
    Thread,
    /// `name:` (true) or `name -` (false).
    Logger(bool),
}

/// A layout for a file no built-in format fits: a delimiter (tab, `|`, `;`) with the same number of
/// fields on 95 % of the lines, otherwise from the left a timestamp, a level word, `[…]` as thread,
/// `name -` or `name:` as logger, the rest as message. `None` if nothing beyond the message is
/// recognisable. The result is a plain regex.
pub fn infer_layout(sample: &[&str]) -> Option<String> {
    let lines: Vec<&str> = sample
        .iter()
        .copied()
        .filter(|l| !l.trim().is_empty())
        .collect();
    if lines.is_empty() {
        return None;
    }
    infer_delimited(&lines).or_else(|| infer_parts(&lines))
}

fn infer_delimited(lines: &[&str]) -> Option<String> {
    for (sep, min_fields) in DELIMITERS {
        let mut counts: HashMap<usize, usize> = HashMap::new();
        for line in lines {
            *counts.entry(line.matches(sep).count() + 1).or_default() += 1;
        }
        let Some((&fields, &n)) = counts.iter().max_by_key(|(fields, n)| (**n, **fields)) else {
            continue;
        };
        if fields < min_fields || (n as f64) < lines.len() as f64 * DELIMITED_SHARE {
            continue;
        }
        let rows: Vec<Vec<&str>> = lines
            .iter()
            .map(|l| l.split(sep).map(str::trim).collect::<Vec<_>>())
            .filter(|r| r.len() == fields)
            .collect();
        let mut names: Vec<String> = Vec::with_capacity(fields);
        for i in 0..fields {
            let values = || rows.iter().map(|r| r[i]).filter(|v| !v.is_empty());
            let total = values().count().max(1);
            let times = values()
                .filter(|v| timestamp::recognise(v).is_some_and(|(_, len)| len == v.len()))
                .count();
            let levels = values()
                .filter(|v| crate::level::Level::from_word(v).is_some())
                .count();
            let has = |name: &str| names.iter().any(|n| n == name);
            let name = if times * 5 >= total * 4 && !has("timestamp") {
                "timestamp".to_string()
            } else if levels * 5 >= total * 4 && !has("level") {
                "level".to_string()
            } else if i == fields - 1 && !has("message") {
                "message".to_string()
            } else {
                format!("field{}", i + 1)
            };
            names.push(name);
        }
        let sep_re = regex::escape(&sep.to_string());
        let not_sep = if sep == '\t' {
            r"[^\t]".to_string()
        } else {
            format!("[^{sep_re}]")
        };
        let mut layout = String::from("^");
        for (i, name) in names.iter().enumerate() {
            if i + 1 == fields {
                layout.push_str(&format!(r"\s*(?P<{name}>.*?)\s*$"));
            } else {
                layout.push_str(&format!(r"\s*(?P<{name}>{not_sep}*?)\s*{sep_re}"));
            }
        }
        return Some(layout);
    }
    None
}

/// The parts at the start of one line, from the left.
fn line_parts(line: &str) -> Vec<Part> {
    let mut parts = Vec::new();
    let mut pos = 0usize;
    if let Some((format, len)) = timestamp::recognise(line) {
        parts.push(Part::Timestamp(format, line.starts_with('[')));
        pos = len;
    }
    let bytes = line.as_bytes();
    let (mut level, mut thread) = (false, false);
    for _ in 0..4 {
        while bytes.get(pos).is_some_and(|b| *b == b' ' || *b == b'\t') {
            pos += 1;
        }
        let rest = &line[pos..];
        if rest.starts_with('[') {
            let Some(close) = rest[..floor_char_boundary(rest, 80)].find(']') else {
                break;
            };
            let inner = rest[1..close].trim();
            if !level && crate::level::Level::from_word(inner).is_some() {
                level = true;
                parts.push(Part::Level(true));
            } else if !thread {
                thread = true;
                parts.push(Part::Thread);
            } else {
                break;
            }
            pos += close + 1;
            continue;
        }
        let word_end = rest.find([' ', '\t']).unwrap_or(rest.len());
        let word = &rest[..word_end];
        if word.is_empty() {
            break;
        }
        if !level
            && word.bytes().all(|b| b.is_ascii_alphabetic())
            && word.bytes().any(|b| b.is_ascii_uppercase())
            && crate::level::Level::from_word(word).is_some()
        {
            level = true;
            parts.push(Part::Level(false));
            pos += word_end;
            continue;
        }
        let name_like = |w: &str| {
            !w.is_empty()
                && w.bytes().next().is_some_and(|b| b.is_ascii_alphabetic())
                && w.bytes().all(|b| {
                    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'$' | b'-' | b'/')
                })
        };
        if let Some(name) = word.strip_suffix(':') {
            if name_like(name) {
                parts.push(Part::Logger(true));
            }
        } else if name_like(word) && rest[word_end..].starts_with(" - ") {
            parts.push(Part::Logger(false));
        }
        break;
    }
    parts
}

fn infer_parts(lines: &[&str]) -> Option<String> {
    let mut shapes: HashMap<Vec<Part>, usize> = HashMap::new();
    for line in lines {
        *shapes.entry(line_parts(line)).or_default() += 1;
    }
    let (shape, _) = shapes
        .into_iter()
        .filter(|(shape, _)| !shape.is_empty())
        .max_by_key(|(shape, n)| (*n, shape.len()))?;
    let bracket = |inner: String, bracketed: bool| {
        if bracketed {
            format!(r"\[{inner}\]")
        } else {
            inner
        }
    };
    let mut layout = String::from("^");
    for (i, part) in shape.iter().enumerate() {
        if i > 0 {
            layout.push_str(r"\s*");
        }
        let piece = match part {
            Part::Timestamp(format, bracketed) => {
                bracket(format!("(?P<timestamp>{})", format.regex()), *bracketed)
            }
            Part::Level(bracketed) => {
                bracket(format!(r"\s*(?P<level>(?i:{LEVEL_WORDS}))\s*"), *bracketed)
                    + if *bracketed { "" } else { r"\b" }
            }
            Part::Thread => r"\[(?P<thread>[^\]]*)\]".to_string(),
            Part::Logger(true) => r"(?P<logger>[A-Za-z][\w.$/-]*):".to_string(),
            Part::Logger(false) => r"(?P<logger>[A-Za-z][\w.$/-]*) -".to_string(),
        };
        layout.push_str(&piece);
    }
    layout.push_str(r"\s*(?P<message>.*)$");
    Some(layout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::builtin_profiles;

    fn profile(id: &str) -> Profile {
        builtin_profiles().into_iter().find(|p| p.id == id).unwrap()
    }

    fn parser(id: &str, sample: &[&str]) -> FieldParser {
        FieldParser::for_profile(&profile(id), sample).unwrap()
    }

    /// Field values by column id, empty fields left out.
    fn fields(parser: &FieldParser, text: &str) -> Vec<(String, String)> {
        let units: Vec<u16> = text.encode_utf16().collect();
        parser
            .parse(text, false)
            .iter()
            .zip(parser.columns())
            .filter(|([s, e], _)| e > s)
            .map(|([s, e], c)| {
                (
                    c.id.clone(),
                    String::from_utf16(&units[*s as usize..*e as usize]).unwrap(),
                )
            })
            .collect()
    }

    fn field<'a>(values: &'a [(String, String)], id: &str) -> Option<&'a str> {
        values
            .iter()
            .find(|(k, _)| k == id)
            .map(|(_, v)| v.as_str())
    }

    fn sample_file(name: &str) -> String {
        std::fs::read_to_string(format!("{}/../samples/{name}", env!("CARGO_MANIFEST_DIR")))
            .unwrap()
    }

    #[test]
    fn spring_boot_layout() {
        let p = parser("log4j", &[]);
        let v = fields(
            &p,
            "2026-01-15T10:00:07.334+01:00 ERROR 4711 --- [nio-8080-exec-2] c.a.shop.service.OrderService            : Could not place order",
        );
        assert_eq!(
            field(&v, "timestamp"),
            Some("2026-01-15T10:00:07.334+01:00")
        );
        assert_eq!(field(&v, "level"), Some("ERROR"));
        assert_eq!(field(&v, "pid"), Some("4711"));
        assert_eq!(field(&v, "thread"), Some("nio-8080-exec-2"));
        assert_eq!(field(&v, "logger"), Some("c.a.shop.service.OrderService"));
        assert_eq!(field(&v, "message"), Some("Could not place order"));
    }

    #[test]
    fn columns_come_from_what_the_sample_fills() {
        let text = sample_file("spring-boot.log");
        let lines: Vec<&str> = text.lines().collect();
        let p = parser("log4j", &lines);
        let ids: Vec<&str> = p.columns().iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            ids,
            ["timestamp", "level", "pid", "thread", "logger", "message"]
        );
        assert_eq!(p.columns()[2].kind, ColumnKind::Number);
        let logback = ["10:00:00.123 [main] WARN  c.a.App - careful"];
        let ids: Vec<String> = parser("log4j", &logback)
            .columns()
            .iter()
            .map(|c| c.id.clone())
            .collect();
        assert_eq!(ids, ["timestamp", "thread", "level", "logger", "message"]);
    }

    #[test]
    fn logback_and_log4j_layouts() {
        let p = parser("log4j", &[]);
        let v = fields(&p, "10:00:00.123 [main] WARN  c.a.App - careful");
        assert_eq!(field(&v, "timestamp"), Some("10:00:00.123"));
        assert_eq!(field(&v, "thread"), Some("main"));
        assert_eq!(field(&v, "level"), Some("WARN"));
        assert_eq!(field(&v, "logger"), Some("c.a.App"));
        assert_eq!(field(&v, "message"), Some("careful"));
        let v = fields(&p, "2024-01-15 10:00:00,123 ERROR [main] c.a.App - x");
        assert_eq!(field(&v, "thread"), Some("main"));
        assert_eq!(field(&v, "logger"), Some("c.a.App"));
        assert_eq!(field(&v, "message"), Some("x"));
    }

    #[test]
    fn python_serilog_syslog_webserver() {
        let v = fields(
            &parser("python", &[]),
            "2026-01-15 10:00:02,789 - app.db - WARNING - Slow query: 1532 ms",
        );
        assert_eq!(field(&v, "logger"), Some("app.db"));
        assert_eq!(field(&v, "level"), Some("WARNING"));
        assert_eq!(field(&v, "message"), Some("Slow query: 1532 ms"));
        let v = fields(&parser("python", &[]), "ERROR:root:boom");
        assert_eq!(
            (
                field(&v, "level"),
                field(&v, "logger"),
                field(&v, "message")
            ),
            (Some("ERROR"), Some("root"), Some("boom"))
        );

        let v = fields(&parser("serilog", &[]), "[10:00:00 WRN] careful");
        assert_eq!(
            (field(&v, "level"), field(&v, "message")),
            (Some("WRN"), Some("careful"))
        );
        let v = fields(
            &parser("serilog", &[]),
            "2024-01-15 10:00:00.000 +01:00 [FTL] gone",
        );
        assert_eq!(
            field(&v, "timestamp"),
            Some("2024-01-15 10:00:00.000 +01:00")
        );

        let v = fields(
            &parser("syslog", &[]),
            "Jan 15 10:00:00 host sshd[12]: Accepted key",
        );
        assert_eq!(field(&v, "host"), Some("host"));
        assert_eq!(field(&v, "logger"), Some("sshd"));
        assert_eq!(field(&v, "pid"), Some("12"));
        assert_eq!(field(&v, "message"), Some("Accepted key"));

        let v = fields(
            &parser("webserver", &[]),
            "2026/01/15 10:00:03 [error] 1234#1234: *3 open() failed",
        );
        assert_eq!(field(&v, "level"), Some("error"));
        assert_eq!(field(&v, "pid"), Some("1234"));
        assert_eq!(field(&v, "message"), Some("*3 open() failed"));
        let v = fields(
            &parser("webserver", &[]),
            "[Mon Jan 15 10:00:00.1 2024] [core:warn] [pid 1] x",
        );
        assert_eq!(field(&v, "level"), Some("warn"));
        assert_eq!(field(&v, "message"), Some("x"));
    }

    #[test]
    fn access_logs_nlog_gc() {
        let line = r#"10.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /a.gif HTTP/1.0" 200 2326 "http://example.com/" "Mozilla/4.08""#;
        let v = fields(&parser("access", &[]), line);
        assert_eq!(field(&v, "client"), Some("10.0.0.1"));
        assert_eq!(field(&v, "user"), Some("frank"));
        assert_eq!(field(&v, "timestamp"), Some("10/Oct/2000:13:55:36 -0700"));
        assert_eq!(field(&v, "request"), Some("GET /a.gif HTTP/1.0"));
        assert_eq!(field(&v, "status"), Some("200"));
        assert_eq!(field(&v, "agent"), Some("Mozilla/4.08"));

        let v = fields(
            &parser("nlog", &[]),
            "2026-01-15 10:00:00.1234|INFO|Shop.Api.Startup|Application started",
        );
        assert_eq!(field(&v, "logger"), Some("Shop.Api.Startup"));
        assert_eq!(field(&v, "message"), Some("Application started"));

        let p = parser("gc", &["[2026-01-15T10:00:00.123+0100][info][gc] GC(12) Pause Young (Normal) (G1 Evacuation Pause) 24M->4M(256M) 12.345ms"]);
        let v = fields(&p, "[2026-01-15T10:00:00.123+0100][info][gc] GC(12) Pause Young (Normal) (G1 Evacuation Pause) 24M->4M(256M) 12.345ms");
        assert_eq!(field(&v, "gc"), Some("12"));
        assert_eq!(field(&v, "duration_ms"), Some("12.345"));
        assert_eq!(field(&v, "tags"), Some("gc"));
        let duration = p.columns().iter().find(|c| c.id == "duration_ms").unwrap();
        assert_eq!(duration.kind, ColumnKind::Number);
    }

    #[test]
    fn utf16_spans_with_umlauts_and_emoji() {
        let p = parser("log4j", &[]);
        let text = "2024-01-15 10:00:00,123 ERROR [wörker-😀] c.ä.App - Größe 😀 ok";
        let v = fields(&p, text);
        assert_eq!(field(&v, "thread"), Some("wörker-😀"));
        assert_eq!(field(&v, "logger"), Some("c.ä.App"));
        assert_eq!(field(&v, "message"), Some("Größe 😀 ok"));
        let spans = p.parse(text, false);
        let total = text.encode_utf16().count() as u32;
        let message = p.columns().iter().position(|c| c.id == "message").unwrap();
        assert_eq!(spans[message][1], total);
    }

    #[test]
    fn a_line_that_does_not_fit_is_one_message() {
        let p = parser("log4j", &[]);
        let spans = p.parse("just text ä", false);
        let message = p.columns().iter().position(|c| c.id == "message").unwrap();
        for (i, span) in spans.iter().enumerate() {
            assert_eq!(*span, if i == message { [0, 11] } else { [0, 0] });
        }
        assert_eq!(p.whole_line("\tat x")[message], [0, 5]);
    }

    #[test]
    fn long_lines_are_split_in_the_first_16_kb_only() {
        let p = parser("log4j", &[]);
        let text = format!(
            "2024-01-15 10:00:00,123 INFO [main] a.B - {}",
            "ü".repeat(20_000)
        );
        let spans = p.parse(&text, false);
        let message = p.columns().iter().position(|c| c.id == "message").unwrap();
        assert_eq!(spans[message][1] as usize, text.encode_utf16().count());
        // Cut inside a multi-byte character: no panic.
        let odd = format!("x{}", "ü".repeat(MAX_PARSE_BYTES));
        p.parse(&odd, true);
    }

    #[test]
    fn json_columns_and_values() {
        let sample = sample_file("app.jsonl");
        let lines: Vec<&str> = sample.lines().collect();
        let p = parser("jsonl", &lines);
        let ids: Vec<&str> = p.columns().iter().map(|c| c.id.as_str()).collect();
        assert_eq!(&ids[..3], &["timestamp", "level", "message"]);
        assert!(ids.contains(&"pid") && ids.contains(&"url"));
        assert_eq!(
            p.columns().iter().find(|c| c.id == "pid").unwrap().kind,
            ColumnKind::Number
        );
        let v = fields(&p, lines[3]);
        assert_eq!(field(&v, "timestamp"), Some("2026-01-15T10:00:03.250Z"));
        assert_eq!(field(&v, "level"), Some("50"));
        assert_eq!(field(&v, "message"), Some("upstream returned 502"));
        // Aliases fold into the same column.
        let v = fields(&p, lines[5]);
        assert_eq!(field(&v, "message"), Some("GCP-style event"));
        assert_eq!(field(&v, "level"), Some("ERROR"));
    }

    #[test]
    fn json_escapes_nesting_quotes_in_keys_and_many_keys() {
        let line =
            r#"{"msg":"say \"hi\" \\ ok","ctx":{"a":[1,{"b":"}"}]},"we\"ird":true,"n":-1.5e3}"#;
        let p = parser("jsonl", &[line]);
        let v = fields(&p, line);
        assert_eq!(field(&v, "message"), Some(r#"say \"hi\" \\ ok"#));
        assert_eq!(field(&v, "ctx"), Some(r#"{"a":[1,{"b":"}"}]}"#));
        assert_eq!(field(&v, r#"we\"ird"#), Some("true"));
        assert_eq!(field(&v, "n"), Some("-1.5e3"));

        let many = format!(
            "{{{}}}",
            (0..20)
                .map(|i| format!(r#""k{i}":{i}"#))
                .collect::<Vec<_>>()
                .join(",")
        );
        let p = parser("jsonl", &[&many]);
        assert_eq!(p.columns().len(), MAX_KEY_COLUMNS);
        assert_eq!(fields(&p, &many).len(), MAX_KEY_COLUMNS);

        // Not JSON, or broken: one message.
        assert!(!p.matches("{\"a\":1"));
        assert!(!p.matches("plain"));
        let spans = p.parse("{\"k0\":\"open", true);
        assert_eq!(spans[0], [7, 11]);
    }

    #[test]
    fn logfmt_with_quotes() {
        let sample = [
            r#"time=2026-01-15T10:00:00Z level=info msg="server started" port=8080"#,
            r#"time=2026-01-15T10:00:01Z level=error msg="dial \"db\" failed" err=timeout"#,
        ];
        let p = parser("logfmt", &sample);
        let v = fields(&p, sample[1]);
        assert_eq!(field(&v, "timestamp"), Some("2026-01-15T10:00:01Z"));
        assert_eq!(field(&v, "level"), Some("error"));
        assert_eq!(field(&v, "message"), Some(r#"dial \"db\" failed"#));
        assert_eq!(field(&v, "err"), Some("timeout"));
        assert!(!p.matches("hello world"));
        assert!(!p.matches("a=1 stray b=2"));
    }

    #[test]
    fn fix_tags_become_columns() {
        let sample = sample_file("fix.log");
        let lines: Vec<&str> = sample.lines().collect();
        let p = parser("fix", &lines);
        let labels: Vec<&str> = p.columns().iter().map(|c| c.label.as_str()).collect();
        assert!(
            labels.contains(&"MsgType") && labels.contains(&"SenderCompID"),
            "{labels:?}"
        );
        let v = fields(&p, lines[0]);
        assert_eq!(field(&v, "tag35"), Some("A"));
        assert!(field(&v, "timestamp").is_some());
        let soh = "8=FIX.4.4\u{1}9=5\u{1}35=0\u{1}49=A\u{1}56=B\u{1}10=000\u{1}";
        let v = fields(&p, soh);
        assert_eq!(field(&v, "tag35"), Some("0"));
        assert_eq!(field(&v, "tag56"), Some("B"));
    }

    #[test]
    fn w3c_names_from_the_fields_directive() {
        let sample = sample_file("iis-w3c.log");
        let lines: Vec<&str> = sample.lines().collect();
        let p = parser("w3c", &lines);
        let ids: Vec<&str> = p.columns().iter().map(|c| c.id.as_str()).collect();
        assert_eq!(&ids[..4], &["date", "time", "s_ip", "cs_method"]);
        let line = lines.iter().find(|l| !l.starts_with('#')).unwrap();
        let v = fields(&p, line);
        assert_eq!(field(&v, "cs_method"), Some("GET"));
        assert!(!p.matches("#Fields: date time"));
    }

    #[test]
    fn inference_tsv_pipe_free_text_and_nothing() {
        let tsv = [
            "2026-01-15 10:00:00\tINFO\tstarted",
            "2026-01-15 10:00:01\tWARN\tslow",
        ];
        let layout = infer_layout(&tsv).unwrap();
        let guess = detect_format(&tsv, &builtin_profiles());
        assert_eq!(guess.inferred_layout.as_deref(), Some(layout.as_str()));
        let v = fields(&guess.parser, tsv[1]);
        assert_eq!(field(&v, "timestamp"), Some("2026-01-15 10:00:01"));
        assert_eq!(field(&v, "level"), Some("WARN"));
        assert_eq!(field(&v, "message"), Some("slow"));

        let pipe = ["a | 1 | x", "b | 2 | y y", "c | 3 | z"];
        let guess = detect_format(&pipe, &builtin_profiles());
        assert_eq!(guess.confidence, 1.0);
        let v = fields(&guess.parser, pipe[1]);
        assert_eq!(field(&v, "field1"), Some("b"));
        assert_eq!(field(&v, "message"), Some("y y"));
        assert_eq!(guess.parser.columns()[1].kind, ColumnKind::Number);

        let free = [
            "12:00:01.5 <worker-1> NOTE engine: warmed up",
            "2026-01-15 12:00:01 [pool-1] Info engine: ready",
            "2026-01-15 12:00:02 [pool-2] Warn engine: slow",
            "2026-01-15 12:00:03 [pool-1] Info cache: hit",
        ];
        let guess = detect_format(&free, &builtin_profiles());
        assert!(guess.inferred_layout.is_some(), "{guess:?}");
        assert!(guess.confidence >= 0.7, "{}", guess.confidence);
        let v = fields(&guess.parser, free[2]);
        assert_eq!(field(&v, "thread"), Some("pool-2"));
        assert_eq!(field(&v, "level"), Some("Warn"));
        assert_eq!(field(&v, "logger"), Some("engine"));
        assert_eq!(field(&v, "message"), Some("slow"));

        let nothing = ["hello world", "some more text", "and a last line"];
        assert_eq!(infer_layout(&nothing), None);
        let guess = detect_format(&nothing, &builtin_profiles());
        assert_eq!(guess.confidence, 0.0);
        assert_eq!(guess.parser.columns().len(), 1);
        assert!(
            detect_format(&[], &builtin_profiles())
                .parser
                .columns()
                .len()
                == 1
        );
    }

    #[test]
    fn stack_traces_do_not_lower_the_confidence() {
        let mut lines = vec!["2024-01-15 10:00:00,123 ERROR [main] c.a.App - boom"];
        lines.extend(std::iter::repeat_n("\tat com.acme.App.run(App.java:1)", 40));
        lines.push("java.lang.IllegalStateException: boom");
        lines.push("2024-01-15 10:00:01,123 INFO [main] c.a.App - fine");
        let guess = detect_format(&lines, &builtin_profiles());
        assert_eq!(guess.profile_id, "log4j");
        assert_eq!(guess.confidence, 1.0);
    }

    /// Foreign data: no input may make a scanner panic, and the spans always fit the text.
    #[test]
    fn garbage_never_panics() {
        let pieces = [
            "{",
            "}",
            "[",
            "]",
            "\"",
            "\\",
            ":",
            ",",
            "=",
            " ",
            "\t",
            "|",
            "\u{1}",
            "8=FIX",
            "35=",
            "ä",
            "😀",
            "2024-01-15 10:00:00,123",
            "ERROR",
            "[main]",
            "a.B",
            " - ",
            "#Fields: a b",
        ];
        let profiles = builtin_profiles();
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut lines = Vec::new();
        for _ in 0..400 {
            let mut line = String::new();
            for _ in 0..(seed % 24) {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                line.push_str(pieces[(seed % pieces.len() as u64) as usize]);
            }
            lines.push(line);
        }
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        for profile in &profiles {
            let parser = FieldParser::for_profile(profile, &refs).unwrap();
            for line in &refs {
                let units = line.encode_utf16().count() as u32;
                for truncated in [false, true] {
                    let spans = parser.parse(line, truncated);
                    assert_eq!(spans.len(), parser.columns().len());
                    assert!(spans.iter().all(|[s, e]| s <= e && *e <= units), "{line:?}");
                }
            }
        }
        detect_format(&refs, &profiles);
        infer_layout(&refs);
    }

    /// Every sample is recognised as its own format, and no other format claims it.
    #[test]
    fn samples_matrix() {
        let expected = [
            ("spring-boot.log", "log4j"),
            ("python.log", "python"),
            ("nginx-error.log", "webserver"),
            ("app.jsonl", "jsonl"),
            ("access.log", "access"),
            ("iis-w3c.log", "w3c"),
            ("nlog.log", "nlog"),
            ("gc.log", "gc"),
            ("fix.log", "fix"),
            ("logfmt.log", "logfmt"),
            ("serilog.log", "serilog"),
            ("syslog.log", "syslog"),
            ("syslog-received.log", "syslog-received"),
        ];
        let profiles = builtin_profiles();
        for (file, id) in expected {
            let text = sample_file(file);
            let lines: Vec<&str> = text.lines().take(200).collect();
            let guess = detect_format(&lines, &profiles);
            assert_eq!(guess.profile_id, id, "{file}");
            assert!(
                guess.confidence >= MIN_CONFIDENCE,
                "{file}: {}",
                guess.confidence
            );
            println!("{file}: {id} {:.0} %", guess.confidence * 100.0);
            for other in &profiles {
                if other.id == id || other.id == GENERIC_PROFILE {
                    continue;
                }
                let theirs = format_of(other, &lines).confidence;
                assert!(
                    theirs < MIN_CONFIDENCE,
                    "{file} also fits {}: {theirs}",
                    other.id
                );
            }
        }
    }
}
