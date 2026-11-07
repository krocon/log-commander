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

/// How a line splits into fields (`fields.rs`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Structure {
    /// The `layouts`: regexes with named groups. Without layouts the format is inferred.
    #[default]
    Regex,
    /// JSON Lines: the top-level keys of the sample.
    Json,
    /// `key=value key="quoted value"`.
    Logfmt,
    /// FIX `tag=value`, separated by SOH (shown as `|`) or `|`.
    Fix,
    /// W3C extended log (IIS): names from the `#Fields:` directive.
    W3c,
}

/// Definition of a profile; custom ones arrive from the settings of the frontend.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// Regexes over the whole line; named groups become columns (`timestamp`, `date`, `time`,
    /// `thread`, `level`, `logger`, `message` are known, any other name is a column of its own).
    #[serde(default)]
    pub layouts: Vec<String>,
    #[serde(default)]
    pub structure: Structure,
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
            layouts: Vec::new(),
            structure: Structure::Regex,
        }
    }

    fn with_layouts(mut self, layouts: &[&str]) -> Self {
        self.layouts = layouts.iter().map(|l| (*l).to_string()).collect();
        self
    }

    /// The level detection of this profile. Also checks the layouts, so a broken one is reported
    /// the same way as a broken level regex.
    pub fn detector(&self) -> AppResult<LevelDetector> {
        crate::fields::compile_layouts(self)?;
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

/// Timestamp shapes shared by the layouts.
const TS_ISO: &str = r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?";
const TS_ISO_OR_TIME: &str =
    r"(?:\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?";
const LOG4J_LEVELS: &str = "TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL";

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
    )
    .with_layouts(&[
        // Spring Boot: `… INFO 4711 --- [app] [main] c.a.App : message` (application optional).
        &format!(
            r"^(?P<timestamp>{TS_ISO})\s+(?P<level>{LOG4J_LEVELS})\s+(?P<pid>\d+)\s+---\s+(?:\[(?P<application>[^\]]*)\]\s+)?\[\s*(?P<thread>[^\]]*?)\s*\]\s+(?P<logger>\S+)\s*:\s?(?P<message>.*)$"
        ),
        // Logback default: `10:00:00.123 [main] WARN  c.a.App - message`.
        &format!(
            r"^\[?(?P<timestamp>{TS_ISO_OR_TIME})\]?\s+\[(?P<thread>[^\]]*)\]\s+(?P<level>{LOG4J_LEVELS})\s+(?P<logger>\S+)\s+-\s?(?P<message>.*)$"
        ),
        // Log4j `%d %-5p [%t] %c - %m`.
        &format!(
            r"^\[?(?P<timestamp>{TS_ISO_OR_TIME})\]?\s+(?P<level>{LOG4J_LEVELS})\s+\[(?P<thread>[^\]]*)\]\s+(?P<logger>\S+)\s+-\s?(?P<message>.*)$"
        ),
        // Time and level only.
        &format!(
            r"^\[?(?P<timestamp>{TS_ISO_OR_TIME})\]? +(?P<level>{LOG4J_LEVELS})\b *(?:(?P<logger>[\w.$]+) - )?(?P<message>.*)$"
        ),
    ]);
    let python = Profile::builtin(
        "python",
        "Python logging",
        &[
            r"(?-u)^(?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL):[^:\s]*:",
            r"(?-u)^\S+ \S+ - .*? - (?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL) - ",
            r"(?-u)^\d{4}-\d{2}-\d{2} \S+ (?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL) ",
        ],
    )
    .with_layouts(&[
        r"^(?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL):(?P<logger>[^:\s]*):(?P<message>.*)$",
        r"^(?P<timestamp>\S+ \S+) - (?P<logger>.*?) - (?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL) - (?P<message>.*)$",
        r"^(?P<timestamp>\d{4}-\d{2}-\d{2} \S+) (?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL) (?:(?P<logger>[^:\s]+): )?(?P<message>.*)$",
    ]);
    let serilog = Profile::builtin(
        "serilog",
        "Serilog",
        &[
            r"(?-u)\[(?:\d{2}:\d{2}:\d{2}\s)?(?P<level>VRB|DBG|INF|WRN|ERR|FTL|Verbose|Debug|Information|Warning|Error|Fatal)\]",
        ],
    )
    .with_layouts(&[
        r"^(?P<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?(?: ?[+-]\d{2}:\d{2})?) \[(?P<level>VRB|DBG|INF|WRN|ERR|FTL|Verbose|Debug|Information|Warning|Error|Fatal)\] (?P<message>.*)$",
        r"^\[(?P<time>\d{2}:\d{2}:\d{2}) (?P<level>VRB|DBG|INF|WRN|ERR|FTL)\] (?P<message>.*)$",
    ]);
    let mut syslog = Profile::builtin(
        "syslog",
        "Syslog",
        &[
            r"(?i-u)^[A-Z][a-z]{2}\s+\d+\s\d{2}:\d{2}:\d{2}\s\S+\s[^:]+:\s.*?\b(?P<level>DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|CRIT|ALERT|EMERG|PANIC)\b",
        ],
    )
    .with_layouts(&[
        // RFC 3164, optionally with the priority.
        r"^(?:<(?P<pri>\d{1,3})>)?(?P<timestamp>[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}) (?P<host>\S+) (?P<logger>[^\s:\[]+)(?:\[(?P<pid>\d+)\])?: ?(?P<message>.*)$",
        // RFC 5424.
        r"^<(?P<pri>\d{1,3})>1 (?P<timestamp>\S+) (?P<host>\S+) (?P<logger>\S+) (?P<pid>\S+) (?P<msgid>\S+) (?P<data>-|(?:\[[^\]]*\])+) ?(?P<message>.*)$",
    ]);
    syslog.syslog_pri = true;
    syslog.head = Some(r"(?-u)^[A-Z][a-z]{2}\s+\d+\s\d{2}:\d{2}:\d{2}\s".into());

    let webserver = Profile::builtin(
        "webserver",
        "nginx / Apache error log",
        &[r"(?-u)\[(?:\w+:)?(?P<level>emerg|alert|crit|error|warn|notice|info|debug)\]"],
    )
    .with_layouts(&[
        r"^(?P<timestamp>\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}) \[(?P<level>\w+)\] (?P<pid>\d+)#(?P<tid>\d+): (?P<message>.*)$",
        r"^\[(?P<timestamp>[^\]]+)\] \[(?:(?P<module>\w+):)?(?P<level>\w+)\](?: \[pid (?P<pid>\d+)(?::tid (?P<tid>\d+))?\])?(?: \[client (?P<client>[^\]]+)\])? (?P<message>.*)$",
    ]);
    let mut jsonl = Profile::builtin("jsonl", "JSON Lines", &[]);
    jsonl.json = true;
    jsonl.head = None;
    jsonl.structure = Structure::Json;

    // Access logs: 4xx is a warning, 5xx an error, everything else an entry without a level.
    let mut access = Profile::builtin(
        "access",
        "Common / Combined Log (Apache, nginx)",
        &[r#"(?-u)^\S+ \S+ \S+ \[[^\]]+\] "[^"]*" (?P<level>[45])\d\d "#],
    )
    .with_layouts(&[
        r#"^(?P<client>\S+) (?P<ident>\S+) (?P<user>\S+) \[(?P<timestamp>[^\]]+)\] "(?P<request>[^"]*)" (?P<status>\d{3}) (?P<bytes>\d+|-)(?: "(?P<referer>[^"]*)" "(?P<agent>[^"]*)")?.*$"#,
    ]);
    access.mapping = HashMap::from([("4".into(), Level::Warn), ("5".into(), Level::Error)]);
    access.head = Some(r"(?-u)^\S+ \S+ \S+ \[\d{2}/[A-Z][a-z]{2}/\d{4}:".into());

    let mut w3c = Profile::builtin("w3c", "W3C Extended / IIS", &[]);
    w3c.head = Some(r"(?-u)^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} ".into());
    w3c.structure = Structure::W3c;

    let nlog = Profile::builtin(
        "nlog",
        "NLog",
        &[r"(?i-u)^\d{4}-\d{2}-\d{2} [\d:.]+\|(?P<level>trace|debug|info|warn|error|fatal)\|"],
    )
    .with_layouts(&[
        r"^(?P<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\|(?P<level>[A-Za-z]+)\|(?P<logger>[^|]*)\|(?P<message>.*)$",
    ]);

    let mut gc = Profile::builtin(
        "gc",
        "Java GC (Unified Logging)",
        &[r"(?-u)^\[[^\]]+\](?:\[[^\]]*\])*?\[(?P<level>trace|debug|info|warning|error)\s*\]"],
    )
    .with_layouts(&[
        r"^\[(?P<timestamp>[^\]]+)\](?:\[(?P<uptime>[\d.,]+s)\])?(?:\[[^\]]*\])*?\[(?P<level>trace|debug|info|warning|error)\s*\]\[(?P<tags>[^\]]+?)\s*\]\s?(?:GC\((?P<gc>\d+)\)\s*)?(?P<message>.*?)(?:\s(?P<duration_ms>\d+(?:[.,]\d+)?)ms)?$",
    ]);
    gc.head = Some(r"(?-u)^\[\d".into());

    let mut fix = Profile::builtin(
        "fix",
        "FIX",
        &[r"(?-u)(?:^|[\x01|])35=(?P<level>[3j])[\x01|]"],
    );
    fix.mapping = HashMap::from([("3".into(), Level::Error), ("j".into(), Level::Error)]);
    fix.head = Some(r"(?-u)8=FIX".into());
    fix.structure = Structure::Fix;

    let mut logfmt = Profile::builtin(
        "logfmt",
        "logfmt / key=value",
        &[r#"(?i-u)(?:^|\s)(?:level|lvl|severity)="?(?P<level>[a-z]+)"#],
    );
    logfmt.head = Some(r"(?-u)^[\w.@-]+=".into());
    logfmt.structure = Structure::Logfmt;

    vec![
        generic, log4j, python, serilog, syslog, webserver, jsonl, access, w3c, nlog, gc, fix,
        logfmt,
    ]
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
            if profile.patterns.is_empty()
                && profile.layouts.is_empty()
                && profile.structure == Structure::Regex
            {
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
            ..Profile::default()
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
            ..Profile::default()
        };
        let err = registry.set_custom(vec![make("^ERR")]).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidProfile);
        assert!(registry.set_custom(vec![make("(")]).is_err());
        assert_eq!(registry.list().len(), builtin_profiles().len());
    }
}
