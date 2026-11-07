//! What the overview ruler draws (prompt 007): which levels occur where in a view, kept up to date
//! while lines arrive instead of scanning the index per query.
//!
//! A [`LevelSummary`] ORs the level bits of consecutive positions into chunks. When there are too
//! many chunks, neighbours are merged and the chunk size doubles, so the memory stays at
//! `MAX_CHUNKS` bytes and the resolution is always finer than any ruler height. Laid onto pixel
//! buckets, the chunks give the levels per pixel and how dense they are (share of chunks with the level).

use crate::level::Level;

/// At most this many chunks (one byte each).
pub const MAX_CHUNKS: usize = 64 * 1024;
/// Positions per chunk at the start: exact for small views, merging starts at 64 K positions.
const FIRST_CHUNK: u32 = 1;

/// Levels with a density per bucket (the ruler's levels), in this order per bucket.
pub const DENSITY_LEVELS: [Level; 3] = [Level::Fatal, Level::Error, Level::Warn];

/// The summary laid onto pixel buckets, see [`LevelSummary::buckets`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Buckets {
    /// Level bits per bucket.
    pub bits: Vec<u8>,
    /// Per bucket one density 0–255 for each of [`DENSITY_LEVELS`].
    pub density: Vec<u8>,
}

/// The bit of a level in a summary mask.
pub fn level_bit(level: Level) -> u8 {
    1 << level as u8
}

/// Level bits per chunk of consecutive positions of a view.
#[derive(Debug, Clone)]
pub struct LevelSummary {
    /// Bit per level that occurs in the chunk.
    chunks: Vec<u8>,
    /// Positions per chunk.
    chunk_size: u32,
    /// The chunk being filled.
    open_mask: u8,
    open_len: u32,
}

/// State to go back to when a provisional line is withdrawn.
#[derive(Debug, Clone, Copy)]
pub struct SummaryMark {
    len: u64,
    chunks: usize,
    chunk_size: u32,
    open_mask: u8,
}

impl Default for LevelSummary {
    fn default() -> Self {
        Self::new()
    }
}

impl LevelSummary {
    pub fn new() -> Self {
        Self {
            chunks: Vec::new(),
            chunk_size: FIRST_CHUNK,
            open_mask: 0,
            open_len: 0,
        }
    }

    /// Number of positions taken.
    pub fn len(&self) -> u64 {
        self.chunks.len() as u64 * u64::from(self.chunk_size) + u64::from(self.open_len)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn chunk_size(&self) -> u32 {
        self.chunk_size
    }

    pub fn push(&mut self, level: Level) {
        self.open_mask |= level_bit(level);
        self.open_len += 1;
        if self.open_len == self.chunk_size {
            self.close();
        }
    }

    /// `count` positions whose levels are among `mask` (lines of an entry taken in afterwards, whose
    /// order is not known any more: every chunk they touch gets all bits).
    pub fn push_run(&mut self, mask: u8, mut count: u64) {
        while count > 0 {
            let room = u64::from(self.chunk_size - self.open_len);
            let step = room.min(count);
            self.open_mask |= mask;
            self.open_len += step as u32;
            count -= step;
            if self.open_len == self.chunk_size {
                self.close();
            }
        }
    }

    fn close(&mut self) {
        self.chunks.push(self.open_mask);
        self.open_mask = 0;
        self.open_len = 0;
        if self.chunks.len() >= MAX_CHUNKS {
            self.compact();
        }
    }

    /// Merges neighbouring chunks (OR) and doubles the chunk size.
    fn compact(&mut self) {
        let merged: Vec<u8> = self
            .chunks
            .chunks(2)
            .map(|p| p.iter().fold(0, |m, c| m | c))
            .collect();
        let odd = self.chunks.len() % 2 == 1;
        self.chunks = merged;
        let old = self.chunk_size;
        self.chunk_size *= 2;
        if odd {
            // The last single chunk becomes the first half of the open one.
            let last = self.chunks.pop().unwrap_or(0);
            self.open_mask |= last;
            self.open_len += old;
        }
    }

    /// Withdraws the last position. Its bit may stay in the chunk: an OR cannot be undone, and
    /// the line nearly always comes again right away. Finding a line looks at the lines anyway.
    pub fn pop(&mut self) {
        if self.open_len == 0 {
            let Some(last) = self.chunks.pop() else {
                return;
            };
            self.open_mask = last;
            self.open_len = self.chunk_size;
        }
        self.open_len -= 1;
        if self.open_len == 0 {
            self.open_mask = 0;
        }
    }

    pub fn mark(&self) -> SummaryMark {
        SummaryMark {
            len: self.len(),
            chunks: self.chunks.len(),
            chunk_size: self.chunk_size,
            open_mask: self.open_mask,
        }
    }

    /// Back to `mark`: exact while no chunk was closed since, otherwise bits may stay (see `pop`).
    pub fn restore(&mut self, mark: SummaryMark) {
        if mark.chunk_size == self.chunk_size
            && mark.chunks == self.chunks.len()
            && mark.len <= self.len()
        {
            self.open_len =
                (mark.len - self.chunks.len() as u64 * u64::from(self.chunk_size)) as u32;
            self.open_mask = mark.open_mask;
        } else {
            self.truncate(mark.len);
        }
    }

    /// Keeps the first `len` positions.
    pub fn truncate(&mut self, len: u64) {
        if len >= self.len() {
            return;
        }
        let size = u64::from(self.chunk_size);
        let full = (len / size) as usize;
        let rest = (len % size) as u32;
        if full < self.chunks.len() {
            let partial = self.chunks[full];
            self.chunks.truncate(full);
            self.open_mask = if rest > 0 { partial } else { 0 };
        } else if rest == 0 {
            self.open_mask = 0;
        }
        self.open_len = rest;
    }

    pub fn clear(&mut self) {
        *self = Self::new();
    }

    /// Bits of the chunk `index`; the open chunk follows the closed ones.
    fn chunk(&self, index: usize) -> u8 {
        self.chunks.get(index).copied().unwrap_or(self.open_mask)
    }

    fn chunk_count(&self) -> usize {
        self.chunks.len() + usize::from(self.open_len > 0)
    }

    /// The chunks laid onto `n` pixel buckets over the first `lines` positions, without touching a
    /// line. A chunk counts in every bucket it covers: with fewer lines than buckets a line fills
    /// all its pixels, so neighbouring lines of one level form one mark.
    ///
    /// Besides the bits, a density per bucket and level of [`DENSITY_LEVELS`]: the share of the
    /// bucket's positions that lie in chunks containing the level, 0–255 (any share above 0 gives at
    /// least 1). Chunks hold bits, no counts, so this is the fraction of chunks with the level,
    /// weighted by how much of each chunk falls into the bucket; with 1-position chunks it is exact.
    pub fn buckets(&self, lines: u64, n: usize) -> Buckets {
        let mut bits = vec![0u8; n];
        let mut covered = vec![0u64; n * DENSITY_LEVELS.len()];
        let lines = lines.min(self.len());
        if n == 0 || lines == 0 {
            return Buckets {
                bits,
                density: vec![0; covered.len()],
            };
        }
        let density_mask = DENSITY_LEVELS.iter().fold(0, |m, &l| m | level_bit(l));
        let size = u64::from(self.chunk_size);
        let wide = n as u64;
        for index in 0..self.chunk_count() {
            let start = index as u64 * size;
            if start >= lines {
                break;
            }
            let chunk_bits = self.chunk(index);
            if chunk_bits == 0 {
                continue;
            }
            let end = (start + size).min(lines);
            // Positions scaled by `n`: lines < 2^32 and n <= 8192 fit into u64 easily.
            let first = (start * wide / lines) as usize;
            let last = (end * wide).div_ceil(lines) as usize;
            for bucket in first.min(n - 1)..last.clamp(first + 1, n) {
                bits[bucket] |= chunk_bits;
                if chunk_bits & density_mask == 0 {
                    continue;
                }
                // Overlap of the chunk with the bucket `[b·lines/n, (b+1)·lines/n)`, in 1/n positions.
                let b = bucket as u64;
                let overlap = (end * wide)
                    .min((b + 1) * lines)
                    .saturating_sub((start * wide).max(b * lines));
                for (k, &level) in DENSITY_LEVELS.iter().enumerate() {
                    if chunk_bits & level_bit(level) != 0 {
                        covered[bucket * DENSITY_LEVELS.len() + k] += overlap;
                    }
                }
            }
        }
        // A bucket is `lines` units long.
        let density = covered
            .into_iter()
            .map(|c| (c * 255).div_ceil(lines).min(255) as u8)
            .collect();
        Buckets { bits, density }
    }

    /// Next position with a hit, strictly after (`forward`) or before `from` (`None`: from the start
    /// or the end), wrapping around once. Chunks without a bit of `levels` are skipped, in the rest
    /// `is_hit` decides per position. Returns the position and whether it wrapped.
    pub fn find(
        &self,
        len: u64,
        from: Option<u64>,
        forward: bool,
        levels: u8,
        mut is_hit: impl FnMut(u64) -> bool,
    ) -> Option<(u64, bool)> {
        if len == 0 {
            return None;
        }
        let parts = match (forward, from) {
            (true, None) => [(0, len, false), (0, 0, true)],
            (true, Some(from)) => {
                let start = (from + 1).min(len);
                [(start, len, false), (0, start, true)]
            }
            (false, None) => [(0, len, false), (0, 0, true)],
            (false, Some(from)) => {
                let end = from.min(len);
                [(0, end, false), (end, len, true)]
            }
        };
        for (start, end, wrapped) in parts {
            if let Some(hit) = self.scan(start, end, forward, levels, &mut is_hit) {
                return Some((hit, wrapped));
            }
        }
        None
    }

    fn scan(
        &self,
        start: u64,
        end: u64,
        forward: bool,
        levels: u8,
        is_hit: &mut impl FnMut(u64) -> bool,
    ) -> Option<u64> {
        let size = u64::from(self.chunk_size);
        // Positions beyond the summary (should not happen) are looked at one by one.
        let covered = self.len();
        let candidate = |p: u64| p >= covered || self.chunk((p / size) as usize) & levels != 0;
        if forward {
            let mut p = start;
            while p < end {
                if !candidate(p) {
                    p = ((p / size) + 1) * size;
                    continue;
                }
                if is_hit(p) {
                    return Some(p);
                }
                p += 1;
            }
        } else {
            let mut p = end;
            while p > start {
                let q = p - 1;
                if !candidate(q) {
                    p = (q / size * size).max(start);
                    continue;
                }
                if is_hit(q) {
                    return Some(q);
                }
                p = q;
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ERR: u8 = 1 << Level::Error as u8;
    const WARN: u8 = 1 << Level::Warn as u8;
    const INFO: u8 = 1 << Level::Info as u8;

    #[test]
    fn empty_summary_gives_empty_buckets() {
        let summary = LevelSummary::new();
        assert_eq!(summary.buckets(0, 4).bits, vec![0; 4]);
        assert_eq!(summary.find(0, None, true, ERR, |_| true), None);
        assert!(summary.is_empty());
    }

    #[test]
    fn more_buckets_than_lines_keeps_every_line_apart() {
        let mut summary = LevelSummary::new();
        for level in [Level::Info, Level::Error, Level::Warn] {
            summary.push(level);
        }
        let buckets = summary.buckets(3, 9).bits;
        assert_eq!(
            buckets,
            vec![INFO, INFO, INFO, ERR, ERR, ERR, WARN, WARN, WARN]
        );
    }

    #[test]
    fn compaction_keeps_every_bit_and_the_length() {
        let mut summary = LevelSummary::new();
        let total = 3 * MAX_CHUNKS as u64 + 17;
        let errors = [5u64, 70_001, 150_000, total - 1];
        for i in 0..total {
            summary.push(if errors.contains(&i) {
                Level::Error
            } else {
                Level::Info
            });
        }
        assert_eq!(summary.len(), total);
        assert!(summary.chunks.len() < MAX_CHUNKS);
        assert!(summary.chunk_size() >= 4);
        let n = 1000;
        let buckets = summary.buckets(total, n).bits;
        for line in errors {
            let bucket = (line * n as u64 / total) as usize;
            // The chunk may start in the bucket before.
            let near = buckets[bucket.saturating_sub(1)..=bucket]
                .iter()
                .any(|b| b & ERR != 0);
            assert!(near, "error at {line} lost");
        }
        let marked = buckets.iter().filter(|b| *b & ERR != 0).count();
        // A chunk across a bucket edge marks both.
        assert!(marked <= 2 * errors.len());
    }

    #[test]
    fn a_single_error_in_ten_million_lines_is_found_and_shown() {
        let mut summary = LevelSummary::new();
        let total = 10_000_000u64;
        let error = 7_654_321u64;
        for i in 0..total {
            summary.push(if i == error {
                Level::Error
            } else {
                Level::Info
            });
        }
        assert!(summary.chunks.len() <= MAX_CHUNKS);
        let buckets = summary.buckets(total, 800).bits;
        let marked = buckets.iter().filter(|b| *b & ERR != 0).count();
        assert!((1..=2).contains(&marked));
        let mut looked = 0;
        let hit = summary.find(total, Some(0), true, ERR, |p| {
            looked += 1;
            p == error
        });
        assert_eq!(hit, Some((error, false)));
        // Only the chunk with the bit was looked at.
        assert!(looked <= summary.chunk_size() as usize);
    }

    #[test]
    fn buckets_at_their_edges() {
        let mut summary = LevelSummary::new();
        for i in 0..100 {
            summary.push(if i == 0 || i == 99 {
                Level::Error
            } else {
                Level::Info
            });
        }
        let buckets = summary.buckets(100, 10).bits;
        assert_eq!(buckets[0] & ERR, ERR);
        assert_eq!(buckets[9] & ERR, ERR);
        assert!(buckets[1..9].iter().all(|b| b & ERR == 0));
        // Fewer lines than the summary has: the rest is left out.
        assert_eq!(summary.buckets(50, 10).bits[9] & ERR, 0);
    }

    /// Density of `level` (index into `DENSITY_LEVELS`) per bucket.
    fn density(buckets: &Buckets, level: usize) -> Vec<u8> {
        buckets
            .density
            .chunks(DENSITY_LEVELS.len())
            .map(|d| d[level])
            .collect()
    }
    const D_FATAL: usize = 0;
    const D_ERROR: usize = 1;
    const D_WARN: usize = 2;

    #[test]
    fn density_is_the_share_of_lines_while_chunks_are_single_lines() {
        let mut summary = LevelSummary::new();
        for i in 0..100 {
            summary.push(if i % 4 == 0 {
                Level::Error
            } else {
                Level::Info
            });
        }
        let buckets = summary.buckets(100, 10);
        assert_eq!(buckets.density.len(), 30);
        // Lines 0, 4, 8 of the first ten: 3/10 of 255, rounded up.
        assert_eq!(density(&buckets, D_ERROR)[0], 77);
        // Lines 12, 16 of 10..20.
        assert_eq!(density(&buckets, D_ERROR)[1], 51);
        assert!(density(&buckets, D_WARN).iter().all(|&d| d == 0));
        assert!(density(&buckets, D_FATAL).iter().all(|&d| d == 0));
        // A line that fills several pixels is dense in all of them.
        let mut few = LevelSummary::new();
        for level in [Level::Info, Level::Fatal, Level::Warn] {
            few.push(level);
        }
        let buckets = few.buckets(3, 9);
        assert_eq!(
            density(&buckets, D_FATAL),
            vec![0, 0, 0, 255, 255, 255, 0, 0, 0]
        );
        assert_eq!(density(&buckets, D_WARN)[6..], [255, 255, 255]);
    }

    #[test]
    fn a_chunk_across_a_bucket_edge_counts_by_its_share() {
        let mut summary = LevelSummary::new();
        for i in 0..3 {
            summary.push(if i == 1 { Level::Error } else { Level::Info });
        }
        // Three lines on two buckets: line 1 lies half in each.
        let buckets = summary.buckets(3, 2);
        assert_eq!(buckets.bits, vec![ERR | INFO, ERR | INFO]);
        assert_eq!(density(&buckets, D_ERROR), vec![85, 85]);
    }

    /// Like the demo (5000 lines/s, about 286 000 lines): FATAL in 2.3 %, ERROR in 9.3 %, WARN in
    /// 6.5 % of the lines. Nearly every pixel holds a FATAL, but the densities tell the levels apart.
    #[test]
    fn a_dense_log_does_not_saturate_every_level() {
        let mut summary = LevelSummary::new();
        let total = 286_000u64;
        let mut state = 4711u64;
        for _ in 0..total {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let roll = (state >> 33) % 1000;
            summary.push(match roll {
                0..=22 => Level::Fatal,
                23..=115 => Level::Error,
                116..=180 => Level::Warn,
                _ => Level::Info,
            });
        }
        assert_eq!(summary.chunk_size(), 8);
        let buckets = summary.buckets(total, 800);
        let fatal_bit = 1 << Level::Fatal as u8;
        let with_fatal = buckets.bits.iter().filter(|b| *b & fatal_bit != 0).count();
        assert!(with_fatal > 790, "the old picture: FATAL nearly everywhere");
        let mean = |level| {
            density(&buckets, level)
                .iter()
                .map(|&d| f64::from(d) / 255.0)
                .sum::<f64>()
                / 800.0
        };
        let (fatal, error, warn) = (mean(D_FATAL), mean(D_ERROR), mean(D_WARN));
        // Chunks of 8 lines: 1 − (1 − p)^8.
        assert!((0.12..0.24).contains(&fatal), "fatal {fatal}");
        assert!((0.45..0.62).contains(&error), "error {error}");
        assert!((0.33..0.48).contains(&warn), "warn {warn}");
        assert!(density(&buckets, D_FATAL).iter().all(|&d| d < 200));
    }

    #[test]
    fn an_isolated_error_has_a_small_but_visible_density() {
        let mut summary = LevelSummary::new();
        let total = 1_000_000u64;
        for i in 0..total {
            summary.push(if i == 500_000 {
                Level::Error
            } else {
                Level::Info
            });
        }
        let buckets = summary.buckets(total, 800);
        let errors = density(&buckets, D_ERROR);
        let marked: Vec<_> = errors.iter().filter(|&&d| d > 0).collect();
        assert!((1..=2).contains(&marked.len()));
        // One chunk of 16 lines among 1250 per pixel: above zero, far below dense.
        assert!(marked.iter().all(|&&d| (1..=10).contains(&d)));
    }

    #[test]
    fn find_forward_backward_and_around() {
        let mut summary = LevelSummary::new();
        for i in 0..1000 {
            summary.push(if i % 100 == 50 {
                Level::Error
            } else {
                Level::Info
            });
        }
        let hit = |p: u64| p % 100 == 50;
        assert_eq!(summary.find(1000, None, true, ERR, hit), Some((50, false)));
        assert_eq!(
            summary.find(1000, Some(50), true, ERR, hit),
            Some((150, false))
        );
        assert_eq!(
            summary.find(1000, Some(950), true, ERR, hit),
            Some((50, true))
        );
        assert_eq!(
            summary.find(1000, Some(150), false, ERR, hit),
            Some((50, false))
        );
        assert_eq!(
            summary.find(1000, Some(50), false, ERR, hit),
            Some((950, true))
        );
        assert_eq!(
            summary.find(1000, None, false, ERR, hit),
            Some((950, false))
        );
        assert_eq!(summary.find(1000, Some(10), true, WARN, |_| true), None);
    }

    #[test]
    fn pop_and_restore_go_back() {
        let mut summary = LevelSummary::new();
        for _ in 0..10 {
            summary.push(Level::Info);
        }
        let mark = summary.mark();
        summary.push(Level::Error);
        summary.push(Level::Error);
        summary.restore(mark);
        assert_eq!(summary.len(), 10);
        summary.push(Level::Warn);
        summary.pop();
        assert_eq!(summary.len(), 10);
        summary.truncate(3);
        assert_eq!(summary.len(), 3);
        summary.push_run(ERR | WARN, 5);
        assert_eq!(summary.len(), 8);
        assert_eq!(summary.buckets(8, 8).bits[7], ERR | WARN);
        summary.clear();
        assert_eq!(summary.len(), 0);
    }

    #[test]
    fn restore_after_a_compaction_truncates() {
        let mut summary = LevelSummary::new();
        for _ in 0..MAX_CHUNKS - 1 {
            summary.push(Level::Info);
        }
        let mark = summary.mark();
        for _ in 0..5 {
            summary.push(Level::Error);
        }
        summary.restore(mark);
        assert_eq!(summary.len(), MAX_CHUNKS as u64 - 1);
    }
}
