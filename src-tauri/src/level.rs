//! Level detection per line: keyword regex in the first ~200 bytes, JSON fields, multi-line
//! entries. Which regexes apply comes from a profile (`profile.rs`).

use regex::bytes::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Only the start of a line is searched: faster, and an `error` inside a message does not count.
pub const LEVEL_SEARCH_PREFIX: usize = 200;
const MAX_LEVEL_WORD: usize = 32;

#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(rename_all = "UPPERCASE")]
#[repr(u8)]
pub enum Level {
    #[default]
    Unknown = 0,
    Trace = 1,
    Debug = 2,
    Info = 3,
    Warn = 4,
    Error = 5,
    Fatal = 6,
}

impl Level {
    pub const COUNT: usize = 7;
    pub const ALL: [Level; Level::COUNT] = [
        Level::Unknown,
        Level::Trace,
        Level::Debug,
        Level::Info,
        Level::Warn,
        Level::Error,
        Level::Fatal,
    ];

    pub fn from_u8(value: u8) -> Level {
        Level::ALL
            .get(value as usize)
            .copied()
            .unwrap_or(Level::Unknown)
    }

    /// Maps the level words the prompt and the common frameworks use onto the six levels.
    pub fn from_word(word: &str) -> Option<Level> {
        Some(match word.to_ascii_lowercase().as_str() {
            "trace" | "trc" | "vrb" | "verbose" | "finest" | "finer" => Level::Trace,
            "debug" | "dbg" | "fine" => Level::Debug,
            "info" | "inf" | "information" | "informational" | "notice" | "config" => Level::Info,
            "warn" | "wrn" | "warning" => Level::Warn,
            "error" | "err" => Level::Error,
            "fatal" | "ftl" | "critical" | "crit" | "severe" | "alert" | "emerg" | "emergency"
            | "panic" => Level::Fatal,
            _ => return None,
        })
    }

    /// Pino/Bunyan numbers: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal.
    pub fn from_number(value: f64) -> Level {
        match value {
            v if v < 20.0 => Level::Trace,
            v if v < 30.0 => Level::Debug,
            v if v < 40.0 => Level::Info,
            v if v < 50.0 => Level::Warn,
            v if v < 60.0 => Level::Error,
            _ => Level::Fatal,
        }
    }

    /// Syslog severity (the PRI value modulo 8).
    pub fn from_syslog_severity(severity: u8) -> Level {
        match severity {
            0..=2 => Level::Fatal,
            3 => Level::Error,
            4 => Level::Warn,
            5 | 6 => Level::Info,
            _ => Level::Debug,
        }
    }
}

/// How one profile recognises the level of a line.
#[derive(Debug, Clone)]
pub struct LevelDetector {
    /// Tried in order; each has a named group `level` (or matches the word as a whole).
    patterns: Vec<Regex>,
    /// Lowercase word → level. Words not in here go through [`Level::from_word`].
    mapping: HashMap<String, Level>,
    json: bool,
    syslog_pri: bool,
    /// Marks the start of an entry without a level, so it does not join the previous entry.
    head: Option<Regex>,
}

impl LevelDetector {
    pub fn new(
        patterns: Vec<Regex>,
        mapping: HashMap<String, Level>,
        json: bool,
        syslog_pri: bool,
        head: Option<Regex>,
    ) -> Self {
        Self {
            patterns,
            mapping,
            json,
            syslog_pri,
            head,
        }
    }

    /// The level of a line by itself. `Some(Unknown)`: the start of an entry without a level.
    pub fn detect(&self, line: &[u8]) -> Option<Level> {
        if self.json && first_non_space(line) == Some(b'{') {
            if let Some(level) = detect_json(line) {
                return Some(level);
            }
        }
        if self.syslog_pri {
            if let Some(level) = detect_syslog_pri(line) {
                return Some(level);
            }
        }
        let prefix = &line[..line.len().min(LEVEL_SEARCH_PREFIX)];
        for pattern in &self.patterns {
            if let Some(level) = self.detect_pattern(pattern, prefix) {
                return Some(level);
            }
        }
        match &self.head {
            Some(head) if head.is_match(prefix) => Some(Level::Unknown),
            _ => None,
        }
    }

    fn detect_pattern(&self, pattern: &Regex, prefix: &[u8]) -> Option<Level> {
        let captures = pattern.captures(prefix)?;
        let word = captures.name("level")?.as_bytes();
        if word.len() > MAX_LEVEL_WORD {
            return None;
        }
        let word = std::str::from_utf8(word).ok()?;
        let mut lower = [0u8; MAX_LEVEL_WORD];
        let lower = &mut lower[..word.len()];
        lower.copy_from_slice(word.as_bytes());
        lower.make_ascii_lowercase();
        let lower = std::str::from_utf8(lower).ok()?;
        self.mapping
            .get(lower)
            .copied()
            .or_else(|| Level::from_word(lower))
    }

    /// Level and continuation flag of a line in the context of the previous one.
    pub fn classify(&self, line: &[u8], prev: &mut PrevLine) -> (Level, bool) {
        if prev.seen && looks_like_continuation(line) {
            return (prev.level, true);
        }
        if let Some(level) = self.detect(line) {
            prev.seen = true;
            prev.level = level;
            return (level, false);
        }
        if !prev.seen {
            prev.seen = true;
            prev.level = Level::Unknown;
            return (Level::Unknown, false);
        }
        if prev.level == Level::Unknown {
            // A text file without levels is many lines, not one giant entry.
            return (Level::Unknown, false);
        }
        (prev.level, true)
    }
}

/// State of the multi-line logic between two lines.
#[derive(Debug, Clone, Copy, Default)]
pub struct PrevLine {
    pub seen: bool,
    pub level: Level,
}

fn first_non_space(line: &[u8]) -> Option<u8> {
    line.iter().copied().find(|b| !b.is_ascii_whitespace())
}

/// Stack traces: `  at x`, `Caused by: x`, `Traceback (…)`, `... 12 more`, indented lines.
/// Checked before the regex: `at com.acme.error.Handler` is not an ERROR line.
fn looks_like_continuation(line: &[u8]) -> bool {
    match line.first() {
        Some(b' ' | b'\t') => first_non_space(line) != Some(b'{'),
        Some(b'a') => line.starts_with(b"at "),
        Some(b'C') => line.starts_with(b"Caused by:"),
        Some(b'T') => line.starts_with(b"Traceback"),
        Some(b'.') => line.starts_with(b"... "),
        _ => false,
    }
}

#[derive(Deserialize)]
struct JsonLevels<'a> {
    #[serde(borrow, default)]
    level: Option<JsonLevel<'a>>,
    #[serde(borrow, default)]
    severity: Option<JsonLevel<'a>>,
    #[serde(borrow, default)]
    lvl: Option<JsonLevel<'a>>,
    #[serde(borrow, default, rename = "@l")]
    at_l: Option<JsonLevel<'a>>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum JsonLevel<'a> {
    Number(f64),
    #[serde(borrow)]
    Text(std::borrow::Cow<'a, str>),
    #[allow(dead_code)]
    Other(serde::de::IgnoredAny),
}

impl JsonLevel<'_> {
    fn level(&self) -> Option<Level> {
        match self {
            JsonLevel::Number(value) => Some(Level::from_number(*value)),
            JsonLevel::Text(word) => Level::from_word(word),
            JsonLevel::Other(_) => None,
        }
    }
}

fn detect_json(line: &[u8]) -> Option<Level> {
    let fields: JsonLevels = serde_json::from_slice(line).ok()?;
    [fields.level, fields.severity, fields.lvl, fields.at_l]
        .iter()
        .flatten()
        .find_map(JsonLevel::level)
}

fn detect_syslog_pri(line: &[u8]) -> Option<Level> {
    let rest = line.strip_prefix(b"<")?;
    let end = rest.iter().take(4).position(|b| *b == b'>')?;
    let pri: u16 = std::str::from_utf8(&rest[..end]).ok()?.parse().ok()?;
    (pri <= 191).then(|| Level::from_syslog_severity((pri % 8) as u8))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{builtin_profiles, GENERIC_PROFILE};

    fn generic() -> LevelDetector {
        builtin_profiles()
            .into_iter()
            .find(|p| p.id == GENERIC_PROFILE)
            .unwrap()
            .detector()
            .unwrap()
    }

    fn profile(id: &str) -> LevelDetector {
        builtin_profiles()
            .into_iter()
            .find(|p| p.id == id)
            .unwrap()
            .detector()
            .unwrap()
    }

    #[test]
    fn maps_all_words_onto_six_levels() {
        let cases = [
            ("TRACE x", Level::Trace),
            ("debug x", Level::Debug),
            ("Info x", Level::Info),
            ("NOTICE x", Level::Info),
            ("WARN x", Level::Warn),
            ("WARNING x", Level::Warn),
            ("ERROR x", Level::Error),
            ("[ERR] x", Level::Error),
            ("FATAL x", Level::Fatal),
            ("CRITICAL x", Level::Fatal),
            ("crit x", Level::Fatal),
            ("SEVERE x", Level::Fatal),
        ];
        let detector = generic();
        for (line, level) in cases {
            assert_eq!(detector.detect(line.as_bytes()), Some(level), "{line}");
        }
    }

    #[test]
    fn word_boundaries_count() {
        assert_eq!(generic().detect(b"terrorism and information"), None);
    }

    #[test]
    fn first_level_wins_over_error_in_the_message() {
        assert_eq!(
            generic().detect(b"2024-01-01 10:00:00 INFO no error here"),
            Some(Level::Info)
        );
    }

    #[test]
    fn only_the_prefix_is_searched() {
        let line = format!("{} ERROR", "x".repeat(LEVEL_SEARCH_PREFIX + 10));
        assert_eq!(generic().detect(line.as_bytes()), None);
    }

    #[test]
    fn json_fields_and_numbers() {
        let detector = generic();
        let cases: [(&str, Level); 10] = [
            (r#"{"level":"warn","msg":"x"}"#, Level::Warn),
            (r#"{"severity":"ERROR","msg":"x"}"#, Level::Error),
            (r#"{"lvl":"debug"}"#, Level::Debug),
            (r#"{"@l":"Warning","@m":"x"}"#, Level::Warn),
            (r#"{"level":10}"#, Level::Trace),
            (r#"{"level":20}"#, Level::Debug),
            (r#"{"level":30}"#, Level::Info),
            (r#"{"level":40}"#, Level::Warn),
            (r#"{"level":50}"#, Level::Error),
            (r#"{"level":60}"#, Level::Fatal),
        ];
        for (line, level) in cases {
            assert_eq!(detector.detect(line.as_bytes()), Some(level), "{line}");
        }
    }

    #[test]
    fn level_field_after_a_long_json_prefix_is_found() {
        let line = format!(r#"{{"msg":"{}","level":"error"}}"#, "x".repeat(500));
        assert_eq!(generic().detect(line.as_bytes()), Some(Level::Error));
    }

    #[test]
    fn broken_json_falls_back_to_the_regex() {
        assert_eq!(generic().detect(b"{not json} WARN x"), Some(Level::Warn));
    }

    #[test]
    fn stack_trace_inherits_and_is_marked() {
        let detector = generic();
        let mut prev = PrevLine::default();
        let lines: [(&str, Level, bool); 7] = [
            ("2024-01-01 ERROR boom", Level::Error, false),
            ("java.lang.IllegalStateException: boom", Level::Error, true),
            (
                "\tat com.acme.error.Handler.run(Handler.java:1)",
                Level::Error,
                true,
            ),
            ("Caused by: java.io.IOException: error", Level::Error, true),
            ("... 12 more", Level::Error, true),
            ("Traceback (most recent call last):", Level::Error, true),
            ("2024-01-01 INFO fine", Level::Info, false),
        ];
        for (line, level, continuation) in lines {
            assert_eq!(
                detector.classify(line.as_bytes(), &mut prev),
                (level, continuation),
                "{line}"
            );
        }
    }

    #[test]
    fn no_level_and_no_predecessor_is_unknown() {
        let mut prev = PrevLine::default();
        assert_eq!(
            generic().classify(b"hello", &mut prev),
            (Level::Unknown, false)
        );
        // Plain text stays separate lines …
        assert_eq!(
            generic().classify(b"world", &mut prev),
            (Level::Unknown, false)
        );
        // … but an indented line still belongs to the one before.
        assert_eq!(
            generic().classify(b"  indented", &mut prev),
            (Level::Unknown, true)
        );
    }

    #[test]
    fn timestamped_line_without_level_starts_a_new_entry() {
        let mut prev = PrevLine::default();
        let detector = generic();
        detector.classify(b"2024-01-01 10:00:00 ERROR boom", &mut prev);
        assert_eq!(
            detector.classify(b"2024-01-01 10:00:01 server started", &mut prev),
            (Level::Unknown, false)
        );
    }

    #[test]
    fn log4j_spring_boot_logback() {
        let detector = profile("log4j");
        let cases = [
            (
                "2024-01-15T10:00:00.123+01:00  INFO 1234 --- [main] c.a.App : ok",
                Level::Info,
            ),
            (
                "2024-01-15 10:00:00,123 ERROR [main] c.a.App - x",
                Level::Error,
            ),
            ("10:00:00.123 [main] WARN  c.a.App - x", Level::Warn),
            ("[2024-01-15 10:00:00.123] DEBUG x", Level::Debug),
        ];
        for (line, level) in cases {
            assert_eq!(detector.detect(line.as_bytes()), Some(level), "{line}");
        }
    }

    #[test]
    fn python_logging() {
        let detector = profile("python");
        assert_eq!(detector.detect(b"ERROR:root:boom"), Some(Level::Error));
        assert_eq!(
            detector.detect(b"2024-01-15 10:00:00,123 - app.db - CRITICAL - gone"),
            Some(Level::Fatal)
        );
        assert_eq!(
            detector.detect(b"2024-01-15 10:00:00,123 WARNING app: careful"),
            Some(Level::Warn)
        );
    }

    #[test]
    fn serilog() {
        let detector = profile("serilog");
        assert_eq!(detector.detect(b"[10:00:00 WRN] x"), Some(Level::Warn));
        assert_eq!(
            detector.detect(b"2024-01-15 10:00:00.000 +01:00 [FTL] x"),
            Some(Level::Fatal)
        );
        assert_eq!(detector.detect(b"[10:00:00 INF] x"), Some(Level::Info));
    }

    #[test]
    fn syslog_priority_and_keywords() {
        let detector = profile("syslog");
        assert_eq!(
            detector.detect(b"<34>1 2003-10-11T22:14:15.003Z host su - ID47 - x"),
            Some(Level::Fatal)
        );
        assert_eq!(
            detector.detect(b"<14>Jan 15 10:00:00 host app: x"),
            Some(Level::Info)
        );
        assert_eq!(
            detector.detect(b"Jan 15 10:00:00 host app[12]: error: disk full"),
            Some(Level::Error)
        );
        // A syslog line without any level is an entry of its own.
        assert_eq!(
            detector.detect(b"Jan 15 10:00:00 host sshd[12]: Accepted key"),
            Some(Level::Unknown)
        );
    }

    #[test]
    fn nginx_and_apache_error_logs() {
        let detector = profile("webserver");
        assert_eq!(
            detector.detect(b"2024/01/15 10:00:00 [error] 12#0: *1 open() failed"),
            Some(Level::Error)
        );
        assert_eq!(
            detector.detect(b"[Mon Jan 15 10:00:00.1 2024] [core:warn] [pid 1] x"),
            Some(Level::Warn)
        );
        assert_eq!(
            detector.detect(b"2024/01/15 10:00:00 [emerg] 12#0: bind() failed"),
            Some(Level::Fatal)
        );
    }

    #[test]
    fn jsonl_profile_only_reads_json() {
        let detector = profile("jsonl");
        assert_eq!(detector.detect(br#"{"level":"info"}"#), Some(Level::Info));
        assert_eq!(detector.detect(b"ERROR not json"), None);
    }
}
