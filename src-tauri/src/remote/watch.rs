//! Rotation and truncation of a remote file from `stat` results (prompt 017), pure.
//!
//! SFTP v3 has no inode. The source keeps the file's handle open and compares, each round, the
//! attributes of the handle (`fstat`) with those of the path (`stat`). The same file gives the same
//! attributes; a write between the two calls is told apart by a second `fstat`. Different
//! attributes twice in a row mean the path names another file now: rotation. The old file is then
//! read to its end through the handle, nothing is lost.

use super::RemoteStat;

/// What one round found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    /// Nothing new.
    Unchanged,
    /// The open file has bytes beyond the offset, up to `size`.
    Grown { size: u64 },
    /// The same file is shorter than what was read: start again at 0.
    Truncated,
    /// The path names another file: read the old one to `size` (its end), then open the path.
    Rotated { size: u64 },
    /// The path is gone and the open file has nothing new (it may come back).
    Gone,
}

/// The watch of one file: remembers a suspected rotation for the next round.
#[derive(Debug, Default, Clone)]
pub struct Watch {
    suspect: bool,
}

fn same(a: &RemoteStat, b: &RemoteStat) -> bool {
    a.size == b.size
        && a.mtime == b.mtime
        && a.uid == b.uid
        && a.gid == b.gid
        && a.permissions == b.permissions
}

/// `path` could be the file of the handle while it grew from `first` to `second`.
fn between(first: &RemoteStat, path: &RemoteStat, second: &RemoteStat) -> bool {
    let owner = |s: &RemoteStat| (s.uid, s.gid, s.permissions);
    owner(first) == owner(path)
        && owner(path) == owner(second)
        && first.size <= path.size
        && path.size <= second.size
        && first.mtime <= path.mtime
        && path.mtime <= second.mtime
}

impl Watch {
    /// `handle`: `fstat` before, `path`: `stat` of the path (None: gone), `again`: `fstat` after the
    /// path's `stat` (asked for only when the first two differ; see [`Watch::needs_again`]).
    pub fn step(
        &mut self,
        offset: u64,
        handle: RemoteStat,
        path: Option<RemoteStat>,
        again: Option<RemoteStat>,
    ) -> Change {
        let Some(path) = path else {
            self.suspect = false;
            return if handle.size > offset {
                Change::Grown { size: handle.size }
            } else {
                Change::Gone
            };
        };
        let same_file = match &again {
            None => same(&handle, &path),
            // Written in between: the path's answer lies between the two answers of the handle.
            Some(again) => same(again, &path) || between(&handle, &path, again),
        };
        let handle = again.unwrap_or(handle);
        if !same_file {
            if self.suspect {
                self.suspect = false;
                return Change::Rotated { size: handle.size };
            }
            self.suspect = true;
            return if handle.size > offset {
                Change::Grown { size: handle.size }
            } else {
                Change::Unchanged
            };
        }
        self.suspect = false;
        if handle.size < offset {
            Change::Truncated
        } else if handle.size > offset {
            Change::Grown { size: handle.size }
        } else {
            Change::Unchanged
        }
    }

    /// Whether the handle should be asked again (the first two answers differ).
    pub fn needs_again(handle: &RemoteStat, path: Option<&RemoteStat>) -> bool {
        path.is_some_and(|p| !same(handle, p))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(size: u64, mtime: u32) -> RemoteStat {
        RemoteStat {
            size,
            mtime: Some(mtime),
            uid: Some(1000),
            gid: Some(1000),
            permissions: Some(0o100644),
            is_dir: false,
            is_file: true,
        }
    }

    #[test]
    fn growth_and_quiet() {
        let mut w = Watch::default();
        assert_eq!(
            w.step(0, st(10, 1), Some(st(10, 1)), None),
            Change::Grown { size: 10 }
        );
        assert_eq!(
            w.step(10, st(10, 1), Some(st(10, 1)), None),
            Change::Unchanged
        );
    }

    #[test]
    fn a_write_between_the_calls_is_no_rotation() {
        let mut w = Watch::default();
        // fstat 10, then the file grows, stat 20, second fstat 20 as well.
        assert!(Watch::needs_again(&st(10, 1), Some(&st(20, 2))));
        assert_eq!(
            w.step(10, st(10, 1), Some(st(20, 2)), Some(st(20, 2))),
            Change::Grown { size: 20 }
        );
        // The same thing again and again never becomes a rotation.
        for i in 0..5 {
            let n = 20 + i * 10;
            assert_eq!(
                w.step(n, st(n, 3), Some(st(n + 10, 4)), Some(st(n + 10, 4))),
                Change::Grown { size: n + 10 }
            );
        }
    }

    #[test]
    fn continuous_writes_are_never_a_rotation() {
        let mut w = Watch::default();
        let mut n = 0;
        for i in 0..20 {
            // fstat sees n, stat a bit later n+5, the second fstat later still n+9.
            let (a, b, c) = (st(n, i), st(n + 5, i), st(n + 9, i + 1));
            assert_eq!(
                w.step(n, a, Some(b), Some(c)),
                Change::Grown { size: n + 9 }
            );
            n += 9;
        }
    }

    #[test]
    fn rotation_needs_two_rounds_and_reads_the_old_file_to_its_end() {
        let mut w = Watch::default();
        // Renamed away (old file 100 bytes, 20 unread), a new empty file at the path.
        assert_eq!(
            w.step(80, st(100, 5), Some(st(0, 6)), Some(st(100, 5))),
            Change::Grown { size: 100 }
        );
        assert_eq!(
            w.step(100, st(100, 5), Some(st(3, 6)), Some(st(100, 5))),
            Change::Rotated { size: 100 }
        );
        // After a rotation the next file starts fresh.
        assert_eq!(
            w.step(0, st(3, 6), Some(st(3, 6)), None),
            Change::Grown { size: 3 }
        );
    }

    #[test]
    fn a_new_file_of_the_same_size_and_time_but_other_owner_is_a_rotation() {
        let mut w = Watch::default();
        let mut other = st(50, 5);
        other.uid = Some(0);
        assert_eq!(
            w.step(50, st(50, 5), Some(other), Some(st(50, 5))),
            Change::Unchanged
        );
        assert_eq!(
            w.step(50, st(50, 5), Some(other), Some(st(50, 5))),
            Change::Rotated { size: 50 }
        );
    }

    #[test]
    fn truncation_and_copytruncate() {
        let mut w = Watch::default();
        // copytruncate: the same file (same handle) is now shorter than what was read.
        assert_eq!(
            w.step(100, st(0, 7), Some(st(0, 7)), None),
            Change::Truncated
        );
        assert_eq!(
            w.step(100, st(5, 7), Some(st(5, 7)), None),
            Change::Truncated
        );
    }

    #[test]
    fn a_deleted_file_is_read_to_its_end_and_then_waited_for() {
        let mut w = Watch::default();
        assert_eq!(
            w.step(10, st(30, 1), None, None),
            Change::Grown { size: 30 }
        );
        assert_eq!(w.step(30, st(30, 1), None, None), Change::Gone);
        // It comes back: another file at the path.
        assert_eq!(
            w.step(30, st(30, 1), Some(st(4, 9)), Some(st(30, 1))),
            Change::Unchanged
        );
        assert_eq!(
            w.step(30, st(30, 1), Some(st(4, 9)), Some(st(30, 1))),
            Change::Rotated { size: 30 }
        );
    }

    #[test]
    fn a_single_odd_round_resets() {
        let mut w = Watch::default();
        assert_eq!(
            w.step(10, st(10, 1), Some(st(11, 2)), Some(st(10, 1))),
            Change::Unchanged
        );
        // Next round agrees again: the suspicion is gone.
        assert_eq!(
            w.step(10, st(12, 2), Some(st(12, 2)), None),
            Change::Grown { size: 12 }
        );
        assert_eq!(
            w.step(12, st(12, 2), Some(st(13, 3)), Some(st(12, 2))),
            Change::Unchanged
        );
    }
}
