//! The Windows event log API behind `EventLog` (prompt 018), only compiled on Windows:
//! `EvtOpenSession` (remote), `EvtQuery`, `EvtSubscribe` (pull, with a signal event), `EvtNext`,
//! `EvtRender` (event XML, bookmarks), `EvtFormatMessage` with cached provider metadata,
//! `EvtOpenChannelEnum`, `EvtCancel`.
//!
//! Uses only `std`, `windows-sys` and the plain modules `backend`, `cache` and `event`, so that it
//! also compiles in a small check crate for the Windows targets (see the design document).

use super::backend::{
    code, from_wide, from_wide_bytes, message_missing, message_partial, since_query, wide,
    ApiError, ApiResult, EventLog, EventStream, RawEvent,
};
use super::cache::{MetadataCache, MAX_PROVIDERS, RETRY_MISSING};
use super::event::provider_name;
use std::ffi::c_void;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::System::EventLog::{
    EvtCancel, EvtClose, EvtCreateBookmark, EvtFormatMessage, EvtFormatMessageEvent,
    EvtFormatMessageTask, EvtNext, EvtNextChannelPath, EvtOpenChannelEnum,
    EvtOpenPublisherMetadata, EvtOpenSession, EvtQuery, EvtQueryChannelPath,
    EvtQueryForwardDirection, EvtQueryReverseDirection, EvtRender, EvtRenderBookmark,
    EvtRenderEventXml, EvtRpcLogin, EvtRpcLoginAuthNegotiate, EvtSubscribe,
    EvtSubscribeStartAfterBookmark, EvtSubscribeStartAtOldestRecord, EvtSubscribeStrict,
    EvtUpdateBookmark, EVT_HANDLE, EVT_RPC_LOGIN,
};
use windows_sys::Win32::System::Threading::{CreateEventW, ResetEvent, WaitForSingleObject};

/// `EvtNext` of a query waits at most this long per call; in between the stop flag is checked
/// (review 018 M2: a hanging remote backlog must not outlive the tab).
const QUERY_WAIT_MS: u32 = 1000;
/// `EvtRender` of one event is tried this often before a placeholder stands in (review L7).
const RENDER_TRIES: u32 = 3;
/// Channels listed at most.
const MAX_CHANNELS: usize = 10_000;

fn last_error(call: &'static str) -> ApiError {
    // SAFETY: reads the calling thread's last error, no preconditions.
    ApiError::new(unsafe { GetLastError() }, call)
}

/// An `EVT_HANDLE`, closed on drop.
struct Handle(EVT_HANDLE);

impl Handle {
    fn new(raw: EVT_HANDLE, call: &'static str) -> ApiResult<Self> {
        if raw == 0 {
            Err(last_error(call))
        } else {
            Ok(Self(raw))
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        if self.0 != 0 {
            // SAFETY: the handle came from an Evt* function and is closed exactly once.
            unsafe { EvtClose(self.0) };
        }
    }
}

/// The signal event of a subscription.
struct Signal(HANDLE);

// SAFETY: a Win32 event handle may be used from any thread.
unsafe impl Send for Signal {}

impl Drop for Signal {
    fn drop(&mut self) {
        // SAFETY: created by CreateEventW, closed once.
        unsafe { CloseHandle(self.0) };
    }
}

/// UTF-16 text that is overwritten when dropped (the password of a remote login).
struct WipedWide(Vec<u16>);

impl WipedWide {
    fn new(text: &str) -> Self {
        Self(wide(text))
    }

    fn ptr(&mut self) -> *mut u16 {
        self.0.as_mut_ptr()
    }
}

impl Drop for WipedWide {
    fn drop(&mut self) {
        for c in self.0.iter_mut() {
            // SAFETY: `c` is a valid, aligned element of the vector; volatile so it is not elided.
            unsafe { std::ptr::write_volatile(c, 0) };
        }
    }
}

/// What a remote session is opened with; kept for reconnecting, the password wiped on drop.
struct Login {
    server: WipedWide,
    user: Option<WipedWide>,
    domain: Option<WipedWide>,
    password: Option<WipedWide>,
}

impl Login {
    fn open(&mut self) -> ApiResult<Handle> {
        let null = std::ptr::null_mut();
        let rpc = EVT_RPC_LOGIN {
            Server: self.server.ptr(),
            User: self.user.as_mut().map_or(null, WipedWide::ptr),
            Domain: self.domain.as_mut().map_or(null, WipedWide::ptr),
            Password: self.password.as_mut().map_or(null, WipedWide::ptr),
            Flags: EvtRpcLoginAuthNegotiate,
        };
        // SAFETY: `rpc` and the strings it points to live until the call returns; the session
        // copies what it needs. It connects on first use, not here.
        let raw = unsafe {
            EvtOpenSession(
                EvtRpcLogin,
                &rpc as *const EVT_RPC_LOGIN as *const c_void,
                0,
                0,
            )
        };
        Handle::new(raw, "EvtOpenSession")
    }
}

/// The session and the open result sets, behind one lock (review 018 M1): `canceller` cancels and
/// `reconnect`/`Stream::drop` close only while holding it, so `EvtCancel` never sees a closed handle.
#[derive(Default)]
struct Active {
    session: Option<Handle>,
    streams: Vec<EVT_HANDLE>,
    stopped: bool,
}

type Shared = Arc<Mutex<Active>>;

fn lock(active: &Mutex<Active>) -> MutexGuard<'_, Active> {
    active.lock().unwrap_or_else(|p| p.into_inner())
}

/// Renders events of one session and formats their messages with cached provider metadata.
struct Renderer {
    session: EVT_HANDLE,
    cache: MetadataCache<Handle>,
}

impl Renderer {
    fn event(&mut self, event: EVT_HANDLE) -> RawEvent {
        let mut last = None;
        for _ in 0..RENDER_TRIES {
            match render(event, EvtRenderEventXml) {
                Ok(xml) => return self.formatted(event, xml),
                Err(e) => last = Some(e.code),
            }
        }
        // The bookmark already moved past it: a placeholder, so it cannot block the source.
        RawEvent {
            render_error: last,
            ..RawEvent::default()
        }
    }

    fn formatted(&mut self, event: EVT_HANDLE, xml: String) -> RawEvent {
        let session = self.session;
        let meta = provider_name(&xml).and_then(|provider| {
            self.cache
                .get(&provider, Instant::now(), || {
                    let name = wide(&provider);
                    // SAFETY: `name` is NUL-terminated; locale 0 is the user's default.
                    let raw = unsafe {
                        EvtOpenPublisherMetadata(session, name.as_ptr(), std::ptr::null(), 0, 0)
                    };
                    Handle::new(raw, "EvtOpenPublisherMetadata").ok()
                })
                .map(|h| h.0)
        });
        let (message, task) = match meta {
            Some(meta) => (
                format_message(meta, event, EvtFormatMessageEvent),
                format_message(meta, event, EvtFormatMessageTask),
            ),
            None => (None, None),
        };
        RawEvent {
            xml,
            message,
            task,
            render_error: None,
        }
    }
}

/// `EvtRender` of an event (XML) or a bookmark, into a string.
fn render(fragment: EVT_HANDLE, flags: u32) -> ApiResult<String> {
    let mut used = 0u32;
    let mut count = 0u32;
    // SAFETY: a size query with an empty buffer; the out-pointers are valid.
    let ok = unsafe {
        EvtRender(
            0,
            fragment,
            flags,
            0,
            std::ptr::null_mut(),
            &mut used,
            &mut count,
        )
    };
    if ok == 0 {
        let e = last_error("EvtRender");
        if e.code != code::INSUFFICIENT_BUFFER {
            return Err(e);
        }
    }
    let mut buffer = vec![0u8; used as usize + 2];
    // SAFETY: `buffer` holds `buffer.len()` writable bytes.
    let ok = unsafe {
        EvtRender(
            0,
            fragment,
            flags,
            buffer.len() as u32,
            buffer.as_mut_ptr() as *mut c_void,
            &mut used,
            &mut count,
        )
    };
    if ok == 0 {
        return Err(last_error("EvtRender"));
    }
    buffer.truncate(used as usize);
    Ok(from_wide_bytes(&buffer))
}

/// A message (or task name) of an event; None if the provider has none for it.
fn format_message(meta: EVT_HANDLE, event: EVT_HANDLE, flags: u32) -> Option<String> {
    let mut used = 0u32;
    // SAFETY: a size query with an empty buffer.
    let ok = unsafe {
        EvtFormatMessage(
            meta,
            event,
            0,
            0,
            std::ptr::null(),
            flags,
            0,
            std::ptr::null_mut(),
            &mut used,
        )
    };
    if ok == 0 {
        let e = last_error("EvtFormatMessage");
        if e.code != code::INSUFFICIENT_BUFFER && !message_partial(e.code) {
            // No message file, no message for this ID, or another failure: the insertion
            // strings stand in (`line.rs`).
            let _ = message_missing(e.code);
            return None;
        }
    }
    if used == 0 {
        return None;
    }
    let mut buffer = vec![0u16; used as usize];
    // SAFETY: `buffer` holds `used` writable UTF-16 units.
    let ok = unsafe {
        EvtFormatMessage(
            meta,
            event,
            0,
            0,
            std::ptr::null(),
            flags,
            used,
            buffer.as_mut_ptr(),
            &mut used,
        )
    };
    if ok == 0 && !message_partial(last_error("EvtFormatMessage").code) {
        return None;
    }
    Some(from_wide(&buffer))
}

/// A query or subscription result set.
struct Stream {
    handle: Handle,
    active: Shared,
    /// Subscriptions only: set when new events arrive.
    signal: Option<Signal>,
    timeout: u32,
    bookmark: Handle,
    moved: bool,
    renderer: Arc<Mutex<Renderer>>,
}

impl Stream {
    fn new(
        handle: Handle,
        active: &Shared,
        signal: Option<Signal>,
        bookmark: Handle,
        moved: bool,
        renderer: &Arc<Mutex<Renderer>>,
    ) -> Self {
        lock(active).streams.push(handle.0);
        let timeout = if signal.is_some() { 0 } else { QUERY_WAIT_MS };
        Self {
            handle,
            active: Arc::clone(active),
            signal,
            timeout,
            bookmark,
            moved,
            renderer: Arc::clone(renderer),
        }
    }

    /// Up to `max` event handles; empty when there are none right now. A query waits in steps of
    /// `QUERY_WAIT_MS` and gives up with `ERROR_CANCELLED` once the source stops.
    fn pull(&self, max: usize) -> ApiResult<Vec<Handle>> {
        let mut raw: Vec<EVT_HANDLE> = vec![0; max];
        let mut returned = 0u32;
        loop {
            // SAFETY: `raw` has room for `max` handles; the returned ones are owned by us.
            let ok = unsafe {
                EvtNext(
                    self.handle.0,
                    max as u32,
                    raw.as_mut_ptr(),
                    self.timeout,
                    0,
                    &mut returned,
                )
            };
            if ok != 0 {
                break;
            }
            let e = last_error("EvtNext");
            match e.code {
                code::NO_MORE_ITEMS => return Ok(Vec::new()),
                code::TIMEOUT if self.timeout != 0 => {
                    if lock(&self.active).stopped {
                        return Err(ApiError::new(code::CANCELLED, "EvtNext"));
                    }
                }
                _ => return Err(e),
            }
        }
        Ok(raw[..returned as usize]
            .iter()
            .map(|&h| Handle(h))
            .collect())
    }
}

impl EventStream for Stream {
    fn next(&mut self, max: usize, wait: Duration) -> ApiResult<Vec<RawEvent>> {
        let mut handles = self.pull(max)?;
        if handles.is_empty() {
            if let Some(signal) = self.signal.as_ref().map(|s| s.0) {
                // Reset first, then look again: an event arriving in between sets it again.
                // SAFETY: a valid event handle.
                unsafe { ResetEvent(signal) };
                handles = self.pull(max)?;
                if handles.is_empty() && !wait.is_zero() {
                    let ms = wait.as_millis().min(u128::from(u32::MAX - 1)) as u32;
                    // SAFETY: a valid event handle; the result only says whether to look again.
                    unsafe { WaitForSingleObject(signal, ms) };
                    handles = self.pull(max)?;
                }
            }
        }
        let mut renderer = self.renderer.lock().unwrap_or_else(|p| p.into_inner());
        let mut out = Vec::with_capacity(handles.len());
        for h in &handles {
            // SAFETY: both handles are valid; the bookmark follows the last event returned.
            if unsafe { EvtUpdateBookmark(self.bookmark.0, h.0) } != 0 {
                self.moved = true;
            }
            out.push(renderer.event(h.0));
        }
        Ok(out)
    }

    fn bookmark(&mut self) -> ApiResult<Option<String>> {
        if !self.moved {
            return Ok(None);
        }
        render(self.bookmark.0, EvtRenderBookmark).map(Some)
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        let raw = std::mem::replace(&mut self.handle.0, 0);
        let mut active = lock(&self.active);
        active.streams.retain(|&h| h != raw);
        if raw != 0 {
            // SAFETY: closed exactly once, while `canceller` cannot run (same lock).
            unsafe { EvtClose(raw) };
        }
    }
}

fn new_bookmark(xml: Option<&str>) -> ApiResult<Handle> {
    let text = xml.map(wide);
    let ptr = text.as_ref().map_or(std::ptr::null(), |t| t.as_ptr());
    // SAFETY: NULL or a NUL-terminated bookmark XML.
    Handle::new(unsafe { EvtCreateBookmark(ptr) }, "EvtCreateBookmark")
}

/// A connection to the event log of this computer (no session) or of a remote one.
pub struct WinLog {
    active: Shared,
    login: Option<Login>,
    renderer: Arc<Mutex<Renderer>>,
}

impl Drop for WinLog {
    /// Metadata handles first, then the session (review L5).
    fn drop(&mut self) {
        self.renderer
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .cache
            .clear();
        lock(&self.active).session = None;
    }
}

impl WinLog {
    /// `computer` empty: this computer with the caller's identity. Otherwise a remote session,
    /// with the logged-on identity when `user` is None.
    pub fn open(
        computer: &str,
        user: Option<&str>,
        domain: Option<&str>,
        password: Option<&str>,
    ) -> ApiResult<Self> {
        let (session, login) = if computer.is_empty() {
            (None, None)
        } else {
            let mut login = Login {
                server: WipedWide::new(computer),
                user: user.map(WipedWide::new),
                domain: domain.map(WipedWide::new),
                password: password.map(WipedWide::new),
            };
            (Some(login.open()?), Some(login))
        };
        let raw = session.as_ref().map_or(0, |s| s.0);
        Ok(Self {
            active: Arc::new(Mutex::new(Active {
                session,
                ..Active::default()
            })),
            login,
            renderer: Arc::new(Mutex::new(Renderer {
                session: raw,
                cache: MetadataCache::new(MAX_PROVIDERS, RETRY_MISSING),
            })),
        })
    }

    fn raw(&self) -> EVT_HANDLE {
        lock(&self.active).session.as_ref().map_or(0, |s| s.0)
    }

    fn query_handle(&self, channel: &str, query: &str, flags: u32) -> ApiResult<Handle> {
        let path = wide(channel);
        let query = wide(query);
        // SAFETY: both strings are NUL-terminated and live until the call returns.
        let raw = unsafe { EvtQuery(self.raw(), path.as_ptr(), query.as_ptr(), flags) };
        Handle::new(raw, "EvtQuery")
    }

    /// The channel paths of the computer.
    pub fn channels(&self) -> ApiResult<Vec<String>> {
        // SAFETY: a valid session (or 0 for this computer).
        let list = Handle::new(
            unsafe { EvtOpenChannelEnum(self.raw(), 0) },
            "EvtOpenChannelEnum",
        )?;
        let mut out = Vec::new();
        let mut buffer = vec![0u16; 512];
        while out.len() < MAX_CHANNELS {
            let mut used = 0u32;
            // SAFETY: `buffer` holds `buffer.len()` writable UTF-16 units.
            let ok = unsafe {
                EvtNextChannelPath(list.0, buffer.len() as u32, buffer.as_mut_ptr(), &mut used)
            };
            if ok == 0 {
                let e = last_error("EvtNextChannelPath");
                match e.code {
                    code::NO_MORE_ITEMS => break,
                    code::INSUFFICIENT_BUFFER if (used as usize) > buffer.len() => {
                        buffer.resize(used as usize, 0);
                        continue;
                    }
                    _ => return Err(e),
                }
            }
            out.push(from_wide(&buffer[..(used as usize).min(buffer.len())]));
        }
        Ok(out)
    }
}

impl EventLog for WinLog {
    fn query(&mut self, channel: &str, since_ms: Option<u64>) -> ApiResult<Box<dyn EventStream>> {
        let handle = self.query_handle(
            channel,
            &since_query(since_ms),
            EvtQueryChannelPath | EvtQueryForwardDirection,
        )?;
        let bookmark = new_bookmark(None)?;
        Ok(Box::new(Stream::new(
            handle,
            &self.active,
            None,
            bookmark,
            false,
            &self.renderer,
        )))
    }

    fn newest(&mut self, channel: &str) -> ApiResult<Option<String>> {
        let handle =
            self.query_handle(channel, "*", EvtQueryChannelPath | EvtQueryReverseDirection)?;
        let bookmark = new_bookmark(None)?;
        let stream = Stream::new(handle, &self.active, None, bookmark, false, &self.renderer);
        let Some(newest) = stream.pull(1)?.into_iter().next() else {
            return Ok(None);
        };
        // SAFETY: both handles are valid.
        if unsafe { EvtUpdateBookmark(stream.bookmark.0, newest.0) } == 0 {
            return Err(last_error("EvtUpdateBookmark"));
        }
        render(stream.bookmark.0, EvtRenderBookmark).map(Some)
    }

    fn subscribe(
        &mut self,
        channel: &str,
        bookmark: Option<&str>,
    ) -> ApiResult<(Box<dyn EventStream>, bool)> {
        // SAFETY: an unnamed manual-reset event, initially set so that the first round looks.
        let raw = unsafe { CreateEventW(std::ptr::null(), 1, 1, std::ptr::null()) };
        if raw.is_null() {
            return Err(last_error("CreateEventW"));
        }
        let signal = Signal(raw);
        let path = wide(channel);
        let query = wide("*");
        let subscribe = |mark: &Handle, flags: u32| {
            // SAFETY: strings NUL-terminated, handles valid, pull model (no callback).
            let raw = unsafe {
                EvtSubscribe(
                    self.raw(),
                    signal.0,
                    path.as_ptr(),
                    query.as_ptr(),
                    mark.0,
                    std::ptr::null(),
                    None,
                    flags,
                )
            };
            Handle::new(raw, "EvtSubscribe")
        };
        let (handle, mark, found) = match bookmark {
            Some(xml) => {
                let mark = new_bookmark(Some(xml))?;
                match subscribe(&mark, EvtSubscribeStartAfterBookmark | EvtSubscribeStrict) {
                    Ok(handle) => (handle, mark, true),
                    Err(e)
                        if e.code == code::NOT_FOUND
                            || e.code == code::EVT_QUERY_RESULT_INVALID_POSITION =>
                    {
                        // The bookmarked event is gone (cleared, overwritten): from the oldest.
                        let fresh = new_bookmark(None)?;
                        let handle = subscribe(&Handle(0), EvtSubscribeStartAtOldestRecord)?;
                        (handle, fresh, false)
                    }
                    Err(e) => return Err(e),
                }
            }
            None => {
                let handle = subscribe(&Handle(0), EvtSubscribeStartAtOldestRecord)?;
                (handle, new_bookmark(None)?, true)
            }
        };
        let moved = bookmark.is_some() && found;
        Ok((
            Box::new(Stream::new(
                handle,
                &self.active,
                Some(signal),
                mark,
                moved,
                &self.renderer,
            )),
            found,
        ))
    }

    fn reconnect(&mut self) -> ApiResult<()> {
        let Some(login) = self.login.as_mut() else {
            return Ok(());
        };
        let session = login.open()?;
        let raw = session.0;
        {
            let mut renderer = self.renderer.lock().unwrap_or_else(|p| p.into_inner());
            // The metadata handles belong to the old session.
            renderer.cache.clear();
            renderer.session = raw;
        }
        // The old session is closed while holding the lock: `canceller` never sees it closed.
        let mut active = lock(&self.active);
        let old = active.session.replace(session);
        drop(old);
        drop(active);
        Ok(())
    }

    fn canceller(&self) -> Box<dyn Fn() + Send + Sync> {
        let active = Arc::clone(&self.active);
        Box::new(move || {
            let mut a = lock(&active);
            a.stopped = true;
            for &stream in &a.streams {
                // SAFETY: open result sets (closed only under this lock).
                unsafe { EvtCancel(stream) };
            }
            if let Some(session) = a.session.as_ref() {
                // SAFETY: the open remote session (closed only under this lock).
                unsafe { EvtCancel(session.0) };
            }
        })
    }
}
