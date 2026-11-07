//! Fields taken out of the text of a column (prompt 011): `cpu=72.3%`, `took 340ms` become columns
//! of their own without changing the file. A rule is a regex with exactly one group, run over the
//! span of its source column when lines are delivered (`get_lines`) or filtered; nothing is stored
//! per line, the index stays at 16 bytes per line.
//!
//! Rules belong to a profile (they describe a format) and live in the `RuleBook` the sessions share.
//! `parse_value` turns a value into a number in a base unit (bytes, seconds) so `340ms` and `1.2s`
//! compare. `suggest` finds candidates in a sample of entry heads.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::fields::{Column, ColumnKind};
use parking_lot::RwLock;
use regex::{Regex, RegexBuilder, RegexSet, RegexSetBuilder};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

/// Hard limit of rules per profile; the dialog says so.
pub const MAX_RULES: usize = 32;
/// From this many rules on one source column, a `RegexSet` decides which rules run at all.
const PREFILTER_FROM: usize = 5;
pub const MAX_NAME_CHARS: usize = 40;
pub const MAX_PATTERN_CHARS: usize = 4096;
const REGEX_SIZE_LIMIT: usize = 1024 * 1024;
/// Entry heads `suggest_fields` reads, spread over the whole file.
pub const SUGGEST_SAMPLE: usize = 2000;
pub const MAX_SUGGESTIONS: usize = 10;
/// A suggestion needs this share of the sampled heads.
const MIN_SHARE: f64 = 0.05;
const MAX_EXAMPLES: usize = 3;

/// What the value of a rule is; numbers are compared in a base unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ValueKind {
    #[default]
    Text,
    Number,
    Percent,
    /// Seconds.
    Duration,
    /// Bytes.
    Size,
}

impl ValueKind {
    pub fn column_kind(self) -> ColumnKind {
        match self {
            ValueKind::Text => ColumnKind::Text,
            ValueKind::Number => ColumnKind::Number,
            ValueKind::Percent => ColumnKind::Percent,
            ValueKind::Duration => ColumnKind::Duration,
            ValueKind::Size => ColumnKind::Size,
        }
    }

    pub fn of_column(kind: ColumnKind) -> Option<Self> {
        match kind {
            ColumnKind::Number => Some(ValueKind::Number),
            ColumnKind::Percent => Some(ValueKind::Percent),
            ColumnKind::Duration => Some(ValueKind::Duration),
            ColumnKind::Size => Some(ValueKind::Size),
            _ => None,
        }
    }
}

fn message_column() -> String {
    "message".into()
}

/// One extracted field. The column id is the name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractRule {
    pub id: String,
    pub name: String,
    /// Id of the column the regex runs over.
    #[serde(default = "message_column")]
    pub column: String,
    pub pattern: String,
    #[serde(default)]
    pub kind: ValueKind,
    /// Unit of a value written without one (`took (\d+)ms` → `ms`).
    #[serde(default)]
    pub unit: Option<String>,
}

/// A suggestion of `suggest_fields`: a finished rule, what it finds and how often.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldSuggestion {
    pub rule: ExtractRule,
    pub examples: Vec<String>,
    /// Share of the sampled entry heads with a value.
    pub share: f32,
    pub distinct: usize,
}

/// What a rule finds in some lines, for the dialog's preview: span of the value (UTF-16) and its number.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulePreview {
    pub spans: Vec<Option<[u32; 2]>>,
    pub values: Vec<Option<f64>>,
}

fn rule_error(rule: &ExtractRule, message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidRule, message).with_node(&rule.id)
}

fn compile(rule: &ExtractRule) -> AppResult<Regex> {
    if rule.pattern.chars().count() > MAX_PATTERN_CHARS {
        return Err(rule_error(
            rule,
            format!("pattern too long (at most {MAX_PATTERN_CHARS} characters)"),
        ));
    }
    let regex = RegexBuilder::new(&rule.pattern)
        .size_limit(REGEX_SIZE_LIMIT)
        .dfa_size_limit(REGEX_SIZE_LIMIT)
        .build()
        .map_err(|e| rule_error(rule, e.to_string()))?;
    // Group 0 is the whole match.
    if regex.captures_len() != 2 {
        return Err(rule_error(
            rule,
            format!(
                "the pattern needs exactly one group, it has {}",
                regex.captures_len() - 1
            ),
        ));
    }
    Ok(regex)
}

/// Checks one rule on its own: name, source, pattern with one group, unit only for numbers.
pub fn check_rule(rule: &ExtractRule) -> AppResult<Regex> {
    let name = rule.name.trim();
    if name.is_empty() {
        return Err(rule_error(rule, "the name is missing"));
    }
    if name != rule.name || name.chars().count() > MAX_NAME_CHARS {
        return Err(rule_error(
            rule,
            format!("invalid name (1 to {MAX_NAME_CHARS} characters, no spaces around it)"),
        ));
    }
    if rule.column.trim().is_empty() {
        return Err(rule_error(rule, "the source column is missing"));
    }
    if rule.unit.as_deref().is_some_and(|u| u.chars().count() > 16) {
        return Err(rule_error(rule, "unit too long"));
    }
    compile(rule)
}

/// Checks the rules of a profile against each other and against the columns of the format: at most
/// `MAX_RULES`, unique names, none named like a column. Nothing is renamed silently.
pub fn validate(rules: &[ExtractRule], base: &[Column]) -> AppResult<()> {
    if rules.len() > MAX_RULES {
        return Err(rule_error(
            &rules[MAX_RULES],
            format!("at most {MAX_RULES} rules per format"),
        ));
    }
    let mut names = HashSet::new();
    let mut ids = HashSet::new();
    for rule in rules {
        check_rule(rule)?;
        if !ids.insert(rule.id.as_str()) {
            return Err(rule_error(rule, "duplicate rule id"));
        }
        if !names.insert(rule.name.to_lowercase()) {
            return Err(rule_error(
                rule,
                format!("the name {} is used twice", rule.name),
            ));
        }
        if let Some(column) = collides(&rule.name, base) {
            return Err(rule_error(
                rule,
                format!(
                    "the name {} is a column of the format already",
                    column.label
                ),
            ));
        }
    }
    Ok(())
}

/// The column of the format a name would be mistaken for (id or label, ignoring case).
fn collides<'a>(name: &str, base: &'a [Column]) -> Option<&'a Column> {
    let lower = name.to_lowercase();
    base.iter()
        .find(|c| c.id.to_lowercase() == lower || c.label.to_lowercase() == lower)
}

/// The rules of every profile, shared by the manager and all sessions.
#[derive(Debug, Default)]
pub struct RuleBook {
    rules: RwLock<HashMap<String, Arc<Vec<ExtractRule>>>>,
}

impl RuleBook {
    pub fn get(&self, profile_id: &str) -> Arc<Vec<ExtractRule>> {
        self.rules
            .read()
            .get(profile_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn set(&self, profile_id: &str, rules: Vec<ExtractRule>) {
        let mut book = self.rules.write();
        if rules.is_empty() {
            book.remove(profile_id);
        } else {
            book.insert(profile_id.to_string(), Arc::new(rules));
        }
    }

    /// Everything from the settings at start: a rule that does not pass on its own is left out
    /// (its error went to the user when it was saved); the profiles that keep rules are returned.
    pub fn load(&self, all: HashMap<String, Vec<ExtractRule>>) -> Vec<String> {
        let mut book = self.rules.write();
        book.clear();
        for (profile, rules) in all {
            let mut names = HashSet::new();
            let valid: Vec<ExtractRule> = rules
                .into_iter()
                .filter(|r| check_rule(r).is_ok() && names.insert(r.name.to_lowercase()))
                .take(MAX_RULES)
                .collect();
            if !valid.is_empty() {
                book.insert(profile, Arc::new(valid));
            }
        }
        book.keys().cloned().collect()
    }
}

/// One compiled rule of a parser.
#[derive(Debug, Clone)]
pub struct Extractor {
    pub rule: ExtractRule,
    regex: Regex,
    /// Index of the source column among the columns of the format; `None` if it has no such column.
    source: Option<usize>,
}

/// The rules of a parser, grouped by source column, with a `RegexSet` as prefilter for many rules.
#[derive(Debug, Clone, Default)]
pub struct Extractors {
    list: Vec<Extractor>,
    /// Per source column: the extractors (indices) and, for many, a set that says which may match.
    groups: Vec<(usize, Vec<usize>, Option<RegexSet>)>,
}

impl Extractors {
    /// Compiles rules for a format with the columns `base`. A rule that fails or collides with a
    /// column of this format is left out (another file of the same profile may have other keys).
    pub fn build(rules: &[ExtractRule], base: &[Column]) -> Self {
        let mut list = Vec::new();
        let mut names = HashSet::new();
        for rule in rules.iter().take(MAX_RULES) {
            if collides(&rule.name, base).is_some() || !names.insert(rule.name.to_lowercase()) {
                continue;
            }
            let Ok(regex) = check_rule(rule) else {
                continue;
            };
            list.push(Extractor {
                rule: rule.clone(),
                regex,
                source: base.iter().position(|c| c.id == rule.column),
            });
        }
        let mut groups: Vec<(usize, Vec<usize>, Option<RegexSet>)> = Vec::new();
        for (i, extractor) in list.iter().enumerate() {
            let Some(source) = extractor.source else {
                continue;
            };
            match groups.iter_mut().find(|(s, _, _)| *s == source) {
                Some((_, members, _)) => members.push(i),
                None => groups.push((source, vec![i], None)),
            }
        }
        for (_, members, set) in &mut groups {
            if members.len() >= PREFILTER_FROM {
                *set = RegexSetBuilder::new(members.iter().map(|&i| list[i].regex.as_str()))
                    .size_limit(REGEX_SIZE_LIMIT * 4)
                    .dfa_size_limit(REGEX_SIZE_LIMIT * 4)
                    .build()
                    .ok();
            }
        }
        Self { list, groups }
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    pub fn columns(&self) -> impl Iterator<Item = Column> + '_ {
        self.list.iter().map(|e| Column {
            id: e.rule.name.clone(),
            label: e.rule.name.clone(),
            kind: e.rule.kind.column_kind(),
            unit: e.rule.unit.clone(),
            rule: Some(e.rule.id.clone()),
        })
    }

    pub fn rule(&self, i: usize) -> Option<&ExtractRule> {
        self.list.get(i).map(|e| &e.rule)
    }

    /// Fills `out[i]` (byte spans in `text`) for every rule from the spans of the columns. A source
    /// span past `limit` bytes is cut there (16 KB, as the layout).
    pub fn fill(&self, text: &str, base: &[[usize; 2]], limit: usize, out: &mut [[usize; 2]]) {
        for (source, members, set) in &self.groups {
            let Some([start, end]) = base.get(*source).copied() else {
                continue;
            };
            let end = floor_boundary(text, end.min(limit));
            if end <= start {
                continue;
            }
            let part = &text[start..end];
            match set {
                Some(set) => {
                    let hits = set.matches(part);
                    if !hits.matched_any() {
                        continue;
                    }
                    for k in hits.iter() {
                        let i = members[k];
                        out[i] = self.list[i]
                            .find(part)
                            .map_or([0, 0], |[s, e]| [s + start, e + start]);
                    }
                }
                None => {
                    for &i in members {
                        out[i] = self.list[i]
                            .find(part)
                            .map_or([0, 0], |[s, e]| [s + start, e + start]);
                    }
                }
            }
        }
    }

    /// The value of one rule in a line, from the spans of the columns.
    pub fn value<'a>(
        &self,
        i: usize,
        text: &'a str,
        base: &[[usize; 2]],
        limit: usize,
    ) -> Option<&'a str> {
        let extractor = self.list.get(i)?;
        let [start, end] = *base.get(extractor.source?)?;
        let end = floor_boundary(text, end.min(limit));
        if end <= start {
            return None;
        }
        let [s, e] = extractor.find(&text[start..end])?;
        Some(&text[start + s..start + e])
    }
}

impl Extractor {
    /// The group of the first match; an empty group is no value.
    fn find(&self, text: &str) -> Option<[usize; 2]> {
        let mut locations = self.regex.capture_locations();
        self.regex.captures_read(&mut locations, text)?;
        let (s, e) = locations.get(1)?;
        (e > s).then_some([s, e])
    }
}

fn floor_boundary(text: &str, at: usize) -> usize {
    if at >= text.len() {
        return text.len();
    }
    (0..=at)
        .rev()
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(0)
}

/// A rule tried on some lines (the whole line is the source), for the preview of the dialog.
pub fn preview(rule: &ExtractRule, lines: &[String]) -> AppResult<RulePreview> {
    let regex = check_rule(rule)?;
    let extractor = Extractor {
        rule: rule.clone(),
        regex,
        source: Some(0),
    };
    let mut spans = Vec::with_capacity(lines.len());
    let mut values = Vec::with_capacity(lines.len());
    for line in lines {
        let end = floor_boundary(line, crate::fields::MAX_PARSE_BYTES);
        match extractor.find(&line[..end]) {
            Some([s, e]) => {
                let utf16 = |b: usize| line[..b].encode_utf16().count() as u32;
                spans.push(Some([utf16(s), utf16(e)]));
                values.push(parse_value(&line[s..e], rule.kind, rule.unit.as_deref()));
            }
            None => {
                spans.push(None);
                values.push(None);
            }
        }
    }
    Ok(RulePreview { spans, values })
}

// ---------------------------------------------------------------------------------------------
// Values

/// Factor of a duration unit to seconds.
fn duration_factor(unit: &str) -> Option<f64> {
    Some(match unit {
        "ns" => 1e-9,
        "us" | "µs" | "μs" => 1e-6,
        "ms" => 1e-3,
        "s" | "sec" | "secs" | "second" | "seconds" => 1.0,
        "m" | "min" | "mins" | "minute" | "minutes" => 60.0,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3600.0,
        "d" | "day" | "days" => 86400.0,
        _ => return None,
    })
}

/// Factor of a size unit to bytes. Logs mean steps of 1024 with `KB` as well (JVM, Linux tools).
fn size_factor(unit: &str) -> Option<f64> {
    let lower = unit.to_ascii_lowercase();
    let step = match lower.as_str() {
        "b" | "byte" | "bytes" => 0,
        "k" | "kb" | "kib" => 1,
        "m" | "mb" | "mib" => 2,
        "g" | "gb" | "gib" => 3,
        "t" | "tb" | "tib" => 4,
        _ => return None,
    };
    Some(1024f64.powi(step))
}

fn unit_class(unit: &str) -> Option<ValueKind> {
    if unit == "%" {
        Some(ValueKind::Percent)
    } else if duration_factor(unit).is_some() {
        Some(ValueKind::Duration)
    } else if size_factor(unit).is_some() {
        Some(ValueKind::Size)
    } else {
        None
    }
}

/// A number as logs write it. `,` and `.` count as decimal separator only where that is clear:
/// `1,5` and `1.5` are 1.5, `1,234` could be a thousand and is no value; with both, the last one is
/// the decimal separator. Spaces and `'` group thousands (`1 024`).
fn parse_number(text: &str) -> Option<f64> {
    let (negative, digits) = match text.as_bytes().first()? {
        b'-' => (true, &text[1..]),
        b'+' => (false, &text[1..]),
        _ => (false, text),
    };
    if digits.is_empty() || !digits.as_bytes()[0].is_ascii_digit() {
        return None;
    }
    let groups_ok = |parts: &[&str]| {
        !parts[0].is_empty()
            && parts[0].len() <= 3
            && parts[1..].iter().all(|p| p.len() == 3)
            && parts.iter().all(|p| p.bytes().all(|b| b.is_ascii_digit()))
    };
    let split_groups = |s: &str, sep: &[char]| -> Option<String> {
        let parts: Vec<&str> = s.split(sep).collect();
        if parts.len() == 1 {
            return parts[0]
                .bytes()
                .all(|b| b.is_ascii_digit())
                .then(|| parts[0].to_string());
        }
        groups_ok(&parts).then(|| parts.concat())
    };
    let space: &[char] = &[' ', '\u{a0}', '\u{202f}', '\''];
    let commas = digits.matches(',').count();
    let dots = digits.matches('.').count();
    let (int, frac) = match (commas, dots) {
        (0, 0) => (split_groups(digits, space)?, None),
        (_, 0) | (0, _) => {
            let sep = if commas > 0 { ',' } else { '.' };
            let count = commas + dots;
            if count > 1 {
                // Only grouping: 1,234,567.
                let joined = split_groups(digits, &[sep])?;
                (joined, None)
            } else {
                let (a, b) = digits.split_once(sep)?;
                if sep == ',' && b.len() == 3 {
                    // 1,234: a thousand or one point two three four.
                    return None;
                }
                (split_groups(a, space)?, Some(b.to_string()))
            }
        }
        _ => {
            let last_comma = digits.rfind(',')?;
            let last_dot = digits.rfind('.')?;
            let (group, decimal) = if last_comma > last_dot {
                ('.', ',')
            } else {
                (',', '.')
            };
            let (a, b) = digits.rsplit_once(decimal)?;
            if a.contains(decimal) {
                return None;
            }
            (split_groups(a, &[group])?, Some(b.to_string()))
        }
    };
    let mut number = int;
    if let Some(frac) = frac {
        if frac.is_empty() || !frac.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        number.push('.');
        number.push_str(&frac);
    }
    let value: f64 = number.parse().ok()?;
    value
        .is_finite()
        .then_some(if negative { -value } else { value })
}

/// The value of a field as a number in the base unit of its kind: seconds for durations, bytes for
/// sizes, the percentage itself for percent. `unit` is what a value without unit means. `None` for
/// text, an empty field, an unclear number or a unit that does not fit.
pub fn parse_value(text: &str, kind: ValueKind, rule_unit: Option<&str>) -> Option<f64> {
    if kind == ValueKind::Text {
        return None;
    }
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    // Split into number and unit: the unit starts at the first letter or `%`.
    let at = text
        .char_indices()
        .find(|(_, c)| c.is_alphabetic() || *c == '%' || *c == 'µ' || *c == 'μ')
        .map_or(text.len(), |(i, _)| i);
    let number = parse_number(text[..at].trim_end())?;
    let suffix = text[at..].trim();
    let unit = if suffix.is_empty() {
        rule_unit.map(str::trim).unwrap_or("")
    } else {
        suffix
    };
    let factor = match kind {
        ValueKind::Text => return None,
        ValueKind::Number => {
            // A number keeps its own unit (`rps`), but only the one of the rule.
            if !suffix.is_empty()
                && !rule_unit.is_some_and(|u| suffix.eq_ignore_ascii_case(u.trim()))
            {
                return None;
            }
            1.0
        }
        ValueKind::Percent => {
            if !unit.is_empty() && unit != "%" {
                return None;
            }
            1.0
        }
        ValueKind::Duration => duration_factor(unit)?,
        ValueKind::Size => size_factor(unit)?,
    };
    Some(number * factor)
}

// ---------------------------------------------------------------------------------------------
// Suggestions

/// `name=value` and `name: value`, the value a number with an optional unit.
static KEY_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?P<name>[A-Za-z_][A-Za-z0-9_.\-]{0,39})[ \t]*[=:][ \t]*(?P<num>[-+]?\d+(?:[.,]\d+)*)(?P<unit>[ \t]?(?:%|[A-Za-zµμ]{1,7}))?")
        .expect("valid regex")
});
/// `took 340ms`, `CPU 72%`: a word, a number and a unit that says what it is.
static WORD_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?P<name>[A-Za-z_][A-Za-z0-9_\-]{0,39})[ \t]+(?P<num>[-+]?\d+(?:[.,]\d+)*)(?P<unit>[ \t]?(?:%|[A-Za-zµμ]{1,7}))")
        .expect("valid regex")
});
/// Names that say "identifier", "position" or "time", not "measurement".
static NOT_A_MEASURE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:.*[_.\-])?(?:id|ids|uuid|guid|pid|tid|ppid|uid|gid|port|line|lineno|seq|serial|no|nr|num|number|version|ver|v|code|status|year|month|day|hour|minute|second|ts|time|timestamp|date|epoch|at|on|from|to|of|in|by|is|for|with|java|http|https|row|col|column|index|idx|offset|page|rank)$|(?-i:[a-z]Id|ID)$")
        .expect("valid regex")
});

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Style {
    KeyValue,
    Word,
}

#[derive(Default)]
struct Candidate {
    names: HashMap<String, usize>,
    lines: usize,
    /// Occurrences per unit class (`None` = no unit).
    classes: HashMap<Option<ValueKind>, usize>,
    units: HashMap<String, usize>,
    separators: HashMap<char, usize>,
    raw: Vec<(String, String)>,
    examples: Vec<String>,
}

/// Where a value may end: not inside a word, a time (`12:30`), a date (`2024-01-15`) or a version.
fn ends_cleanly(text: &str, end: usize) -> bool {
    let rest = &text[end..];
    let mut chars = rest.chars();
    match chars.next() {
        None => true,
        Some(c) if c.is_alphanumeric() || c == '_' => false,
        Some(':' | '-' | '/') => false,
        Some('.') => !chars.next().is_some_and(|c| c.is_ascii_digit()),
        Some(_) => true,
    }
}

fn starts_cleanly(text: &str, start: usize) -> bool {
    text[..start]
        .chars()
        .next_back()
        .is_none_or(|c| !(c.is_alphanumeric() || c == '_' || c == '.' || c == '-'))
}

/// Candidates for rules in the source text of sampled entry heads (`message`, mostly). Names that
/// are columns already (`existing`) are left out, as are constants, rare fields, identifiers and
/// times. At most `MAX_SUGGESTIONS`, the most frequent and most varied first.
pub fn suggest(heads: &[&str], existing: &[Column], source: &str) -> Vec<FieldSuggestion> {
    if heads.is_empty() {
        return Vec::new();
    }
    let mut candidates: HashMap<(String, Style), Candidate> = HashMap::new();
    for head in heads {
        let head = &head[..floor_boundary(head, crate::fields::MAX_PARSE_BYTES)];
        let mut seen: HashSet<(String, Style)> = HashSet::new();
        for (style, regex) in [(Style::KeyValue, &*KEY_VALUE), (Style::Word, &*WORD_VALUE)] {
            let mut pos = 0;
            while let Some(caps) = regex.captures_at(head, pos) {
                let (Some(name), Some(num)) = (caps.name("name"), caps.name("num")) else {
                    break;
                };
                // A match that is no field may hide the next one in its "unit" (`id=7 cpu=5%`): the
                // search goes on right after the number.
                pos = num.end();
                let unit_match = caps.name("unit");
                let end = unit_match.map_or(num.end(), |u| u.end());
                if !starts_cleanly(head, name.start()) || !ends_cleanly(head, end) {
                    continue;
                }
                let unit = unit_match.map(|u| u.as_str().trim().to_string());
                let class = match unit.as_deref() {
                    None => None,
                    Some(u) => match unit_class(u) {
                        Some(class) => Some(class),
                        // An unknown unit (`5rps`) is no measurement this knows how to compare.
                        None => continue,
                    },
                };
                if style == Style::Word && class.is_none() {
                    continue;
                }
                let key = (name.as_str().to_lowercase(), style);
                if !seen.insert(key.clone()) {
                    continue;
                }
                let candidate = candidates.entry(key).or_default();
                *candidate
                    .names
                    .entry(name.as_str().to_string())
                    .or_default() += 1;
                candidate.lines += 1;
                *candidate.classes.entry(class).or_default() += 1;
                if let Some(u) = &unit {
                    *candidate.units.entry(u.clone()).or_default() += 1;
                }
                if style == Style::KeyValue {
                    let between = &head[name.end()..num.start()];
                    if let Some(sep) = between.chars().find(|c| *c == '=' || *c == ':') {
                        *candidate.separators.entry(sep).or_default() += 1;
                    }
                }
                let value = &head[num.start()..end];
                if candidate.raw.len() < 4000 {
                    candidate
                        .raw
                        .push((num.as_str().to_string(), unit.clone().unwrap_or_default()));
                }
                if candidate.examples.len() < MAX_EXAMPLES
                    && !candidate.examples.iter().any(|e| e == value)
                {
                    candidate.examples.push(value.to_string());
                }
            }
        }
    }
    let total = heads.len() as f64;
    let mut out: Vec<FieldSuggestion> = Vec::new();
    let mut taken: HashSet<String> = HashSet::new();
    for ((lower, style), candidate) in candidates {
        let share = candidate.lines as f64 / total;
        if share < MIN_SHARE || collides(&lower, existing).is_some() {
            continue;
        }
        let name = candidate
            .names
            .iter()
            .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
            .map(|(n, _)| n.clone())
            .unwrap_or(lower.clone());
        if NOT_A_MEASURE.is_match(&name) {
            continue;
        }
        let class = candidate
            .classes
            .iter()
            .max_by(|a, b| {
                a.1.cmp(b.1)
                    .then_with(|| class_rank(*b.0).cmp(&class_rank(*a.0)))
            })
            .map(|(c, _)| *c)
            .unwrap_or(None);
        let kind = class.unwrap_or(ValueKind::Number);
        let unit_optional = candidate.classes.get(&None).copied().unwrap_or(0) > 0;
        let default_unit = candidate
            .units
            .iter()
            .filter(|(u, _)| unit_class(u) == class)
            .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
            .map(|(u, _)| u.clone());
        // Values in the base unit, for the spread; identifiers and epoch times are no measurements.
        let mut distinct: HashSet<u64> = HashSet::new();
        let (mut integers, mut long) = (0usize, 0usize);
        let mut values = 0usize;
        for (num, unit) in &candidate.raw {
            if unit_class(unit) != class && !(unit.is_empty() && unit_optional) {
                continue;
            }
            let written = if unit.is_empty() {
                None
            } else {
                Some(unit.as_str())
            };
            let Some(v) = parse_value(
                &format!("{num}{}", written.unwrap_or("")),
                kind,
                default_unit.as_deref(),
            ) else {
                continue;
            };
            values += 1;
            distinct.insert(v.to_bits());
            if !num.contains(['.', ',']) {
                integers += 1;
                if num.trim_start_matches(['-', '+']).len() >= 9 {
                    long += 1;
                }
            }
        }
        if distinct.len() < 2 || values == 0 {
            continue;
        }
        if class.is_none()
            && integers == values
            && (long * 2 > values || (values >= 20 && distinct.len() * 100 >= values * 95))
        {
            continue;
        }
        if !taken.insert(name.to_lowercase()) {
            // The same name as `key=` and as `word value`: the first (more frequent) wins below.
            continue;
        }
        let separator = candidate
            .separators
            .iter()
            .max_by_key(|(_, n)| **n)
            .map(|(c, _)| *c);
        let rule = ExtractRule {
            id: format!("s-{}", lower),
            name: name.clone(),
            column: source.to_string(),
            pattern: rule_pattern(&name, style, separator, class, unit_optional),
            kind,
            unit: default_unit,
        };
        out.push(FieldSuggestion {
            rule,
            examples: candidate.examples,
            share: share as f32,
            distinct: distinct.len(),
        });
    }
    out.sort_by(|a, b| {
        b.share
            .total_cmp(&a.share)
            .then(b.distinct.cmp(&a.distinct))
            .then(a.rule.name.cmp(&b.rule.name))
    });
    out.truncate(MAX_SUGGESTIONS);
    out
}

fn class_rank(class: Option<ValueKind>) -> u8 {
    match class {
        Some(ValueKind::Duration) => 0,
        Some(ValueKind::Size) => 1,
        Some(ValueKind::Percent) => 2,
        _ => 3,
    }
}

const NUMBER_PATTERN: &str = r"[-+]?\d+(?:[.,]\d+)*";

fn unit_pattern(class: Option<ValueKind>) -> &'static str {
    match class {
        Some(ValueKind::Percent) => r"[ \t]?%",
        Some(ValueKind::Duration) => r"[ \t]?(?:ns|us|µs|μs|ms|min|sec|s|m|h|d)\b",
        Some(ValueKind::Size) => r"[ \t]?(?:[kKmMgGtT]i?[bB]|[bB]|[kKmMgGtT])\b",
        _ => "",
    }
}

/// The regex of a suggestion: the name (any case), the separator, the value with its unit in the
/// group, so `340ms` and `1.2s` both carry what they mean.
fn rule_pattern(
    name: &str,
    style: Style,
    separator: Option<char>,
    class: Option<ValueKind>,
    unit_optional: bool,
) -> String {
    let unit = unit_pattern(class);
    let unit = if unit.is_empty() {
        r"\b".to_string()
    } else if unit_optional {
        format!("(?:{unit})?")
    } else {
        unit.to_string()
    };
    let name = regex::escape(name);
    match style {
        Style::KeyValue => {
            let sep = match separator {
                Some(':') => ":",
                _ => "=",
            };
            format!(r"(?i:\b{name})[ \t]*{sep}[ \t]*({NUMBER_PATTERN}{unit})")
        }
        Style::Word => format!(r"(?i:\b{name})[ \t]+({NUMBER_PATTERN}{unit})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(name: &str, pattern: &str, kind: ValueKind, unit: Option<&str>) -> ExtractRule {
        ExtractRule {
            id: format!("r-{name}"),
            name: name.into(),
            column: "message".into(),
            pattern: pattern.into(),
            kind,
            unit: unit.map(Into::into),
        }
    }

    #[test]
    fn values_as_a_table() {
        use ValueKind::*;
        let gb = 1024f64.powi(3);
        let cases: &[(&str, ValueKind, Option<&str>, Option<f64>)] = &[
            ("340ms", Duration, None, Some(0.34)),
            ("1.2s", Duration, None, Some(1.2)),
            ("1h", Duration, None, Some(3600.0)),
            ("340", Duration, Some("ms"), Some(0.34)),
            ("340", Duration, None, None),
            ("5 min", Duration, None, Some(300.0)),
            ("250µs", Duration, None, Some(0.000_25)),
            ("72.3%", Percent, None, Some(72.3)),
            ("72.3", Percent, Some("%"), Some(72.3)),
            ("1.2GB", Size, None, Some(1.2 * gb)),
            ("512 KiB", Size, None, Some(512.0 * 1024.0)),
            ("1 024", Number, None, Some(1024.0)),
            ("1,234", Number, None, None),
            ("1,5", Number, None, Some(1.5)),
            ("1,234.5", Number, None, Some(1234.5)),
            ("1.234,5", Number, None, Some(1234.5)),
            ("-3", Number, None, Some(-3.0)),
            ("", Number, None, None),
            ("abc", Number, None, None),
            ("12 apples", Number, None, None),
            ("5rps", Number, Some("rps"), Some(5.0)),
            ("72", Text, None, None),
        ];
        for &(text, kind, unit, want) in cases {
            let got = parse_value(text, kind, unit);
            match (got, want) {
                (Some(g), Some(w)) => assert!(
                    (g - w).abs() < 1e-9 * w.abs().max(1.0),
                    "{text}: {g} != {w}"
                ),
                (g, w) => assert_eq!(g, w, "{text}"),
            }
        }
        // Units that do not fit the kind are no value, not a guess.
        assert_eq!(parse_value("3GB", Duration, None), None);
        assert_eq!(parse_value("3ms", Percent, None), None);
        assert_eq!(parse_value("1 02", Number, None), None);
        assert_eq!(parse_value("1.2.3", Number, None), None);
    }

    #[test]
    fn rules_are_checked() {
        let base = vec![Column::named("timestamp"), Column::named("message")];
        let good = rule("cpu", r"cpu=([\d.]+)%", ValueKind::Percent, None);
        assert!(validate(std::slice::from_ref(&good), &base).is_ok());
        let no_group = rule("cpu", r"cpu=[\d.]+%", ValueKind::Percent, None);
        let err = validate(&[no_group], &base).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidRule);
        assert_eq!(err.node_id.as_deref(), Some("r-cpu"));
        let two = rule("cpu", r"(cpu)=([\d.]+)", ValueKind::Number, None);
        assert!(validate(&[two], &base).is_err());
        let broken = rule("cpu", r"cpu=(\d+", ValueKind::Number, None);
        assert_eq!(
            validate(&[broken], &base).unwrap_err().code,
            ErrorCode::InvalidRule
        );
        // Named like a column of the format, by id or label.
        let clash = rule("Message", r"m=(\d+)", ValueKind::Number, None);
        assert!(validate(&[clash], &base).is_err());
        let clash = rule("Nachricht", r"m=(\d+)", ValueKind::Number, None);
        assert!(validate(&[clash], &base).is_err());
        let twice = [
            good.clone(),
            ExtractRule {
                id: "other".into(),
                ..good.clone()
            },
        ];
        assert!(validate(&twice, &base).is_err());
        let empty = rule(" ", r"(\d)", ValueKind::Number, None);
        assert!(validate(&[empty], &base).is_err());
        let many: Vec<ExtractRule> = (0..=MAX_RULES)
            .map(|i| rule(&format!("f{i}"), r"x(\d)", ValueKind::Number, None))
            .collect();
        let err = validate(&many, &base).unwrap_err();
        assert_eq!(
            err.node_id.as_deref(),
            Some(format!("r-f{MAX_RULES}").as_str())
        );
        assert!(validate(&many[..MAX_RULES], &base).is_ok());
    }

    #[test]
    fn extractors_fill_spans_also_with_the_prefilter() {
        let base_columns = vec![Column::named("level"), Column::named("message")];
        let text = "INFO cpu=72.3% mem=1.2GB took 340ms";
        let base = [[0, 4], [5, text.len()]];
        for n in [1usize, 8] {
            let mut rules = vec![
                rule("cpu", r"cpu=([\d.]+)%", ValueKind::Percent, Some("%")),
                rule("took", r"took (\d+ms)", ValueKind::Duration, None),
            ];
            for i in 0..n {
                rules.push(rule(
                    &format!("x{i}"),
                    &format!(r"nothing{i}=(\d+)"),
                    ValueKind::Number,
                    None,
                ));
            }
            let ex = Extractors::build(&rules, &base_columns);
            assert_eq!(ex.len(), rules.len());
            let mut out = vec![[0usize; 2]; ex.len()];
            ex.fill(text, &base, crate::fields::MAX_PARSE_BYTES, &mut out);
            assert_eq!(&text[out[0][0]..out[0][1]], "72.3");
            assert_eq!(&text[out[1][0]..out[1][1]], "340ms");
            assert!(out[2..].iter().all(|s| *s == [0, 0]));
            assert_eq!(ex.value(1, text, &base, 16 * 1024), Some("340ms"));
        }
        // A source the format does not have gives nothing; a colliding rule is left out.
        let rules = [
            rule("a", r"(\d)", ValueKind::Number, None),
            rule("level", r"(\d)", ValueKind::Number, None),
        ];
        let rules = [
            ExtractRule {
                column: "thread".into(),
                ..rules[0].clone()
            },
            rules[1].clone(),
        ];
        let ex = Extractors::build(&rules, &base_columns);
        assert_eq!(ex.len(), 1);
        let mut out = vec![[0usize; 2]; 1];
        ex.fill(text, &base, 16 * 1024, &mut out);
        assert_eq!(out[0], [0, 0]);
    }

    #[test]
    fn source_beyond_the_limit_is_cut() {
        let base_columns = vec![Column::named("message")];
        let mut text = "x".repeat(100);
        text.push_str("cpu=5");
        let base = [[0, text.len()]];
        let ex = Extractors::build(
            &[rule("cpu", r"cpu=(\d+)", ValueKind::Number, None)],
            &base_columns,
        );
        let mut out = vec![[0usize; 2]; 1];
        ex.fill(&text, &base, 50, &mut out);
        assert_eq!(out[0], [0, 0]);
        ex.fill(&text, &base, 200, &mut out);
        assert_eq!(&text[out[0][0]..out[0][1]], "5");
    }

    fn messages(n: usize) -> Vec<String> {
        (0..n)
            .map(|i| {
                let base = format!(
                    "request {i} id={} user=u{} cpu={}.{}% took {}ms from 10.0.0.{} at 12:30:{:02} version=3 build 2024-01-15",
                    100_000 + i,
                    i % 7,
                    20 + i % 70,
                    i % 10,
                    5 + (i * 37) % 900,
                    i % 255,
                    i % 60
                );
                if i % 3 == 0 {
                    format!("{base} mem={}.{}GB", 1 + i % 4, i % 10)
                } else if i % 50 == 0 {
                    format!("{base} rare=1")
                } else {
                    base
                }
            })
            .collect()
    }

    #[test]
    fn suggestions_find_measurements() {
        let lines = messages(600);
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let existing = vec![Column::named("timestamp"), Column::named("message")];
        let found = suggest(&refs, &existing, "message");
        let names: Vec<&str> = found.iter().map(|s| s.rule.name.as_str()).collect();
        assert!(names.contains(&"cpu"), "{names:?}");
        assert!(names.contains(&"took"), "{names:?}");
        assert!(names.contains(&"mem"), "{names:?}");
        // IDs, constants, times and rare fields are no suggestions.
        for gone in ["id", "version", "request", "at", "rare", "user", "build"] {
            assert!(!names.contains(&gone), "{gone} in {names:?}");
        }
        let cpu = found.iter().find(|s| s.rule.name == "cpu").unwrap();
        assert_eq!(cpu.rule.kind, ValueKind::Percent);
        assert!((cpu.share - 1.0).abs() < 1e-6);
        let took = found.iter().find(|s| s.rule.name == "took").unwrap();
        assert_eq!(took.rule.kind, ValueKind::Duration);
        assert_eq!(took.rule.unit.as_deref(), Some("ms"));
        let mem = found.iter().find(|s| s.rule.name == "mem").unwrap();
        assert_eq!(mem.rule.kind, ValueKind::Size);
        assert!(mem.share > 0.3 && mem.share < 0.4);
        // The suggested rules are valid and find the value with its unit.
        let rules: Vec<ExtractRule> = found.iter().map(|s| s.rule.clone()).collect();
        validate(&rules, &existing).unwrap();
        let text = &lines[3];
        let preview = preview(&took.rule, std::slice::from_ref(text)).unwrap();
        let [s, e] = preview.spans[0].unwrap();
        assert!(text[s as usize..e as usize].ends_with("ms"));
        assert!(preview.values[0].is_some());
        // Suggestions skip names that are columns already.
        let with_cpu = vec![Column::named("message"), Column::named("cpu")];
        assert!(suggest(&refs, &with_cpu, "message")
            .iter()
            .all(|s| s.rule.name != "cpu"));
        assert!(suggest(&[], &existing, "message").is_empty());
    }

    #[test]
    fn suggestion_names_any_case_and_units_vary() {
        let lines: Vec<String> = (0..100)
            .map(|i| {
                if i % 2 == 0 {
                    format!("CPU {}% used, call took {}.{}s", 10 + i % 50, i % 3, i % 10)
                } else {
                    format!("CPU {}% used, call took {}ms", 10 + i % 50, 100 + i)
                }
            })
            .collect();
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let found = suggest(&refs, &[Column::named("message")], "message");
        let cpu = found.iter().find(|s| s.rule.name == "CPU").unwrap();
        assert_eq!(cpu.rule.kind, ValueKind::Percent);
        let took = found.iter().find(|s| s.rule.name == "took").unwrap();
        let preview = preview(&took.rule, &lines[..2]).unwrap();
        assert_eq!(preview.values[0], Some(0.0));
        assert!((preview.values[1].unwrap() - 0.101).abs() < 1e-9);
    }

    #[test]
    fn rule_book_loads_only_valid_rules() {
        let book = RuleBook::default();
        let mut all = HashMap::new();
        all.insert(
            "log4j".to_string(),
            vec![
                rule("cpu", r"cpu=(\d+)", ValueKind::Number, None),
                rule("bad", r"(", ValueKind::Number, None),
                rule("CPU", r"c=(\d+)", ValueKind::Number, None),
            ],
        );
        all.insert(
            "json".to_string(),
            vec![rule("bad", r"x", ValueKind::Number, None)],
        );
        let kept = book.load(all);
        assert_eq!(kept, vec!["log4j".to_string()]);
        assert_eq!(book.get("log4j").len(), 1);
        assert!(book.get("json").is_empty());
        book.set("log4j", Vec::new());
        assert!(book.get("log4j").is_empty());
    }
}
