//! Nested filter conditions (prompt 010): a tree of AND/OR groups and conditions from the sidebar,
//! compiled into one evaluation over a bit mask of leaves.
//!
//! Conditions hold for an **entry** (head plus continuations): a leaf is set as soon as any line of the
//! entry fulfils it, and the tree is evaluated on that mask. `NOT "x"` therefore means "no line of the
//! entry contains x". Field and time conditions look at the head only, continuations inherit them.
//! Sections between two markers (`Range`) are state over the lines in file order, across entries.
//!
//! Everything here is user input: at most [`MAX_LEAVES`] conditions, [`MAX_DEPTH`] levels, patterns of
//! at most [`MAX_PATTERN_CHARS`] characters, regex size limits; errors carry the id of the node.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::extract::{parse_value, ValueKind};
use crate::fields::FormatGuess;
use crate::filter::{LevelMask, SearchQuery, MAX_MATCHES_PER_LINE};
use crate::level::Level;
use crate::timestamp::TimestampParser;
use regex::{Regex, RegexBuilder, RegexSet, RegexSetBuilder};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::SystemTime;

/// Leaves of one expression: one bit each in a `u64`.
pub const MAX_LEAVES: usize = 64;
/// Nesting of groups.
pub const MAX_DEPTH: usize = 16;
/// Length of a text, pattern or value of a condition.
pub const MAX_PATTERN_CHARS: usize = 4096;
const REGEX_SIZE_LIMIT: usize = 32 * 1024 * 1024;

/// A node of the filter tree, as the frontend sends it (`filter-tree.ts` compiles to this shape).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FilterExpr {
    Group {
        id: String,
        op: GroupOp,
        #[serde(default)]
        negate: bool,
        children: Vec<FilterExpr>,
    },
    Cond {
        id: String,
        #[serde(default)]
        negate: bool,
        cond: Cond,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GroupOp {
    And,
    Or,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Cond {
    /// Some line of the entry contains the text (or matches the regex).
    Text(SearchQuery),
    /// Some line of the entry has one of the levels.
    Level { levels: Vec<Level> },
    /// A field of the head (column of the format, prompt 008).
    #[serde(rename_all = "camelCase")]
    Field {
        column: String,
        op: FieldOp,
        value: String,
        #[serde(default)]
        value2: Option<String>,
        #[serde(default)]
        case_sensitive: bool,
    },
    /// The time of the head lies within `[from, to]`; either end may be open.
    Time {
        #[serde(default)]
        from: Option<String>,
        #[serde(default)]
        to: Option<String>,
    },
    /// Lines between a start and an end marker; without an end the section stays open.
    Range {
        start: SearchQuery,
        #[serde(default)]
        end: Option<SearchQuery>,
        #[serde(default = "yes")]
        inclusive: bool,
    },
    /// Line numbers `[first, last]` (the selection's "from here", "up to here").
    Lines {
        #[serde(default)]
        first: Option<u32>,
        #[serde(default)]
        last: Option<u32>,
    },
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldOp {
    Eq,
    Contains,
    Regex,
    Gt,
    Lt,
    Between,
}

/// What compiling needs from the session: the format (fields) and a sample (time format).
pub struct ExprContext<'a> {
    pub format: Arc<FormatGuess>,
    pub sample: &'a [String],
    /// Date for logs that only write a time of day (and the year of syslog).
    pub reference: SystemTime,
}

/// What a line's text says about the leaves: `leaves` has the text, field and time leaves and the
/// start markers of sections, `ends` the end markers of sections (same bit as their leaf).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LeafProbe {
    pub leaves: u64,
    pub ends: u64,
}

#[derive(Debug)]
enum Node {
    Leaf {
        bit: u8,
        negate: bool,
    },
    Group {
        and: bool,
        negate: bool,
        children: Vec<Node>,
    },
}

#[derive(Debug)]
enum FieldTest {
    Regex(Regex),
    /// Values in the base unit of the column (prompt 011): `took > 500 ms` compares seconds.
    Number {
        op: FieldOp,
        a: f64,
        b: f64,
        kind: ValueKind,
        unit: Option<String>,
    },
    Text {
        op: FieldOp,
        a: String,
        b: String,
    },
}

#[derive(Debug)]
enum Leaf {
    Level(LevelMask),
    Lines {
        first: u32,
        last: u32,
    },
    /// Decided by the regex set alone.
    Text,
    Field {
        column: usize,
        test: FieldTest,
    },
    Time {
        from: i64,
        to: i64,
    },
    Range {
        has_end: bool,
        inclusive: bool,
    },
}

#[derive(Debug, Clone, Copy)]
enum Role {
    /// Text leaf, or the start marker of a section.
    Leaf,
    End,
}

/// A compiled expression; shared by the tail, the merge and the filter job (`Arc`), compared by pointer.
#[derive(Debug)]
pub struct CompiledExpr {
    root: Node,
    leaves: Vec<Leaf>,
    /// All text patterns of the tree in one pass; `targets[i]` says whose pattern `i` is.
    set: Option<RegexSet>,
    /// The only pattern, when there is one: `is_match` stops at the first hit, a set cannot.
    single: Option<Regex>,
    /// All patterns as one alternation: is any of them in the line at all?
    any: Option<Regex>,
    targets: Vec<(u8, Role)>,
    /// Leaves that need no text (level, line numbers).
    static_bits: u64,
    /// Text leaves: any line of the entry.
    text_bits: u64,
    /// Field and time leaves: the head only.
    head_bits: u64,
    range_bits: u64,
    /// No negation anywhere: once true, an entry stays in.
    monotone: bool,
    format: Option<Arc<FormatGuess>>,
    /// Cloned per head, so the result never depends on what was parsed before (job = tail).
    clock: Option<TimestampParser>,
    /// Text leaves that are not negated, as one alternation, for highlighting.
    highlight: Option<Regex>,
}

impl CompiledExpr {
    pub fn compile(expr: &FilterExpr, ctx: &ExprContext) -> AppResult<Self> {
        let mut builder = Builder {
            ctx,
            leaves: Vec::new(),
            patterns: Vec::new(),
            targets: Vec::new(),
            highlight: Vec::new(),
            monotone: true,
            uses_time: false,
            uses_fields: false,
        };
        let root = builder.node(expr, 0, false)?;
        let mut bits = [0u64; 4];
        for (i, leaf) in builder.leaves.iter().enumerate() {
            let slot = match leaf {
                Leaf::Level(_) | Leaf::Lines { .. } => 0,
                Leaf::Text => 1,
                Leaf::Field { .. } | Leaf::Time { .. } => 2,
                Leaf::Range { .. } => 3,
            };
            bits[slot] |= 1 << i;
        }
        let (set, single, any) = match builder.patterns.len() {
            0 => (None, None, None),
            1 => (None, Some(compile_regex(&builder.patterns[0])?), None),
            _ => {
                let set = RegexSetBuilder::new(&builder.patterns)
                    .size_limit(REGEX_SIZE_LIMIT)
                    .dfa_size_limit(REGEX_SIZE_LIMIT)
                    .build()
                    .map_err(|e| node_error(expr_id(expr), &e.to_string()))?;
                let any = compile_regex(&alternation(&builder.patterns)).ok();
                (Some(set), None, any)
            }
        };
        let clock = builder.uses_time.then(|| clock_for(ctx));
        let highlight = match builder.highlight.len() {
            0 => None,
            _ => Some(
                compile_regex(&alternation(&builder.highlight))
                    .map_err(|e| node_error(expr_id(expr), &e.message))?,
            ),
        };
        let format = builder.uses_fields.then(|| Arc::clone(&ctx.format));
        Ok(Self {
            root,
            leaves: builder.leaves,
            set,
            single,
            any,
            targets: builder.targets,
            static_bits: bits[0],
            text_bits: bits[1],
            head_bits: bits[2],
            range_bits: bits[3],
            monotone: builder.monotone,
            format,
            clock,
            highlight,
        })
    }

    pub fn leaf_count(&self) -> usize {
        self.leaves.len()
    }

    /// Some leaf needs the text of a line.
    pub fn needs_text(&self) -> bool {
        self.text_bits | self.head_bits | self.range_bits != 0
    }

    pub fn has_ranges(&self) -> bool {
        self.range_bits != 0
    }

    pub fn is_monotone(&self) -> bool {
        self.monotone
    }

    /// Leaves a line can set from its text: text leaves always, field and time leaves on a head.
    pub fn text_leaves(&self, head: bool) -> u64 {
        if head {
            self.text_bits | self.head_bits
        } else {
            self.text_bits
        }
    }

    /// Reads the text of one line (decoded, without ANSI colours).
    pub fn probe(&self, text: &str, head: bool) -> LeafProbe {
        let mut probe = LeafProbe::default();
        if let Some(single) = &self.single {
            if single.is_match(text) {
                self.hit(0, &mut probe);
            }
        } else if let Some(set) = &self.set {
            // Most lines match none: one alternation stops early (and gets the literal prefilters of
            // a single regex), the set has to run to the end.
            if self.any.as_ref().is_none_or(|any| any.is_match(text)) {
                for i in set.matches(text).iter() {
                    self.hit(i, &mut probe);
                }
            }
        }
        if head && self.head_bits != 0 {
            let mut time = None;
            for (bit, leaf) in self.leaves.iter().enumerate() {
                let ok = match leaf {
                    Leaf::Field { column, test } => self
                        .format
                        .as_ref()
                        .and_then(|f| f.parser.field(text, *column))
                        .is_some_and(|value| test.matches(value)),
                    Leaf::Time { from, to } => {
                        let at = *time.get_or_insert_with(|| {
                            self.clock.clone().and_then(|mut clock| clock.parse(text))
                        });
                        at.is_some_and(|t| t >= *from && t <= *to)
                    }
                    _ => continue,
                };
                if ok {
                    probe.leaves |= 1 << bit;
                }
            }
        }
        probe
    }

    fn hit(&self, pattern: usize, probe: &mut LeafProbe) {
        let (bit, role) = self.targets[pattern];
        match role {
            Role::Leaf => probe.leaves |= 1 << bit,
            Role::End => probe.ends |= 1 << bit,
        }
    }

    /// Leaves decided without text.
    pub fn static_bits(&self, level: Level, line: u32) -> u64 {
        if self.static_bits == 0 {
            return 0;
        }
        let mut bits = 0;
        for (bit, leaf) in self.leaves.iter().enumerate() {
            let ok = match leaf {
                Leaf::Level(mask) => mask.contains(level),
                Leaf::Lines { first, last } => line >= *first && line <= *last,
                _ => continue,
            };
            if ok {
                bits |= 1 << bit;
            }
        }
        bits
    }

    /// Moves the sections on by one line (always, in file order) and returns those the line is in.
    pub fn advance_ranges(&self, open: &mut u64, probe: LeafProbe) -> u64 {
        if self.range_bits == 0 {
            return 0;
        }
        let mut inside = 0;
        for (bit, leaf) in self.leaves.iter().enumerate() {
            let Leaf::Range { has_end, inclusive } = leaf else {
                continue;
            };
            let b = 1u64 << bit;
            if *open & b != 0 {
                if *has_end && probe.ends & b != 0 {
                    *open &= !b;
                    if *inclusive {
                        inside |= b;
                    }
                } else {
                    inside |= b;
                }
            } else if probe.leaves & b != 0 {
                *open |= b;
                if *inclusive {
                    inside |= b;
                }
            }
        }
        inside
    }

    /// The tree on the leaves an entry fulfils.
    pub fn eval(&self, mask: u64) -> bool {
        eval(&self.root, mask)
    }

    /// Matches of the text conditions that are not negated, for highlighting (UTF-16 units).
    pub fn match_ranges(&self, text: &str, out: &mut Vec<[u32; 2]>) {
        if let Some(regex) = &self.highlight {
            out.extend(utf16_ranges(regex, text));
        }
    }

    pub fn highlights(&self) -> bool {
        self.highlight.is_some()
    }
}

fn eval(node: &Node, mask: u64) -> bool {
    match node {
        Node::Leaf { bit, negate } => (mask >> bit & 1 == 1) != *negate,
        Node::Group {
            and,
            negate,
            children,
        } => {
            let value = if *and {
                children.iter().all(|c| eval(c, mask))
            } else {
                children.iter().any(|c| eval(c, mask))
            };
            value != *negate
        }
    }
}

impl FieldTest {
    fn matches(&self, value: &str) -> bool {
        match self {
            FieldTest::Regex(regex) => regex.is_match(value),
            FieldTest::Number {
                op,
                a,
                b,
                kind,
                unit,
            } => {
                let Some(n) = parse_value(value, *kind, unit.as_deref()) else {
                    return false;
                };
                match op {
                    FieldOp::Eq => n == *a,
                    FieldOp::Gt => n > *a,
                    FieldOp::Lt => n < *a,
                    FieldOp::Between => n >= *a && n <= *b,
                    _ => false,
                }
            }
            FieldTest::Text { op, a, b } => {
                let v = value.trim();
                match op {
                    FieldOp::Gt => v > a.as_str(),
                    FieldOp::Lt => v < a.as_str(),
                    FieldOp::Between => v >= a.as_str() && v <= b.as_str(),
                    _ => false,
                }
            }
        }
    }
}

struct Builder<'a, 'c> {
    ctx: &'a ExprContext<'c>,
    leaves: Vec<Leaf>,
    patterns: Vec<String>,
    targets: Vec<(u8, Role)>,
    highlight: Vec<String>,
    monotone: bool,
    uses_time: bool,
    uses_fields: bool,
}

impl Builder<'_, '_> {
    fn node(&mut self, expr: &FilterExpr, depth: usize, negated: bool) -> AppResult<Node> {
        if depth > MAX_DEPTH {
            return Err(node_error(
                expr_id(expr),
                &format!("nested too deeply (at most {MAX_DEPTH} levels)"),
            ));
        }
        match expr {
            FilterExpr::Group {
                op,
                negate,
                children,
                ..
            } => {
                self.monotone &= !negate;
                let mut nodes = Vec::with_capacity(children.len());
                for child in children {
                    nodes.push(self.node(child, depth + 1, negated != *negate)?);
                }
                Ok(Node::Group {
                    and: *op == GroupOp::And,
                    negate: *negate,
                    children: nodes,
                })
            }
            FilterExpr::Cond { id, negate, cond } => {
                self.monotone &= !negate;
                if self.leaves.len() >= MAX_LEAVES {
                    return Err(node_error(
                        id,
                        &format!("too many conditions (at most {MAX_LEAVES})"),
                    ));
                }
                let bit = self.leaves.len() as u8;
                let leaf = self.leaf(id, bit, cond, negated != *negate)?;
                self.leaves.push(leaf);
                Ok(Node::Leaf {
                    bit,
                    negate: *negate,
                })
            }
        }
    }

    fn leaf(&mut self, id: &str, bit: u8, cond: &Cond, negated: bool) -> AppResult<Leaf> {
        Ok(match cond {
            Cond::Text(query) => {
                let pattern = pattern_of(id, query)?;
                if !negated {
                    self.highlight.push(pattern.clone());
                }
                self.add_pattern(id, pattern, bit, Role::Leaf)?;
                Leaf::Text
            }
            Cond::Level { levels } => {
                if levels.is_empty() {
                    return Err(node_error(id, "no level chosen"));
                }
                Leaf::Level(LevelMask::from_levels(levels))
            }
            Cond::Lines { first, last } => {
                let (first, last) = (first.unwrap_or(0), last.unwrap_or(u32::MAX));
                if first > last {
                    return Err(node_error(id, "the first line comes after the last"));
                }
                Leaf::Lines { first, last }
            }
            Cond::Range {
                start,
                end,
                inclusive,
            } => {
                let start = pattern_of(id, start)?;
                self.add_pattern(id, start, bit, Role::Leaf)?;
                if let Some(end) = end.as_ref().filter(|e| !e.text.is_empty()) {
                    let end = pattern_of(id, end)?;
                    self.add_pattern(id, end, bit, Role::End)?;
                }
                Leaf::Range {
                    has_end: end.as_ref().is_some_and(|e| !e.text.is_empty()),
                    inclusive: *inclusive,
                }
            }
            Cond::Time { from, to } => {
                let clock = clock_for(self.ctx);
                let parse = |text: &Option<String>, open: i64| -> AppResult<i64> {
                    match text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                        None => Ok(open),
                        Some(text) => user_time(&clock, text)
                            .ok_or_else(|| node_error(id, &format!("not a time: {}", short(text)))),
                    }
                };
                let (from, to) = (parse(from, i64::MIN)?, parse(to, i64::MAX)?);
                if from > to {
                    return Err(node_error(id, "the start comes after the end"));
                }
                self.uses_time = true;
                Leaf::Time { from, to }
            }
            Cond::Field {
                column,
                op,
                value,
                value2,
                case_sensitive,
            } => {
                let columns = self.ctx.format.parser.columns();
                let index = columns
                    .iter()
                    .position(|c| c.id == *column)
                    .ok_or_else(|| node_error(id, &format!("no column {}", short(column))))?;
                check_len(id, value)?;
                let value2 = value2.clone().unwrap_or_default();
                check_len(id, &value2)?;
                let flags = if *case_sensitive { "" } else { "(?i)" };
                // Numbers come from `parse_value` with the kind and unit of the column (prompt 011);
                // a text column compares as numbers if the values typed are numbers.
                let column_kind = ValueKind::of_column(columns[index].kind);
                let value_kind = column_kind.unwrap_or(ValueKind::Number);
                let unit = columns[index].unit.clone();
                let number = |text: &str| parse_value(text, value_kind, unit.as_deref());
                let test = match op {
                    FieldOp::Eq | FieldOp::Contains | FieldOp::Regex
                        if !(*op == FieldOp::Eq && column_kind.is_some()) =>
                    {
                        let body = match op {
                            FieldOp::Eq => format!(r"^\s*{}\s*$", regex::escape(value)),
                            FieldOp::Contains => regex::escape(value),
                            _ => value.clone(),
                        };
                        let regex = compile_regex(&format!("{flags}{body}"))
                            .map_err(|e| node_error(id, &e.message))?;
                        FieldTest::Regex(regex)
                    }
                    _ => {
                        let numeric = column_kind.is_some()
                            || number(value).is_some()
                                && (*op != FieldOp::Between || number(&value2).is_some());
                        if numeric {
                            let a = number(value).ok_or_else(|| {
                                node_error(id, &format!("not a number: {}", short(value)))
                            })?;
                            let b = if *op == FieldOp::Between {
                                number(&value2).ok_or_else(|| {
                                    node_error(id, &format!("not a number: {}", short(&value2)))
                                })?
                            } else {
                                a
                            };
                            FieldTest::Number {
                                op: *op,
                                a,
                                b,
                                kind: value_kind,
                                unit: unit.clone(),
                            }
                        } else {
                            FieldTest::Text {
                                op: *op,
                                a: value.trim().to_string(),
                                b: value2.trim().to_string(),
                            }
                        }
                    }
                };
                self.uses_fields = true;
                Leaf::Field {
                    column: index,
                    test,
                }
            }
        })
    }

    fn add_pattern(&mut self, id: &str, pattern: String, bit: u8, role: Role) -> AppResult<()> {
        compile_regex(&pattern).map_err(|e| node_error(id, &e.message))?;
        self.patterns.push(pattern);
        self.targets.push((bit, role));
        Ok(())
    }
}

/// The regex of a text condition, flags included.
fn pattern_of(id: &str, query: &SearchQuery) -> AppResult<String> {
    if query.text.is_empty() {
        return Err(node_error(id, "no text"));
    }
    check_len(id, &query.text)?;
    let body = if query.is_regex {
        query.text.clone()
    } else {
        regex::escape(&query.text)
    };
    Ok(if query.case_sensitive {
        body
    } else {
        format!("(?i){body}")
    })
}

fn check_len(id: &str, text: &str) -> AppResult<()> {
    if text.chars().count() > MAX_PATTERN_CHARS {
        return Err(node_error(
            id,
            &format!("too long (at most {MAX_PATTERN_CHARS} characters)"),
        ));
    }
    Ok(())
}

fn compile_regex(pattern: &str) -> AppResult<Regex> {
    Ok(RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT)
        .dfa_size_limit(REGEX_SIZE_LIMIT)
        .build()?)
}

fn alternation(patterns: &[String]) -> String {
    patterns
        .iter()
        .map(|p| format!("(?:{p})"))
        .collect::<Vec<_>>()
        .join("|")
}

fn node_error(id: &str, message: &str) -> AppError {
    AppError::new(ErrorCode::InvalidSearch, message).with_node(id)
}

fn expr_id(expr: &FilterExpr) -> &str {
    match expr {
        FilterExpr::Group { id, .. } | FilterExpr::Cond { id, .. } => id,
    }
}

fn short(text: &str) -> String {
    text.chars().take(40).collect()
}

fn clock_for(ctx: &ExprContext) -> TimestampParser {
    TimestampParser::detect(ctx.sample.iter().map(String::as_str), ctx.reference)
}

/// A time the user typed: as a log writes it, also without seconds or as a bare date.
fn user_time(clock: &TimestampParser, text: &str) -> Option<i64> {
    let candidates = [
        text.to_string(),
        format!("{text}:00"),
        format!("{text} 00:00:00"),
    ];
    candidates.iter().find_map(|t| clock.clone().parse(t))
}

fn utf16_ranges<'a>(regex: &'a Regex, text: &'a str) -> impl Iterator<Item = [u32; 2]> + 'a {
    let mut byte_pos = 0usize;
    let mut utf16_pos = 0u32;
    regex
        .find_iter(text)
        .take(MAX_MATCHES_PER_LINE)
        .filter(|m| !m.is_empty())
        .map(move |m| {
            utf16_pos += text[byte_pos..m.start()].encode_utf16().count() as u32;
            let start = utf16_pos;
            utf16_pos += text[m.start()..m.end()].encode_utf16().count() as u32;
            byte_pos = m.end();
            [start, utf16_pos]
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fields::FormatGuess;

    pub(crate) fn ctx_with(format: FormatGuess) -> ExprContext<'static> {
        ExprContext {
            format: Arc::new(format),
            sample: &[],
            reference: SystemTime::now(),
        }
    }

    fn ctx() -> ExprContext<'static> {
        ctx_with(FormatGuess::none())
    }

    fn text(id: &str, t: &str) -> FilterExpr {
        cond(id, false, Cond::Text(q(t)))
    }

    fn q(t: &str) -> SearchQuery {
        SearchQuery {
            text: t.into(),
            is_regex: false,
            case_sensitive: false,
        }
    }

    fn cond(id: &str, negate: bool, cond: Cond) -> FilterExpr {
        FilterExpr::Cond {
            id: id.into(),
            negate,
            cond,
        }
    }

    fn group(op: GroupOp, children: Vec<FilterExpr>) -> FilterExpr {
        FilterExpr::Group {
            id: "g".into(),
            op,
            negate: false,
            children,
        }
    }

    fn mask_of(expr: &CompiledExpr, lines: &[&str]) -> u64 {
        lines
            .iter()
            .enumerate()
            .fold(0, |m, (i, l)| m | expr.probe(l, i == 0).leaves)
    }

    #[test]
    fn and_or_not_on_a_table() {
        let and = CompiledExpr::compile(
            &group(GroupOp::And, vec![text("a", "timeout"), text("b", "order")]),
            &ctx(),
        )
        .unwrap();
        let or = CompiledExpr::compile(
            &group(GroupOp::Or, vec![text("a", "timeout"), text("b", "order")]),
            &ctx(),
        )
        .unwrap();
        let not = CompiledExpr::compile(
            &group(
                GroupOp::And,
                vec![
                    text("a", "timeout"),
                    cond("b", true, Cond::Text(q("order"))),
                ],
            ),
            &ctx(),
        )
        .unwrap();
        let nested = CompiledExpr::compile(
            &group(
                GroupOp::Or,
                vec![
                    text("x", "fatal"),
                    group(GroupOp::And, vec![text("a", "timeout"), text("b", "order")]),
                ],
            ),
            &ctx(),
        )
        .unwrap();
        let table: [(&[&str], bool, bool, bool, bool); 5] = [
            (&["Timeout in OrderService"], true, true, false, true),
            (
                &["Timeout", "  at OrderService.run"],
                true,
                true,
                false,
                true,
            ),
            (&["Timeout"], false, true, true, false),
            (&["nothing"], false, false, false, false),
            (&["FATAL"], false, false, false, true),
        ];
        for (lines, a, o, n, x) in table {
            assert_eq!(and.eval(mask_of(&and, lines)), a, "AND {lines:?}");
            assert_eq!(or.eval(mask_of(&or, lines)), o, "OR {lines:?}");
            assert_eq!(not.eval(mask_of(&not, lines)), n, "NOT {lines:?}");
            assert_eq!(nested.eval(mask_of(&nested, lines)), x, "nested {lines:?}");
        }
        assert!(and.is_monotone() && !not.is_monotone());
    }

    #[test]
    fn sixty_four_leaves_compile_and_sixty_five_fail_at_the_node() {
        let leaves = |n: usize| {
            group(
                GroupOp::Or,
                (0..n)
                    .map(|i| text(&format!("n{i}"), &format!("w{i}")))
                    .collect(),
            )
        };
        let expr = CompiledExpr::compile(&leaves(64), &ctx()).unwrap();
        assert_eq!(expr.leaf_count(), 64);
        assert!(expr.probe("w63", true).leaves & 1 << 63 != 0);
        let err = CompiledExpr::compile(&leaves(65), &ctx()).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidSearch);
        assert_eq!(err.node_id.as_deref(), Some("n64"));
    }

    #[test]
    fn bad_input_names_the_node() {
        let bad = cond(
            "r",
            false,
            Cond::Text(SearchQuery {
                text: "(".into(),
                is_regex: true,
                case_sensitive: false,
            }),
        );
        let err = CompiledExpr::compile(&group(GroupOp::And, vec![text("ok", "x"), bad]), &ctx())
            .unwrap_err();
        assert_eq!(err.node_id.as_deref(), Some("r"));
        let empty = CompiledExpr::compile(&text("e", ""), &ctx()).unwrap_err();
        assert_eq!(empty.node_id.as_deref(), Some("e"));
        let long = CompiledExpr::compile(&text("l", &"x".repeat(MAX_PATTERN_CHARS + 1)), &ctx())
            .unwrap_err();
        assert_eq!(long.node_id.as_deref(), Some("l"));
        let mut deep = text("leaf", "x");
        for _ in 0..=MAX_DEPTH {
            deep = group(GroupOp::And, vec![deep]);
        }
        assert!(CompiledExpr::compile(&deep, &ctx()).is_err());
        let field = cond(
            "f",
            false,
            Cond::Field {
                column: "nope".into(),
                op: FieldOp::Eq,
                value: "x".into(),
                value2: None,
                case_sensitive: false,
            },
        );
        assert_eq!(
            CompiledExpr::compile(&field, &ctx())
                .unwrap_err()
                .node_id
                .as_deref(),
            Some("f")
        );
        let time = cond(
            "t",
            false,
            Cond::Time {
                from: Some("gestern".into()),
                to: None,
            },
        );
        assert_eq!(
            CompiledExpr::compile(&time, &ctx())
                .unwrap_err()
                .node_id
                .as_deref(),
            Some("t")
        );
    }

    #[test]
    fn json_shape_of_the_frontend() {
        let json = r#"{"kind":"group","id":"root","op":"and","children":[
            {"kind":"cond","id":"a","negate":true,"cond":{"type":"text","text":"x","isRegex":false,"caseSensitive":false}},
            {"kind":"cond","id":"b","cond":{"type":"level","levels":["WARN","ERROR"]}},
            {"kind":"cond","id":"c","cond":{"type":"range","start":{"text":"BEGIN"},"end":{"text":"END"},"inclusive":true}},
            {"kind":"cond","id":"d","cond":{"type":"lines","first":10}},
            {"kind":"cond","id":"e","cond":{"type":"time","from":"2024-01-15 10:00:00"}},
            {"kind":"cond","id":"f","cond":{"type":"field","column":"message","op":"contains","value":"y"}}
        ]}"#;
        let expr: FilterExpr = serde_json::from_str(json).unwrap();
        let compiled = CompiledExpr::compile(&expr, &ctx()).unwrap();
        assert_eq!(compiled.leaf_count(), 6);
        assert!(compiled.has_ranges() && compiled.needs_text());
    }

    #[test]
    fn ranges_open_close_and_reopen_in_line_order() {
        let range = |end: Option<&str>, inclusive| {
            CompiledExpr::compile(
                &cond(
                    "r",
                    false,
                    Cond::Range {
                        start: q("BEGIN"),
                        end: end.map(q),
                        inclusive,
                    },
                ),
                &ctx(),
            )
            .unwrap()
        };
        let lines = [
            "a", "BEGIN 1", "b", "END 1", "c", "BEGIN 2", "d", "END 2", "e",
        ];
        let walk = |expr: &CompiledExpr| {
            let mut open = 0;
            lines
                .iter()
                .map(|l| expr.advance_ranges(&mut open, expr.probe(l, true)) != 0)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            walk(&range(Some("END"), true)),
            [false, true, true, true, false, true, true, true, false]
        );
        assert_eq!(
            walk(&range(Some("END"), false)),
            [false, false, true, false, false, false, true, false, false]
        );
        // Without an end the section stays open to the end of the file.
        assert_eq!(
            walk(&range(None, true)),
            [false, true, true, true, true, true, true, true, true]
        );
    }

    #[test]
    fn lines_and_levels_need_no_text() {
        let expr = CompiledExpr::compile(
            &group(
                GroupOp::And,
                vec![
                    cond(
                        "l",
                        false,
                        Cond::Level {
                            levels: vec![Level::Error],
                        },
                    ),
                    cond(
                        "n",
                        false,
                        Cond::Lines {
                            first: Some(5),
                            last: None,
                        },
                    ),
                ],
            ),
            &ctx(),
        )
        .unwrap();
        assert!(!expr.needs_text());
        assert!(expr.eval(expr.static_bits(Level::Error, 5)));
        assert!(!expr.eval(expr.static_bits(Level::Error, 4)));
        assert!(!expr.eval(expr.static_bits(Level::Info, 9)));
    }

    #[test]
    fn time_of_the_head_within_bounds() {
        let sample = vec!["2024-01-15 10:00:00,000 INFO a".to_string()];
        let ctx = ExprContext {
            format: Arc::new(FormatGuess::none()),
            sample: &sample,
            reference: SystemTime::now(),
        };
        let expr = CompiledExpr::compile(
            &cond(
                "t",
                false,
                Cond::Time {
                    from: Some("2024-01-15 10:00".into()),
                    to: Some("2024-01-15 10:30:00".into()),
                },
            ),
            &ctx,
        )
        .unwrap();
        let hit = |line: &str, head| expr.probe(line, head).leaves != 0;
        assert!(hit("2024-01-15 10:15:00,000 INFO in", true));
        assert!(!hit("2024-01-15 10:31:00,000 INFO after", true));
        assert!(!hit("2024-01-15 09:59:59,999 INFO before", true));
        // A continuation inherits: it is not read for the time.
        assert!(!hit("2024-01-15 10:15:00,000 at x", false));
        assert!(!hit("no time", true));
    }

    #[test]
    fn field_conditions_read_the_head() {
        let sample: Vec<String> = [
            "2024-01-15 10:00:00,123 INFO [main] com.acme.Order - took 12 ms",
            "2024-01-15 10:00:01,123 WARN [pool-1] com.acme.Billing - took 900 ms",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let refs: Vec<&str> = sample.iter().map(String::as_str).collect();
        let profile = crate::profile::ProfileRegistry::default()
            .find("log4j")
            .unwrap();
        let format = crate::fields::format_for(&profile, &refs).unwrap();
        assert!(format.parser.columns().iter().any(|c| c.id == "thread"));
        let ctx = ctx_with(format);
        let field = |op, value: &str, value2: Option<&str>| {
            CompiledExpr::compile(
                &cond(
                    "f",
                    false,
                    Cond::Field {
                        column: "thread".into(),
                        op,
                        value: value.into(),
                        value2: value2.map(Into::into),
                        case_sensitive: false,
                    },
                ),
                &ctx,
            )
            .unwrap()
        };
        let hit = |e: &CompiledExpr, line: &str| e.probe(line, true).leaves != 0;
        let eq = field(FieldOp::Eq, "MAIN", None);
        assert!(hit(&eq, &sample[0]) && !hit(&eq, &sample[1]));
        let contains = field(FieldOp::Contains, "pool", None);
        assert!(!hit(&contains, &sample[0]) && hit(&contains, &sample[1]));
        let regex = field(FieldOp::Regex, "^p.*1$", None);
        assert!(hit(&regex, &sample[1]));
        let between = field(FieldOp::Between, "m", "o".into());
        assert!(hit(&between, &sample[0]) && !hit(&between, &sample[1]));
        // Not a head: nothing is read.
        assert_eq!(eq.probe(&sample[0], false).leaves, 0);
    }

    #[test]
    fn highlight_covers_text_leaves_that_are_not_negated() {
        let expr = CompiledExpr::compile(
            &group(
                GroupOp::And,
                vec![text("a", "ä"), cond("b", true, Cond::Text(q("x")))],
            ),
            &ctx(),
        )
        .unwrap();
        let mut out = Vec::new();
        expr.match_ranges("😀ä x ä", &mut out);
        assert_eq!(out, vec![[2, 3], [6, 7]]);
    }
}
