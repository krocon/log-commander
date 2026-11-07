//! Backend filter: active levels plus optional text search yield a sorted list of line numbers.
//! New lines extend the list incrementally; a multi-line entry stays together. A filter expression
//! (prompt 010, `filter_expr.rs`) is one more AND term, decided per entry.

use crate::encoding::{display_text, Encoding};
use crate::error::AppResult;
use crate::filter_expr::{CompiledExpr, LeafProbe};
use crate::indexer::MAX_SEARCH_BYTES;
use crate::level::Level;
use crate::overview::{level_bit, LevelSummary, SummaryMark};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub const MAX_MATCHES_PER_LINE: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub text: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SearchMode {
    /// Only lines (entries) with a match are shown.
    #[default]
    Filter,
    /// All lines stay, matches are marked.
    Highlight,
}

/// Compiled text search. Matching always runs on the decoded text without ANSI colours.
#[derive(Debug)]
pub struct TextMatcher {
    regex: Regex,
}

impl TextMatcher {
    pub fn new(query: &SearchQuery) -> AppResult<Self> {
        let pattern = if query.is_regex {
            query.text.clone()
        } else {
            regex::escape(&query.text)
        };
        let regex = RegexBuilder::new(&pattern)
            .case_insensitive(!query.case_sensitive)
            .size_limit(32 * 1024 * 1024)
            .build()?;
        Ok(Self { regex })
    }

    pub fn is_match(&self, text: &str) -> bool {
        self.regex.is_match(text)
    }

    /// Match ranges in UTF-16 code units, which is what the frontend indexes strings with.
    pub fn match_ranges(&self, text: &str) -> Vec<[u32; 2]> {
        let mut ranges = Vec::new();
        let mut byte_pos = 0usize;
        let mut utf16_pos = 0u32;
        let mut advance = |to: usize| {
            utf16_pos += text[byte_pos..to].encode_utf16().count() as u32;
            byte_pos = to;
            utf16_pos
        };
        for found in self.regex.find_iter(text).take(MAX_MATCHES_PER_LINE) {
            if found.is_empty() {
                continue;
            }
            let start = advance(found.start());
            let end = advance(found.end());
            ranges.push([start, end]);
        }
        ranges
    }
}

/// Bit mask of the visible levels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LevelMask(u8);

impl LevelMask {
    pub const ALL: LevelMask = LevelMask((1 << Level::COUNT) - 1);

    pub fn from_levels(levels: &[Level]) -> Self {
        Self(
            levels
                .iter()
                .fold(0, |mask, level| mask | (1 << *level as u8)),
        )
    }

    pub fn contains(self, level: Level) -> bool {
        self.0 & (1 << level as u8) != 0
    }
}

/// Bit mask of the visible sources of a merge (bit = source index); a single file is source 0.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceMask(pub u16);

impl SourceMask {
    pub const ALL: SourceMask = SourceMask(u16::MAX);

    pub fn contains(self, source: usize) -> bool {
        source >= 16 || self.0 & (1 << source) != 0
    }
}

/// What the user asked for, after compiling the search.
#[derive(Debug, Clone)]
pub struct FilterSpec {
    pub levels: LevelMask,
    pub matcher: Option<Arc<TextMatcher>>,
    pub mode: SearchMode,
    /// Sources of a merge; decided at the head of an entry, the entry stays whole.
    pub sources: SourceMask,
    /// The filter tree of the sidebar (prompt 010), an AND term below levels and search.
    pub expr: Option<Arc<CompiledExpr>>,
}

impl Default for FilterSpec {
    fn default() -> Self {
        Self {
            levels: LevelMask::ALL,
            matcher: None,
            mode: SearchMode::Filter,
            sources: SourceMask::ALL,
            expr: None,
        }
    }
}

/// What the text of a line says for a filter: the search hit and the leaves of an expression.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Probe {
    pub matched: bool,
    pub leaves: LeafProbe,
}

/// Everything of a filter that reads the text of a line. Prepared before the write lock (tail, merge)
/// and compared by pointer: a different one means the filter changed and the text is read again.
#[derive(Debug, Clone, Default)]
pub struct TextTest {
    matcher: Option<Arc<TextMatcher>>,
    expr: Option<Arc<CompiledExpr>>,
}

impl TextTest {
    /// Nothing to read.
    pub fn is_empty(&self) -> bool {
        self.matcher.is_none() && !self.expr.as_ref().is_some_and(|e| e.needs_text())
    }

    pub fn same(&self, other: &TextTest) -> bool {
        fn eq<T>(a: &Option<Arc<T>>, b: &Option<Arc<T>>) -> bool {
            match (a, b) {
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                (None, None) => true,
                _ => false,
            }
        }
        eq(&self.matcher, &other.matcher) && eq(&self.expr, &other.expr)
    }

    /// Reads a raw line (at most the search limit); `head`: the line starts an entry.
    pub fn probe_raw(&self, raw: &[u8], encoding: Encoding, head: bool) -> Probe {
        if self.is_empty() {
            return Probe::default();
        }
        let raw = &raw[..raw.len().min(MAX_SEARCH_BYTES)];
        self.probe_text(&display_text(raw, encoding), head)
    }

    pub fn probe_text(&self, text: &str, head: bool) -> Probe {
        Probe {
            matched: self.matcher.as_ref().is_some_and(|m| m.is_match(text)),
            leaves: self
                .expr
                .as_ref()
                .filter(|e| e.needs_text())
                .map_or_else(LeafProbe::default, |e| e.probe(text, head)),
        }
    }
}

impl FilterSpec {
    /// Matcher that decides which lines are shown (not the one that only marks them).
    pub fn filtering_matcher(&self) -> Option<&Arc<TextMatcher>> {
        match self.mode {
            SearchMode::Filter => self.matcher.as_ref(),
            SearchMode::Highlight => None,
        }
    }

    /// Every line is visible: no list needed, position and line number are the same.
    pub fn is_identity(&self) -> bool {
        self.levels == LevelMask::ALL
            && self.filtering_matcher().is_none()
            && self.sources == SourceMask::ALL
            && self.expr.is_none()
    }

    pub fn needs_text(&self) -> bool {
        self.filtering_matcher().is_some() || self.expr.as_ref().is_some_and(|e| e.needs_text())
    }

    /// What reads the text of a line for this filter.
    pub fn text_test(&self) -> TextTest {
        TextTest {
            matcher: self.filtering_matcher().cloned(),
            expr: self.expr.clone(),
        }
    }
}

/// Lines per level, indexed by `Level as usize`.
pub type Counts = [u64; Level::COUNT];

/// The incrementally maintained list. `None` as list = identity.
#[derive(Debug, Default)]
pub struct FilteredLines {
    pub spec: FilterSpec,
    list: Option<Vec<u32>>,
    entry_start: u32,
    entry_included: bool,
    /// The entry's head is from a source the filter hides: no line of it is shown.
    entry_excluded: bool,
    next_line: u32,
    /// Lines in `list` per level (the "Ansicht" column of the statistics).
    counts: Counts,
    /// Level of the line at `entry_start`.
    entry_head: Level,
    /// Lines after `entry_start` not taken yet: a later hit in the entry brings them in.
    entry_counts: Counts,
    /// `entry_counts` is not all zero.
    entry_pending: bool,
    /// Levels per chunk of positions in `list`, for the overview ruler (prompt 007).
    summary: LevelSummary,
    /// The entry being decided by an expression (prompt 010).
    expr: ExprState,
    /// Lowest list length an expression went back to since the last update (`take_retracted`).
    retracted_from: Option<u64>,
}

/// Per-entry state of an expression: what a retraction goes back to, and the leaves so far.
#[derive(Debug, Clone, Copy)]
struct ExprState {
    /// Leaves some line of the entry fulfils.
    mask: u64,
    /// Some line of the entry passed levels and search (the implicit AND above the tree).
    base_hit: bool,
    /// Sections (range leaves) open after the last line; in file order, across entries.
    open: u64,
    /// List length, counts and summary before the head of the entry.
    list_len: usize,
    counts: Counts,
    summary: SummaryMark,
    /// Lines of the entry per level, the head included.
    levels: Counts,
}

impl Default for ExprState {
    fn default() -> Self {
        Self::new(&LevelSummary::new())
    }
}

impl ExprState {
    fn new(summary: &LevelSummary) -> Self {
        Self {
            mask: 0,
            base_hit: false,
            open: 0,
            list_len: 0,
            counts: [0; Level::COUNT],
            summary: summary.mark(),
            levels: [0; Level::COUNT],
        }
    }
}

/// Bits of all levels with a count.
fn levels_mask(counts: &Counts) -> u8 {
    counts
        .iter()
        .enumerate()
        .filter(|(_, n)| **n > 0)
        .fold(0, |mask, (i, _)| mask | level_bit(Level::ALL[i]))
}

/// State to restore when a provisional last line is withdrawn.
#[derive(Debug, Clone, Copy)]
pub struct FilterCheckpoint {
    entry_start: u32,
    entry_included: bool,
    entry_excluded: bool,
    next_line: u32,
    list_len: usize,
    counts: Counts,
    entry_head: Level,
    entry_counts: Counts,
    entry_pending: bool,
    summary: SummaryMark,
    expr: ExprState,
}

impl FilteredLines {
    pub fn new(spec: FilterSpec) -> Self {
        let list = (!spec.is_identity()).then(Vec::new);
        let summary = LevelSummary::new();
        Self {
            spec,
            list,
            entry_start: 0,
            entry_included: false,
            entry_excluded: false,
            next_line: 0,
            counts: [0; Level::COUNT],
            entry_head: Level::Unknown,
            entry_counts: [0; Level::COUNT],
            entry_pending: false,
            expr: ExprState::new(&summary),
            summary,
            retracted_from: None,
        }
    }

    /// An identity filter that already covers `total` lines.
    pub fn identity(spec: FilterSpec, total: usize) -> Self {
        debug_assert!(spec.is_identity());
        let mut filter = Self::new(spec);
        filter.next_line = total as u32;
        filter
    }

    /// Number of visible lines, given the number of all lines.
    pub fn len(&self, total: usize) -> usize {
        self.list.as_ref().map_or(total, Vec::len)
    }

    pub fn is_identity(&self) -> bool {
        self.list.is_none()
    }

    /// Visible lines per level; for the identity that is `all`, the counts of the index.
    pub fn counts(&self, all: &Counts) -> Counts {
        if self.list.is_some() {
            self.counts
        } else {
            *all
        }
    }

    /// Levels per chunk of positions; `None` for the identity, where the index has them.
    pub fn summary(&self) -> Option<&LevelSummary> {
        self.list.is_some().then_some(&self.summary)
    }

    /// The line number at a position in the view.
    pub fn line_at(&self, position: usize, total: usize) -> Option<u32> {
        match &self.list {
            None => (position < total).then_some(position as u32),
            Some(list) => list.get(position).copied(),
        }
    }

    /// First position whose line number is `>= line`.
    pub fn position_of(&self, line: u32, total: usize) -> usize {
        match &self.list {
            None => (line as usize).min(total),
            Some(list) => list.partition_point(|l| *l < line),
        }
    }

    pub fn clear(&mut self) {
        if let Some(list) = &mut self.list {
            list.clear();
        }
        self.entry_start = 0;
        self.entry_included = false;
        self.entry_excluded = false;
        self.next_line = 0;
        self.counts = [0; Level::COUNT];
        self.entry_head = Level::Unknown;
        self.entry_counts = [0; Level::COUNT];
        self.entry_pending = false;
        self.summary.clear();
        self.expr = ExprState::new(&self.summary);
        self.retracted_from = None;
    }

    /// An expression took lines out of the end of the list since the last call: the view from
    /// this position on may differ although the count does not (frontend: `invalidateTail`).
    pub fn take_retracted(&mut self) -> Option<u64> {
        self.retracted_from.take()
    }

    pub fn retracted(&self) -> Option<u64> {
        self.retracted_from
    }

    pub fn checkpoint(&self) -> FilterCheckpoint {
        FilterCheckpoint {
            entry_start: self.entry_start,
            entry_included: self.entry_included,
            entry_excluded: self.entry_excluded,
            next_line: self.next_line,
            list_len: self.list.as_ref().map_or(0, Vec::len),
            counts: self.counts,
            entry_head: self.entry_head,
            entry_counts: self.entry_counts,
            entry_pending: self.entry_pending,
            summary: self.summary.mark(),
            expr: self.expr,
        }
    }

    pub fn restore(&mut self, checkpoint: FilterCheckpoint) {
        self.entry_start = checkpoint.entry_start;
        self.entry_included = checkpoint.entry_included;
        self.entry_excluded = checkpoint.entry_excluded;
        self.next_line = checkpoint.next_line;
        self.counts = checkpoint.counts;
        self.entry_head = checkpoint.entry_head;
        self.entry_counts = checkpoint.entry_counts;
        self.entry_pending = checkpoint.entry_pending;
        self.expr = checkpoint.expr;
        self.summary.restore(checkpoint.summary);
        if let Some(list) = &mut self.list {
            if list.len() >= checkpoint.list_len {
                list.truncate(checkpoint.list_len);
            } else {
                // The withdrawn line made an expression take its entry out: the entry was the end of
                // the list, contiguous up to the line before the withdrawn one.
                let missing = checkpoint.list_len - list.len();
                list.extend(checkpoint.next_line - missing as u32..checkpoint.next_line);
                self.summary
                    .push_run(levels_mask(&checkpoint.expr.levels), missing as u64);
            }
        }
    }

    /// Takes the next line. `probe` reads its text and is only called when the answer matters.
    pub fn append(&mut self, level: Level, continuation: bool, probe: impl FnOnce() -> Probe) {
        self.append_from(0, level, continuation, probe);
    }

    /// Takes the next line of a source (merge). The source of the head decides for the entry.
    pub fn append_from(
        &mut self,
        source: usize,
        level: Level,
        continuation: bool,
        probe: impl FnOnce() -> Probe,
    ) {
        let line = self.next_line;
        self.next_line += 1;
        if self.list.is_none() {
            return;
        }
        if let Some(expr) = self.spec.expr.take() {
            self.append_expr(&expr, line, source, level, continuation, probe);
            self.spec.expr = Some(expr);
            return;
        }
        let Some(list) = &mut self.list else {
            return;
        };
        // The first line has no entry before it to continue: it is a head.
        if !continuation || line == 0 {
            self.entry_start = line;
            self.entry_included = false;
            self.entry_excluded = !self.spec.sources.contains(source);
            self.entry_head = level;
            if self.entry_pending {
                self.entry_counts = [0; Level::COUNT];
                self.entry_pending = false;
            }
        } else if self.entry_included {
            list.push(line);
            self.counts[level as usize] += 1;
            self.summary.push(level);
            return;
        }
        if self.entry_excluded
            || !self.spec.levels.contains(level)
            || self.spec.filtering_matcher().is_some() && !probe().matched
        {
            // A later hit in the entry brings this line in; its level is gone by then. The head
            // keeps its level apart, so a single-line entry costs no array.
            if line != self.entry_start {
                self.entry_counts[level as usize] += 1;
                self.entry_pending = true;
            }
            return;
        }
        // A hit in a stack trace also brings in the head of the entry and the lines between.
        if line != self.entry_start {
            list.extend(self.entry_start..line);
            self.counts[self.entry_head as usize] += 1;
            self.summary.push(self.entry_head);
            if self.entry_pending {
                // Their order is gone; all of them lie between head and this line, so their chunks get
                // the bits of all their levels.
                let mut mask = 0u8;
                let mut taken = 0u64;
                for (i, (count, pending)) in
                    self.counts.iter_mut().zip(self.entry_counts).enumerate()
                {
                    *count += pending;
                    if pending > 0 {
                        mask |= level_bit(Level::ALL[i]);
                        taken += pending;
                    }
                }
                self.summary.push_run(mask, taken);
                self.entry_counts = [0; Level::COUNT];
                self.entry_pending = false;
            }
        }
        list.push(line);
        self.counts[level as usize] += 1;
        self.summary.push(level);
        self.entry_included = true;
    }

    /// The expression path: the entry is in while levels/search hit some line of it and the tree
    /// holds on its leaves. With a negation the tree can turn false again; then the entry, which is
    /// the end of the list, goes out again.
    fn append_expr(
        &mut self,
        expr: &CompiledExpr,
        line: u32,
        source: usize,
        level: Level,
        continuation: bool,
        probe: impl FnOnce() -> Probe,
    ) {
        let Some(list) = &mut self.list else {
            return;
        };
        let head = !continuation || line == 0;
        if head {
            self.entry_start = line;
            self.entry_included = false;
            self.entry_excluded = !self.spec.sources.contains(source);
            self.entry_head = level;
            self.expr = ExprState {
                mask: 0,
                base_hit: false,
                open: self.expr.open,
                list_len: list.len(),
                counts: self.counts,
                summary: self.summary.mark(),
                levels: [0; Level::COUNT],
            };
        }
        let state = &mut self.expr;
        state.levels[level as usize] += 1;
        let level_ok = self.spec.levels.contains(level);
        let searching = self.spec.mode == SearchMode::Filter && self.spec.matcher.is_some();
        // Field and time leaves come from a real head (probes of continuations may carry them).
        let text_leaves = expr.text_leaves(!continuation);
        // Text is read only while it can change something; sections always move on, line by line.
        let need = expr.has_ranges()
            || !self.entry_excluded
                && (!state.base_hit && level_ok && searching
                    || text_leaves & !state.mask != 0
                        && !(self.entry_included && expr.is_monotone()));
        let probe = if need { probe() } else { Probe::default() };
        let inside = expr.advance_ranges(&mut state.open, probe.leaves);
        if self.entry_excluded {
            return;
        }
        state.mask |= expr.static_bits(level, line) | inside | probe.leaves.leaves & text_leaves;
        state.base_hit |= level_ok && (!searching || probe.matched);
        let ok = state.base_hit && expr.eval(state.mask);
        match (self.entry_included, ok) {
            (true, true) => {
                list.push(line);
                self.counts[level as usize] += 1;
                self.summary.push(level);
            }
            (false, true) => {
                list.extend(self.entry_start..=line);
                for (count, taken) in self.counts.iter_mut().zip(state.levels) {
                    *count += taken;
                }
                self.summary.push(self.entry_head);
                let rest = u64::from(line - self.entry_start);
                if rest > 0 {
                    let mut others = state.levels;
                    others[self.entry_head as usize] -= 1;
                    self.summary.push_run(levels_mask(&others), rest);
                }
                self.entry_included = true;
            }
            (true, false) => {
                list.truncate(state.list_len);
                self.counts = state.counts;
                self.summary.restore(state.summary);
                self.summary.truncate(state.list_len as u64);
                self.entry_included = false;
                let from = state.list_len as u64;
                self.retracted_from = Some(self.retracted_from.map_or(from, |r| r.min(from)));
            }
            (false, false) => {}
        }
    }

    /// Number of lines taken so far.
    pub fn next_line(&self) -> u32 {
        self.next_line
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(levels: &[Level], search: Option<&str>) -> FilterSpec {
        FilterSpec {
            levels: LevelMask::from_levels(levels),
            matcher: search.map(|text| {
                Arc::new(
                    TextMatcher::new(&SearchQuery {
                        text: text.into(),
                        is_regex: false,
                        case_sensitive: false,
                    })
                    .unwrap(),
                )
            }),
            mode: SearchMode::Filter,
            sources: SourceMask::ALL,
            expr: None,
        }
    }

    #[test]
    fn source_filter_takes_whole_entries_by_their_head() {
        let mut filter = FilteredLines::new(FilterSpec {
            sources: SourceMask(0b10),
            ..FilterSpec::default()
        });
        assert!(!filter.spec.is_identity());
        let lines = [
            (0, Level::Info, false),
            (1, Level::Error, false),
            (1, Level::Error, true),
            (0, Level::Warn, false),
            (0, Level::Warn, true),
            (1, Level::Info, false),
        ];
        for (source, level, continuation) in lines {
            filter.append_from(source, level, continuation, Probe::default);
        }
        assert_eq!(filter.len(6), 3);
        assert_eq!(
            (0..3).map(|p| filter.line_at(p, 6)).collect::<Vec<_>>(),
            vec![Some(1), Some(2), Some(5)]
        );
        assert_eq!(count_of(&view_counts(&filter), Level::Warn), 0);
    }

    fn feed(filter: &mut FilteredLines, lines: &[(Level, bool, &str)]) {
        for (level, continuation, text) in lines {
            let test = filter.spec.text_test();
            filter.append(*level, *continuation, || {
                test.probe_text(text, !continuation)
            });
        }
    }

    fn view_counts(filter: &FilteredLines) -> Counts {
        filter.counts(&[0; Level::COUNT])
    }

    fn count_of(counts: &Counts, level: Level) -> u64 {
        counts[level as usize]
    }

    #[test]
    fn level_filter_counts_the_shown_lines_per_level() {
        let mut filter = FilteredLines::new(spec(&[Level::Error, Level::Warn], None));
        feed(
            &mut filter,
            &[
                (Level::Info, false, "a"),
                (Level::Error, false, "b"),
                (Level::Warn, false, "c"),
                (Level::Error, false, "d"),
                (Level::Debug, false, "e"),
            ],
        );
        let counts = view_counts(&filter);
        assert_eq!(count_of(&counts, Level::Error), 2);
        assert_eq!(count_of(&counts, Level::Warn), 1);
        assert_eq!(count_of(&counts, Level::Info), 0);
        assert_eq!(counts.iter().sum::<u64>(), filter.len(5) as u64);
    }

    #[test]
    fn a_hit_in_the_stack_trace_counts_head_and_lines_between() {
        // Continuations of other levels (as a detector might give them) keep their own level.
        let mut filter = FilteredLines::new(spec(&Level::ALL, Some("needle")));
        feed(
            &mut filter,
            &[
                (Level::Info, false, "before"),
                (Level::Error, false, "head"),
                (Level::Error, true, "  at a"),
                (Level::Unknown, true, "  plain"),
                (Level::Error, true, "  at needle"),
                (Level::Error, true, "  at b"),
                (Level::Info, false, "after"),
            ],
        );
        let counts = view_counts(&filter);
        assert_eq!(count_of(&counts, Level::Error), 4);
        assert_eq!(count_of(&counts, Level::Unknown), 1);
        assert_eq!(count_of(&counts, Level::Info), 0);
        assert_eq!(counts.iter().sum::<u64>(), filter.len(7) as u64);
    }

    #[test]
    fn lines_of_an_entry_without_a_hit_are_not_counted() {
        let mut filter = FilteredLines::new(spec(&[Level::Error], Some("needle")));
        feed(
            &mut filter,
            &[
                (Level::Error, false, "head"),
                (Level::Error, true, "  at a"),
                (Level::Error, false, "needle"),
            ],
        );
        let counts = view_counts(&filter);
        assert_eq!(count_of(&counts, Level::Error), 1);
        assert_eq!(filter.len(3), 1);
    }

    #[test]
    fn checkpoint_restores_the_counts_of_a_withdrawn_line() {
        let mut filter = FilteredLines::new(spec(&[Level::Error], Some("needle")));
        feed(
            &mut filter,
            &[
                (Level::Error, false, "head"),
                (Level::Error, true, "  at a"),
            ],
        );
        let checkpoint = filter.checkpoint();
        // A provisional continuation with the hit brings in the whole entry ...
        feed(&mut filter, &[(Level::Error, true, "  at needle")]);
        assert_eq!(count_of(&view_counts(&filter), Level::Error), 3);
        // ... withdrawn, the entry is pending again, and the real line counts it once.
        filter.restore(checkpoint);
        assert_eq!(count_of(&view_counts(&filter), Level::Error), 0);
        feed(&mut filter, &[(Level::Error, true, "  at needle, longer")]);
        assert_eq!(count_of(&view_counts(&filter), Level::Error), 3);
        assert_eq!(filter.len(3), 3);
    }

    #[test]
    fn a_file_starting_with_continuations_counts_each_line_once() {
        let mut filter = FilteredLines::new(spec(&Level::ALL, Some("needle")));
        feed(
            &mut filter,
            &[
                (Level::Warn, true, "  orphan"),
                (Level::Debug, true, "  more"),
                (Level::Debug, true, "  needle"),
            ],
        );
        let counts = view_counts(&filter);
        assert_eq!(filter.len(3), 3);
        assert_eq!(
            (
                count_of(&counts, Level::Warn),
                count_of(&counts, Level::Debug)
            ),
            (1, 2)
        );
    }

    #[test]
    fn clear_resets_the_counts() {
        let mut filter = FilteredLines::new(spec(&[Level::Error], None));
        feed(&mut filter, &[(Level::Error, false, "a")]);
        filter.clear();
        assert_eq!(view_counts(&filter), [0; Level::COUNT]);
        feed(&mut filter, &[(Level::Error, false, "b")]);
        assert_eq!(count_of(&view_counts(&filter), Level::Error), 1);
    }

    #[test]
    fn identity_counts_are_the_counts_of_all_lines() {
        let mut filter = FilteredLines::new(FilterSpec::default());
        feed(&mut filter, &[(Level::Info, false, "a")]);
        let all = [1, 2, 3, 4, 5, 6, 7];
        assert_eq!(filter.counts(&all), all);
    }

    #[test]
    fn all_levels_without_search_needs_no_list() {
        let mut filter = FilteredLines::new(FilterSpec::default());
        feed(&mut filter, &[(Level::Info, false, "a")]);
        assert!(filter.is_identity());
        assert_eq!(filter.len(1), 1);
        assert_eq!(filter.line_at(0, 1), Some(0));
    }

    #[test]
    fn level_filter_grows_incrementally() {
        let mut filter = FilteredLines::new(spec(&[Level::Error], None));
        feed(
            &mut filter,
            &[(Level::Info, false, "a"), (Level::Error, false, "b")],
        );
        assert_eq!(filter.len(2), 1);
        feed(
            &mut filter,
            &[(Level::Error, false, "c"), (Level::Warn, false, "d")],
        );
        assert_eq!(filter.len(4), 2);
        assert_eq!(filter.line_at(1, 4), Some(2));
        assert_eq!(filter.position_of(2, 4), 1);
        assert_eq!(filter.position_of(3, 4), 2);
    }

    #[test]
    fn search_hit_in_the_stack_trace_brings_the_whole_entry() {
        let mut filter = FilteredLines::new(spec(&[Level::Error, Level::Info], Some("needle")));
        feed(
            &mut filter,
            &[
                (Level::Info, false, "before"),
                (Level::Error, false, "head"),
                (Level::Error, true, "  at a"),
                (Level::Error, true, "  at needle"),
                (Level::Error, true, "  at b"),
                (Level::Info, false, "after"),
            ],
        );
        let shown: Vec<_> = (0..filter.len(6))
            .map(|p| filter.line_at(p, 6).unwrap())
            .collect();
        assert_eq!(shown, vec![1, 2, 3, 4]);
    }

    #[test]
    fn hit_in_the_head_brings_following_continuations() {
        let mut filter = FilteredLines::new(spec(&[Level::Error], Some("head")));
        feed(
            &mut filter,
            &[
                (Level::Error, false, "head"),
                (Level::Error, true, "  x"),
                (Level::Error, false, "other"),
            ],
        );
        assert_eq!(filter.len(3), 2);
    }

    #[test]
    fn checkpoint_undoes_a_provisional_line() {
        let mut filter = FilteredLines::new(spec(&[Level::Error], None));
        feed(&mut filter, &[(Level::Error, false, "a")]);
        let checkpoint = filter.checkpoint();
        feed(&mut filter, &[(Level::Error, false, "b")]);
        assert_eq!(filter.len(2), 2);
        filter.restore(checkpoint);
        assert_eq!(filter.len(1), 1);
        assert_eq!(filter.next_line(), 1);
    }

    #[test]
    fn highlight_mode_does_not_filter() {
        let mut highlight = spec(&[Level::Info], Some("x"));
        highlight.mode = SearchMode::Highlight;
        assert!(!highlight.needs_text());
        let mut all = spec(&Level::ALL, Some("x"));
        all.mode = SearchMode::Highlight;
        assert!(all.is_identity());
    }

    #[test]
    fn match_ranges_are_utf16_units() {
        let matcher = TextMatcher::new(&SearchQuery {
            text: "b".into(),
            is_regex: false,
            case_sensitive: true,
        })
        .unwrap();
        // "ä" one unit, "😀" two units.
        assert_eq!(matcher.match_ranges("äb😀b"), vec![[1, 2], [4, 5]]);
    }

    #[test]
    fn literal_search_escapes_and_regex_compiles_or_fails() {
        let query = |text: &str, is_regex| SearchQuery {
            text: text.into(),
            is_regex,
            case_sensitive: false,
        };
        assert!(TextMatcher::new(&query("a.c", false))
            .unwrap()
            .is_match("A.C"));
        assert!(!TextMatcher::new(&query("a.c", false))
            .unwrap()
            .is_match("abc"));
        assert!(TextMatcher::new(&query("a.c", true))
            .unwrap()
            .is_match("abc"));
        assert!(TextMatcher::new(&query("(", true)).is_err());
    }

    #[test]
    fn summary_follows_the_list_including_lines_taken_afterwards() {
        let mut filter = FilteredLines::new(spec(&Level::ALL, Some("needle")));
        let err = 1u8 << Level::Error as u8;
        feed(
            &mut filter,
            &[
                (Level::Info, false, "start"),
                (Level::Error, false, "failed"),
                (Level::Error, true, "at a"),
                (Level::Error, true, "at needle"),
                (Level::Info, false, "after"),
            ],
        );
        let summary = filter.summary().unwrap();
        assert_eq!(summary.len(), filter.len(5) as u64);
        assert_eq!(summary.buckets(3, 3).bits, vec![err, err, err]);

        // A provisional line taken and withdrawn again.
        let checkpoint = filter.checkpoint();
        feed(&mut filter, &[(Level::Warn, false, "needle warn")]);
        assert_eq!(filter.summary().unwrap().len(), 4);
        filter.restore(checkpoint);
        assert_eq!(filter.summary().unwrap().len(), 3);
        filter.clear();
        assert_eq!(filter.summary().unwrap().len(), 0);
        assert!(FilteredLines::new(FilterSpec::default())
            .summary()
            .is_none());
    }

    // ---------------------------------------------------------------- expressions (prompt 010)

    use crate::fields::FormatGuess;
    use crate::filter_expr::{Cond, ExprContext, FilterExpr, GroupOp};

    fn q(text: &str) -> SearchQuery {
        SearchQuery {
            text: text.into(),
            is_regex: false,
            case_sensitive: false,
        }
    }

    fn t(id: &str, negate: bool, text: &str) -> FilterExpr {
        FilterExpr::Cond {
            id: id.into(),
            negate,
            cond: Cond::Text(q(text)),
        }
    }

    fn g(op: GroupOp, children: Vec<FilterExpr>) -> FilterExpr {
        FilterExpr::Group {
            id: "g".into(),
            op,
            negate: false,
            children,
        }
    }

    fn range(start: &str, end: Option<&str>) -> FilterExpr {
        FilterExpr::Cond {
            id: "r".into(),
            negate: false,
            cond: Cond::Range {
                start: q(start),
                end: end.map(q),
                inclusive: true,
            },
        }
    }

    fn expr_spec(levels: &[Level], expr: &FilterExpr) -> FilterSpec {
        let ctx = ExprContext {
            format: Arc::new(FormatGuess::none()),
            sample: &[],
            reference: std::time::SystemTime::now(),
        };
        FilterSpec {
            expr: Some(Arc::new(CompiledExpr::compile(expr, &ctx).unwrap())),
            ..spec(levels, None)
        }
    }

    fn shown(filter: &FilteredLines, total: usize) -> Vec<u32> {
        (0..filter.len(total))
            .map(|p| filter.line_at(p, total).unwrap())
            .collect()
    }

    /// Lines as `(level, continuation, text)`; `E` head, `  ` continuation.
    fn entries(lines: &[&str]) -> Vec<(Level, bool, String)> {
        lines
            .iter()
            .map(|l| (Level::Info, l.starts_with(' '), l.to_string()))
            .collect()
    }

    fn feed_owned(filter: &mut FilteredLines, lines: &[(Level, bool, String)]) {
        for (level, continuation, text) in lines {
            let test = filter.spec.text_test();
            filter.append(*level, *continuation, || {
                test.probe_text(text, !continuation)
            });
        }
    }

    #[test]
    fn conditions_hold_for_the_entry_head_or_stack_trace() {
        let lines = entries(&[
            "Timeout calling billing",
            "  at OrderService.run",
            "Timeout elsewhere",
            "OrderService fine",
        ]);
        let and = g(
            GroupOp::And,
            vec![t("a", false, "timeout"), t("b", false, "orderservice")],
        );
        let mut filter = FilteredLines::new(expr_spec(&Level::ALL, &and));
        feed_owned(&mut filter, &lines);
        assert_eq!(shown(&filter, 4), vec![0, 1]);
        let or = g(
            GroupOp::Or,
            vec![t("a", false, "billing"), t("b", false, "fine")],
        );
        let mut filter = FilteredLines::new(expr_spec(&Level::ALL, &or));
        feed_owned(&mut filter, &lines);
        assert_eq!(shown(&filter, 4), vec![0, 1, 3]);
        let nested = g(
            GroupOp::And,
            vec![
                t("a", false, "timeout"),
                g(
                    GroupOp::Or,
                    vec![t("b", false, "billing"), t("c", false, "elsewhere")],
                ),
            ],
        );
        let mut filter = FilteredLines::new(expr_spec(&Level::ALL, &nested));
        feed_owned(&mut filter, &lines);
        assert_eq!(shown(&filter, 4), vec![0, 1, 2]);
    }

    #[test]
    fn a_late_hit_under_not_takes_the_entry_out_again() {
        let not = g(
            GroupOp::And,
            vec![t("a", false, "timeout"), t("b", true, "retry")],
        );
        let mut filter = FilteredLines::new(expr_spec(&Level::ALL, &not));
        feed_owned(
            &mut filter,
            &entries(&["ok timeout", "Timeout head", "  at a"]),
        );
        assert_eq!(shown(&filter, 3), vec![0, 1, 2]);
        assert_eq!(filter.take_retracted(), None);
        // The stack trace says retry: the entry, the end of the list, goes out.
        feed_owned(&mut filter, &entries(&["  at retry"]));
        assert_eq!(shown(&filter, 4), vec![0]);
        assert_eq!(filter.take_retracted(), Some(1));
        assert_eq!(filter.take_retracted(), None);
        assert_eq!(view_counts(&filter).iter().sum::<u64>(), 1);
        assert_eq!(filter.summary().unwrap().len(), 1);
        feed_owned(&mut filter, &entries(&["  at b", "timeout again"]));
        assert_eq!(shown(&filter, 6), vec![0, 5]);
    }

    #[test]
    fn not_or_other_brings_a_retracted_entry_back() {
        let expr = g(
            GroupOp::Or,
            vec![t("a", true, "retry"), t("b", false, "fatal")],
        );
        let mut filter = FilteredLines::new(expr_spec(&Level::ALL, &expr));
        feed_owned(
            &mut filter,
            &entries(&["head", "  retry", "  fatal", "  more"]),
        );
        assert_eq!(shown(&filter, 4), vec![0, 1, 2, 3]);
        assert_eq!(view_counts(&filter).iter().sum::<u64>(), 4);
    }

    #[test]
    fn levels_and_search_stay_an_and_above_the_tree() {
        let expr = t("a", false, "x");
        let mut filter = FilteredLines::new(FilterSpec {
            matcher: spec(&Level::ALL, Some("needle")).matcher,
            ..expr_spec(&[Level::Error], &expr)
        });
        let lines = vec![
            (Level::Error, false, "x needle".to_string()),
            (Level::Info, false, "x needle".to_string()),
            (Level::Error, false, "x".to_string()),
            (Level::Error, false, "needle".to_string()),
        ];
        feed_owned(&mut filter, &lines);
        assert_eq!(shown(&filter, 4), vec![0]);
    }

    #[test]
    fn ranges_in_and_or_or() {
        let lines = entries(&["a", "BEGIN", "b", "END", "c", "BEGIN", "d", "zzz"]);
        let mut filter = FilteredLines::new(expr_spec(&Level::ALL, &range("begin", Some("end"))));
        feed_owned(&mut filter, &lines);
        // Opened, closed, opened again and open at the end.
        assert_eq!(shown(&filter, 8), vec![1, 2, 3, 5, 6, 7]);
        // In an OR the section moves on even where the other side already decided.
        let or = g(
            GroupOp::Or,
            vec![t("x", false, "a"), range("begin", Some("end"))],
        );
        let mut filter = FilteredLines::new(expr_spec(&Level::ALL, &or));
        feed_owned(&mut filter, &lines);
        assert_eq!(shown(&filter, 8), vec![0, 1, 2, 3, 5, 6, 7]);
        let and = g(
            GroupOp::And,
            vec![t("x", false, "zzz"), range("begin", None)],
        );
        let mut filter = FilteredLines::new(expr_spec(&Level::ALL, &and));
        feed_owned(&mut filter, &lines);
        assert_eq!(shown(&filter, 8), vec![7]);
    }

    /// For each kind: a provisional line taken and withdrawn leaves the same state as never seen.
    #[test]
    fn checkpoint_withdraws_a_provisional_line_for_every_kind() {
        let level = FilterExpr::Cond {
            id: "l".into(),
            negate: false,
            cond: Cond::Level {
                levels: vec![Level::Error],
            },
        };
        let lines_cond = FilterExpr::Cond {
            id: "n".into(),
            negate: false,
            cond: Cond::Lines {
                first: Some(2),
                last: None,
            },
        };
        let kinds = [
            t("a", false, "hit"),
            t("a", true, "hit"),
            g(GroupOp::Or, vec![t("a", false, "hit"), t("b", true, "x")]),
            range("hit", Some("stop")),
            level,
            lines_cond,
        ];
        let base = vec![
            (Level::Error, false, "head hit".to_string()),
            (Level::Error, true, "  at a".to_string()),
        ];
        let provisional = [
            (Level::Error, true, "  at hit stop".to_string()),
            (Level::Info, false, "hit".to_string()),
            (Level::Error, true, "  x".to_string()),
        ];
        for expr in &kinds {
            for line in &provisional {
                let mut filter = FilteredLines::new(expr_spec(&Level::ALL, expr));
                feed_owned(&mut filter, &base);
                let before = (shown(&filter, 2), view_counts(&filter));
                let checkpoint = filter.checkpoint();
                feed_owned(&mut filter, std::slice::from_ref(line));
                filter.restore(checkpoint);
                assert_eq!(
                    (shown(&filter, 2), view_counts(&filter)),
                    before,
                    "{expr:?} {line:?}"
                );
                assert_eq!(filter.summary().unwrap().len() as usize, before.0.len());
                // And the real line after it gives what a fresh run gives.
                let next = (Level::Error, true, "  at b".to_string());
                feed_owned(&mut filter, std::slice::from_ref(&next));
                let mut fresh = FilteredLines::new(expr_spec(&Level::ALL, expr));
                feed_owned(&mut fresh, &[base.clone(), vec![next]].concat());
                assert_eq!(shown(&filter, 3), shown(&fresh, 3), "{expr:?} {line:?}");
                assert_eq!(view_counts(&filter), view_counts(&fresh));
            }
        }
    }

    #[test]
    fn retraction_by_a_provisional_line_is_undone_by_the_checkpoint() {
        let not = g(
            GroupOp::And,
            vec![t("a", false, "head"), t("b", true, "retry")],
        );
        let mut filter = FilteredLines::new(expr_spec(&Level::ALL, &not));
        feed_owned(&mut filter, &entries(&["x", "head", "  at a"]));
        assert_eq!(shown(&filter, 3), vec![1, 2]);
        let checkpoint = filter.checkpoint();
        feed_owned(&mut filter, &entries(&["  retry"]));
        assert_eq!(shown(&filter, 4), Vec::<u32>::new());
        filter.restore(checkpoint);
        assert_eq!(shown(&filter, 3), vec![1, 2]);
        assert_eq!(view_counts(&filter).iter().sum::<u64>(), 2);
        assert_eq!(filter.summary().unwrap().len(), 2);
        feed_owned(&mut filter, &entries(&["  fine", "head 2"]));
        assert_eq!(shown(&filter, 5), vec![1, 2, 3, 4]);
    }

    #[test]
    fn a_tree_without_text_reads_no_text() {
        let expr = FilterExpr::Cond {
            id: "l".into(),
            negate: false,
            cond: Cond::Level {
                levels: vec![Level::Warn],
            },
        };
        let mut filter = FilteredLines::new(expr_spec(&Level::ALL, &expr));
        for level in [Level::Info, Level::Warn, Level::Error] {
            filter.append(level, false, || panic!("text read"));
        }
        assert_eq!(shown(&filter, 3), vec![1]);
    }
}
