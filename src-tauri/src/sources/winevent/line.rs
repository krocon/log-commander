//! An event as one JSON line of the spool (prompt 018): the JSON profile, the level detection and
//! the columns then work without a special path. Keys in this order: `timestamp`, `level`,
//! `provider`, `eventId`, `message`, `channel`, `computer`, `task`, `user`, `recordId`, `xml`.
//!
//! Strings are escaped so that an event stays one line and nothing in it can act on the display:
//! `"`, `\`, line breaks and tabs as usual, every other control character (C0, DEL, C1) and the
//! bidi marks and overrides, U+2028/2029 as `\uXXXX` (the same classes as the syslog spool of 016).

use super::event::Event;
use crate::sources::syslog::TRUNCATED_MARK;
use chrono::TimeZone;

/// Characters of the message in the line; longer ones are cut and marked.
pub const MAX_MESSAGE_CHARS: usize = 32 * 1024;
/// Characters of the attached XML.
pub const MAX_XML_CHARS: usize = 64 * 1024;

/// Keywords bits of the security audit (winmeta.xml).
pub const AUDIT_FAILURE: u64 = 0x0010_0000_0000_0000;
pub const AUDIT_SUCCESS: u64 = 0x0020_0000_0000_0000;

/// Windows level and keywords to the level words of the app (`Level::from_word`).
///
/// | Windows | App |
/// |---|---|
/// | Audit failure (keyword) | error |
/// | Audit success (keyword) | info |
/// | 1 Critical | fatal |
/// | 2 Error | error |
/// | 3 Warning | warn |
/// | 0 LogAlways, 4 Information | info |
/// | 5 Verbose | debug |
/// | 6–255 (provider-defined, more detailed) | trace |
pub fn app_level(level: u8, keywords: u64) -> &'static str {
    if keywords & AUDIT_FAILURE != 0 {
        return "error";
    }
    if keywords & AUDIT_SUCCESS != 0 {
        return "info";
    }
    match level {
        1 => "fatal",
        2 => "error",
        3 => "warn",
        0 | 4 => "info",
        5 => "debug",
        _ => "trace",
    }
}

/// Names of well-known accounts; other SIDs stay as they are (resolving them would ask the domain
/// for every new SID).
pub fn user_name(sid: &str) -> &str {
    match sid {
        "S-1-5-18" => "SYSTEM",
        "S-1-5-19" => "LOCAL SERVICE",
        "S-1-5-20" => "NETWORK SERVICE",
        "S-1-5-7" => "ANONYMOUS LOGON",
        "S-1-1-0" => "Everyone",
        "S-1-5-32-544" => "Administrators",
        other => other,
    }
}

/// `2026-11-08T09:15:30.1234567Z` in local time with milliseconds and offset
/// (`2026-11-08T10:15:30.123+01:00`); what cannot be read stays as written.
pub fn local_time<Tz: TimeZone>(system_time: &str, zone: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    match chrono::DateTime::parse_from_rfc3339(system_time) {
        Ok(t) => t
            .with_timezone(zone)
            .format("%Y-%m-%dT%H:%M:%S%.3f%:z")
            .to_string(),
        Err(_) => system_time.to_string(),
    }
}

/// What goes into the line besides the parsed event.
pub struct Extra<'a> {
    /// The formatted message; None or empty: the insertion strings stand in.
    pub message: Option<&'a str>,
    pub task: Option<&'a str>,
    /// The whole event XML, if it is attached.
    pub xml: Option<&'a str>,
}

/// The message, or the insertion strings when the provider has none (no message file).
pub fn message_text(event: &Event, message: Option<&str>) -> String {
    let message = message.map(str::trim_end).unwrap_or_default();
    if !message.is_empty() {
        return message.to_string();
    }
    let data: Vec<&str> = event
        .data
        .iter()
        .map(|d| d.trim())
        .filter(|d| !d.is_empty())
        .collect();
    if data.is_empty() {
        format!(
            "(keine Meldung) Ereignis {} von {}",
            event.event_id, event.provider
        )
    } else {
        format!("(keine Meldung) {}", data.join("; "))
    }
}

/// The spool line; true if the message or the XML was cut.
pub fn json_line<Tz: TimeZone>(event: &Event, extra: &Extra, zone: &Tz, out: &mut String) -> bool
where
    Tz::Offset: std::fmt::Display,
{
    out.clear();
    let mut cut = false;
    out.push_str("{\"timestamp\":");
    push_str(out, &local_time(&event.time, zone));
    out.push_str(",\"level\":");
    push_str(out, app_level(event.level, event.keywords));
    out.push_str(",\"provider\":");
    push_str(out, &event.provider);
    out.push_str(",\"eventId\":");
    out.push_str(&event.event_id.to_string());
    out.push_str(",\"message\":");
    cut |= push_capped(out, &message_text(event, extra.message), MAX_MESSAGE_CHARS);
    out.push_str(",\"channel\":");
    push_str(out, &event.channel);
    out.push_str(",\"computer\":");
    push_str(out, &event.computer);
    out.push_str(",\"task\":");
    match extra.task.map(str::trim).filter(|t| !t.is_empty()) {
        Some(task) => push_str(out, task),
        None => push_str(out, &event.task.to_string()),
    }
    out.push_str(",\"user\":");
    push_str(out, event.user_sid.as_deref().map(user_name).unwrap_or(""));
    out.push_str(",\"recordId\":");
    out.push_str(&event.record_id.to_string());
    if let Some(xml) = extra.xml {
        out.push_str(",\"xml\":");
        cut |= push_capped(out, xml, MAX_XML_CHARS);
    }
    out.push('}');
    cut
}

/// An event whose XML cannot be read or rendered: still a line, so nothing disappears silently.
/// The raw XML only when attaching it is on (review 018 L8).
pub fn unreadable_line<Tz: TimeZone>(
    xml: Option<&str>,
    render_error: Option<u32>,
    zone: &Tz,
    out: &mut String,
) where
    Tz::Offset: std::fmt::Display,
{
    out.clear();
    out.push_str("{\"timestamp\":");
    push_str(
        out,
        &chrono::Utc::now()
            .with_timezone(zone)
            .format("%Y-%m-%dT%H:%M:%S%.3f%:z")
            .to_string(),
    );
    out.push_str(",\"level\":\"warn\",\"message\":");
    match render_error {
        Some(code) => push_str(out, &format!("(Ereignis nicht lesbar, Fehler {code})")),
        None => push_str(out, "(Ereignis nicht lesbar)"),
    }
    if let Some(xml) = xml.filter(|x| !x.is_empty()) {
        out.push_str(",\"xml\":");
        push_capped(out, xml, MAX_XML_CHARS);
    }
    out.push('}');
}

fn push_capped(out: &mut String, text: &str, max_chars: usize) -> bool {
    match text.char_indices().nth(max_chars) {
        Some((end, _)) => {
            push_str(out, &format!("{}{TRUNCATED_MARK}", &text[..end]));
            true
        }
        None => {
            push_str(out, text);
            false
        }
    }
}

/// A JSON string with the escapes described above.
pub fn push_str(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if needs_escape(c) => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn needs_escape(c: char) -> bool {
    matches!(c,
        '\u{0}'..='\u{1F}'
        | '\u{7F}'..='\u{9F}'
        | '\u{200E}' | '\u{200F}'
        | '\u{202A}'..='\u{202E}'
        | '\u{2066}'..='\u{2069}'
        | '\u{2028}' | '\u{2029}')
}

#[cfg(test)]
mod tests {
    use super::super::event::parse;
    use super::*;
    use chrono::FixedOffset;

    const APP: &str = "<Event><System><Provider Name='Application Error'/><EventID Qualifiers='0'>1000</EventID><Level>2</Level><Task>100</Task><Keywords>0x80000000000000</Keywords><TimeCreated SystemTime='2026-11-08T09:15:30.1234567Z'/><EventRecordID>42</EventRecordID><Channel>Application</Channel><Computer>WS01</Computer><Security UserID='S-1-5-18'/></System><EventData><Data>app.exe</Data><Data>  </Data><Data>c0000005</Data></EventData></Event>";

    fn cet() -> FixedOffset {
        FixedOffset::east_opt(3600).unwrap()
    }

    #[test]
    fn the_level_table() {
        let table = [
            (0, 0, "info"),
            (1, 0, "fatal"),
            (2, 0, "error"),
            (3, 0, "warn"),
            (4, 0, "info"),
            (5, 0, "debug"),
            (6, 0, "trace"),
            (255, 0, "trace"),
            (0, 0x8020_0000_0000_0000, "info"),
            (0, 0x8010_0000_0000_0000, "error"),
            // The audit keyword wins over the level.
            (4, AUDIT_FAILURE, "error"),
            (2, AUDIT_SUCCESS, "info"),
        ];
        for (level, keywords, word) in table {
            assert_eq!(app_level(level, keywords), word, "{level} {keywords:#x}");
            // Every word is one the level detection of the app knows.
            assert!(crate::level::Level::from_word(word).is_some(), "{word}");
        }
    }

    #[test]
    fn an_event_becomes_one_json_line() {
        let event = parse(APP).unwrap();
        let mut out = String::new();
        let extra = Extra {
            message: Some("Fehler in „app.exe“:\r\n\tZugriffsverletzung 😀\r\n"),
            task: Some("Absturz"),
            xml: Some(APP),
        };
        assert!(!json_line(&event, &extra, &cet(), &mut out));
        assert!(!out.contains('\n') && !out.contains('\r'));
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["timestamp"], "2026-11-08T10:15:30.123+01:00");
        assert_eq!(v["level"], "error");
        assert_eq!(v["provider"], "Application Error");
        assert_eq!(v["eventId"], 1000);
        assert_eq!(
            v["message"],
            "Fehler in „app.exe“:\r\n\tZugriffsverletzung 😀"
        );
        assert_eq!(v["channel"], "Application");
        assert_eq!(v["computer"], "WS01");
        assert_eq!(v["task"], "Absturz");
        assert_eq!(v["user"], "SYSTEM");
        assert_eq!(v["recordId"], 42);
        assert_eq!(v["xml"], APP);
        // Key order: the columns of the JSON profile follow the first line.
        let keys: Vec<&str> = [
            "timestamp",
            "level",
            "provider",
            "eventId",
            "message",
            "channel",
            "computer",
            "task",
            "user",
            "recordId",
            "xml",
        ]
        .to_vec();
        let mut at = 0;
        for k in keys {
            let pos = out.find(&format!("\"{k}\":")).unwrap();
            assert!(pos >= at, "{k}");
            at = pos;
        }
        // The app's own level detection reads it.
        let detector = crate::profile::builtin_profiles()
            .into_iter()
            .find(|p| p.id == crate::profile::WINEVENT_PROFILE)
            .unwrap()
            .detector()
            .unwrap();
        assert_eq!(
            detector.detect(out.as_bytes()),
            Some(crate::level::Level::Error)
        );
    }

    #[test]
    fn without_a_message_the_insertion_strings_stand_in() {
        let event = parse(APP).unwrap();
        let mut out = String::new();
        let extra = Extra {
            message: None,
            task: None,
            xml: None,
        };
        json_line(&event, &extra, &cet(), &mut out);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["message"], "(keine Meldung) app.exe; c0000005");
        assert_eq!(v["task"], "100");
        assert!(v.get("xml").is_none());
        let mut bare = event.clone();
        bare.data.clear();
        assert_eq!(
            message_text(&bare, Some("  ")),
            "(keine Meldung) Ereignis 1000 von Application Error"
        );
    }

    #[test]
    fn escapes_keep_one_line_and_hide_nothing() {
        let mut out = String::new();
        push_str(
            &mut out,
            "a\"b\\c\nd\re\tf\x1b[31mg\x07h\u{7f}i\u{85}j\u{202E}k\u{2066}l\u{2028}m\u{200D}n€",
        );
        assert_eq!(
            out,
            "\"a\\\"b\\\\c\\nd\\re\\tf\\u001B[31mg\\u0007h\\u007Fi\\u0085j\\u202Ek\\u2066l\\u2028m\u{200D}n€\"",
        );
        let back: String = serde_json::from_str(&out).unwrap();
        assert!(back.starts_with("a\"b\\c\nd"));
        assert!(back.contains('\u{202E}'));
    }

    #[test]
    fn long_messages_and_xml_are_cut_and_marked() {
        let event = parse(APP).unwrap();
        let long = "ä".repeat(MAX_MESSAGE_CHARS + 10);
        let xml = "x".repeat(MAX_XML_CHARS + 1);
        let mut out = String::new();
        let extra = Extra {
            message: Some(&long),
            task: None,
            xml: Some(&xml),
        };
        assert!(json_line(&event, &extra, &cet(), &mut out));
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let m = v["message"].as_str().unwrap();
        assert!(m.ends_with(TRUNCATED_MARK));
        assert_eq!(
            m.chars().count(),
            MAX_MESSAGE_CHARS + TRUNCATED_MARK.chars().count()
        );
        assert!(v["xml"].as_str().unwrap().ends_with(TRUNCATED_MARK));
    }

    #[test]
    fn times_and_users() {
        assert_eq!(
            local_time("2026-01-15T23:30:00.5Z", &cet()),
            "2026-01-16T00:30:00.500+01:00"
        );
        assert_eq!(local_time("kaputt", &cet()), "kaputt");
        assert_eq!(user_name("S-1-5-20"), "NETWORK SERVICE");
        assert_eq!(user_name("S-1-5-21-1-2-3-500"), "S-1-5-21-1-2-3-500");
        let mut out = String::new();
        unreadable_line(Some("<Event"), None, &cet(), &mut out);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["level"], "warn");
        assert_eq!(v["xml"], "<Event");
        unreadable_line(None, Some(15005), &cet(), &mut out);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["message"], "(Ereignis nicht lesbar, Fehler 15005)");
        assert!(v.get("xml").is_none());
    }
}
