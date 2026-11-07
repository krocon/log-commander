//! What the timeline above the log draws (prompt 014): entries over *time*, stacked by level.
//!
//! A [`TimeSummary`] keeps, per chunk of consecutive lines of the index, the time of the first and
//! the last entry head with a time, the largest jump between the times seen in it and how many
//! entries (all, WARN, ERROR, FATAL) start in it. Only a few heads per chunk are parsed for their
//! time while indexing (see [`TimeCursor`]: the first, one every `SAMPLE_STEP` lines, the last), so
//! reading a file costs next to nothing more. Like the level summary of prompt 007, neighbours are
//! merged when there are too many chunks: the memory stays below `MAX_TIME_CHUNKS × 48` bytes.
//!
//! A query lays the chunks onto time buckets, assuming the entries of a chunk spread evenly between
//! its first and last time, split at its largest jump (an outage inside a chunk stays visible).

use crate::indexer::LineEntry;
use crate::level::Level;

/// Lines per chunk at the start.
pub const TIME_CHUNK: u32 = 256;
/// At most this many chunks; then neighbours merge and the chunk size doubles.
pub const MAX_TIME_CHUNKS: usize = 64 * 1024;
/// Heads of a chunk tried for the first time before giving up on it (a file without times
/// costs at most this many parses per chunk).
pub const FIRST_TIME_ATTEMPTS: u32 = 8;
/// Within a chunk one head every this many lines is parsed too, to find an outage inside it.
pub const SAMPLE_STEP: u32 = 32;
/// At most this many gaps per answer.
pub const MAX_GAPS: usize = 512;
/// A chunk spanning more than this many times the median span of all chunks (and more than
/// `OUTLIER_MIN_SPAN`) holds an outlier (year 1970, a timestamp in the data): it is laid at one end.
const OUTLIER_FACTOR: i64 = 16;
const OUTLIER_MIN_SPAN: i64 = 3_600_000_000;
/// Percentiles of the axis over the whole file.
const LOW_PERCENTILE: f64 = 0.01;
const HIGH_PERCENTILE: f64 = 0.99;
/// A jump within a chunk is an outage when it is this many times longer than its lines would take
/// at the rate of the rest of the chunk.
const OUTAGE_FACTOR: i64 = 10;
/// How far beyond the percentiles the axis may reach, in multiples of their range.
const AXIS_WIDEN: i64 = 3;
/// Half a minute either side when everything happened at one moment.
const POINT_PADDING: i64 = 30_000_000;

const NO_TIME: i64 = i64::MIN;

/// One chunk: first and last time of its heads (if any), its largest jump in time and the entries
/// starting in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeChunk {
    first: i64,
    last: i64,
    /// The largest forward jump between two times seen in the chunk (`gap_to == NO_TIME`: none).
    gap_from: i64,
    gap_to: i64,
    /// Lines (within the chunk) of the last time, and of the times before and after the jump.
    last_line: u32,
    gap_from_line: u32,
    gap_line: u32,
    pub all: u32,
    pub warn: u32,
    pub error: u32,
    pub fatal: u32,
}

impl TimeChunk {
    const EMPTY: Self = Self {
        first: NO_TIME,
        last: NO_TIME,
        gap_from: NO_TIME,
        gap_to: NO_TIME,
        last_line: 0,
        gap_from_line: 0,
        gap_line: 0,
        all: 0,
        warn: 0,
        error: 0,
        fatal: 0,
    };

    pub fn first(&self) -> Option<i64> {
        (self.first != NO_TIME).then_some(self.first)
    }

    pub fn last(&self) -> Option<i64> {
        (self.last != NO_TIME).then_some(self.last)
    }

    fn count(&mut self, level: Level, add: bool) {
        let step = |v: &mut u32| {
            *v = if add {
                v.saturating_add(1)
            } else {
                v.saturating_sub(1)
            }
        };
        step(&mut self.all);
        match level {
            Level::Warn => step(&mut self.warn),
            Level::Error => step(&mut self.error),
            Level::Fatal => step(&mut self.fatal),
            _ => {}
        }
    }

    fn gap(&self) -> i64 {
        if self.gap_to == NO_TIME {
            0
        } else {
            self.gap_to - self.gap_from
        }
    }

    /// A time seen at line `line` of the chunk.
    fn time(&mut self, ts: i64, line: u32) {
        if self.first == NO_TIME {
            self.first = ts;
        } else if ts.saturating_sub(self.last) > self.gap() {
            self.gap_from = self.last;
            self.gap_from_line = self.last_line;
            self.gap_to = ts;
            self.gap_line = line;
        }
        self.last = ts;
        self.last_line = line;
    }

    /// `a` (with `a_lines` lines) followed by `b`.
    fn merged(a: Self, b: Self, a_lines: u32) -> Self {
        // The largest jump: in a, in b, or between them.
        let b_first_line = if b.gap_to != NO_TIME && b.gap_from_line == 0 {
            0
        } else {
            b.gap_from_line.min(b.last_line)
        };
        let mut gap = (a.gap(), a.gap_from, a.gap_to, a.gap_from_line, a.gap_line);
        if b.gap() > gap.0 {
            gap = (
                b.gap(),
                b.gap_from,
                b.gap_to,
                b.gap_from_line + a_lines,
                b.gap_line + a_lines,
            );
        }
        if a.last != NO_TIME && b.first != NO_TIME && b.first.saturating_sub(a.last) > gap.0 {
            gap = (
                b.first - a.last,
                a.last,
                b.first,
                a.last_line,
                a_lines + b_first_line,
            );
        }
        Self {
            first: if a.first != NO_TIME { a.first } else { b.first },
            last: if b.last != NO_TIME { b.last } else { a.last },
            gap_from: gap.1,
            gap_to: gap.2,
            last_line: if b.last != NO_TIME {
                b.last_line + a_lines
            } else {
                a.last_line
            },
            gap_from_line: gap.3,
            gap_line: gap.4,
            all: a.all.saturating_add(b.all),
            warn: a.warn.saturating_add(b.warn),
            error: a.error.saturating_add(b.error),
            fatal: a.fatal.saturating_add(b.fatal),
        }
    }
}

/// Times and entry counts per chunk of lines of the index.
#[derive(Debug, Clone)]
pub struct TimeSummary {
    chunks: Vec<TimeChunk>,
    chunk_size: u32,
    open: TimeChunk,
    open_len: u32,
}

/// State to go back to when the provisional line is withdrawn.
#[derive(Debug, Clone, Copy)]
pub struct TimeMark {
    chunks: usize,
    chunk_size: u32,
    open: TimeChunk,
    open_len: u32,
}

impl Default for TimeSummary {
    fn default() -> Self {
        Self::new()
    }
}

impl TimeSummary {
    pub fn new() -> Self {
        Self::with_chunk(TIME_CHUNK)
    }

    /// Mainly for tests: a smaller first chunk.
    pub fn with_chunk(chunk_size: u32) -> Self {
        Self {
            chunks: Vec::new(),
            chunk_size: chunk_size.max(1),
            open: TimeChunk::EMPTY,
            open_len: 0,
        }
    }

    /// Lines taken.
    pub fn len(&self) -> u64 {
        self.chunks.len() as u64 * u64::from(self.chunk_size) + u64::from(self.open_len)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn chunk_size(&self) -> u32 {
        self.chunk_size
    }

    /// One line: `head` lines count as entries, `ts` is its time if it was parsed.
    pub fn push(&mut self, level: Level, head: bool, ts: Option<i64>) {
        if head {
            self.open.count(level, true);
        }
        if let Some(ts) = ts {
            self.open.time(ts, self.open_len);
        }
        self.open_len += 1;
        if self.open_len == self.chunk_size {
            self.chunks.push(self.open);
            self.open = TimeChunk::EMPTY;
            self.open_len = 0;
            if self.chunks.len() >= MAX_TIME_CHUNKS {
                self.compact();
            }
        }
    }

    fn compact(&mut self) {
        let old = self.chunk_size;
        let merged: Vec<TimeChunk> = self
            .chunks
            .chunks(2)
            .map(|p| match p {
                [a, b] => TimeChunk::merged(*a, *b, old),
                [a] => *a,
                _ => TimeChunk::EMPTY,
            })
            .collect();
        let odd = self.chunks.len() % 2 == 1;
        self.chunks = merged;
        self.chunk_size *= 2;
        if odd {
            let last = self.chunks.pop().unwrap_or(TimeChunk::EMPTY);
            self.open = TimeChunk::merged(last, self.open, old);
            self.open_len += old;
        }
    }

    /// Withdraws the last line (its count; a time it brought stays until `restore`).
    pub fn pop(&mut self, level: Level, head: bool) {
        if self.open_len == 0 {
            let Some(last) = self.chunks.pop() else {
                return;
            };
            self.open = last;
            self.open_len = self.chunk_size;
        }
        if head {
            self.open.count(level, false);
        }
        self.open_len -= 1;
        if self.open_len == 0 {
            self.open = TimeChunk::EMPTY;
        }
    }

    pub fn mark(&self) -> TimeMark {
        TimeMark {
            chunks: self.chunks.len(),
            chunk_size: self.chunk_size,
            open: self.open,
            open_len: self.open_len,
        }
    }

    /// Back to `mark` after the lines pushed since were popped: exact unless chunks were merged
    /// meanwhile (then only the counts are right, see `pop`).
    pub fn restore(&mut self, mark: TimeMark) {
        if mark.chunk_size == self.chunk_size
            && mark.chunks == self.chunks.len()
            && mark.open_len == self.open_len
        {
            self.open = mark.open;
        }
    }

    pub fn clear(&mut self) {
        *self = Self::with_chunk(TIME_CHUNK);
    }

    /// Counts again from the index after a re-levelling; the times stay.
    pub fn recount(&mut self, entries: &[LineEntry]) {
        let size = self.chunk_size as usize;
        let count = |start: usize, end: usize, chunk: &mut TimeChunk| {
            *chunk = TimeChunk {
                all: 0,
                warn: 0,
                error: 0,
                fatal: 0,
                ..*chunk
            };
            for (i, entry) in entries[start..end].iter().enumerate() {
                // The first line starts an entry even if it looks like a continuation.
                if !entry.is_continuation() || start + i == 0 {
                    chunk.count(entry.level(), true);
                }
            }
        };
        for (i, chunk) in self.chunks.iter_mut().enumerate() {
            let start = (i * size).min(entries.len());
            count(start, (start + size).min(entries.len()), chunk);
        }
        let start = (self.chunks.len() * size).min(entries.len());
        let end = (start + self.open_len as usize).min(entries.len());
        count(start, end, &mut self.open);
    }

    /// Where the next line goes, for deciding before the write lock which lines to parse.
    pub fn cursor(&self) -> TimeCursor {
        TimeCursor {
            chunks: self.chunks.len(),
            chunk_size: self.chunk_size,
            open_len: self.open_len,
            has_first: self.open.first != NO_TIME,
            attempts: 0,
            sample_due: false,
        }
    }

    /// All chunks with the first line of each, the open one last.
    fn all_chunks(&self) -> impl Iterator<Item = (u64, TimeChunk)> + '_ {
        let size = u64::from(self.chunk_size);
        let open = (self.open_len > 0).then_some(self.open);
        self.chunks
            .iter()
            .copied()
            .chain(open)
            .enumerate()
            .map(move |(i, c)| (i as u64 * size, c))
    }

    /// Lines of the chunk starting at `start`.
    fn lines_of(&self, start: u64) -> u64 {
        u64::from(self.chunk_size).min(self.len() - start)
    }

    /// Whether any head had a time.
    pub fn has_times(&self) -> bool {
        self.all_chunks().any(|(_, c)| c.first != NO_TIME)
    }

    /// The lines `[start, end)` of the first chunk that reaches `ts` (its last time ≥ `ts`), for an
    /// exact search among its heads; `None` if every time is before `ts` or there is none.
    pub fn chunk_reaching(&self, ts: i64) -> Option<(u64, u64)> {
        let size = u64::from(self.chunk_size);
        let len = self.len();
        self.all_chunks()
            .find(|(_, c)| c.first != NO_TIME && c.first.max(c.last) >= ts)
            .map(|(start, _)| (start, (start + size).min(len)))
    }

    /// The chunks laid onto time buckets, see [`TimelineData`].
    pub fn timeline(&self, query: &TimelineQuery) -> TimelineData {
        let spans = self.spans();
        let mut out = TimelineData {
            entries: self.all_chunks().map(|(_, c)| u64::from(c.all)).sum(),
            ..TimelineData::default()
        };
        if spans.is_empty() {
            out.untimed = out.entries;
            return out;
        }
        out.untimed = spans
            .iter()
            .filter(|s| s.inherited)
            .map(|s| s.all())
            .sum::<f64>()
            .round() as u64;
        out.min = spans.iter().map(|s| s.a.min(s.b)).min();
        out.max = spans.iter().map(|s| s.a.max(s.b)).max();
        let (from, to) = match (query.from, query.to) {
            (Some(from), Some(to)) if to > from => (from, to),
            _ => axis(&spans),
        };
        out.from = from;
        out.to = to;
        let n = query.buckets;
        out.buckets = vec![Bucket::default(); n];
        let median = median_span(&spans);
        let width = (to - from) as f64 / n.max(1) as f64;
        let (mut before, mut after) = (0f64, 0f64);
        for span in &spans {
            let (a, b) = laid(span, from, to, median);
            let (c, share) = (&span.chunk, span.share);
            if c.all == 0 {
                continue;
            }
            if b <= a {
                // A point: unordered chunk, a single time or an outlier laid at one end.
                if a < from {
                    before += span.all();
                } else if a > to {
                    after += span.all();
                } else if n > 0 {
                    let i = (((a - from) as f64 / width) as usize).min(n - 1);
                    out.buckets[i].add(c, share);
                }
                continue;
            }
            let length = (b - a) as f64;
            if a < from {
                before += span.all() * ((b.min(from) - a) as f64 / length);
            }
            if b > to {
                after += span.all() * ((b - a.max(to)) as f64 / length);
            }
            let (lo, hi) = (a.max(from), b.min(to));
            if hi < lo || n == 0 {
                continue;
            }
            let first = (((lo - from) as f64 / width) as usize).min(n - 1);
            let last = (((hi - from) as f64 / width) as usize).min(n - 1);
            for (i, bucket) in out
                .buckets
                .iter_mut()
                .enumerate()
                .take(last + 1)
                .skip(first)
            {
                let start = from as f64 + i as f64 * width;
                let overlap = (hi as f64).min(start + width) - (lo as f64).max(start);
                if overlap > 0.0 {
                    bucket.add(c, share * overlap / length);
                }
            }
        }
        out.before = before.round() as u64;
        out.after = after.round() as u64;
        out.gaps = gaps(&spans, from, to, width.max(1.0) as i64);
        out.anchors = anchors(&spans, self.len(), query.anchors);
        out
    }

    /// Every chunk with entries as a time span; chunks without a time take it from their
    /// neighbours. Empty if no chunk has a time.
    fn spans(&self) -> Vec<Span> {
        let chunks: Vec<(u64, TimeChunk)> = self.all_chunks().collect();
        if !chunks.iter().any(|(_, c)| c.first != NO_TIME) {
            return Vec::new();
        }
        // The next time after each chunk, for chunks without one.
        let mut next = vec![None; chunks.len()];
        let mut seen = None;
        for i in (0..chunks.len()).rev() {
            next[i] = seen;
            if chunks[i].1.first != NO_TIME {
                seen = Some(chunks[i].1.first);
            }
        }
        let mut prev: Option<i64> = None;
        let mut spans = Vec::with_capacity(chunks.len());
        for (i, (start, chunk)) in chunks.into_iter().enumerate() {
            let span = if chunk.first != NO_TIME {
                prev = Some(chunk.last);
                let lines = self.lines_of(start);
                if let Some(pieces) = outage_pieces(&chunk, lines) {
                    spans.extend(pieces.into_iter().map(|(line, a, b, share)| Span {
                        start: start + line,
                        a,
                        b,
                        chunk,
                        share,
                        inherited: false,
                    }));
                    continue;
                }
                Span {
                    start,
                    a: chunk.first,
                    b: chunk.last,
                    chunk,
                    share: 1.0,
                    inherited: false,
                }
            } else {
                let (a, b) = match (prev, next[i]) {
                    (Some(p), Some(n)) => (p, n.max(p)),
                    (Some(p), None) => (p, p),
                    (None, Some(n)) => (n, n),
                    (None, None) => continue,
                };
                Span {
                    start,
                    a,
                    b,
                    chunk,
                    share: 1.0,
                    inherited: true,
                }
            };
            spans.push(span);
        }
        spans
    }
}

/// A chunk whose largest jump is an outage, as pieces `(first line, from, to, share of entries)`:
/// before the jump, the lines sampled across it at the rate of the rest of the chunk (half after
/// the time before it, half before the time after it), and after it. `None`: no outage, linear.
fn outage_pieces(c: &TimeChunk, lines: u64) -> Option<Vec<(u64, i64, i64, f64)>> {
    if c.gap() <= 0 || c.last < c.first || c.gap_from < c.first || c.gap_to > c.last {
        return None;
    }
    let lines = lines as f64;
    let (from_line, to_line) = (f64::from(c.gap_from_line), f64::from(c.gap_line));
    if to_line <= from_line || to_line > lines {
        return None;
    }
    let inside = to_line - from_line;
    let outside_time = (c.gap_from - c.first) + (c.last - c.gap_to);
    let outside_lines = lines - inside;
    if outside_time <= 0 || outside_lines <= 0.0 {
        return None;
    }
    // How long the lines across the jump would take at the rate of the rest.
    let expected = (inside * outside_time as f64 / outside_lines) as i64;
    if c.gap() <= expected.saturating_mul(OUTAGE_FACTOR) {
        return None;
    }
    let half = expected / 2;
    let share = |n: f64| n / lines;
    let middle = (from_line + inside / 2.0).round();
    Some(vec![
        (0, c.first, c.gap_from, share(from_line)),
        (
            from_line as u64,
            c.gap_from,
            c.gap_from + half,
            share(middle - from_line),
        ),
        (
            middle as u64,
            c.gap_to - half,
            c.gap_to,
            share(to_line - middle),
        ),
        (to_line as u64, c.gap_to, c.last, share(lines - to_line)),
    ])
}

/// Decides per line whether to parse its time: the first heads of a chunk until one has a time
/// (at most `FIRST_TIME_ATTEMPTS`), one head every `SAMPLE_STEP` lines, and the last line of a
/// chunk (or the last head before it).
#[derive(Debug, Clone, Copy)]
pub struct TimeCursor {
    chunks: usize,
    chunk_size: u32,
    open_len: u32,
    has_first: bool,
    attempts: u32,
    sample_due: bool,
}

/// What to do with the next line, see [`TimeCursor::next`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeStep {
    /// Parse this head: the chunk has no time yet, or a sample is due.
    pub want: bool,
    /// The line closes its chunk: its time, or that of the last head before it, is wanted.
    pub closes: bool,
}

impl TimeCursor {
    /// Steps over one line; `head` tells whether it starts an entry.
    pub fn next(&mut self, head: bool) -> TimeStep {
        if self.open_len == 0 {
            self.has_first = false;
            self.attempts = 0;
            self.sample_due = false;
        } else if self.open_len.is_multiple_of(SAMPLE_STEP) {
            self.sample_due = true;
        }
        let first = !self.has_first && self.attempts < FIRST_TIME_ATTEMPTS;
        let want = head && (first || self.sample_due);
        if want {
            self.attempts += u32::from(first);
            self.sample_due = false;
        }
        self.open_len += 1;
        let closes = self.open_len == self.chunk_size;
        if closes {
            self.open_len = 0;
            self.chunks += 1;
            if self.chunks >= MAX_TIME_CHUNKS {
                let odd = self.chunks % 2 == 1;
                self.chunks = self.chunks.div_ceil(2);
                let old = self.chunk_size;
                self.chunk_size *= 2;
                if odd {
                    self.chunks -= 1;
                    self.open_len = old;
                    self.has_first = true;
                }
            }
        }
        TimeStep { want, closes }
    }

    /// The head asked for by `want` had a time.
    pub fn found(&mut self) {
        self.has_first = true;
    }
}

/// What the timeline asks for: the time range (`None`: the whole file, see [`axis`]), the number of
/// buckets and how many anchors (line → time) at most.
#[derive(Debug, Clone, Copy, Default)]
pub struct TimelineQuery {
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub buckets: usize,
    pub anchors: usize,
}

/// Entries per bucket, fractions where a chunk spreads over several buckets.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Bucket {
    pub all: f32,
    pub warn: f32,
    pub error: f32,
    pub fatal: f32,
}

impl Bucket {
    fn add(&mut self, c: &TimeChunk, share: f64) {
        self.all += (f64::from(c.all) * share) as f32;
        self.warn += (f64::from(c.warn) * share) as f32;
        self.error += (f64::from(c.error) * share) as f32;
        self.fatal += (f64::from(c.fatal) * share) as f32;
    }
}

/// The answer of [`TimeSummary::timeline`]. Times in microseconds since the epoch (UTC).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TimelineData {
    /// The axis; 0 when nothing has a time.
    pub from: i64,
    pub to: i64,
    pub buckets: Vec<Bucket>,
    /// Stretches without entries between chunks, at least one bucket long, within the axis.
    pub gaps: Vec<(i64, i64)>,
    /// Earliest and latest time of the file (outliers included).
    pub min: Option<i64>,
    pub max: Option<i64>,
    /// Entries before and after the axis (outliers, or outside the zoom).
    pub before: u64,
    pub after: u64,
    /// Entries in chunks without any time (placed by their neighbours).
    pub untimed: u64,
    pub entries: u64,
    /// Line → time at chunk boundaries, for the band of the visible lines.
    pub anchors: Vec<(u64, i64)>,
}

/// A chunk (or the part of it before or after its largest jump) on the time axis: `share` of its
/// entries between `a` and `b`, the first of its lines being `start`.
#[derive(Debug, Clone, Copy)]
struct Span {
    start: u64,
    a: i64,
    b: i64,
    chunk: TimeChunk,
    share: f64,
    inherited: bool,
}

impl Span {
    fn all(&self) -> f64 {
        f64::from(self.chunk.all) * self.share
    }
}

/// The axis over the whole file: from the 1st to the 99th percentile of the chunk times, widened by
/// `AXIS_WIDEN` times that range on either side, to the outermost times within that reach. A normal
/// file keeps its ends (also a few entries after a long pause); an outlier decades away falls outside.
fn axis(spans: &[Span]) -> (i64, i64) {
    let mut points: Vec<(i64, u64)> = Vec::with_capacity(spans.len() * 2);
    for s in spans {
        let all = (s.all().round() as u64).max(1);
        points.push((s.a, all / 2 + all % 2));
        if s.b != s.a {
            points.push((s.b, all / 2));
        }
    }
    points.sort_unstable_by_key(|p| p.0);
    let total: u64 = points.iter().map(|p| p.1).sum();
    let at = |share: f64| {
        let goal = (total as f64 * share).ceil().max(1.0) as u64;
        let mut sum = 0;
        for &(t, w) in &points {
            sum += w;
            if sum >= goal {
                return t;
            }
        }
        points.last().map_or(0, |p| p.0)
    };
    let (low, high) = (at(LOW_PERCENTILE), at(HIGH_PERCENTILE));
    let widen = (high - low).saturating_mul(AXIS_WIDEN);
    let (reach_low, reach_high) = (low.saturating_sub(widen), high.saturating_add(widen));
    // The outermost times within reach: the axis starts and ends at data, not in the void.
    let from = points
        .iter()
        .map(|p| p.0)
        .find(|&t| t >= reach_low)
        .unwrap_or(low);
    let to = points
        .iter()
        .rev()
        .map(|p| p.0)
        .find(|&t| t <= reach_high)
        .unwrap_or(high);
    if to > from {
        (from, to)
    } else {
        (from - POINT_PADDING, from + POINT_PADDING)
    }
}

fn median_span(spans: &[Span]) -> i64 {
    let mut lengths: Vec<i64> = spans
        .iter()
        .filter(|s| !s.inherited)
        .map(|s| s.b.saturating_sub(s.a).max(0))
        .collect();
    if lengths.is_empty() {
        return 0;
    }
    let middle = lengths.len() / 2;
    *lengths.select_nth_unstable(middle).1
}

/// Where a chunk lies: unordered chunks (`b < a`) at their first time, a chunk that spans far more
/// than usual (an outlier at one end) at whichever end lies on the axis.
fn laid(span: &Span, from: i64, to: i64, median: i64) -> (i64, i64) {
    let (a, b) = (span.a, span.b);
    if b < a {
        return (a, a);
    }
    let length = b - a;
    if length > OUTLIER_MIN_SPAN && length > median.saturating_mul(OUTLIER_FACTOR) {
        let on = |t: i64| t >= from && t <= to;
        return if on(b) || !on(a) { (b, b) } else { (a, a) };
    }
    (a, b)
}

/// Stretches of the axis no chunk covers, at least `min` long.
fn gaps(spans: &[Span], from: i64, to: i64, min: i64) -> Vec<(i64, i64)> {
    let mut ranges: Vec<(i64, i64)> = spans
        .iter()
        .filter(|s| s.chunk.all > 0)
        .map(|s| (s.a.min(s.b), s.a.max(s.b)))
        .collect();
    ranges.sort_unstable();
    let mut out = Vec::new();
    let mut covered: Option<i64> = None;
    for (a, b) in ranges {
        if let Some(end) = covered {
            let (lo, hi) = (end.max(from), a.min(to));
            if a > end && hi - lo >= min && out.len() < MAX_GAPS {
                out.push((lo, hi));
            }
        }
        covered = Some(covered.map_or(b, |c| c.max(b)));
    }
    out
}

/// Line → time at the chunk boundaries, at most `max` (evenly thinned out), plus the end.
fn anchors(spans: &[Span], len: u64, max: usize) -> Vec<(u64, i64)> {
    if max < 2 || spans.is_empty() {
        return Vec::new();
    }
    let step = spans.len().div_ceil(max - 1).max(1);
    let mut out: Vec<(u64, i64)> = spans.iter().step_by(step).map(|s| (s.start, s.a)).collect();
    let last = spans[spans.len() - 1];
    out.push((len.saturating_sub(1).max(last.start), last.b));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: i64 = 1_000_000;

    fn head(summary: &mut TimeSummary, level: Level, ts: Option<i64>) {
        summary.push(level, true, ts);
    }

    /// `n` lines, one per second from `start`, each a head with its time.
    fn lines(summary: &mut TimeSummary, start: i64, n: i64, level: Level) {
        for i in 0..n {
            head(summary, level, Some(start + i * S));
        }
    }

    fn query(buckets: usize) -> TimelineQuery {
        TimelineQuery {
            buckets,
            anchors: 16,
            ..TimelineQuery::default()
        }
    }

    fn total(data: &TimelineData) -> f32 {
        data.buckets.iter().map(|b| b.all).sum()
    }

    #[test]
    fn a_chunk_keeps_its_first_and_last_time_and_counts_heads() {
        let mut s = TimeSummary::with_chunk(4);
        head(&mut s, Level::Info, Some(10));
        s.push(Level::Info, false, None);
        head(&mut s, Level::Error, None);
        head(&mut s, Level::Warn, Some(40));
        head(&mut s, Level::Fatal, Some(50));
        assert_eq!(s.chunks.len(), 1);
        let c = s.chunks[0];
        assert_eq!((c.first(), c.last()), (Some(10), Some(40)));
        assert_eq!((c.all, c.warn, c.error, c.fatal), (3, 1, 1, 0));
        assert_eq!(s.open.fatal, 1);
        assert_eq!(s.len(), 5);
    }

    #[test]
    fn growing_and_compacting_keeps_counts_and_outer_times() {
        let mut s = TimeSummary::with_chunk(1);
        let n = MAX_TIME_CHUNKS as i64 + 10;
        lines(&mut s, 0, n, Level::Info);
        assert_eq!(s.chunk_size(), 2);
        assert!(s.chunks.len() < MAX_TIME_CHUNKS);
        assert_eq!(s.len(), n as u64);
        let all: u64 = s.all_chunks().map(|(_, c)| u64::from(c.all)).sum();
        assert_eq!(all, n as u64);
        assert_eq!(s.chunks[0].first(), Some(0));
        assert_eq!(s.chunks[0].last(), Some(S));
        let data = s.timeline(&query(10));
        assert_eq!((data.from, data.to), (0, (n - 1) * S));
        assert!((total(&data) - n as f32).abs() < 1.0);
    }

    #[test]
    fn the_cursor_follows_compaction() {
        let mut s = TimeSummary::with_chunk(1);
        let mut cursor = s.cursor();
        for i in 0..(MAX_TIME_CHUNKS as i64 * 2 + 7) {
            if cursor.next(true).want {
                cursor.found();
            }
            head(&mut s, Level::Info, Some(i));
            let fresh = s.cursor();
            assert_eq!(
                (fresh.chunks, fresh.chunk_size, fresh.open_len),
                (cursor.chunks, cursor.chunk_size, cursor.open_len),
                "line {i}"
            );
        }
    }

    #[test]
    fn the_cursor_asks_for_first_heads_and_the_closing_line() {
        let mut s = TimeSummary::with_chunk(4);
        head(&mut s, Level::Info, None);
        let mut cursor = s.cursor();
        // Line 2 of the chunk: no time yet.
        assert_eq!(
            cursor.next(true),
            TimeStep {
                want: true,
                closes: false
            }
        );
        cursor.found();
        assert!(!cursor.next(true).want);
        let step = cursor.next(false);
        assert!(step.closes && !step.want);
        // A new chunk wants its first time again; continuations are never asked.
        assert!(!cursor.next(false).want);
        assert!(cursor.next(true).want);
    }

    #[test]
    fn a_file_without_times_gives_up_after_some_heads() {
        let mut cursor = TimeSummary::with_chunk(64).cursor();
        // The first attempts, then one sample every `SAMPLE_STEP` lines.
        let asked = (0..64).filter(|_| cursor.next(true).want).count();
        assert_eq!(asked, FIRST_TIME_ATTEMPTS as usize + 1);
        let s = {
            let mut s = TimeSummary::with_chunk(4);
            for _ in 0..10 {
                head(&mut s, Level::Info, None);
            }
            s
        };
        assert!(!s.has_times());
        let data = s.timeline(&query(10));
        assert!(data.buckets.is_empty());
        assert_eq!((data.entries, data.untimed), (10, 10));
    }

    #[test]
    fn pop_and_restore_withdraw_a_provisional_line() {
        let mut s = TimeSummary::with_chunk(2);
        head(&mut s, Level::Info, Some(10));
        let mark = s.mark();
        head(&mut s, Level::Error, Some(99));
        assert_eq!(s.chunks.len(), 1);
        s.pop(Level::Error, true);
        s.restore(mark);
        assert_eq!(s.len(), 1);
        assert_eq!(
            (s.open.first(), s.open.last(), s.open.error),
            (Some(10), Some(10), 0)
        );
        head(&mut s, Level::Warn, Some(20));
        assert_eq!(s.chunks[0].last(), Some(20));
        assert_eq!(s.chunks[0].warn, 1);
    }

    #[test]
    fn recount_takes_new_levels_and_keeps_times() {
        let mut s = TimeSummary::with_chunk(2);
        head(&mut s, Level::Info, Some(1));
        head(&mut s, Level::Info, Some(2));
        head(&mut s, Level::Info, Some(3));
        let entries = vec![
            LineEntry::new(0, 1, Level::Error, false),
            LineEntry::new(1, 1, Level::Error, true),
            LineEntry::new(2, 1, Level::Warn, false),
        ];
        s.recount(&entries);
        assert_eq!((s.chunks[0].all, s.chunks[0].error), (1, 1));
        assert_eq!((s.open.all, s.open.warn), (1, 1));
        assert_eq!(s.chunks[0].last(), Some(2));
    }

    #[test]
    fn buckets_spread_a_chunk_evenly_and_sum_up() {
        let mut s = TimeSummary::with_chunk(100);
        lines(&mut s, 0, 100, Level::Info);
        lines(&mut s, 100 * S, 100, Level::Error);
        let data = s.timeline(&query(4));
        assert_eq!((data.from, data.to), (0, 199 * S));
        assert!((total(&data) - 200.0).abs() < 0.01);
        let errors: Vec<f32> = data.buckets.iter().map(|b| b.error).collect();
        assert!(errors[0] < 0.01 && errors[1] < 0.01);
        assert!(errors[2] > 45.0 && errors[3] > 45.0);
        assert!(data.gaps.is_empty());
        assert_eq!(data.anchors.first(), Some(&(0, 0)));
        assert_eq!(data.anchors.last(), Some(&(199, 199 * S)));
    }

    #[test]
    fn a_gap_between_chunks_is_reported_and_left_empty() {
        let mut s = TimeSummary::with_chunk(10);
        lines(&mut s, 0, 10, Level::Info);
        lines(&mut s, 3_600 * S, 10, Level::Info);
        let data = s.timeline(&query(100));
        assert_eq!(data.gaps, vec![(9 * S, 3_600 * S)]);
        let empty = data.buckets.iter().filter(|b| b.all == 0.0).count();
        assert!(empty >= 95, "{empty}");
    }

    #[test]
    fn an_outage_inside_a_chunk_splits_it() {
        let mut s = TimeSummary::with_chunk(100);
        // 40 lines, an hour of silence, 60 lines; only every tenth line has its time parsed.
        for i in 0..100i64 {
            let t = if i < 40 { i * S } else { 3_600 * S + i * S };
            head(&mut s, Level::Info, (i % 10 == 0 || i == 99).then_some(t));
        }
        let data = s.timeline(&query(100));
        // The hole is known to the samples (30 s, 3 640 s) less the time the ten lines between
        // them would take at the rate of the rest: 5 s either side.
        assert_eq!(data.gaps.len(), 1, "{:?}", data.gaps);
        let (from, to) = data.gaps[0];
        assert!((from - 35 * S).abs() <= S, "{from}");
        assert!((to - 3_635 * S).abs() <= S, "{to}");
        // 30 lines before the first sample of the jump, half of the ten across it.
        let early: f32 = data.buckets[..5].iter().map(|b| b.all).sum();
        assert!((early - 35.0).abs() < 1.0, "{early}");
        assert!((total(&data) - 100.0).abs() < 0.01);
    }

    #[test]
    fn compaction_keeps_the_largest_jump() {
        let a = {
            let mut c = TimeChunk::EMPTY;
            c.time(0, 0);
            c.time(10, 1);
            c
        };
        let b = {
            let mut c = TimeChunk::EMPTY;
            c.time(100, 0);
            c.time(105, 1);
            c
        };
        let m = TimeChunk::merged(a, b, 2);
        assert_eq!((m.gap_from, m.gap_to), (10, 100));
        assert_eq!((m.gap_from_line, m.gap_line, m.last_line), (1, 2, 3));
        assert_eq!((m.first(), m.last()), (Some(0), Some(105)));
    }

    #[test]
    fn the_cursor_samples_one_head_every_step() {
        let mut cursor = TimeSummary::with_chunk(256).cursor();
        let wanted: Vec<usize> = (0..256)
            .filter(|_| {
                let want = cursor.next(true).want;
                if want {
                    cursor.found();
                }
                want
            })
            .collect();
        assert_eq!(wanted, vec![0, 32, 64, 96, 128, 160, 192, 224]);
    }

    #[test]
    fn an_unordered_chunk_goes_into_the_bucket_of_its_first_time() {
        let mut s = TimeSummary::with_chunk(3);
        lines(&mut s, 0, 3, Level::Info);
        head(&mut s, Level::Error, Some(90 * S));
        head(&mut s, Level::Info, Some(80 * S));
        head(&mut s, Level::Info, Some(10 * S));
        let data = s.timeline(&TimelineQuery {
            from: Some(0),
            to: Some(100 * S),
            buckets: 10,
            anchors: 0,
        });
        assert_eq!(data.buckets[9].all, 3.0);
        assert_eq!(data.buckets[9].error, 1.0);
        assert!((total(&data) - 6.0).abs() < 0.01);
    }

    #[test]
    fn chunks_without_time_inherit_from_their_neighbours() {
        let mut s = TimeSummary::with_chunk(2);
        lines(&mut s, 0, 2, Level::Info);
        head(&mut s, Level::Info, None);
        head(&mut s, Level::Info, None);
        lines(&mut s, 10 * S, 2, Level::Info);
        let data = s.timeline(&query(10));
        assert!((total(&data) - 6.0).abs() < 0.01);
        assert_eq!(data.untimed, 2);
    }

    #[test]
    fn the_axis_leaves_out_an_outlier_decades_away() {
        let day = 86_400 * S;
        let now = 1_760_000_000 * S;
        let mut s = TimeSummary::with_chunk(10);
        // One line from 1970 at the start of the first chunk, then a day of logging.
        head(&mut s, Level::Info, Some(0));
        for i in 1..1000 {
            head(&mut s, Level::Info, Some(now + i * day / 1000));
        }
        let data = s.timeline(&query(50));
        assert!(data.from >= now - day, "{}", data.from);
        assert_eq!(data.min, Some(0));
        assert!(data.to <= now + day);
        // The first chunk is laid at its end, so nearly everything is on the axis.
        assert!(total(&data) > 990.0, "{}", total(&data));
        assert!(data.before <= 10);
    }

    #[test]
    fn a_normal_file_keeps_its_ends_on_the_axis() {
        let mut s = TimeSummary::with_chunk(16);
        lines(&mut s, 1_000 * S, 1000, Level::Info);
        let data = s.timeline(&query(20));
        assert_eq!((data.from, data.to), (1_000 * S, 1_999 * S));
        assert_eq!((data.before, data.after), (0, 0));
    }

    #[test]
    fn a_zoom_counts_what_lies_outside() {
        let mut s = TimeSummary::with_chunk(10);
        lines(&mut s, 0, 100, Level::Info);
        let data = s.timeline(&TimelineQuery {
            from: Some(20 * S),
            to: Some(60 * S),
            buckets: 4,
            anchors: 0,
        });
        assert!((total(&data) - 40.0).abs() < 1.5, "{}", total(&data));
        assert!((data.before as i64 - 20).abs() <= 2, "{}", data.before);
        assert!((data.after as i64 - 40).abs() <= 2, "{}", data.after);
    }

    #[test]
    fn chunk_reaching_finds_the_chunk_for_a_time() {
        let mut s = TimeSummary::with_chunk(10);
        lines(&mut s, 0, 25, Level::Info);
        assert_eq!(s.chunk_reaching(0), Some((0, 10)));
        assert_eq!(s.chunk_reaching(9 * S), Some((0, 10)));
        assert_eq!(s.chunk_reaching(10 * S), Some((10, 20)));
        assert_eq!(s.chunk_reaching(24 * S), Some((20, 25)));
        assert_eq!(s.chunk_reaching(25 * S), None);
        assert_eq!(TimeSummary::new().chunk_reaching(0), None);
    }

    #[test]
    fn everything_at_one_moment_gets_a_small_axis() {
        let mut s = TimeSummary::with_chunk(4);
        lines(&mut s, 0, 1, Level::Info);
        head(&mut s, Level::Info, Some(0));
        let data = s.timeline(&query(10));
        assert!(data.to > data.from);
        assert!((total(&data) - 2.0).abs() < 0.01);
    }
}
