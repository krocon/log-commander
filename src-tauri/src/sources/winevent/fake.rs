//! A fake event log for the tests (prompt 018): a channel as a list of events that a test can add
//! to, clear, or make fail, with the query, bookmark and subscription rules of the real one.

use super::backend::{code, ApiError, ApiResult, EventLog, EventStream, RawEvent};
use super::{WinAuth, WinTarget};
use crate::remote::secrets::Secret;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct FakeEvent {
    pub record: u64,
    pub level: u8,
    /// Outside the backlog period.
    pub old: bool,
    pub message: Option<String>,
}

#[derive(Default)]
pub struct FakeState {
    pub events: Vec<FakeEvent>,
    /// Errors the next calls of `next` return, in order.
    pub fail_next: VecDeque<u32>,
    pub cancels: u32,
    /// Records that `EvtRender` cannot render.
    pub render_fail: Vec<u64>,
    /// `next` blocks until cancelled (a remote call that hangs).
    pub hang: bool,
    pub reconnects: u32,
    pub queries: u32,
    /// The bookmark of each subscription.
    pub subscribed: Vec<Option<String>>,
}

impl FakeState {
    pub fn add(&mut self, level: u8, message: &str) -> u64 {
        let record = self.events.last().map_or(1, |e| e.record + 1);
        self.events.push(FakeEvent {
            record,
            level,
            old: false,
            message: (!message.is_empty()).then(|| message.to_string()),
        });
        record
    }
}

#[derive(Clone, Default)]
pub struct FakeLog {
    pub state: Arc<Mutex<FakeState>>,
    /// The backlog query fails with this code.
    pub query_error: Option<u32>,
}

pub fn xml(e: &FakeEvent) -> String {
    format!(
        "<Event><System><Provider Name='Test-Provider'/><EventID>{}</EventID><Level>{}</Level>\
         <Task>0</Task><Keywords>0x80000000000000</Keywords>\
         <TimeCreated SystemTime='2026-11-08T09:00:00.000Z'/><EventRecordID>{}</EventRecordID>\
         <Channel>Application</Channel><Computer>pc</Computer></System>\
         <EventData><Data>daten {}</Data></EventData></Event>",
        1000 + e.record % 7,
        e.level,
        e.record,
        e.record
    )
}

fn bookmark(record: u64) -> String {
    format!("<BookmarkList><Bookmark Channel='Application' RecordId='{record}'/></BookmarkList>")
}

fn record_of(bookmark: &str) -> Option<u64> {
    let start = bookmark.find("RecordId='")? + "RecordId='".len();
    let end = bookmark[start..].find('\'')? + start;
    bookmark[start..end].parse().ok()
}

impl FakeLog {
    /// An opener that accepts `password` for a remote target with auth `password`.
    pub fn opener(
        log: FakeLog,
        password: &'static str,
    ) -> impl Fn(&WinTarget, Option<&Secret>) -> ApiResult<Box<dyn EventLog>> {
        move |target, secret| {
            if target.auth == WinAuth::Password && secret.map(Secret::expose) != Some(password) {
                return Err(ApiError::new(code::LOGON_FAILURE, "EvtQuery"));
            }
            Ok(Box::new(log.clone()))
        }
    }
}

struct FakeStream {
    state: Arc<Mutex<FakeState>>,
    /// Index of the next event.
    at: usize,
    /// A query sees the events there were when it started; a subscription sees new ones.
    end: Option<usize>,
    only_recent: bool,
    last: Option<u64>,
}

impl EventStream for FakeStream {
    fn next(&mut self, max: usize, wait: Duration) -> ApiResult<Vec<RawEvent>> {
        let mut out = Vec::new();
        if self.state.lock().hang {
            let start = std::time::Instant::now();
            while self.state.lock().cancels == 0 && start.elapsed() < Duration::from_secs(10) {
                std::thread::sleep(Duration::from_millis(5));
            }
            return Err(ApiError::new(code::CANCELLED, "EvtNext"));
        }
        {
            let mut s = self.state.lock();
            if let Some(code) = s.fail_next.pop_front() {
                return Err(ApiError::new(code, "EvtNext"));
            }
            let end = self.end.unwrap_or(s.events.len()).min(s.events.len());
            while self.at < end && out.len() < max {
                let e = &s.events[self.at];
                self.at += 1;
                if self.only_recent && e.old {
                    continue;
                }
                self.last = Some(e.record);
                if s.render_fail.contains(&e.record) {
                    // Like the API: the bookmark is past it, a placeholder stands in.
                    out.push(RawEvent {
                        render_error: Some(15005),
                        ..RawEvent::default()
                    });
                    continue;
                }
                out.push(RawEvent {
                    xml: xml(e),
                    message: e.message.clone(),
                    task: None,
                    render_error: None,
                });
            }
        }
        if out.is_empty() && self.end.is_none() {
            std::thread::sleep(wait.min(Duration::from_millis(20)));
        }
        Ok(out)
    }

    fn bookmark(&mut self) -> ApiResult<Option<String>> {
        Ok(self.last.map(bookmark))
    }
}

impl EventLog for FakeLog {
    fn query(&mut self, _channel: &str, since_ms: Option<u64>) -> ApiResult<Box<dyn EventStream>> {
        if let Some(code) = self.query_error {
            return Err(ApiError::new(code, "EvtQuery"));
        }
        let mut s = self.state.lock();
        s.queries += 1;
        Ok(Box::new(FakeStream {
            state: Arc::clone(&self.state),
            at: 0,
            end: Some(s.events.len()),
            only_recent: since_ms.is_some(),
            last: None,
        }))
    }

    fn newest(&mut self, _channel: &str) -> ApiResult<Option<String>> {
        Ok(self.state.lock().events.last().map(|e| bookmark(e.record)))
    }

    fn subscribe(
        &mut self,
        _channel: &str,
        mark: Option<&str>,
    ) -> ApiResult<(Box<dyn EventStream>, bool)> {
        let mut s = self.state.lock();
        s.subscribed.push(mark.map(str::to_string));
        let (at, found) = match mark.and_then(record_of) {
            Some(record) => match s.events.iter().position(|e| e.record == record) {
                Some(i) => (i + 1, true),
                None => (0, false),
            },
            None => (0, mark.is_none()),
        };
        Ok((
            Box::new(FakeStream {
                state: Arc::clone(&self.state),
                at,
                end: None,
                only_recent: false,
                last: None,
            }),
            found,
        ))
    }

    fn reconnect(&mut self) -> ApiResult<()> {
        self.state.lock().reconnects += 1;
        Ok(())
    }

    fn canceller(&self) -> Box<dyn Fn() + Send + Sync> {
        let state = Arc::clone(&self.state);
        Box::new(move || state.lock().cancels += 1)
    }
}

/// The whole path on every platform: fake log → source → spool → session (columns, levels).
#[cfg(test)]
mod flow {
    use super::super::{WinEventConfig, WinEventSource};
    use super::*;
    use crate::level::Level;
    use crate::model::{SessionInfo, SourceState};
    use crate::remote::Credentials;
    use crate::session::{OpenOptions, SessionManager};
    use crate::spool::{SpoolConfig, SpoolRoot};
    use std::time::Instant;

    const TIMEOUT: Duration = Duration::from_secs(30);

    struct Fixture {
        _cache: tempfile::TempDir,
        manager: SessionManager,
        log: FakeLog,
    }

    fn fixture() -> Fixture {
        let cache = tempfile::tempdir().unwrap();
        let manager = SessionManager::default();
        manager.set_spool_root(Arc::new(SpoolRoot::prepare(cache.path()).unwrap()));
        Fixture {
            _cache: cache,
            manager,
            log: FakeLog::default(),
        }
    }

    fn config() -> WinEventConfig {
        serde_json::from_str(r#"{"channel":"Application"}"#).unwrap()
    }

    impl Fixture {
        fn open(&self, config: WinEventConfig) -> SessionInfo {
            self.open_as(config, Credentials::default())
        }

        fn open_as(&self, config: WinEventConfig, creds: Credentials) -> SessionInfo {
            let opener = FakeLog::opener(self.log.clone(), "geheim");
            let source = WinEventSource::open_with(config, &creds, None, &opener).unwrap();
            let root = self.manager.spool_root().unwrap();
            self.manager
                .open_prepared_source(
                    Box::new(source),
                    SpoolConfig::sized(root.new_dir(), 1 << 20, 4),
                    false,
                    OpenOptions::default(),
                    Box::new(|_| {}),
                )
                .unwrap()
        }

        fn lines(&self, info: &SessionInfo) -> Vec<(String, Level)> {
            let session = self.manager.session(info.session_id).unwrap();
            let total = session.stats().total_lines as usize;
            session
                .get_lines(false, 0, total)
                .unwrap()
                .into_iter()
                .map(|l| (l.text, l.level))
                .collect()
        }

        fn records(&self, info: &SessionInfo) -> Vec<u64> {
            self.lines(info)
                .iter()
                .map(|(t, _)| {
                    serde_json::from_str::<serde_json::Value>(t).unwrap()["recordId"]
                        .as_u64()
                        .unwrap()
                })
                .collect()
        }

        fn wait(&self, info: &SessionInfo, what: &str, done: impl Fn(&Self) -> bool) {
            let start = Instant::now();
            while !done(self) {
                let status = self.manager.session(info.session_id).unwrap().stats();
                assert!(
                    start.elapsed() < TIMEOUT,
                    "timeout waiting for {what}: {:?} {:?}",
                    status.total_lines,
                    status.source_status
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        fn state(&self, info: &SessionInfo) -> SourceState {
            let stats = self.manager.session(info.session_id).unwrap().stats();
            stats.source_status.unwrap().state
        }
    }

    #[test]
    fn backlog_then_live_with_levels_and_columns() {
        let fx = fixture();
        {
            let mut s = fx.log.state.lock();
            s.add(4, "");
            s.events[0].old = true;
            for level in [1, 2, 3, 4, 5] {
                s.add(level, &format!("Meldung {level}\r\nzweite Zeile"));
            }
        }
        let info = fx.open(config());
        assert_eq!(
            info.source.as_ref().unwrap().label,
            "Ereignisse: Application"
        );
        // The old event is outside the 24 hours.
        fx.wait(&info, "backlog", |f| f.lines(&info).len() == 5);
        fx.wait(&info, "live", |f| f.state(&info) == SourceState::Listening);
        assert_eq!(
            fx.lines(&info).iter().map(|l| l.1).collect::<Vec<_>>(),
            [
                Level::Fatal,
                Level::Error,
                Level::Warn,
                Level::Info,
                Level::Debug
            ]
        );
        // One event, one line: the line break of the message is escaped.
        let (first, _) = &fx.lines(&info)[0];
        assert!(
            first.contains(r#""message":"Meldung 1\r\nzweite Zeile""#),
            "{first}"
        );
        // The subscription starts after the last event of the backlog.
        let subscribed = fx.log.state.lock().subscribed.clone();
        assert_eq!(subscribed.len(), 1);
        assert!(subscribed[0].as_deref().unwrap().contains("RecordId='6'"));
        // New events show up live.
        fx.log.state.lock().add(2, "neu");
        fx.wait(&info, "live event", |f| f.lines(&info).len() == 6);
        assert_eq!(fx.records(&info), [2, 3, 4, 5, 6, 7]);
        // The profile of the source: JSON columns with German names.
        let session = fx.manager.session(info.session_id).unwrap();
        let columns = session.columns();
        assert_eq!(columns.profile_id, crate::profile::WINEVENT_PROFILE);
        let labels: Vec<(String, String)> = columns
            .columns
            .iter()
            .map(|c| (c.id.clone(), c.label.clone()))
            .collect();
        for (id, label) in [
            ("timestamp", "Zeit"),
            ("level", "Level"),
            ("message", "Nachricht"),
            ("provider", "Provider"),
            ("eventId", "Event-ID"),
            ("channel", "Kanal"),
            ("xml", "XML"),
        ] {
            assert!(
                labels.contains(&(id.to_string(), label.to_string())),
                "{id} in {labels:?}"
            );
        }
    }

    #[test]
    fn closing_cancels_a_hanging_call() {
        let fx = fixture();
        let info = fx.open(config());
        fx.wait(&info, "live", |f| f.state(&info) == SourceState::Listening);
        fx.log.state.lock().hang = true;
        std::thread::sleep(Duration::from_millis(100));
        let start = Instant::now();
        fx.manager.close(info.session_id).unwrap();
        // Without the cancel the fake hangs 10 s; the rest is the session closing under load.
        assert!(
            start.elapsed() < Duration::from_secs(8),
            "{:?}",
            start.elapsed()
        );
        assert_eq!(fx.log.state.lock().cancels, 1);
    }

    #[test]
    fn a_broken_connection_continues_at_the_bookmark_without_gap_or_doubles() {
        let fx = fixture();
        {
            let mut s = fx.log.state.lock();
            for _ in 0..300 {
                s.add(4, "x");
            }
        }
        let mut c = config();
        c.xml = false;
        let info = fx.open(c);
        fx.wait(&info, "live", |f| f.state(&info) == SourceState::Listening);
        fx.wait(&info, "backlog", |f| f.lines(&info).len() == 300);
        assert!(!fx.lines(&info)[0].0.contains("\"xml\""));
        // The connection breaks (RPC server unavailable), events go on meanwhile.
        {
            let mut s = fx.log.state.lock();
            s.fail_next.push_back(code::RPC_SERVER_UNAVAILABLE);
            s.add(3, "während der Störung");
        }
        fx.wait(&info, "reconnecting", |f| {
            matches!(f.state(&info), SourceState::Reconnecting { .. })
        });
        fx.log.state.lock().add(3, "danach");
        fx.wait(&info, "back", |f| f.lines(&info).len() == 302);
        fx.wait(&info, "live again", |f| {
            f.state(&info) == SourceState::Listening
        });
        let records = fx.records(&info);
        assert_eq!(records, (1..=302).collect::<Vec<_>>());
        let s = fx.log.state.lock();
        assert_eq!(s.reconnects, 1);
        assert_eq!(s.queries, 1, "the backlog is not read again");
        assert!(s.subscribed[1]
            .as_deref()
            .unwrap()
            .contains("RecordId='300'"));
    }

    #[test]
    fn a_cleared_log_is_a_counted_gap() {
        let fx = fixture();
        fx.log.state.lock().add(4, "a");
        let info = fx.open(config());
        fx.wait(&info, "live", |f| f.state(&info) == SourceState::Listening);
        {
            // Cleared: the bookmarked event is gone, record IDs start over.
            let mut s = fx.log.state.lock();
            s.events.clear();
            s.fail_next.push_back(code::EVT_QUERY_RESULT_STALE);
        }
        fx.wait(&info, "resubscribed", |f| {
            f.log.state.lock().subscribed.len() == 2
        });
        fx.log.state.lock().add(2, "nach dem Leeren");
        fx.wait(&info, "new event", |f| f.lines(&info).len() == 2);
        let stats = fx.manager.session(info.session_id).unwrap().stats();
        assert_eq!(stats.source_status.unwrap().gaps, 1);
    }

    #[test]
    fn an_empty_period_subscribes_after_the_newest_event() {
        let fx = fixture();
        {
            let mut s = fx.log.state.lock();
            s.add(4, "alt");
            s.events[0].old = true;
        }
        let info = fx.open(config());
        fx.wait(&info, "live", |f| f.state(&info) == SourceState::Listening);
        std::thread::sleep(Duration::from_millis(300));
        assert!(fx.lines(&info).is_empty());
        let subscribed = fx.log.state.lock().subscribed.clone();
        assert!(subscribed[0].as_deref().unwrap().contains("RecordId='1'"));
        fx.log.state.lock().add(4, "neu");
        fx.wait(&info, "live event", |f| f.records(&info) == [2]);
    }

    #[test]
    fn an_event_that_cannot_be_rendered_is_a_placeholder_and_does_not_block() {
        let fx = fixture();
        {
            let mut s = fx.log.state.lock();
            s.add(4, "a");
            let bad = s.add(4, "b");
            s.add(4, "c");
            s.render_fail.push(bad);
        }
        let mut c = config();
        c.xml = false;
        let info = fx.open(c);
        fx.wait(&info, "three lines", |f| f.lines(&info).len() == 3);
        fx.wait(&info, "live", |f| f.state(&info) == SourceState::Listening);
        let lines = fx.lines(&info);
        assert!(
            lines[1].0.contains("(Ereignis nicht lesbar, Fehler 15005)"),
            "{}",
            lines[1].0
        );
        assert!(!lines[1].0.contains("\"xml\""));
        assert_eq!(lines[1].1, Level::Warn);
        let stats = fx.manager.session(info.session_id).unwrap().stats();
        assert_eq!(stats.source_status.unwrap().rejected, 1);
        // Nothing is retried: the next event comes live after it.
        fx.log.state.lock().add(2, "d");
        fx.wait(&info, "live event", |f| f.lines(&info).len() == 4);
        assert_eq!(fx.log.state.lock().reconnects, 0);
    }

    #[test]
    fn with_a_password_unknown_errors_are_not_retried_forever() {
        let fx = fixture();
        let mut c = config();
        c.computer = "srv01".into();
        c.auth = super::super::WinAuth::Password;
        c.user = "CORP\\ops".into();
        let creds = Credentials {
            secret: Some(Secret::new("geheim")),
            remember: false,
            trust_fingerprint: None,
        };
        let info = fx.open_as(c, creds);
        fx.wait(&info, "live", |f| f.state(&info) == SourceState::Listening);
        // An error nobody classified (31 = ERROR_GEN_FAILURE), again and again.
        fx.log
            .state
            .lock()
            .fail_next
            .extend([31, 31, 31, 31, 31, 31]);
        let start = Instant::now();
        fx.wait(&info, "error", |f| {
            matches!(f.state(&info), SourceState::Error { .. })
        });
        // 1 + 2 + 4 s of backoff, then it stops instead of logging in again and again.
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "{:?}",
            start.elapsed()
        );
        assert_eq!(fx.log.state.lock().reconnects, 3);
    }

    #[test]
    fn a_lost_right_stops_with_the_hint() {
        let fx = fixture();
        let info = fx.open(config());
        fx.wait(&info, "live", |f| f.state(&info) == SourceState::Listening);
        fx.log.state.lock().fail_next.push_back(code::ACCESS_DENIED);
        fx.wait(&info, "error", |f| {
            matches!(f.state(&info), SourceState::Error { ref message } if message.contains("Event Log Readers"))
        });
        assert_eq!(fx.log.state.lock().reconnects, 0);
    }
}
