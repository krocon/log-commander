//! The flow of a Windows event source (prompt 018), on the source's thread:
//!
//! 1. **Backlog:** the query of the chosen period, in batches of `BATCH` (rendered, formatted,
//!    written), the bookmark after each batch.
//! 2. **Live:** a subscription after that bookmark (an empty backlog: after the newest event, an
//!    empty channel: from the oldest), waiting at most `WAIT` per round so that stopping is quick.
//! 3. **Broken:** a connection error is retried after 1, 2, 4 … 60 s with a new session, then it
//!    goes on after the bookmark. Record IDs already written are skipped (no doubles); if the
//!    bookmarked event is gone (log cleared or overwritten meanwhile) the gap is counted.
//!    Missing rights, an unknown channel or a refused login stop the source with an error.
//!
//! Everything here works on the `EventLog` trait and is tested on every platform with a fake.

use super::backend::{self, ApiError, EventLog, EventStream, Kind, RawEvent};
use super::event;
use super::line::{json_line, unreadable_line, Extra};
use super::{app_error, WinTarget};
use crate::model::SourceState;
use crate::sources::SourceContext;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Events rendered per round.
pub const BATCH: usize = 128;
/// A subscription waits at most this long for new events per round.
const WAIT: Duration = Duration::from_millis(200);
/// With a password, unclassified errors are tried this often, then the source stops (review 018
/// M3: no endless logins with a password that may be the reason).
const MAX_PASSWORD_RETRIES: u32 = 3;
/// Waits between reconnect attempts: 1, 2, 4 … at most 60 s.
const MAX_BACKOFF_S: u32 = 60;

pub struct Options {
    pub target: WinTarget,
    pub channel: String,
    pub since_ms: Option<u64>,
    pub xml: bool,
}

/// Where the source stands: the bookmark after the last event written and its record ID.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Cursor {
    pub bookmark: Option<String>,
    last_record: Option<u64>,
}

impl Cursor {
    /// An event is new unless its record ID was written already (after a resume). 0 = unknown.
    pub fn accept(&mut self, record_id: u64) -> bool {
        if record_id == 0 {
            return true;
        }
        if self.last_record.is_some_and(|last| record_id <= last) {
            return false;
        }
        self.last_record = Some(record_id);
        true
    }

    /// The bookmarked event is gone: the log started over, every record ID counts again.
    pub fn lost(&mut self) {
        self.last_record = None;
    }
}

enum Phase {
    /// Query (or bookmark) still to do.
    Start,
    Backlog(Box<dyn EventStream>),
    Subscribe,
    Live(Box<dyn EventStream>),
}

struct Follow {
    log: Box<dyn EventLog>,
    options: Options,
    ctx: SourceContext,
    cursor: Cursor,
    line: String,
}

/// Runs until `ctx.stop`; a watcher cancels hanging calls of the log when it is set.
pub fn run(
    log: Box<dyn EventLog>,
    backlog: Option<Box<dyn EventStream>>,
    options: Options,
    ctx: SourceContext,
) {
    let done = Arc::new(AtomicBool::new(false));
    let watcher = {
        let cancel = log.canceller();
        let stop = ctx.stop.clone();
        let done = Arc::clone(&done);
        std::thread::Builder::new()
            .name("winevent-cancel".into())
            .spawn(move || {
                while !done.load(Ordering::SeqCst) {
                    if stop.is_stopped() {
                        cancel();
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            })
            .ok()
    };
    let mut follow = Follow {
        log,
        options,
        ctx,
        cursor: Cursor::default(),
        line: String::new(),
    };
    follow.run(backlog);
    done.store(true, Ordering::SeqCst);
    if let Some(w) = watcher {
        let _ = w.join();
    }
}

impl Follow {
    fn stopped(&self) -> bool {
        self.ctx.stop.is_stopped()
    }

    fn run(&mut self, backlog: Option<Box<dyn EventStream>>) {
        let mut phase = match backlog {
            Some(stream) => {
                self.ctx.monitor.set_state(SourceState::Loading);
                Phase::Backlog(stream)
            }
            None => Phase::Start,
        };
        let mut attempt: u32 = 0;
        while !self.stopped() {
            match self.step(phase) {
                Ok(next) => {
                    if matches!(next, Phase::Live(_)) && attempt > 0 {
                        attempt = 0;
                    }
                    phase = next;
                }
                Err(_) if self.stopped() => break,
                Err(e) if backend::permanent(e.code) => {
                    let message =
                        app_error(e, &self.options.target, Some(&self.options.channel)).message;
                    self.ctx.monitor.set_state(SourceState::Error { message });
                    // The lines stay; nothing more to do until the tab closes.
                    while !self.stopped() {
                        self.sleep(Duration::from_millis(200));
                    }
                    return;
                }
                Err(e) if backend::kind(e.code) == Kind::Stale && attempt == 0 => {
                    // The log was cleared or overwritten under the subscription: subscribe again.
                    attempt = 1;
                    phase = Phase::Start;
                }
                Err(e)
                    if backend::kind(e.code) == Kind::Other
                        && self.options.target.auth == super::WinAuth::Password
                        && attempt >= MAX_PASSWORD_RETRIES =>
                {
                    let message =
                        app_error(e, &self.options.target, Some(&self.options.channel)).message;
                    self.ctx.monitor.set_state(SourceState::Error { message });
                    while !self.stopped() {
                        self.sleep(Duration::from_millis(200));
                    }
                    return;
                }
                Err(e) => {
                    self.wait_before_retry(e, attempt);
                    attempt += 1;
                    phase = Phase::Start;
                    if self.stopped() {
                        break;
                    }
                    if let Err(e) = self.log.reconnect() {
                        if backend::permanent(e.code) {
                            let message =
                                app_error(e, &self.options.target, Some(&self.options.channel))
                                    .message;
                            self.ctx.monitor.set_state(SourceState::Error { message });
                            while !self.stopped() {
                                self.sleep(Duration::from_millis(200));
                            }
                            return;
                        }
                    }
                }
            }
        }
        self.ctx.monitor.flush();
    }

    fn wait_before_retry(&self, e: ApiError, attempt: u32) {
        let message = app_error(e, &self.options.target, Some(&self.options.channel)).message;
        let wait = (1u32 << attempt.min(6)).min(MAX_BACKOFF_S);
        for left in (1..=wait).rev() {
            if self.stopped() {
                return;
            }
            self.ctx.monitor.set_state(SourceState::Reconnecting {
                message: message.clone(),
                retry_in_s: left,
            });
            self.sleep(Duration::from_secs(1));
        }
    }

    fn sleep(&self, total: Duration) {
        let start = Instant::now();
        while !self.stopped() && start.elapsed() < total {
            std::thread::sleep((total - start.elapsed()).min(Duration::from_millis(50)));
        }
    }

    fn step(&mut self, phase: Phase) -> backend::ApiResult<Phase> {
        let channel = self.options.channel.clone();
        match phase {
            Phase::Start if self.cursor.bookmark.is_some() => Ok(Phase::Subscribe),
            Phase::Start => {
                self.ctx.monitor.set_state(SourceState::Loading);
                let stream = self.log.query(&channel, self.options.since_ms)?;
                Ok(Phase::Backlog(stream))
            }
            Phase::Backlog(mut stream) => {
                let batch = stream.next(BATCH, Duration::ZERO)?;
                if batch.is_empty() {
                    return Ok(Phase::Subscribe);
                }
                let go_on = self.write(&batch);
                if let Some(b) = stream.bookmark()? {
                    self.cursor.bookmark = Some(b);
                }
                self.ctx.monitor.flush();
                Ok(if go_on {
                    Phase::Backlog(stream)
                } else {
                    Phase::Start
                })
            }
            Phase::Subscribe => {
                let bookmark = match self.cursor.bookmark.clone() {
                    Some(b) => Some(b),
                    // Nothing in the period: after the newest event, so nothing new is missed.
                    None => self.log.newest(&channel)?,
                };
                let (stream, found) = self.log.subscribe(&channel, bookmark.as_deref())?;
                if bookmark.is_some() && !found {
                    self.cursor.lost();
                    self.ctx.monitor.gaps.fetch_add(1, Ordering::Relaxed);
                }
                self.ctx.monitor.set_state(SourceState::Listening);
                Ok(Phase::Live(stream))
            }
            Phase::Live(mut stream) => {
                let batch = stream.next(BATCH, WAIT)?;
                if !batch.is_empty() {
                    self.write(&batch);
                    if let Some(b) = stream.bookmark()? {
                        self.cursor.bookmark = Some(b);
                    }
                }
                self.ctx.monitor.flush();
                Ok(Phase::Live(stream))
            }
        }
    }

    /// Writes a batch; false when stopped.
    fn write(&mut self, batch: &[RawEvent]) -> bool {
        let zone = chrono::Local;
        for raw in batch {
            let monitor = &self.ctx.monitor;
            let mut line = std::mem::take(&mut self.line);
            let parsed = if raw.render_error.is_some() {
                None
            } else {
                event::parse(&raw.xml)
            };
            match parsed {
                Some(e) => {
                    if !self.cursor.accept(e.record_id) {
                        self.line = line;
                        continue;
                    }
                    let extra = Extra {
                        message: raw.message.as_deref(),
                        task: raw.task.as_deref(),
                        xml: self.options.xml.then_some(raw.xml.as_str()),
                    };
                    if json_line(&e, &extra, &zone, &mut line) {
                        monitor.truncated.fetch_add(1, Ordering::Relaxed);
                    }
                }
                None => {
                    // Counted as `rejected` (status bar: „nicht lesbar“).
                    monitor.rejected.fetch_add(1, Ordering::Relaxed);
                    let xml = self.options.xml.then_some(raw.xml.as_str());
                    unreadable_line(xml, raw.render_error, &zone, &mut line);
                }
            }
            monitor.received.fetch_add(1, Ordering::Relaxed);
            let ok = self
                .ctx
                .writer
                .line_blocking(line.as_bytes().to_vec(), &self.ctx.stop);
            monitor.counted();
            self.line = line;
            if !ok {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cursor_skips_what_was_written() {
        let mut c = Cursor::default();
        assert!(c.accept(5));
        assert!(c.accept(6));
        assert!(!c.accept(6));
        assert!(!c.accept(3));
        assert!(c.accept(0));
        assert!(c.accept(9));
        c.lost();
        assert!(c.accept(1));
    }
}
