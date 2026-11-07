//! Timestamps in log lines, without a regex per line: recognising one at the start of a text (the
//! field inference of `fields.rs`) and turning it into microseconds since the epoch, UTC (the merge
//! of prompt 006). The format is determined once from a sample and then tried first.
//!
//! Without a zone the local zone of this computer applies. Syslog has no year and some logs only a
//! time of day: both take the date from a reference (the modification time of the file).

use chrono::{Datelike, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike};
use serde::Deserialize;
use std::time::SystemTime;

const MONTHS: [&[u8; 3]; 12] = [
    b"Jan", b"Feb", b"Mar", b"Apr", b"May", b"Jun", b"Jul", b"Aug", b"Sep", b"Oct", b"Nov", b"Dec",
];
const WEEKDAYS: [&[u8; 3]; 7] = [b"Mon", b"Tue", b"Wed", b"Thu", b"Fri", b"Sat", b"Sun"];
/// A jump back by more than this between two times of day means the next day began.
const DAY_ROLLOVER_SECS: i64 = 6 * 3600;
/// An Apache/nginx access line has its time within this many bytes.
const CLF_SEARCH: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TsFormat {
    /// `2022-01-12 10:36:43,544`, `…T10:36:43.544Z`, `…+01:00`, `… +01:00` (Log4j, Logback, ISO 8601, Serilog).
    Iso,
    /// `2022/01/12 10:36:43` (nginx error log).
    Slash,
    /// `12/Jan/2022:10:36:43 +0000` (Apache and nginx access log, not at the start of the line).
    Clf,
    /// `Jan 12 10:36:43` (syslog, no year).
    Syslog,
    /// `Mon Jan 15 10:00:00.123 2024` (Apache error log).
    Ctime,
    /// `10:36:43.544` (time of day only).
    TimeOnly,
}

impl TsFormat {
    pub const ALL: [TsFormat; 6] = [
        TsFormat::Iso,
        TsFormat::Slash,
        TsFormat::Clf,
        TsFormat::Ctime,
        TsFormat::Syslog,
        TsFormat::TimeOnly,
    ];

    /// The same shape as a regex fragment, for layouts built by the inference.
    pub fn regex(self) -> &'static str {
        match self {
            TsFormat::Iso => {
                r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?: ?(?:Z|[+-]\d{2}:?\d{2}))?"
            }
            TsFormat::Slash => r"\d{4}/\d{2}/\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?",
            TsFormat::Clf => r"\d{2}/[A-Z][a-z]{2}/\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?",
            TsFormat::Syslog => r"[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}",
            TsFormat::Ctime => {
                r"[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}(?:\.\d+)? \d{4}"
            }
            TsFormat::TimeOnly => r"\d{2}:\d{2}:\d{2}(?:[.,]\d+)?",
        }
    }
}

/// What a scan found: the parts as written, plus the length in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Parts {
    len: usize,
    year: Option<i32>,
    month: Option<u32>,
    day: Option<u32>,
    hour: u32,
    minute: u32,
    second: u32,
    micros: u32,
    /// Offset east of UTC in seconds, if the text names one.
    offset: Option<i32>,
}

/// Length in bytes of a timestamp at the very start of `text`, a surrounding `[…]` included.
pub fn recognise(text: &str) -> Option<(TsFormat, usize)> {
    let bytes = text.as_bytes();
    let (inner, bracket) = match bytes.first() {
        Some(b'[') => (&bytes[1..], 1),
        _ => (bytes, 0),
    };
    for format in TsFormat::ALL {
        if let Some(parts) = scan(inner, format) {
            let mut len = bracket + parts.len;
            if bracket == 1 {
                if bytes.get(len) != Some(&b']') {
                    continue;
                }
                len += 1;
            }
            return Some((format, len));
        }
    }
    None
}

fn scan(b: &[u8], format: TsFormat) -> Option<Parts> {
    match format {
        TsFormat::Iso => scan_date_time(b, b'-'),
        TsFormat::Slash => scan_date_time(b, b'/'),
        TsFormat::Clf => scan_clf(b),
        TsFormat::Syslog => scan_syslog(b),
        TsFormat::Ctime => scan_ctime(b),
        TsFormat::TimeOnly => {
            let (hour, minute, second, micros, len) = scan_time(b)?;
            Some(Parts {
                len,
                year: None,
                month: None,
                day: None,
                hour,
                minute,
                second,
                micros,
                offset: None,
            })
        }
    }
}

fn digits(b: &[u8], at: usize, n: usize) -> Option<u32> {
    let slice = b.get(at..at + n)?;
    slice.iter().try_fold(0u32, |acc, d| {
        d.is_ascii_digit().then(|| acc * 10 + u32::from(d - b'0'))
    })
}

/// `HH:MM:SS` with an optional fraction after `.` or `,`.
fn scan_time(b: &[u8]) -> Option<(u32, u32, u32, u32, usize)> {
    let hour = digits(b, 0, 2)?;
    let minute = (b.get(2) == Some(&b':')).then(|| digits(b, 3, 2))??;
    let second = (b.get(5) == Some(&b':')).then(|| digits(b, 6, 2))??;
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let mut len = 8;
    let mut micros = 0u32;
    if matches!(b.get(8), Some(b'.' | b',')) && b.get(9).is_some_and(u8::is_ascii_digit) {
        len = 9;
        let mut scale = 100_000u32;
        while let Some(d) = b.get(len).filter(|d| d.is_ascii_digit()) {
            micros += u32::from(d - b'0') * scale;
            scale /= 10;
            len += 1;
        }
    }
    Some((hour, minute, second.min(59), micros, len))
}

/// `Z`, `+01:00`, `+0100`, optionally after one space.
fn scan_offset(b: &[u8]) -> Option<(i32, usize)> {
    let (b, space) = match b.first() {
        Some(b' ') => (&b[1..], 1),
        _ => (b, 0),
    };
    match b.first()? {
        b'Z' if space == 0 => Some((0, 1)),
        sign @ (b'+' | b'-') => {
            let hours = digits(b, 1, 2)?;
            let (minutes, len) = match b.get(3) {
                Some(b':') => (digits(b, 4, 2)?, 6),
                _ => (digits(b, 3, 2)?, 5),
            };
            let secs = (hours * 3600 + minutes * 60) as i32;
            Some((if *sign == b'-' { -secs } else { secs }, space + len))
        }
        _ => None,
    }
}

fn scan_date_time(b: &[u8], sep: u8) -> Option<Parts> {
    let year = digits(b, 0, 4)?;
    let month = (b.get(4) == Some(&sep)).then(|| digits(b, 5, 2))??;
    let day = (b.get(7) == Some(&sep)).then(|| digits(b, 8, 2))??;
    if !matches!(b.get(10), Some(b'T' | b' ')) || !(1..=12).contains(&month) || day == 0 {
        return None;
    }
    let (hour, minute, second, micros, time_len) = scan_time(&b[11..])?;
    let mut len = 11 + time_len;
    let offset = if sep == b'-' {
        scan_offset(&b[len..]).map(|(offset, n)| {
            len += n;
            offset
        })
    } else {
        None
    };
    Some(Parts {
        len,
        year: Some(year as i32),
        month: Some(month),
        day: Some(day),
        hour,
        minute,
        second,
        micros,
        offset,
    })
}

fn month(b: &[u8]) -> Option<u32> {
    let word = b.get(..3)?;
    MONTHS
        .iter()
        .position(|m| m.as_slice() == word)
        .map(|i| i as u32 + 1)
}

/// `12/Jan/2022:10:36:43 +0000`
fn scan_clf(b: &[u8]) -> Option<Parts> {
    let day = digits(b, 0, 2)?;
    let month = (b.get(2) == Some(&b'/')).then(|| month(&b[3..]))??;
    let year = (b.get(6) == Some(&b'/')).then(|| digits(b, 7, 4))??;
    if b.get(11) != Some(&b':') {
        return None;
    }
    let (hour, minute, second, micros, time_len) = scan_time(&b[12..])?;
    let mut len = 12 + time_len;
    let offset = match scan_offset(&b[len..]) {
        Some((offset, n)) if b.get(len) == Some(&b' ') => {
            len += n;
            Some(offset)
        }
        _ => None,
    };
    Some(Parts {
        len,
        year: Some(year as i32),
        month: Some(month),
        day: Some(day),
        hour,
        minute,
        second,
        micros,
        offset,
    })
}

/// Day of month with one or two digits, or a space-padded one: `12`, ` 5`, `5`.
fn day_of_month(b: &[u8]) -> Option<(u32, usize)> {
    match (b.first()?, b.get(1)) {
        (b' ', Some(d)) if d.is_ascii_digit() => Some((u32::from(d - b'0'), 2)),
        (d1, Some(d2)) if d1.is_ascii_digit() && d2.is_ascii_digit() => {
            Some((u32::from(d1 - b'0') * 10 + u32::from(d2 - b'0'), 2))
        }
        (d, _) if d.is_ascii_digit() => Some((u32::from(d - b'0'), 1)),
        _ => None,
    }
}

/// `Jan 12 10:36:43`
fn scan_syslog(b: &[u8]) -> Option<Parts> {
    let month = month(b)?;
    if b.get(3) != Some(&b' ') {
        return None;
    }
    let (day, n) = day_of_month(&b[4..])?;
    let at = 4 + n;
    if b.get(at) != Some(&b' ') || day == 0 {
        return None;
    }
    let (hour, minute, second, micros, time_len) = scan_time(&b[at + 1..])?;
    Some(Parts {
        len: at + 1 + time_len,
        year: None,
        month: Some(month),
        day: Some(day),
        hour,
        minute,
        second,
        micros,
        offset: None,
    })
}

/// `Mon Jan 15 10:00:00.123 2024`
fn scan_ctime(b: &[u8]) -> Option<Parts> {
    let weekday = b.get(..3)?;
    if !WEEKDAYS.iter().any(|w| w.as_slice() == weekday) || b.get(3) != Some(&b' ') {
        return None;
    }
    let mut parts = scan_syslog(&b[4..])?;
    let at = 4 + parts.len;
    let year = (b.get(at) == Some(&b' ')).then(|| digits(b, at + 1, 4))??;
    parts.len = at + 5;
    parts.year = Some(year as i32);
    Some(parts)
}

#[derive(Deserialize)]
struct JsonTime<'a> {
    #[serde(borrow, default)]
    timestamp: Option<JsonValue<'a>>,
    #[serde(borrow, default, rename = "@timestamp")]
    at_timestamp: Option<JsonValue<'a>>,
    #[serde(borrow, default)]
    time: Option<JsonValue<'a>>,
    #[serde(borrow, default)]
    ts: Option<JsonValue<'a>>,
    #[serde(borrow, default, rename = "@t")]
    at_t: Option<JsonValue<'a>>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum JsonValue<'a> {
    Number(f64),
    #[serde(borrow)]
    Text(std::borrow::Cow<'a, str>),
    #[allow(dead_code)]
    Other(serde::de::IgnoredAny),
}

/// Turns timestamps of one source into microseconds since the epoch (UTC).
#[derive(Debug, Clone)]
pub struct TimestampParser {
    /// Tried first; found from a sample.
    preferred: Option<TsFormat>,
    /// Local date of the reference (modification time of the file).
    reference: NaiveDate,
    /// For time-only logs: the last time of day and how many days passed since the reference.
    last_time: Option<i64>,
    day_offset: i64,
}

impl TimestampParser {
    pub fn new(reference: SystemTime) -> Self {
        let reference = chrono::DateTime::<Local>::from(reference).date_naive();
        Self {
            preferred: None,
            reference,
            last_time: None,
            day_offset: 0,
        }
    }

    /// Picks the format most of the sample lines start with (or contain, for access logs).
    pub fn detect<'a>(sample: impl Iterator<Item = &'a str>, reference: SystemTime) -> Self {
        let mut counts = [0usize; TsFormat::ALL.len()];
        for line in sample {
            if let Some((format, _)) = find(line, None) {
                if let Some(i) = TsFormat::ALL.iter().position(|f| *f == format) {
                    counts[i] += 1;
                }
            }
        }
        let mut parser = Self::new(reference);
        parser.preferred = counts
            .iter()
            .enumerate()
            .filter(|(_, n)| **n > 0)
            .max_by_key(|(i, n)| (**n, usize::MAX - i))
            .map(|(i, _)| TsFormat::ALL[i]);
        parser
    }

    pub fn format(&self) -> Option<TsFormat> {
        self.preferred
    }

    /// Microseconds since the epoch, UTC, or `None` if the line has no recognisable time.
    pub fn parse(&mut self, line: &str) -> Option<i64> {
        if line.trim_start().starts_with('{') {
            if let Some(micros) = self.parse_json(line) {
                return Some(micros);
            }
        }
        let (format, at) = find(line, self.preferred)?;
        let bytes = &line.as_bytes()[at..];
        let parts = scan(bytes, format)?;
        self.micros_of(parts)
    }

    fn parse_json(&mut self, line: &str) -> Option<i64> {
        let fields: JsonTime = serde_json::from_str(line.trim()).ok()?;
        let value = [
            fields.timestamp,
            fields.at_timestamp,
            fields.time,
            fields.ts,
            fields.at_t,
        ]
        .into_iter()
        .flatten()
        .next()?;
        match value {
            JsonValue::Number(n) if n.is_finite() && n > 0.0 => Some(epoch_number(n)),
            JsonValue::Text(text) => {
                let (format, len) = recognise(&text)?;
                let inner = text.as_bytes();
                let start = usize::from(inner.first() == Some(&b'['));
                let parts = scan(&inner[start..len], format)?;
                self.micros_of(parts)
            }
            _ => None,
        }
    }

    fn micros_of(&mut self, parts: Parts) -> Option<i64> {
        let time =
            NaiveTime::from_hms_micro_opt(parts.hour, parts.minute, parts.second, parts.micros)?;
        let date = match (parts.year, parts.month, parts.day) {
            (Some(year), Some(month), Some(day)) => NaiveDate::from_ymd_opt(year, month, day)?,
            (None, Some(month), Some(day)) => {
                // Syslog: the year of the reference, a later month belongs to the year before.
                let year = self.reference.year() - i32::from(month > self.reference.month());
                NaiveDate::from_ymd_opt(year, month, day)?
            }
            _ => {
                let seconds = i64::from(time.num_seconds_from_midnight());
                if let Some(last) = self.last_time {
                    if seconds + DAY_ROLLOVER_SECS < last {
                        self.day_offset += 1;
                    }
                }
                self.last_time = Some(seconds);
                self.reference
                    .checked_add_signed(chrono::Duration::days(self.day_offset))?
            }
        };
        let naive = NaiveDateTime::new(date, time);
        let utc = match parts.offset {
            Some(offset) => naive.and_utc().timestamp_micros() - i64::from(offset) * 1_000_000,
            None => Local
                .from_local_datetime(&naive)
                .earliest()?
                .timestamp_micros(),
        };
        Some(utc)
    }
}

/// Epoch as a number: seconds, milliseconds or microseconds, told apart by size.
fn epoch_number(n: f64) -> i64 {
    if n >= 1e14 {
        n as i64
    } else if n >= 1e11 {
        (n * 1_000.0) as i64
    } else {
        (n * 1_000_000.0) as i64
    }
}

/// Where a timestamp of a line starts: at the start (after an optional `[`), or for access logs
/// in the first `[` of the line.
fn find(line: &str, preferred: Option<TsFormat>) -> Option<(TsFormat, usize)> {
    let bytes = line.as_bytes();
    let at_start = usize::from(bytes.first() == Some(&b'['));
    let try_format = |format: TsFormat| -> Option<(TsFormat, usize)> {
        if format == TsFormat::Clf {
            let window = &bytes[..bytes.len().min(CLF_SEARCH)];
            let open = memchr::memchr(b'[', window)?;
            scan(&bytes[open + 1..], format).map(|_| (format, open + 1))
        } else {
            scan(&bytes[at_start..], format).map(|_| (format, at_start))
        }
    };
    if let Some(found) = preferred.and_then(try_format) {
        return Some(found);
    }
    TsFormat::ALL
        .into_iter()
        .filter(|f| Some(*f) != preferred)
        .find_map(try_format)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    fn utc(text: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(text)
            .unwrap()
            .timestamp_micros()
    }

    fn local(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32, micros: u32) -> i64 {
        let naive = NaiveDate::from_ymd_opt(y, mo, d)
            .unwrap()
            .and_hms_micro_opt(h, mi, s, micros)
            .unwrap();
        Local
            .from_local_datetime(&naive)
            .earliest()
            .unwrap()
            .timestamp_micros()
    }

    /// 2022-03-01 12:00 UTC: a reference in March.
    fn reference() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_646_136_000)
    }

    fn parse(line: &str) -> Option<i64> {
        TimestampParser::new(reference()).parse(line)
    }

    #[test]
    fn iso_variants() {
        assert_eq!(
            parse("2022-01-12T10:36:43.544Z INFO x"),
            Some(utc("2022-01-12T10:36:43.544Z"))
        );
        assert_eq!(
            parse("2022-01-12T10:36:43.544+01:00 INFO x"),
            Some(utc("2022-01-12T09:36:43.544Z"))
        );
        assert_eq!(
            parse("2022-01-12 10:36:43,544 ERROR x"),
            Some(local(2022, 1, 12, 10, 36, 43, 544_000))
        );
        assert_eq!(
            parse("2022-01-12 10:36:43.123456 x"),
            Some(local(2022, 1, 12, 10, 36, 43, 123_456))
        );
        assert_eq!(
            parse("2024-01-15 10:00:00.000 +01:00 [FTL] x"),
            Some(utc("2024-01-15T09:00:00Z"))
        );
        assert_eq!(
            parse("[2022-01-12 10:36:43] x"),
            Some(local(2022, 1, 12, 10, 36, 43, 0))
        );
        assert_eq!(
            parse("2022/01/12 10:36:43 [error] x"),
            Some(local(2022, 1, 12, 10, 36, 43, 0))
        );
    }

    #[test]
    fn access_log_time_is_found_inside_the_line() {
        assert_eq!(
            parse(r#"10.0.0.1 - - [12/Jan/2022:10:36:43 +0000] "GET / HTTP/1.1" 200 5"#),
            Some(utc("2022-01-12T10:36:43Z"))
        );
    }

    #[test]
    fn syslog_takes_the_year_from_the_reference() {
        assert_eq!(
            parse("Jan 12 10:36:43 host app: x"),
            Some(local(2022, 1, 12, 10, 36, 43, 0))
        );
        // A month after the reference belongs to the year before.
        assert_eq!(
            parse("Dec  5 10:36:43 host app: x"),
            Some(local(2021, 12, 5, 10, 36, 43, 0))
        );
    }

    #[test]
    fn apache_error_log_ctime() {
        assert_eq!(
            parse("[Mon Jan 15 10:00:00.5 2024] [core:warn] x"),
            Some(local(2024, 1, 15, 10, 0, 0, 500_000))
        );
    }

    #[test]
    fn time_only_rolls_over_to_the_next_day() {
        let mut parser = TimestampParser::new(reference());
        let late = parser.parse("23:59:58.100 [main] INFO x").unwrap();
        let early = parser.parse("00:00:01.000 [main] INFO y").unwrap();
        assert_eq!(late, local(2022, 3, 1, 23, 59, 58, 100_000));
        assert_eq!(early, local(2022, 3, 2, 0, 0, 1, 0));
        // A small step back is out-of-order writing, not a new day.
        let back = parser.parse("00:00:00.500 [main] INFO z").unwrap();
        assert_eq!(back, local(2022, 3, 2, 0, 0, 0, 500_000));
    }

    #[test]
    fn json_strings_and_epochs() {
        assert_eq!(
            parse(r#"{"time":"2026-01-15T10:00:00.123Z","level":30}"#),
            Some(utc("2026-01-15T10:00:00.123Z"))
        );
        assert_eq!(
            parse(r#"{"@timestamp":"2026-01-15T10:00:00Z"}"#),
            Some(utc("2026-01-15T10:00:00Z"))
        );
        assert_eq!(parse(r#"{"ts":1700000000}"#), Some(1_700_000_000_000_000));
        assert_eq!(
            parse(r#"{"ts":1700000000123}"#),
            Some(1_700_000_000_123_000)
        );
        assert_eq!(parse(r#"{"ts":1700000000.5}"#), Some(1_700_000_000_500_000));
    }

    #[test]
    fn nonsense_is_none() {
        for line in [
            "",
            "hello",
            "2022-13-01 10:00:00 x",
            "2022-13-45 10:00:00 x",
            "2022-02-30 10:00:00 x",
            "2022-01-12 25:00:00 x",
            "12345",
            "Foo 12 10:00:00",
            "{\"msg\":\"no time\"}",
        ] {
            assert_eq!(parse(line), None, "{line}");
        }
    }

    #[test]
    fn recognise_gives_format_and_length() {
        assert_eq!(
            recognise("2026-01-15T10:00:00.123+01:00  INFO"),
            Some((TsFormat::Iso, 29))
        );
        assert_eq!(recognise("[10:00:00 INF] x"), None);
        assert_eq!(
            recognise("[2026-01-15 10:00:00] x"),
            Some((TsFormat::Iso, 21))
        );
        assert_eq!(
            recognise("10:00:00.123 [main]"),
            Some((TsFormat::TimeOnly, 12))
        );
        assert_eq!(
            recognise("Jan  5 10:00:00 host"),
            Some((TsFormat::Syslog, 15))
        );
        assert_eq!(
            recognise("2026/01/15 10:00:00 [error]"),
            Some((TsFormat::Slash, 19))
        );
    }

    #[test]
    fn regex_fragments_match_what_the_scanner_accepts() {
        let cases = [
            (TsFormat::Iso, "2026-01-15T10:00:00.123+01:00"),
            (TsFormat::Iso, "2024-01-15 10:00:00.000 +01:00"),
            (TsFormat::Slash, "2026/01/15 10:00:00"),
            (TsFormat::Clf, "12/Jan/2022:10:36:43 +0000"),
            (TsFormat::Syslog, "Jan  5 10:00:00"),
            (TsFormat::Ctime, "Mon Jan 15 10:00:00.5 2024"),
            (TsFormat::TimeOnly, "10:00:00,123"),
        ];
        for (format, text) in cases {
            let regex = regex::Regex::new(&format!("^{}$", format.regex())).unwrap();
            assert!(regex.is_match(text), "{format:?} {text}");
            assert!(
                scan(text.as_bytes(), format).is_some_and(|p| p.len == text.len()),
                "{text}"
            );
        }
    }

    #[test]
    fn detect_prefers_the_common_format() {
        let sample = [
            "10:00:00.000 a",
            "2026-01-15 10:00:00 b",
            "2026-01-15 10:00:01 c",
        ];
        let parser = TimestampParser::detect(sample.into_iter(), reference());
        assert_eq!(parser.format(), Some(TsFormat::Iso));
    }
}
