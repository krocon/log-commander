//! Anchors of lines (prompt 015): bookmarks, notes and the scroll position of a saved workspace
//! name a line by number, byte offset, length and a hash of its first bytes, so it can be found
//! again after a restart, when lines were inserted before it or the file was rotated. The search
//! itself is `LogSession::resolve_anchors`.

use std::ops::Range;

/// Bytes of a line the hash covers.
pub const ANCHOR_HASH_BYTES: usize = 256;
/// A moved line is looked for this many lines around its number and around its old offset.
pub const ANCHOR_WINDOW: usize = 10_000;
/// Anchors per call.
pub const MAX_ANCHORS: usize = 10_000;

/// FNV-1a (64 bit) of the first `ANCHOR_HASH_BYTES` raw bytes, as 16 hex digits (a JSON number
/// would lose bits in JavaScript).
pub fn hash_line(raw: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in &raw[..raw.len().min(ANCHOR_HASH_BYTES)] {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Sorted ranges with overlapping or touching ones joined, so no line is read twice.
pub fn merge_ranges(mut ranges: Vec<Range<usize>>) -> Vec<Range<usize>> {
    ranges.retain(|r| r.start < r.end);
    ranges.sort_by_key(|r| r.start);
    let mut out: Vec<Range<usize>> = Vec::with_capacity(ranges.len());
    for range in ranges {
        match out.last_mut() {
            Some(last) if range.start <= last.end => last.end = last.end.max(range.end),
            _ => out.push(range),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_covers_only_the_first_bytes() {
        let a = vec![b'a'; 300];
        let mut b = a.clone();
        b[299] = b'b';
        assert_eq!(hash_line(&a), hash_line(&b));
        b[10] = b'b';
        assert_ne!(hash_line(&a), hash_line(&b));
        assert_eq!(hash_line(b"").len(), 16);
    }

    #[test]
    fn ranges_merge() {
        assert_eq!(
            merge_ranges(vec![10..20, 0..5, 15..30, 5..6, 40..40]),
            vec![0..6, 10..30]
        );
    }
}
