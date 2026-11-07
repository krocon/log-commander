//! The line index (no text in RAM: offset, length, level per line), the block-wise line splitter
//! and reading line text back from the file.
//!
//! Offsets in the index are *virtual*: every file segment of a session (the file before and after
//! a rotation) occupies its own range, see [`Segment`]. A merge of several files (prompt 006) gives
//! every source its own address space: the top byte of an offset is the source ([`source_of`]).

use crate::encoding::Encoding;
use crate::level::Level;
use memchr::memchr_iter;
use std::fs::File;
use std::io;
use std::sync::Arc;

/// A longer line without a line end is split, so a binary file cannot exhaust the memory.
pub const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
/// Text sent to the UI per line.
pub const MAX_DISPLAY_BYTES: usize = 128 * 1024;
/// Text of a line that search looks at.
pub const MAX_SEARCH_BYTES: usize = 1024 * 1024;

/// The top bits of a virtual offset name the source of a merged session; a single file is source 0.
pub const SOURCE_SHIFT: u32 = 56;
/// Sources of one merge (the source filter is a `u16` mask).
pub const MAX_SOURCES: usize = 16;

/// The source a virtual offset belongs to.
pub fn source_of(offset: u64) -> usize {
    (offset >> SOURCE_SHIFT) as usize
}

/// First virtual offset of a source's address space.
pub fn source_base(source: usize) -> u64 {
    (source as u64) << SOURCE_SHIFT
}

const FLAG_CONTINUATION: u8 = 0b1000_0000;
const LEVEL_MASK: u8 = 0b0000_0111;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineEntry {
    pub offset: u64,
    pub len: u32,
    meta: u8,
}

impl LineEntry {
    pub fn source(&self) -> usize {
        source_of(self.offset)
    }

    /// The same line as the head of an entry of its own.
    pub fn as_head(self) -> Self {
        Self {
            meta: self.meta & !FLAG_CONTINUATION,
            ..self
        }
    }

    pub fn new(offset: u64, len: u32, level: Level, continuation: bool) -> Self {
        let flag = if continuation { FLAG_CONTINUATION } else { 0 };
        Self {
            offset,
            len,
            meta: level as u8 | flag,
        }
    }

    pub fn level(&self) -> Level {
        Level::from_u8(self.meta & LEVEL_MASK)
    }

    pub fn is_continuation(&self) -> bool {
        self.meta & FLAG_CONTINUATION != 0
    }
}

#[derive(Debug, Default)]
pub struct LineIndex {
    pub entries: Vec<LineEntry>,
    pub counts: [u64; Level::COUNT],
}

impl LineIndex {
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn push(&mut self, entry: LineEntry) {
        self.counts[entry.level() as usize] += 1;
        self.entries.push(entry);
    }

    pub fn pop(&mut self) -> Option<LineEntry> {
        let entry = self.entries.pop()?;
        self.counts[entry.level() as usize] -= 1;
        Some(entry)
    }

    pub fn replace(&mut self, index: usize, entry: LineEntry) {
        let old = self.entries[index];
        self.counts[old.level() as usize] -= 1;
        self.counts[entry.level() as usize] += 1;
        self.entries[index] = entry;
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.counts = [0; Level::COUNT];
    }
}

/// Splits a stream of blocks into lines (LF and CRLF, for UTF-16 on code-unit boundaries). The
/// incomplete last line stays in `carry` until its line end arrives.
#[derive(Debug)]
pub struct LineSplitter {
    encoding: Encoding,
    carry: Vec<u8>,
    carry_offset: u64,
}

impl LineSplitter {
    pub fn new(encoding: Encoding, start_offset: u64) -> Self {
        Self {
            encoding,
            carry: Vec::new(),
            carry_offset: start_offset,
        }
    }

    pub fn has_partial(&self) -> bool {
        !self.carry.is_empty()
    }

    /// The incomplete last line and its offset.
    pub fn partial(&self) -> (u64, &[u8]) {
        (self.carry_offset, trim_cr(&self.carry, self.encoding))
    }

    /// Hands out the incomplete last line as a line of its own; what follows starts a new line.
    pub fn take_partial(&mut self) -> Option<(u64, Vec<u8>)> {
        if self.carry.is_empty() {
            return None;
        }
        let offset = self.carry_offset;
        let raw = trim_cr(&self.carry, self.encoding).to_vec();
        self.carry_offset += self.carry.len() as u64;
        self.carry.clear();
        Some((offset, raw))
    }

    /// Feeds the block that follows the previous one in the file. `on_line(offset, raw)` gets
    /// each complete line without its line end.
    pub fn feed(&mut self, block: &[u8], mut on_line: impl FnMut(u64, &[u8])) {
        if self.carry.is_empty() {
            let base = self.carry_offset;
            let consumed = split_lines(block, base, self.encoding, &mut on_line);
            self.carry.extend_from_slice(&block[consumed..]);
            self.carry_offset = base + consumed as u64;
        } else {
            let mut joined = std::mem::take(&mut self.carry);
            joined.extend_from_slice(block);
            let base = self.carry_offset;
            let consumed = split_lines(&joined, base, self.encoding, &mut on_line);
            joined.drain(..consumed);
            self.carry = joined;
            self.carry_offset = base + consumed as u64;
        }
        if self.carry.len() >= MAX_LINE_BYTES {
            let aligned = self.carry.len() - self.carry.len() % self.encoding.code_unit();
            on_line(self.carry_offset, &self.carry[..aligned]);
            self.carry_offset += aligned as u64;
            self.carry.drain(..aligned);
        }
    }
}

/// Emits all complete lines, returns the number of bytes consumed.
fn split_lines(
    data: &[u8],
    base: u64,
    encoding: Encoding,
    on_line: &mut impl FnMut(u64, &[u8]),
) -> usize {
    let mut start = 0usize;
    match encoding {
        Encoding::Utf8 | Encoding::Latin1 => {
            for newline in memchr_iter(b'\n', data) {
                on_line(
                    base + start as u64,
                    trim_cr(&data[start..newline], encoding),
                );
                start = newline + 1;
            }
        }
        Encoding::Utf16Le | Encoding::Utf16Be => {
            let little = encoding == Encoding::Utf16Le;
            let mut i = 0usize;
            while i + 1 < data.len() {
                let (low, high) = if little {
                    (data[i], data[i + 1])
                } else {
                    (data[i + 1], data[i])
                };
                if low == b'\n' && high == 0 {
                    on_line(base + start as u64, trim_cr(&data[start..i], encoding));
                    start = i + 2;
                }
                i += 2;
            }
        }
    }
    start
}

fn trim_cr(line: &[u8], encoding: Encoding) -> &[u8] {
    match encoding {
        Encoding::Utf8 | Encoding::Latin1 => line.strip_suffix(b"\r").unwrap_or(line),
        Encoding::Utf16Le => line.strip_suffix(b"\r\0").unwrap_or(line),
        Encoding::Utf16Be => line.strip_suffix(b"\0\r").unwrap_or(line),
    }
}

/// One physical file of a session. `base` is the virtual offset of its first byte.
#[derive(Debug)]
pub struct Segment {
    pub base: u64,
    pub file: Arc<File>,
    pub encoding: Encoding,
}

/// Adds a segment where its base belongs: lookups by offset need them sorted.
pub fn insert_segment(segments: &mut Vec<Arc<Segment>>, segment: Arc<Segment>) {
    let at = segments.partition_point(|s| s.base <= segment.base);
    segments.insert(at, segment);
}

/// Positional read that neither moves a shared cursor nor needs a lock.
pub fn read_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_at(buf, offset)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        file.seek_read(buf, offset)
    }
}

/// Reads the text of index entries with a sliding block buffer per source, so scanning
/// neighbouring lines costs one read per block instead of one per line, also when a merge changes
/// the source from line to line.
pub struct LineReader {
    segments: Vec<Arc<Segment>>,
    block: usize,
    backward: bool,
    /// One buffer per source (`offset >> SOURCE_SHIFT`), created on first use.
    bufs: Vec<ReadBuf>,
}

#[derive(Default)]
struct ReadBuf {
    data: Vec<u8>,
    start: u64,
}

impl LineReader {
    pub fn new(segments: Vec<Arc<Segment>>, block: usize) -> Self {
        Self {
            segments,
            block,
            backward: false,
            bufs: Vec::new(),
        }
    }

    /// Optimises the buffer for walking towards the start of the file.
    pub fn backward(mut self) -> Self {
        self.backward = true;
        self
    }

    /// Up to `limit` raw bytes of the line (fewer if the file shrank in the meantime).
    pub fn raw(&mut self, entry: &LineEntry, limit: usize) -> io::Result<(&[u8], Encoding)> {
        let at = self.segments.partition_point(|s| s.base <= entry.offset);
        let Some(index) = at.checked_sub(1) else {
            return Ok((&[], Encoding::Utf8));
        };
        let segment = &self.segments[index];
        let encoding = segment.encoding;
        let source = source_of(entry.offset);
        if self.bufs.len() <= source {
            self.bufs.resize_with(source + 1, ReadBuf::default);
        }
        let buf = &mut self.bufs[source];
        let wanted = (entry.len as usize).min(limit);
        let end = entry.offset + wanted as u64;
        let buffered = entry.offset >= buf.start && end <= buf.start + buf.data.len() as u64;
        if !buffered {
            let size = wanted.max(self.block);
            let start = if self.backward {
                end.saturating_sub(size as u64).max(segment.base)
            } else {
                entry.offset
            };
            // Never read across the segment's end: virtual offsets of the next one follow.
            let next_base = self.segments.get(index + 1).map_or(u64::MAX, |s| s.base);
            let size = (size as u64).min(next_base - start) as usize;
            buf.data.resize(size, 0);
            let physical = start - segment.base;
            let mut filled = 0usize;
            while filled < size {
                let n = read_at(
                    &segment.file,
                    &mut buf.data[filled..],
                    physical + filled as u64,
                )?;
                if n == 0 {
                    break;
                }
                filled += n;
            }
            buf.data.truncate(filled);
            buf.start = start;
        }
        let from = (entry.offset.saturating_sub(buf.start) as usize).min(buf.data.len());
        let to = (end.saturating_sub(buf.start) as usize).min(buf.data.len());
        Ok((&buf.data[from..to], encoding))
    }
}

/// The segment an offset lies in; `segments` sorted by base.
pub fn segment_of(segments: &[Arc<Segment>], offset: u64) -> Option<&Arc<Segment>> {
    let after = segments.partition_point(|s| s.base <= offset);
    after.checked_sub(1).map(|i| &segments[i])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_of(blocks: &[&[u8]], encoding: Encoding) -> (Vec<(u64, Vec<u8>)>, Vec<u8>) {
        let mut splitter = LineSplitter::new(encoding, 0);
        let mut out = Vec::new();
        for block in blocks {
            splitter.feed(block, |offset, raw| out.push((offset, raw.to_vec())));
        }
        let partial = splitter.partial().1.to_vec();
        (out, partial)
    }

    #[test]
    fn splits_lf_and_crlf() {
        let (lines, partial) = lines_of(&[b"a\nbb\r\n\nccc"], Encoding::Utf8);
        assert_eq!(
            lines,
            vec![(0, b"a".to_vec()), (2, b"bb".to_vec()), (6, b"".to_vec())]
        );
        assert_eq!(partial, b"ccc");
    }

    #[test]
    fn incomplete_line_is_kept_until_its_end_arrives() {
        let (lines, partial) = lines_of(&[b"hel", b"lo", b" world\r", b"\nnext"], Encoding::Utf8);
        assert_eq!(lines, vec![(0, b"hello world".to_vec())]);
        assert_eq!(partial, b"next");
    }

    #[test]
    fn utf16_splits_on_code_units_even_across_blocks() {
        // "a\n" then U+0A00 (bytes 00 0A in LE) must not be taken for a newline.
        let data: &[u8] = b"a\0\n\0\x00\x0Ab\0\r\0\n\0";
        let (lines, partial) = lines_of(&[&data[..3], &data[3..7], &data[7..]], Encoding::Utf16Le);
        assert_eq!(lines[0], (0, b"a\0".to_vec()));
        assert_eq!(lines[1], (4, b"\x00\x0Ab\0".to_vec()));
        assert!(partial.is_empty());
    }

    #[test]
    fn utf16_be_newline() {
        let (lines, _) = lines_of(&[b"\0a\0\n\0b\0\r\0\n"], Encoding::Utf16Be);
        assert_eq!(lines, vec![(0, b"\0a".to_vec()), (4, b"\0b".to_vec())]);
    }

    #[test]
    fn huge_line_without_end_is_split() {
        let block = vec![b'x'; MAX_LINE_BYTES + 5];
        let (lines, partial) = lines_of(&[&block], Encoding::Utf8);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].1.len(), MAX_LINE_BYTES + 5);
        assert!(partial.is_empty());
    }

    #[test]
    fn entry_packs_level_and_continuation() {
        let entry = LineEntry::new(7, 9, Level::Error, true);
        assert_eq!(entry.level(), Level::Error);
        assert!(entry.is_continuation());
        assert!(!LineEntry::new(7, 9, Level::Fatal, false).is_continuation());
        assert!(std::mem::size_of::<LineEntry>() <= 16);
    }

    #[test]
    fn index_keeps_counts() {
        let mut index = LineIndex::default();
        index.push(LineEntry::new(0, 1, Level::Info, false));
        index.push(LineEntry::new(1, 1, Level::Error, false));
        index.replace(0, LineEntry::new(0, 1, Level::Warn, false));
        assert_eq!(index.counts[Level::Info as usize], 0);
        assert_eq!(index.counts[Level::Warn as usize], 1);
        index.pop();
        assert_eq!(index.counts[Level::Error as usize], 0);
    }
}
