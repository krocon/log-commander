//! Text encodings of log files: detection from a sample and lossy decoding of single lines.

use serde::Serialize;
use std::borrow::Cow;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    /// Windows-1252 superset of Latin-1, chosen when a sample is clearly not UTF-8.
    Latin1,
}

impl Encoding {
    /// Returns the encoding and the length of its byte order mark.
    pub fn detect(sample: &[u8]) -> (Encoding, usize) {
        match sample {
            [0xEF, 0xBB, 0xBF, ..] => (Encoding::Utf8, 3),
            [0xFF, 0xFE, ..] => (Encoding::Utf16Le, 2),
            [0xFE, 0xFF, ..] => (Encoding::Utf16Be, 2),
            _ if looks_like_latin1(sample) => (Encoding::Latin1, 0),
            _ => (Encoding::Utf8, 0),
        }
    }

    pub fn code_unit(self) -> usize {
        match self {
            Encoding::Utf16Le | Encoding::Utf16Be => 2,
            _ => 1,
        }
    }

    /// Decodes without ever failing: invalid bytes become U+FFFD.
    pub fn decode<'a>(self, raw: &'a [u8]) -> Cow<'a, str> {
        match self {
            Encoding::Utf8 => String::from_utf8_lossy(raw),
            Encoding::Latin1 => encoding_rs::WINDOWS_1252.decode_without_bom_handling(raw).0,
            Encoding::Utf16Le => encoding_rs::UTF_16LE.decode_without_bom_handling(raw).0,
            Encoding::Utf16Be => encoding_rs::UTF_16BE.decode_without_bom_handling(raw).0,
        }
    }
}

/// A few stray bytes in a UTF-8 log stay UTF-8 (shown lossy); a sample with more invalid bytes
/// than valid multi-byte sequences is a legacy single-byte file.
fn looks_like_latin1(sample: &[u8]) -> bool {
    let mut rest = sample;
    let mut invalid = 0usize;
    let mut multibyte = 0usize;
    loop {
        match std::str::from_utf8(rest) {
            Ok(valid) => {
                multibyte += count_multibyte(valid);
                break;
            }
            Err(err) => {
                let (valid, tail) = rest.split_at(err.valid_up_to());
                // SAFETY-free: `valid_up_to` guarantees this prefix is valid UTF-8.
                multibyte += std::str::from_utf8(valid).map_or(0, count_multibyte);
                match err.error_len() {
                    Some(len) => {
                        invalid += 1;
                        rest = &tail[len..];
                    }
                    // A sequence cut off by the end of the sample says nothing.
                    None => break,
                }
            }
        }
    }
    invalid > multibyte
}

fn count_multibyte(text: &str) -> usize {
    if text.is_ascii() {
        0
    } else {
        text.chars().filter(|c| !c.is_ascii()).count()
    }
}

/// Removes ANSI CSI colour sequences (`ESC [ … letter`), which many tools write into log files
/// and which would break `\bERROR\b` as well as the display.
pub fn strip_ansi(text: &str) -> Cow<'_, str> {
    if !text.contains('\u{1b}') {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    Cow::Owned(out)
}

/// Text of a raw line as the user sees it. The FIX separator SOH (`\x01`) shows as `|`, one UTF-16
/// unit for one, so spans stay where they are.
pub fn display_text<'a>(raw: &'a [u8], encoding: Encoding) -> Cow<'a, str> {
    let text = match encoding.decode(raw) {
        Cow::Borrowed(text) => strip_ansi(text),
        Cow::Owned(text) => match strip_ansi(&text) {
            Cow::Borrowed(_) => Cow::Owned(text),
            Cow::Owned(stripped) => Cow::Owned(stripped),
        },
    };
    if memchr::memchr(0x01, text.as_bytes()).is_none() {
        return text;
    }
    Cow::Owned(text.replace('\u{1}', "|"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_boms() {
        assert_eq!(Encoding::detect(b"\xEF\xBB\xBFabc"), (Encoding::Utf8, 3));
        assert_eq!(Encoding::detect(b"\xFF\xFEa\0"), (Encoding::Utf16Le, 2));
        assert_eq!(Encoding::detect(b"\xFE\xFF\0a"), (Encoding::Utf16Be, 2));
    }

    #[test]
    fn stray_bytes_stay_utf8_but_legacy_text_is_latin1() {
        assert_eq!(
            Encoding::detect("äöü ok \u{20ac}".as_bytes()).0,
            Encoding::Utf8
        );
        let mostly_utf8 = [b"\xC3\xA4\xC3\xB6\xC3\xBC ".as_slice(), b"\xFF"].concat();
        assert_eq!(Encoding::detect(&mostly_utf8).0, Encoding::Utf8);
        assert_eq!(
            Encoding::detect(b"Gr\xFC\xDFe aus K\xF6ln").0,
            Encoding::Latin1
        );
    }

    #[test]
    fn multibyte_cut_by_the_sample_end_is_not_invalid() {
        assert_eq!(Encoding::detect(b"abc \xE2\x82").0, Encoding::Utf8);
    }

    #[test]
    fn decoding_is_lossy_and_never_fails() {
        assert_eq!(Encoding::Utf8.decode(b"a\xFFb"), "a\u{FFFD}b");
        assert_eq!(Encoding::Latin1.decode(b"K\xF6ln"), "Köln");
        assert_eq!(Encoding::Utf16Le.decode(b"h\0i\0"), "hi");
        assert_eq!(Encoding::Utf16Be.decode(b"\0h\0i"), "hi");
    }

    #[test]
    fn fix_separator_shows_as_a_bar() {
        assert_eq!(
            display_text(b"8=FIX.4.4\x0135=A\x01", Encoding::Utf8),
            "8=FIX.4.4|35=A|"
        );
    }

    #[test]
    fn strips_ansi_colours() {
        assert_eq!(strip_ansi("\u{1b}[31mERROR\u{1b}[0m boom"), "ERROR boom");
        assert_eq!(strip_ansi("plain"), "plain");
    }
}
