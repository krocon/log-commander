//! A rendered Windows event (`EvtRender` with `EvtRenderEventXml`) read into its fields (prompt 018).
//!
//! Plain Rust without dependencies, so it runs and is tested on every platform (and compiles in the
//! Windows check crate, see `prompts/done/018-windows-ereignisse.design.md`). The XML comes from the
//! event log service, but the values inside (`EventData`, `UserData`, the computer name) are written
//! by whoever logs the event: they are foreign data. The reader is small and forgiving: it never
//! panics, bounds what it keeps and takes only what the `Event` schema puts where it is expected.

/// Insertion strings kept per event.
pub const MAX_DATA: usize = 256;
/// Characters kept per value (insertion string, computer …).
pub const MAX_VALUE_CHARS: usize = 8 * 1024;
/// Nesting below which elements are ignored (`UserData` may nest).
const MAX_DEPTH: usize = 32;

/// The fields of an event that the spool line needs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Event {
    pub provider: String,
    pub event_id: u32,
    pub level: u8,
    pub task: u16,
    pub keywords: u64,
    /// `TimeCreated/@SystemTime` as written (UTC, `2026-11-08T09:15:30.1234567Z`).
    pub time: String,
    pub record_id: u64,
    pub channel: String,
    pub computer: String,
    /// `Security/@UserID` (a SID), if set.
    pub user_sid: Option<String>,
    /// Insertion strings of `EventData` (`Data`) or the leaf values of `UserData`, in order.
    pub data: Vec<String>,
}

/// The provider's name without reading the whole event (the metadata cache needs it first).
pub fn provider_name(xml: &str) -> Option<String> {
    let mut found = None;
    walk(xml, &mut |item| {
        if let Item::Open { name, attrs, path } = item {
            if name == "Provider" && path == ["Event", "System"] {
                found = attr(attrs, "Name");
                return false;
            }
        }
        true
    });
    found
}

/// Reads an event; `None` if this is no `<Event>` at all.
pub fn parse(xml: &str) -> Option<Event> {
    let mut event = Event::default();
    let mut root = false;
    let mut text = String::new();
    walk(xml, &mut |item| {
        match item {
            Item::Open { name, attrs, path } => {
                text.clear();
                if path.is_empty() {
                    root = name == "Event";
                    return root;
                }
                if path == ["Event", "System"] {
                    match name {
                        "Provider" => event.provider = attr(attrs, "Name").unwrap_or_default(),
                        "TimeCreated" => event.time = attr(attrs, "SystemTime").unwrap_or_default(),
                        "Security" => event.user_sid = attr(attrs, "UserID"),
                        _ => {}
                    }
                }
            }
            Item::Text(t) => push_capped(&mut text, t),
            Item::Close { name, path, leaf } => {
                let value = std::mem::take(&mut text);
                if path == ["Event", "System"] {
                    let v = value.trim();
                    match name {
                        "EventID" => event.event_id = v.parse().unwrap_or(0),
                        "Level" => event.level = v.parse().unwrap_or(0),
                        "Task" => event.task = v.parse().unwrap_or(0),
                        "Keywords" => event.keywords = parse_hex(v),
                        "EventRecordID" => event.record_id = v.parse().unwrap_or(0),
                        "Channel" => event.channel = cap(v),
                        "Computer" => event.computer = cap(v),
                        _ => {}
                    }
                } else if path == ["Event", "EventData"] {
                    if name == "Data" && event.data.len() < MAX_DATA {
                        event.data.push(value);
                    }
                } else if path.len() >= 2
                    && path[..2] == ["Event", "UserData"]
                    && path.len() >= 3
                    && leaf
                    && event.data.len() < MAX_DATA
                {
                    event.data.push(value);
                }
            }
        }
        true
    });
    root.then_some(event)
}

fn cap(text: &str) -> String {
    let mut out = String::new();
    push_capped(&mut out, text);
    out
}

/// Appends up to the limit; counts once, then keeps a running count (review 018 M4: counting
/// per character made long values quadratic).
fn push_capped(out: &mut String, text: &str) {
    let room = MAX_VALUE_CHARS.saturating_sub(out.chars().count());
    out.extend(text.chars().take(room));
}

/// `0x8020000000000000` (or decimal).
fn parse_hex(text: &str) -> u64 {
    match text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        Some(hex) => u64::from_str_radix(hex, 16).unwrap_or(0),
        None => text.parse().unwrap_or(0),
    }
}

fn attr(attrs: &[(&str, String)], name: &str) -> Option<String> {
    attrs.iter().find(|(n, _)| *n == name).map(|(_, v)| cap(v))
}

enum Item<'a, 'p> {
    /// `path` is the chain of open elements above this one (local names).
    Open {
        name: &'a str,
        attrs: &'p [(&'a str, String)],
        path: &'p [&'a str],
    },
    Text(&'p str),
    /// `leaf`: the element had no child elements.
    Close {
        name: &'a str,
        path: &'p [&'a str],
        leaf: bool,
    },
}

/// The local name of `ns:Name`.
fn local(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

/// A small pull reader over elements, attributes and text; `visit` returns false to stop.
/// Unknown constructs (`<?…?>`, comments, `<!DOCTYPE`) are skipped, broken markup ends the walk.
fn walk<'a>(xml: &'a str, visit: &mut dyn FnMut(Item<'a, '_>) -> bool) {
    let b = xml.as_bytes();
    let mut i = 0;
    let mut path: Vec<&'a str> = Vec::new();
    // Per open element: had it a child element?
    let mut children: Vec<bool> = Vec::new();
    let mut text = String::new();
    while i < b.len() {
        if b[i] != b'<' {
            let end = memchr_lt(b, i);
            decode_into(&xml[i..end], &mut text);
            if !text.is_empty() && !path.is_empty() && !visit(Item::Text(&text)) {
                return;
            }
            text.clear();
            i = end;
            continue;
        }
        let rest = &xml[i..];
        if rest.starts_with("<!--") {
            match rest.find("-->") {
                Some(e) => i += e + 3,
                None => return,
            }
            continue;
        }
        if rest.starts_with("<![CDATA[") {
            let Some(e) = rest.find("]]>") else { return };
            if !path.is_empty() && !visit(Item::Text(&rest[9..e])) {
                return;
            }
            i += e + 3;
            continue;
        }
        if rest.starts_with("<?") || rest.starts_with("<!") {
            match rest.find('>') {
                Some(e) => i += e + 1,
                None => return,
            }
            continue;
        }
        if let Some(close) = rest.strip_prefix("</") {
            let Some(e) = close.find('>') else { return };
            let name = local(close[..e].trim());
            let Some(open) = path.pop() else { return };
            let leaf = !children.pop().unwrap_or(false);
            if open != name {
                return;
            }
            if !visit(Item::Close {
                name,
                path: &path,
                leaf,
            }) {
                return;
            }
            i += 2 + e + 1;
            continue;
        }
        // An opening tag: name, attributes, `>` or `/>`.
        let Some((name, attrs, self_closing, len)) = open_tag(&xml[i..]) else {
            return;
        };
        i += len;
        if path.len() >= MAX_DEPTH {
            return;
        }
        if let Some(parent) = children.last_mut() {
            *parent = true;
        }
        if !visit(Item::Open {
            name,
            attrs: &attrs,
            path: &path,
        }) {
            return;
        }
        if self_closing {
            if !visit(Item::Close {
                name,
                path: &path,
                leaf: true,
            }) {
                return;
            }
        } else {
            path.push(name);
            children.push(false);
        }
    }
}

fn memchr_lt(b: &[u8], from: usize) -> usize {
    b[from..]
        .iter()
        .position(|&c| c == b'<')
        .map_or(b.len(), |p| from + p)
}

type Tag<'a> = (&'a str, Vec<(&'a str, String)>, bool, usize);

/// `<Name a='1' b="2">` → name, attributes, self-closing, length.
fn open_tag(s: &str) -> Option<Tag<'_>> {
    let b = s.as_bytes();
    let mut i = 1;
    let start = i;
    while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'>' && b[i] != b'/' {
        i += 1;
    }
    if i == start {
        return None;
    }
    let name = local(&s[start..i]);
    let mut attrs = Vec::new();
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        match b.get(i)? {
            b'>' => return Some((name, attrs, false, i + 1)),
            b'/' => {
                return (b.get(i + 1) == Some(&b'>')).then_some((name, attrs, true, i + 2));
            }
            _ => {}
        }
        let a = i;
        while i < b.len() && b[i] != b'=' && !b[i].is_ascii_whitespace() && b[i] != b'>' {
            i += 1;
        }
        let attr_name = local(&s[a..i]);
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if b.get(i) != Some(&b'=') {
            return None;
        }
        i += 1;
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let quote = *b.get(i)?;
        if quote != b'\'' && quote != b'"' {
            return None;
        }
        i += 1;
        let v = i;
        while i < b.len() && b[i] != quote {
            i += 1;
        }
        if i >= b.len() {
            return None;
        }
        let mut value = String::new();
        decode_into(&s[v..i], &mut value);
        attrs.push((attr_name, value));
        i += 1;
    }
}

/// Text with the five entities and character references resolved; anything unknown stays as is.
fn decode_into(raw: &str, out: &mut String) {
    let mut rest = raw;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        let Some(semi) = after.find(';').filter(|&s| s <= 10) else {
            out.push('&');
            rest = after;
            continue;
        };
        let entity = &after[..semi];
        let c = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match c {
            Some(c) => {
                out.push(c);
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
}

#[cfg(test)]
mod tests {
    use super::*;

    pub const SECURITY: &str = "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-a5ba-3e3b0328c30d}'/><EventID>4625</EventID><Version>0</Version><Level>0</Level><Task>12544</Task><Opcode>0</Opcode><Keywords>0x8010000000000000</Keywords><TimeCreated SystemTime='2026-11-08T09:15:30.1234567Z'/><EventRecordID>987654</EventRecordID><Correlation/><Execution ProcessID='812' ThreadID='9000'/><Channel>Security</Channel><Computer>WS01.corp.example</Computer><Security/></System><EventData><Data Name='SubjectUserSid'>S-1-5-18</Data><Data Name='TargetUserName'>m&#252;ller &amp; co</Data><Data Name='Empty'/></EventData></Event>";

    #[test]
    fn reads_the_system_part_and_the_data() {
        let e = parse(SECURITY).unwrap();
        assert_eq!(e.provider, "Microsoft-Windows-Security-Auditing");
        assert_eq!(e.event_id, 4625);
        assert_eq!(e.level, 0);
        assert_eq!(e.task, 12544);
        assert_eq!(e.keywords, 0x8010_0000_0000_0000);
        assert_eq!(e.time, "2026-11-08T09:15:30.1234567Z");
        assert_eq!(e.record_id, 987_654);
        assert_eq!(e.channel, "Security");
        assert_eq!(e.computer, "WS01.corp.example");
        assert_eq!(e.user_sid, None);
        assert_eq!(e.data, ["S-1-5-18", "müller & co", ""]);
        assert_eq!(
            provider_name(SECURITY).as_deref(),
            Some("Microsoft-Windows-Security-Auditing")
        );
    }

    #[test]
    fn classic_events_user_data_and_odd_markup() {
        let xml = r#"<?xml version="1.0"?><!-- x --><Event><System><Provider Name="Application Error"/><EventID Qualifiers="0">1000</EventID><Level>2</Level><TimeCreated SystemTime="2026-01-15T10:00:00.000Z"/><EventRecordID>7</EventRecordID><Channel>Application</Channel><Computer>pc</Computer><Security UserID="S-1-5-21-1-2-3-1001"/></System><UserData><ns:Frame xmlns:ns="urn:x"><ns:A>eins</ns:A><ns:B><![CDATA[<zwei>]]></ns:B><C>drei
vier</C></ns:Frame></UserData></Event>"#;
        let e = parse(xml).unwrap();
        assert_eq!(e.provider, "Application Error");
        assert_eq!(e.event_id, 1000);
        assert_eq!(e.level, 2);
        assert_eq!(e.user_sid.as_deref(), Some("S-1-5-21-1-2-3-1001"));
        assert_eq!(e.data, ["eins", "<zwei>", "drei\nvier"]);
        // Not an event, or broken: nothing or what was read so far, never a panic.
        assert_eq!(parse("<Other/>"), None);
        assert_eq!(parse(""), None);
        let broken = parse("<Event><System><Provider Name='p'/><EventID>5</Event>").unwrap();
        assert_eq!(broken.provider, "p");
        assert_eq!(
            decode("a &bogus; &#xZZ; &#128512; &lt;"),
            "a &bogus; &#xZZ; 😀 <"
        );
    }

    fn decode(s: &str) -> String {
        let mut out = String::new();
        decode_into(s, &mut out);
        out
    }

    #[test]
    fn values_and_counts_are_bounded() {
        let many: String = (0..1000).map(|i| format!("<Data>{i}</Data>")).collect();
        let xml = format!(
            "<Event><System><Computer>{}</Computer></System><EventData>{many}</EventData></Event>",
            "x".repeat(MAX_VALUE_CHARS * 2)
        );
        let e = parse(&xml).unwrap();
        assert_eq!(e.data.len(), MAX_DATA);
        assert_eq!(e.computer.chars().count(), MAX_VALUE_CHARS);
        let deep = format!(
            "<Event><UserData>{}{}</UserData></Event>",
            "<a>".repeat(100),
            "</a>".repeat(100)
        );
        assert!(parse(&deep).is_some());
    }

    #[test]
    fn a_large_event_is_read_quickly() {
        // About 64 KB in a few long values (the old reader counted per character: quadratic).
        let value = "ä€x".repeat(7_000);
        let data: String = (0..3).map(|_| format!("<Data>{value}</Data>")).collect();
        let xml = format!(
            "<Event><System><Provider Name='p'/><Computer>{value}</Computer></System><EventData>{data}</EventData></Event>"
        );
        assert!(xml.len() > 64 * 1024);
        let start = std::time::Instant::now();
        let e = parse(&xml).unwrap();
        assert!(
            start.elapsed() < std::time::Duration::from_millis(200),
            "{:?}",
            start.elapsed()
        );
        assert_eq!(e.data.len(), 3);
        assert_eq!(e.data[0].chars().count(), MAX_VALUE_CHARS);
    }

    #[test]
    fn garbage_never_panics() {
        // Deterministic pseudo-random input from the pieces XML is made of.
        let pieces = [
            "<",
            ">",
            "/",
            "'",
            "\"",
            "=",
            "&",
            ";",
            "Event",
            "System",
            "Data",
            "<!--",
            "-->",
            "<![CDATA[",
            "]]>",
            "<?",
            "?>",
            "&#x",
            "ä",
            "😀",
            " ",
            "\n",
            "EventData",
            "UserData",
        ];
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        for _ in 0..3000 {
            let mut s = String::new();
            for _ in 0..(seed % 60) {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                s.push_str(pieces[(seed % pieces.len() as u64) as usize]);
            }
            let _ = parse(&s);
            let _ = provider_name(&s);
        }
    }
}
