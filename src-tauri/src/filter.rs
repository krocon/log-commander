//! Backend filter: active levels plus optional text search yield a sorted list of line numbers.
//! New lines extend the list incrementally; a multi-line entry stays together.

use crate::error::AppResult;
use crate::level::Level;
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
}

impl Default for FilterSpec {
    fn default() -> Self {
        Self {
            levels: LevelMask::ALL,
            matcher: None,
            mode: SearchMode::Filter,
            sources: SourceMask::ALL,
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
    }

    pub fn needs_text(&self) -> bool {
        self.filtering_matcher().is_some()
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
}

impl FilteredLines {
    pub fn new(spec: FilterSpec) -> Self {
        let list = (!spec.is_identity()).then(Vec::new);
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
        if let Some(list) = &mut self.list {
            list.truncate(checkpoint.list_len);
        }
    }

    /// Takes the next line. `text_matches` is only called when the answer matters.
    pub fn append(
        &mut self,
        level: Level,
        continuation: bool,
        text_matches: impl FnOnce() -> bool,
    ) {
        self.append_from(0, level, continuation, text_matches);
    }

    /// Takes the next line of a source (merge). The source of the head decides for the entry.
    pub fn append_from(
        &mut self,
        source: usize,
        level: Level,
        continuation: bool,
        text_matches: impl FnOnce() -> bool,
    ) {
        let line = self.next_line;
        self.next_line += 1;
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
            return;
        }
        if self.entry_excluded
            || !self.spec.levels.contains(level)
            || self.spec.filtering_matcher().is_some() && !text_matches()
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
            if self.entry_pending {
                for (count, pending) in self.counts.iter_mut().zip(self.entry_counts) {
                    *count += pending;
                }
                self.entry_counts = [0; Level::COUNT];
                self.entry_pending = false;
            }
        }
        list.push(line);
        self.counts[level as usize] += 1;
        self.entry_included = true;
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
            filter.append_from(source, level, continuation, || true);
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
            let matcher = filter.spec.filtering_matcher().cloned();
            filter.append(*level, *continuation, || {
                matcher.is_some_and(|m| m.is_match(text))
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
}
