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

/// What the user asked for, after compiling the search.
#[derive(Debug, Clone)]
pub struct FilterSpec {
    pub levels: LevelMask,
    pub matcher: Option<Arc<TextMatcher>>,
    pub mode: SearchMode,
}

impl Default for FilterSpec {
    fn default() -> Self {
        Self {
            levels: LevelMask::ALL,
            matcher: None,
            mode: SearchMode::Filter,
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
        self.levels == LevelMask::ALL && self.filtering_matcher().is_none()
    }

    pub fn needs_text(&self) -> bool {
        self.filtering_matcher().is_some()
    }
}

/// The incrementally maintained list. `None` as list = identity.
#[derive(Debug, Default)]
pub struct FilteredLines {
    pub spec: FilterSpec,
    list: Option<Vec<u32>>,
    entry_start: u32,
    entry_included: bool,
    next_line: u32,
}

/// State to restore when a provisional last line is withdrawn.
#[derive(Debug, Clone, Copy)]
pub struct FilterCheckpoint {
    entry_start: u32,
    entry_included: bool,
    next_line: u32,
    list_len: usize,
}

impl FilteredLines {
    pub fn new(spec: FilterSpec) -> Self {
        let list = (!spec.is_identity()).then(Vec::new);
        Self {
            spec,
            list,
            entry_start: 0,
            entry_included: false,
            next_line: 0,
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
        self.next_line = 0;
    }

    pub fn checkpoint(&self) -> FilterCheckpoint {
        FilterCheckpoint {
            entry_start: self.entry_start,
            entry_included: self.entry_included,
            next_line: self.next_line,
            list_len: self.list.as_ref().map_or(0, Vec::len),
        }
    }

    pub fn restore(&mut self, checkpoint: FilterCheckpoint) {
        self.entry_start = checkpoint.entry_start;
        self.entry_included = checkpoint.entry_included;
        self.next_line = checkpoint.next_line;
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
        let line = self.next_line;
        self.next_line += 1;
        let Some(list) = &mut self.list else {
            return;
        };
        if !continuation {
            self.entry_start = line;
            self.entry_included = false;
        }
        if self.entry_included {
            list.push(line);
            return;
        }
        if !self.spec.levels.contains(level) {
            return;
        }
        let matched = match self.spec.filtering_matcher() {
            None => true,
            Some(_) => text_matches(),
        };
        if matched {
            // A hit in a stack trace also brings in the head of the entry and the lines between.
            list.extend(self.entry_start..=line);
            self.entry_included = true;
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
        }
    }

    fn feed(filter: &mut FilteredLines, lines: &[(Level, bool, &str)]) {
        for (level, continuation, text) in lines {
            let matcher = filter.spec.filtering_matcher().cloned();
            filter.append(*level, *continuation, || {
                matcher.is_some_and(|m| m.is_match(text))
            });
        }
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
