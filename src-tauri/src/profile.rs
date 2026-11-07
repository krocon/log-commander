//! Level profiles: built-in formats, user-defined regexes and the automatic suggestion.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::level::{Level, LevelDetector};
use regex::bytes::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const GENERIC_PROFILE: &str = "generic";
/// A format is suggested if at least this share of the sampled lines fits it.
const SUGGEST_MIN_RATIO: f64 = 0.3;
const SUGGEST_LINES: usize = 100;

const TIMESTAMP_HEAD: &str = r"(?-u)^\[?\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}";
const GENERIC_PATTERN: &str = r"(?i-u)\b(?P<level>TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|CRIT|SEVERE)\b";

/// Definition of a profile; custom ones arrive from the settings of the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub builtin: bool,
    pub patterns: Vec<String>,
    /// Word in the `level` group (any case) → level. Other words use the standard mapping.
    #[serde(default)]
    pub mapping: HashMap<String, Level>,
    #[serde(default)]
    pub json: bool,
    #[serde(default)]
    pub syslog_pri: bool,
    #[serde(default)]
    pub head: Option<String>,
}

impl Profile {
    fn builtin(id: &str, name: &str, patterns: &[&str]) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            builtin: true,
            patterns: patterns.iter().map(|p| (*p).to_string()).collect(),
            mapping: HashMap::new(),
            json: false,
            syslog_pri: false,
            head: Some(TIMESTAMP_HEAD.into()),
        }
    }

    pub fn detector(&self) -> AppResult<LevelDetector> {
        let patterns = self
            .patterns
            .iter()
            .map(|p| {
                let regex = Regex::new(p).map_err(|e| invalid(&self.name, &e.to_string()))?;
                if !regex.capture_names().flatten().any(|n| n == "level") {
                    return Err(invalid(
                        &self.name,
                        "the regex needs a group (?P<level>...)",
                    ));
                }
                Ok(regex)
            })
            .collect::<AppResult<Vec<_>>>()?;
        let head = self
            .head
            .as_deref()
            .map(Regex::new)
            .transpose()
            .map_err(|e| invalid(&self.name, &e.to_string()))?;
        let mapping = self
            .mapping
            .iter()
            .map(|(word, level)| (word.to_ascii_lowercase(), *level))
            .collect();
        Ok(LevelDetector::new(
            patterns,
            mapping,
            self.json,
            self.syslog_pri,
            head,
        ))
    }
}

fn invalid(name: &str, reason: &str) -> AppError {
    AppError::new(ErrorCode::InvalidProfile, format!("{name}: {reason}"))
}

pub fn builtin_profiles() -> Vec<Profile> {
    let mut generic = Profile::builtin(
        GENERIC_PROFILE,
        "Generic (keywords, JSON)",
        &[GENERIC_PATTERN],
    );
    generic.json = true;

    let log4j = Profile::builtin(
        "log4j",
        "Log4j / Logback / Spring Boot",
        &[
            r"(?-u)^\[?(?:\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}[.,]?\d*(?:Z|[+-]\d{2}:?\d{2})?\]?\s+(?:\[[^\]]*\]\s+)?(?P<level>TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b",
        ],
    );
    let python = Profile::builtin(
        "python",
        "Python logging",
        &[
            r"(?-u)^(?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL):[^:\s]*:",
            r"(?-u)^\S+ \S+ - .*? - (?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL) - ",
            r"(?-u)^\d{4}-\d{2}-\d{2} \S+ (?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL) ",
        ],
    );
    let serilog = Profile::builtin(
        "serilog",
        "Serilog",
        &[
            r"(?-u)\[(?:\d{2}:\d{2}:\d{2}\s)?(?P<level>VRB|DBG|INF|WRN|ERR|FTL|Verbose|Debug|Information|Warning|Error|Fatal)\]",
        ],
    );
    let mut syslog = Profile::builtin(
        "syslog",
        "Syslog",
        &[
            r"(?i-u)^[A-Z][a-z]{2}\s+\d+\s\d{2}:\d{2}:\d{2}\s\S+\s[^:]+:\s.*?\b(?P<level>DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|CRIT|ALERT|EMERG|PANIC)\b",
        ],
    );
    syslog.syslog_pri = true;
    syslog.head = Some(r"(?-u)^[A-Z][a-z]{2}\s+\d+\s\d{2}:\d{2}:\d{2}\s".into());

    let webserver = Profile::builtin(
        "webserver",
        "nginx / Apache error log",
        &[r"(?-u)\[(?:\w+:)?(?P<level>emerg|alert|crit|error|warn|notice|info|debug)\]"],
    );
    let mut jsonl = Profile::builtin("jsonl", "JSON Lines", &[]);
    jsonl.json = true;
    jsonl.head = None;

    vec![generic, log4j, python, serilog, syslog, webserver, jsonl]
}

/// Picks the format most of the first lines fit; `generic` if none stands out. Lines must already
/// be plain text bytes.
pub fn suggest_profile<'a>(lines: impl Iterator<Item = &'a [u8]>) -> String {
    let lines: Vec<&[u8]> = lines
        .filter(|line| !line.is_empty())
        .take(SUGGEST_LINES)
        .collect();
    if lines.is_empty() {
        return GENERIC_PROFILE.into();
    }
    let mut best: Option<(String, usize)> = None;
    for profile in builtin_profiles() {
        if profile.id == GENERIC_PROFILE {
            continue;
        }
        // The suggestion needs positive evidence: a head-only match of the shared timestamp
        // pattern does not count, except for syslog where the head *is* the format.
        let mut strict = profile.clone();
        if profile.id != "syslog" {
            strict.head = None;
        }
        let Ok(detector) = strict.detector() else {
            continue;
        };
        let hits = lines
            .iter()
            .filter(|line| detector.detect(line).is_some())
            .count();
        if hits > best.as_ref().map_or(0, |(_, h)| *h) {
            best = Some((profile.id, hits));
        }
    }
    match best {
        Some((id, hits)) if hits as f64 / lines.len() as f64 >= SUGGEST_MIN_RATIO => id,
        _ => GENERIC_PROFILE.into(),
    }
}

/// All known profiles: the fixed built-ins plus what the user defined.
#[derive(Debug, Default)]
pub struct ProfileRegistry {
    custom: Vec<Profile>,
}

impl ProfileRegistry {
    pub fn list(&self) -> Vec<Profile> {
        let mut all = builtin_profiles();
        all.extend(self.custom.iter().cloned());
        all
    }

    pub fn find(&self, id: &str) -> AppResult<Profile> {
        self.list()
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| AppError::new(ErrorCode::UnknownProfile, format!("no profile {id}")))
    }

    /// Replaces the custom profiles. All are validated first; nothing changes on an error.
    pub fn set_custom(&mut self, profiles: Vec<Profile>) -> AppResult<()> {
        let mut checked = Vec::with_capacity(profiles.len());
        for mut profile in profiles {
            profile.builtin = false;
            if profile.patterns.is_empty() {
                return Err(invalid(&profile.name, "the regex is empty"));
            }
            profile.detector()?;
            checked.push(profile);
        }
        self.custom = checked;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn suggest(text: &str) -> String {
        suggest_profile(text.lines().map(str::as_bytes))
    }

    #[test]
    fn suggests_by_format() {
        assert_eq!(
            suggest("2024-01-15T10:00:00.123+01:00  INFO 12 --- [main] a.B : x\n2024-01-15T10:00:01.123+01:00 ERROR 12 --- [main] a.B : y\n"),
            "log4j"
        );
        assert_eq!(suggest("ERROR:root:x\nINFO:root:y\n"), "python");
        assert_eq!(suggest("[10:00:00 INF] x\n[10:00:01 WRN] y\n"), "serilog");
        assert_eq!(
            suggest("Jan 15 10:00:00 host a: x\nJan 15 10:00:01 host a: y\n"),
            "syslog"
        );
        assert_eq!(
            suggest("2024/01/15 10:00:00 [error] 1#0: x\n2024/01/15 10:00:00 [warn] 1#0: y\n"),
            "webserver"
        );
        assert_eq!(suggest("{\"level\":\"info\"}\n{\"level\":30}\n"), "jsonl");
    }

    #[test]
    fn unknown_formats_get_generic() {
        assert_eq!(suggest("hello world\nerror somewhere\n"), GENERIC_PROFILE);
        assert_eq!(suggest(""), GENERIC_PROFILE);
    }

    #[test]
    fn custom_profile_maps_its_own_words() {
        let profile = Profile {
            id: "c".into(),
            name: "Custom".into(),
            builtin: false,
            patterns: vec![r"^(?P<level>OOPS|MEH) ".into()],
            mapping: HashMap::from([("oops".into(), Level::Fatal), ("MEH".into(), Level::Warn)]),
            json: false,
            syslog_pri: false,
            head: None,
        };
        let mut registry = ProfileRegistry::default();
        registry.set_custom(vec![profile]).unwrap();
        let detector = registry.find("c").unwrap().detector().unwrap();
        assert_eq!(detector.detect(b"OOPS x"), Some(Level::Fatal));
        assert_eq!(detector.detect(b"MEH x"), Some(Level::Warn));
        assert_eq!(detector.detect(b"nothing"), None);
    }

    #[test]
    fn rejects_regex_without_level_group_and_broken_regex() {
        let mut registry = ProfileRegistry::default();
        let make = |pattern: &str| Profile {
            id: "c".into(),
            name: "Custom".into(),
            builtin: false,
            patterns: vec![pattern.into()],
            mapping: HashMap::new(),
            json: false,
            syslog_pri: false,
            head: None,
        };
        let err = registry.set_custom(vec![make("^ERR")]).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidProfile);
        assert!(registry.set_custom(vec![make("(")]).is_err());
        assert_eq!(registry.list().len(), builtin_profiles().len());
    }
}
