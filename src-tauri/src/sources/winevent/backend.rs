//! What the source needs from the event log (prompt 018), as a trait: implemented over the Windows
//! API in `api.rs` (only on Windows) and by a fake in the tests, so that the flow (backlog, live,
//! bookmark, reconnect, stop) runs and is tested on every platform. Plain Rust without crate types,
//! so `api.rs` also compiles in the small Windows check crate.

use std::time::Duration;

/// A Win32 error code (`GetLastError`) and the call it came from. Never holds a secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApiError {
    pub code: u32,
    pub call: &'static str,
}

impl ApiError {
    pub fn new(code: u32, call: &'static str) -> Self {
        Self { code, call }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

/// Win32 codes the source tells apart (winerror.h).
pub mod code {
    pub const FILE_NOT_FOUND: u32 = 2;
    pub const ACCESS_DENIED: u32 = 5;
    pub const INVALID_HANDLE: u32 = 6;
    pub const BAD_NETPATH: u32 = 53;
    pub const INVALID_PARAMETER: u32 = 87;
    pub const INSUFFICIENT_BUFFER: u32 = 122;
    pub const NO_MORE_ITEMS: u32 = 259;
    pub const NOT_FOUND: u32 = 1168;
    pub const CANCELLED: u32 = 1223;
    pub const CONNECTION_REFUSED: u32 = 1225;
    pub const LOGON_FAILURE: u32 = 1326;
    pub const ACCOUNT_RESTRICTION: u32 = 1327;
    pub const ACCOUNT_DISABLED: u32 = 1331;
    pub const PASSWORD_EXPIRED: u32 = 1330;
    pub const LOGON_TYPE_NOT_GRANTED: u32 = 1385;
    pub const ACCOUNT_EXPIRED: u32 = 1793;
    pub const PASSWORD_MUST_CHANGE: u32 = 1907;
    pub const RPC_SEC_PKG_ERROR: u32 = 1825;
    pub const TIMEOUT: u32 = 1460;
    pub const RPC_SERVER_UNAVAILABLE: u32 = 1722;
    pub const RPC_CALL_FAILED: u32 = 1726;
    pub const RPC_CALL_FAILED_DNE: u32 = 1727;
    pub const RPC_NO_ENDPOINT: u32 = 1753;
    pub const ACCOUNT_LOCKED_OUT: u32 = 1909;
    pub const EVT_INVALID_CHANNEL_PATH: u32 = 15000;
    pub const EVT_INVALID_QUERY: u32 = 15001;
    pub const EVT_PUBLISHER_METADATA_NOT_FOUND: u32 = 15002;
    pub const EVT_CHANNEL_NOT_FOUND: u32 = 15007;
    pub const EVT_QUERY_RESULT_STALE: u32 = 15011;
    pub const EVT_QUERY_RESULT_INVALID_POSITION: u32 = 15012;
    pub const EVT_MESSAGE_NOT_FOUND: u32 = 15027;
    pub const EVT_MESSAGE_ID_NOT_FOUND: u32 = 15028;
    pub const EVT_UNRESOLVED_VALUE_INSERT: u32 = 15029;
    pub const EVT_UNRESOLVED_PARAMETER_INSERT: u32 = 15030;
    pub const EVT_MAX_INSERTS_REACHED: u32 = 15031;
    pub const EVT_MESSAGE_LOCALE_NOT_FOUND: u32 = 15033;
}

/// What an error means for the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// No right to read the channel (Security without admin rights or Event Log Readers).
    AccessDenied,
    /// The channel does not exist (on that computer).
    ChannelNotFound,
    /// The remote computer refused the login (wrong password, locked, disabled, expired).
    AuthFailed,
    /// The remote computer cannot be reached or the connection broke: try again.
    Connection,
    /// The result is no longer valid (log cleared or overwritten meanwhile): subscribe again.
    Stale,
    /// Stopped from outside (`EvtCancel` when the tab closes).
    Cancelled,
    /// Anything else; tried again a few times like a broken connection.
    Other,
}

pub fn kind(code: u32) -> Kind {
    use code::*;
    match code {
        ACCESS_DENIED => Kind::AccessDenied,
        EVT_CHANNEL_NOT_FOUND | EVT_INVALID_CHANNEL_PATH | FILE_NOT_FOUND => Kind::ChannelNotFound,
        LOGON_FAILURE
        | ACCOUNT_RESTRICTION
        | ACCOUNT_DISABLED
        | PASSWORD_EXPIRED
        | ACCOUNT_LOCKED_OUT
        | LOGON_TYPE_NOT_GRANTED
        | ACCOUNT_EXPIRED
        | PASSWORD_MUST_CHANGE
        | RPC_SEC_PKG_ERROR => Kind::AuthFailed,
        BAD_NETPATH
        | CONNECTION_REFUSED
        | TIMEOUT
        | RPC_SERVER_UNAVAILABLE
        | RPC_CALL_FAILED
        | RPC_CALL_FAILED_DNE
        | RPC_NO_ENDPOINT
        | INVALID_HANDLE => Kind::Connection,
        EVT_QUERY_RESULT_STALE | EVT_QUERY_RESULT_INVALID_POSITION => Kind::Stale,
        CANCELLED => Kind::Cancelled,
        _ => Kind::Other,
    }
}

/// Retrying cannot help (or would lock an account): the source stops with an error.
pub fn permanent(code: u32) -> bool {
    matches!(
        kind(code),
        Kind::AccessDenied | Kind::ChannelNotFound | Kind::AuthFailed
    ) || code == code::EVT_INVALID_QUERY
}

/// `EvtFormatMessage` failed because the provider has no (readable) message for this event: the
/// spool line carries the insertion strings instead.
pub fn message_missing(code: u32) -> bool {
    use code::*;
    matches!(
        code,
        FILE_NOT_FOUND
            | EVT_PUBLISHER_METADATA_NOT_FOUND
            | EVT_MESSAGE_NOT_FOUND
            | EVT_MESSAGE_ID_NOT_FOUND
            | EVT_MESSAGE_LOCALE_NOT_FOUND
    )
}

/// `EvtFormatMessage` wrote the message but could not fill every insert: the text is still usable.
pub fn message_partial(code: u32) -> bool {
    use code::*;
    matches!(
        code,
        EVT_UNRESOLVED_VALUE_INSERT | EVT_UNRESOLVED_PARAMETER_INSERT | EVT_MAX_INSERTS_REACHED
    )
}

/// One event as rendered by the system.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RawEvent {
    /// `EvtRender(EvtRenderEventXml)`.
    pub xml: String,
    /// `EvtFormatMessage(EvtFormatMessageEvent)`; None: the provider has no message for it.
    pub message: Option<String>,
    /// The display name of the task (`EvtFormatMessageTask`), if the provider has one.
    pub task: Option<String>,
    /// `EvtRender` failed even after retries (Win32 code): a placeholder line stands in, the
    /// bookmark has already moved past the event (review 018 L7).
    pub render_error: Option<u32>,
}

/// A query or a subscription.
pub trait EventStream: Send {
    /// Up to `max` events, oldest first. Empty: nothing more right now; a subscription waits up to
    /// `wait` for new ones first, a query returns at once.
    fn next(&mut self, max: usize, wait: Duration) -> ApiResult<Vec<RawEvent>>;
    /// The position after the last event returned (bookmark XML), None before the first.
    fn bookmark(&mut self) -> ApiResult<Option<String>>;
}

/// One connection to an event log: this computer or a remote one (`EvtOpenSession`).
pub trait EventLog: Send {
    /// Events of `channel` that are at most `since_ms` old (None: all), oldest first.
    fn query(&mut self, channel: &str, since_ms: Option<u64>) -> ApiResult<Box<dyn EventStream>>;
    /// The bookmark of the newest event, None for an empty channel.
    fn newest(&mut self, channel: &str) -> ApiResult<Option<String>>;
    /// New events after `bookmark` (None: from the oldest, for a channel that was empty). The flag
    /// says whether the bookmarked event still exists; if not (log cleared or overwritten) the
    /// subscription starts at the oldest event and there may be a gap.
    fn subscribe(
        &mut self,
        channel: &str,
        bookmark: Option<&str>,
    ) -> ApiResult<(Box<dyn EventStream>, bool)>;
    /// A new session after a broken connection (remote); local: nothing to do.
    fn reconnect(&mut self) -> ApiResult<()>;
    /// Ends blocking calls from another thread (the tab closes while a remote call hangs).
    fn canceller(&self) -> Box<dyn Fn() + Send + Sync>;
}

/// XPath of the backlog: events of the last `ms` milliseconds; None: all.
pub fn since_query(ms: Option<u64>) -> String {
    match ms {
        Some(ms) => format!("*[System[TimeCreated[timediff(@SystemTime) <= {ms}]]]"),
        None => "*".into(),
    }
}

/// Windows API strings are UTF-16 with a terminating 0.
/// Allocated once at its final size, so no reallocation leaves a copy behind (a password is
/// built with it and wiped by its owner, review 018 L6).
pub fn wide(text: &str) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.encode_utf16().count() + 1);
    out.extend(text.encode_utf16());
    out.push(0);
    out
}

/// A UTF-16 buffer up to its first 0 (or its end); broken surrogates become U+FFFD.
pub fn from_wide(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

/// `EvtRender` writes XML as UTF-16 into a byte buffer.
pub fn from_wide_bytes(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|p| u16::from_le_bytes(*p))
        .collect();
    from_wide(&units)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_are_told_apart() {
        assert_eq!(kind(5), Kind::AccessDenied);
        assert_eq!(kind(15007), Kind::ChannelNotFound);
        assert_eq!(kind(1326), Kind::AuthFailed);
        for logon in [1326, 1327, 1330, 1331, 1385, 1793, 1825, 1907, 1909] {
            assert_eq!(kind(logon), Kind::AuthFailed, "{logon}");
            assert!(permanent(logon), "{logon}");
        }
        assert_eq!(kind(1722), Kind::Connection);
        assert_eq!(kind(15011), Kind::Stale);
        assert_eq!(kind(1223), Kind::Cancelled);
        assert_eq!(kind(31), Kind::Other);
        assert!(permanent(5) && permanent(15007) && permanent(1326) && permanent(15001));
        assert!(!permanent(1722) && !permanent(15011) && !permanent(31));
        assert!(message_missing(15027) && message_missing(15002) && !message_missing(5));
        assert!(message_partial(15029) && !message_partial(15027));
    }

    #[test]
    fn queries_and_strings() {
        assert_eq!(
            since_query(Some(86_400_000)),
            "*[System[TimeCreated[timediff(@SystemTime) <= 86400000]]]"
        );
        assert_eq!(since_query(None), "*");
        let w = wide("Größe 😀");
        assert_eq!(*w.last().unwrap(), 0);
        assert_eq!(w.capacity(), w.len(), "allocated once at its size");
        assert_eq!(from_wide(&w), "Größe 😀");
        assert_eq!(from_wide(&[0x41, 0xD800, 0x42]), "A\u{FFFD}B");
        let bytes: Vec<u8> = w.iter().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(from_wide_bytes(&bytes), "Größe 😀");
        assert_eq!(from_wide_bytes(&[0x41]), "");
    }
}
