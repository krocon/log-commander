//! Windows event logs (prompt 018): a channel of this or another computer as a source of 016. The
//! events go as JSON lines (`line.rs`) into the spool, so the JSON profile, level detection, columns,
//! filters and search need no special path.
//!
//! Flow (`follow.rs`): first the events of the chosen period (`EvtQuery`, 24 h by default), then a
//! subscription after the bookmark of the last one (`EvtSubscribe`); after a broken connection it
//! continues at the bookmark, without a gap and without doubles. Rendering runs on the source's
//! thread in batches, closing the tab ends it (`EvtCancel` for a hanging remote call).
//!
//! Only `api.rs` talks to Windows and is compiled only there; everything else (configuration,
//! level table, JSON line, bookmark and reconnect logic, metadata cache, error texts) is plain Rust
//! and tested on every platform against a fake `EventLog`. On other systems `prepare` says so.
//!
//! A remote computer is opened with the logged-on Windows identity, or with user and password. The
//! password comes from the dialog for this connect or from the OS keychain (only on request, only
//! after it worked, like SFTP in 017); it is never in a configuration, workspace, log or error.

pub mod backend;
pub mod cache;
pub mod event;
mod follow;
pub mod line;

#[cfg(windows)]
pub mod api;

use self::backend::{kind, ApiError, EventLog, EventStream, Kind};
use super::{Source, SourceContext};
use crate::error::{AppError, AppResult, ErrorCode, RemoteDetail};
use crate::model::SourceKind;
use crate::remote::secrets::{scoped_account, Secret, SecretKind, SecretStore};
use crate::remote::Credentials;
use serde::{Deserialize, Serialize};

/// The backlog takes the events of the last 24 hours by default (prompt 018).
pub const DEFAULT_HOURS: u32 = 24;
/// At most ten years back; None in the configuration: everything the channel holds.
pub const MAX_HOURS: u32 = 24 * 366 * 10;
const MAX_CHANNEL: usize = 256;
const MAX_COMPUTER: usize = 253;
const MAX_USER: usize = 256;
/// Keychain accounts of this source: `winevent:password:<hash of user@computer>`.
const KEYCHAIN_SCOPE: &str = "winevent";

fn default_hours() -> Option<u32> {
    Some(DEFAULT_HOURS)
}

fn default_true() -> bool {
    true
}

/// How a remote computer is logged on to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WinAuth {
    /// The logged-on Windows identity (Kerberos/NTLM through Negotiate).
    #[default]
    Current,
    /// User and password (dialog or keychain).
    Password,
}

/// Where the events come from: this computer (`computer` empty) or another one.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WinTarget {
    #[serde(default)]
    pub computer: String,
    #[serde(default)]
    pub auth: WinAuth,
    /// `DOMAIN\user`, `user@domain` or `user` (auth `password`).
    #[serde(default)]
    pub user: String,
}

/// What the dialog configures (and settings or a workspace keep): never a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WinEventConfig {
    /// `Application`, `System`, `Security`, `Microsoft-Windows-PowerShell/Operational` …
    pub channel: String,
    #[serde(default)]
    pub computer: String,
    #[serde(default)]
    pub auth: WinAuth,
    #[serde(default)]
    pub user: String,
    /// The backlog reaches this many hours back; None: everything.
    #[serde(default = "default_hours")]
    pub hours: Option<u32>,
    /// Attach the whole event XML (field `xml`, for the detail panel); off saves space.
    #[serde(default = "default_true")]
    pub xml: bool,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidSource, message)
}

fn plain(text: &str) -> bool {
    !text.chars().any(char::is_control)
}

impl WinTarget {
    pub fn is_remote(&self) -> bool {
        !self.computer.trim().is_empty()
    }

    /// `\\srv01` and `srv01` are the same computer.
    pub fn computer(&self) -> &str {
        self.computer.trim().trim_start_matches('\\')
    }

    pub fn validate(&self) -> AppResult<()> {
        let computer = self.computer();
        if computer.len() > MAX_COMPUTER
            || computer.starts_with(['-', '.'])
            || !computer
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'))
        {
            return Err(invalid(format!("kein Rechnername: {computer}")));
        }
        let user = self.user.trim();
        if user.len() > MAX_USER
            || !plain(user)
            || user.contains([
                '"', '/', '[', ']', ':', ';', '|', '=', ',', '+', '*', '?', '<', '>',
            ])
            || user.matches('\\').count() > 1
        {
            return Err(invalid("kein Benutzername"));
        }
        match self.auth {
            WinAuth::Password if !self.is_remote() => Err(invalid(
                "dieser Rechner wird immer mit der angemeldeten Identität gelesen",
            )),
            WinAuth::Password if user.is_empty() => Err(invalid("Benutzer fehlt")),
            _ => Ok(()),
        }
    }

    /// The keychain subject: `user@computer`, both in lower case.
    pub fn account(&self) -> String {
        scoped_account(
            KEYCHAIN_SCOPE,
            SecretKind::Password,
            &format!(
                "{}@{}",
                self.user.trim().to_lowercase(),
                self.computer().to_lowercase()
            ),
        )
    }

    /// `DOMAIN\user` → (`Some(DOMAIN)`, `user`); `user@domain` and `user` stay whole.
    pub fn user_and_domain(&self) -> (Option<&str>, &str) {
        let user = self.user.trim();
        match user.split_once('\\') {
            Some((domain, name)) if !domain.is_empty() => (Some(domain), name),
            Some((_, name)) => (None, name),
            None => (None, user),
        }
    }
}

impl WinEventConfig {
    pub fn target(&self) -> WinTarget {
        WinTarget {
            computer: self.computer.clone(),
            auth: self.auth,
            user: self.user.clone(),
        }
    }

    pub fn validate(&self) -> AppResult<()> {
        self.target().validate()?;
        let channel = self.channel.trim();
        if channel.is_empty()
            || channel.len() > MAX_CHANNEL
            || channel != self.channel
            || !plain(channel)
        {
            return Err(invalid("kein Kanal gewählt"));
        }
        if self.hours.is_some_and(|h| h == 0 || h > MAX_HOURS) {
            return Err(invalid(format!(
                "Zeitraum 1–{MAX_HOURS} Stunden oder alles"
            )));
        }
        Ok(())
    }

    /// `Ereignisse: System`, `Ereignisse srv01: System`.
    pub fn label(&self) -> String {
        let target = self.target();
        if target.is_remote() {
            format!("Ereignisse {}: {}", target.computer(), self.channel)
        } else {
            format!("Ereignisse: {}", self.channel)
        }
    }

    /// The backlog's reach in milliseconds.
    pub fn since_ms(&self) -> Option<u64> {
        self.hours.map(|h| u64::from(h) * 3_600_000)
    }
}

/// An API error in words for the dialog and the status bar (German like the rest of the UI; the
/// hint for Security is part of the message). Never holds the password.
pub fn app_error(e: ApiError, target: &WinTarget, channel: Option<&str>) -> AppError {
    let on = if target.is_remote() {
        format!(" auf {}", target.computer())
    } else {
        String::new()
    };
    let what = channel.map_or_else(
        || "die Ereignisprotokolle".to_string(),
        |c| format!("„{c}“"),
    );
    let mut error = match kind(e.code) {
        // On another computer it is the login or the group there (review 018 M3).
        Kind::AccessDenied if target.is_remote() => AppError::new(
            ErrorCode::PermissionDenied,
            format!(
                "Kein Zugriff auf {what}{on}: Anmeldedaten falsch, oder das Konto ist dort weder in der \
                 Gruppe „Ereignisprotokollleser“ (Event Log Readers) noch Administrator."
            ),
        ),
        Kind::AccessDenied => AppError::new(
            ErrorCode::PermissionDenied,
            format!(
                "Kein Zugriff auf {what}{on}. „Security“ braucht Administratorrechte oder die Gruppe \
                 „Ereignisprotokollleser“ (Event Log Readers); die App fordert keine Rechteerhöhung an."
            ),
        ),
        Kind::ChannelNotFound => AppError::new(
            ErrorCode::NotFound,
            format!("Den Kanal {what} gibt es{on} nicht"),
        ),
        Kind::AuthFailed if target.auth == WinAuth::Password => {
            AppError::new(
                ErrorCode::SecretRequired,
                format!("Anmeldung{on} abgelehnt (Fehler {})", e.code),
            )
            .with_remote(RemoteDetail {
                secret: Some(SecretKind::Password),
                wrong: true,
                ..RemoteDetail::default()
            })
        }
        Kind::AuthFailed => AppError::new(
            ErrorCode::AuthFailed,
            format!("Anmeldung{on} mit der angemeldeten Identität abgelehnt (Fehler {})", e.code),
        ),
        Kind::Connection if target.is_remote() => AppError::new(
            ErrorCode::ConnectionFailed,
            format!(
                "{} nicht erreichbar (Fehler {}). Dort muss die Firewall-Regel \
                 „Remoteereignisprotokollverwaltung“ freigegeben sein.",
                target.computer(),
                e.code
            ),
        ),
        Kind::Connection => AppError::new(
            ErrorCode::ConnectionFailed,
            format!("Der Dienst Windows-Ereignisprotokoll antwortet nicht (Fehler {})", e.code),
        ),
        _ => AppError::new(
            ErrorCode::Io,
            format!("{} fehlgeschlagen (Fehler {})", e.call, e.code),
        ),
    };
    error.path = channel.map(str::to_string);
    error
}

fn secret_required(target: &WinTarget) -> AppError {
    AppError::new(
        ErrorCode::SecretRequired,
        format!(
            "Passwort für {} auf {} nötig",
            target.user.trim(),
            target.computer()
        ),
    )
    .with_remote(RemoteDetail {
        secret: Some(SecretKind::Password),
        wrong: false,
        ..RemoteDetail::default()
    })
}

/// The password for a target: none for the logged-on identity, else typed (true) or from the
/// keychain (false). Missing: `secret_required` for the dialog.
fn password(
    target: &WinTarget,
    creds: &Credentials,
    store: Option<&dyn SecretStore>,
) -> AppResult<Option<(Secret, bool)>> {
    if target.auth == WinAuth::Current {
        return Ok(None);
    }
    if let Some(secret) = creds.secret.as_ref().filter(|s| !s.is_empty()) {
        return Ok(Some((secret.clone(), true)));
    }
    if let Some(store) = store.filter(|s| s.available()) {
        if let Ok(Some(secret)) = store.get(&target.account()) {
            return Ok(Some((secret, false)));
        }
    }
    Err(secret_required(target))
}

/// Opens an event log connection (the Windows API, or a fake in tests); the password only for
/// this call, it is not kept by the caller.
pub type Opener<'a> =
    dyn Fn(&WinTarget, Option<&Secret>) -> backend::ApiResult<Box<dyn EventLog>> + 'a;

/// After the first call worked: a typed password goes into the keychain if the user asked for it.
fn remember(
    target: &WinTarget,
    secret: &Option<(Secret, bool)>,
    creds: &Credentials,
    store: Option<&dyn SecretStore>,
) {
    if let (Some((secret, true)), true, Some(store)) = (secret, creds.remember, store) {
        if let Err(e) = store.set(&target.account(), secret) {
            eprintln!("keychain: {}", e.0);
        }
    }
}

/// The source, prepared: connected, the backlog query running (so that a missing right or a wrong
/// password shows in the dialog), then run on its own thread.
pub struct WinEventSource {
    config: WinEventConfig,
    log: Box<dyn EventLog>,
    backlog: Option<Box<dyn EventStream>>,
}

impl std::fmt::Debug for WinEventSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WinEventSource")
            .field("config", &self.config)
            .finish()
    }
}

impl WinEventSource {
    /// Checks the configuration, finds the password, connects and starts the backlog query.
    pub fn open_with(
        config: WinEventConfig,
        creds: &Credentials,
        store: Option<&dyn SecretStore>,
        opener: &Opener,
    ) -> AppResult<Self> {
        config.validate()?;
        let target = config.target();
        let secret = password(&target, creds, store)?;
        let fail = |e: ApiError| app_error(e, &target, Some(&config.channel));
        let mut log = opener(&target, secret.as_ref().map(|(s, _)| s)).map_err(fail)?;
        let backlog = log
            .query(&config.channel, config.since_ms())
            .map_err(fail)?;
        remember(&target, &secret, creds, store);
        Ok(Self {
            config,
            log,
            backlog: Some(backlog),
        })
    }
}

impl Source for WinEventSource {
    fn kind(&self) -> SourceKind {
        SourceKind::Winevent
    }

    fn label(&self) -> String {
        self.config.label()
    }

    fn config(&self) -> serde_json::Value {
        let mut v = serde_json::to_value(&self.config).unwrap_or_default();
        if let Some(o) = v.as_object_mut() {
            o.insert("kind".into(), "winevent".into());
        }
        v
    }

    fn profile(&self) -> Option<&'static str> {
        Some(crate::profile::WINEVENT_PROFILE)
    }

    fn run(self: Box<Self>, ctx: SourceContext) {
        let s = *self;
        follow::run(
            s.log,
            s.backlog,
            follow::Options {
                target: s.config.target(),
                channel: s.config.channel.clone(),
                since_ms: s.config.since_ms(),
                xml: s.config.xml,
            },
            ctx,
        );
    }
}

/// The opener of this platform: the Windows API, elsewhere a clear error.
#[cfg(windows)]
fn system_opener(
    target: &WinTarget,
    secret: Option<&Secret>,
) -> backend::ApiResult<Box<dyn EventLog>> {
    let (domain, user) = target.user_and_domain();
    let log = api::WinLog::open(
        target.computer(),
        if target.auth == WinAuth::Password {
            Some(user)
        } else {
            None
        },
        domain.filter(|_| target.auth == WinAuth::Password),
        secret.map(Secret::expose),
    )?;
    Ok(Box::new(log))
}

#[cfg_attr(windows, allow(dead_code))]
fn not_here() -> AppError {
    AppError::new(
        ErrorCode::Unsupported,
        "Windows-Ereignisprotokolle gibt es nur unter Windows",
    )
}

/// Windows event logs can be read on this system.
pub const SUPPORTED: bool = cfg!(windows);

/// Prepares a source from the dialog's configuration.
pub fn prepare(
    config: WinEventConfig,
    creds: &Credentials,
    store: Option<&dyn SecretStore>,
) -> AppResult<WinEventSource> {
    #[cfg(windows)]
    {
        WinEventSource::open_with(config, creds, store, &system_opener)
    }
    #[cfg(not(windows))]
    {
        let _ = (config, creds, store);
        Err(not_here())
    }
}

/// The channels of a computer for the dialog (`EvtOpenChannelEnum`), sorted, the usual ones first.
pub fn channels(
    target: &WinTarget,
    creds: &Credentials,
    store: Option<&dyn SecretStore>,
) -> AppResult<Vec<String>> {
    target.validate()?;
    #[cfg(windows)]
    {
        let secret = password(target, creds, store)?;
        let (domain, user) = target.user_and_domain();
        let fail = |e: ApiError| app_error(e, target, None);
        let log = api::WinLog::open(
            target.computer(),
            if target.auth == WinAuth::Password {
                Some(user)
            } else {
                None
            },
            domain.filter(|_| target.auth == WinAuth::Password),
            secret.as_ref().map(|(s, _)| s.expose()),
        )
        .map_err(fail)?;
        let list = log.channels().map_err(fail)?;
        remember(target, &secret, creds, store);
        Ok(sort_channels(list))
    }
    #[cfg(not(windows))]
    {
        let _ = (creds, store);
        Err(not_here())
    }
}

/// The classic logs first (Application, System, Security, Setup, ForwardedEvents), then the rest
/// alphabetically without duplicates.
pub fn sort_channels(mut list: Vec<String>) -> Vec<String> {
    const FIRST: [&str; 5] = [
        "Application",
        "System",
        "Security",
        "Setup",
        "ForwardedEvents",
    ];
    let rank = |c: &str| {
        FIRST
            .iter()
            .position(|f| f.eq_ignore_ascii_case(c))
            .unwrap_or(FIRST.len())
    };
    list.retain(|c| !c.is_empty() && c.len() <= MAX_CHANNEL && plain(c));
    list.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.to_lowercase().cmp(&b.to_lowercase()))
    });
    list.dedup();
    list
}

/// Removes the stored password of a target from the keychain.
pub fn forget(target: &WinTarget, store: &dyn SecretStore) -> AppResult<()> {
    store
        .delete(&target.account())
        .map_err(|e| AppError::new(ErrorCode::Io, format!("Schlüsselbund: {}", e.0)))
}

#[cfg(test)]
pub(crate) mod fake;

#[cfg(test)]
mod tests {
    use super::fake::FakeLog;
    use super::*;
    use crate::remote::secrets::MemoryStore;

    fn config() -> WinEventConfig {
        WinEventConfig {
            channel: "Application".into(),
            computer: String::new(),
            auth: WinAuth::Current,
            user: String::new(),
            hours: Some(24),
            xml: true,
        }
    }

    fn remote() -> WinEventConfig {
        WinEventConfig {
            computer: "srv01.corp.example".into(),
            auth: WinAuth::Password,
            user: "CORP\\ops".into(),
            ..config()
        }
    }

    #[test]
    fn configs_are_checked() {
        assert!(config().validate().is_ok());
        assert!(remote().validate().is_ok());
        assert_eq!(config().label(), "Ereignisse: Application");
        assert_eq!(
            remote().label(),
            "Ereignisse srv01.corp.example: Application"
        );
        let bad = |f: fn(&mut WinEventConfig)| {
            let mut c = remote();
            f(&mut c);
            c.validate().is_err()
        };
        assert!(bad(|c| c.channel = String::new()));
        assert!(bad(|c| c.channel = " System".into()));
        assert!(bad(|c| c.channel = "Sys\ntem".into()));
        assert!(bad(|c| c.channel = "x".repeat(300)));
        assert!(bad(|c| c.computer = "srv 01".into()));
        assert!(bad(|c| c.computer = "-oX".into()));
        assert!(bad(|c| c.computer = "srv/01".into()));
        assert!(bad(|c| c.user = String::new()));
        assert!(bad(|c| c.user = "a\\b\\c".into()));
        assert!(bad(|c| c.user = "a\"b".into()));
        assert!(bad(|c| c.hours = Some(0)));
        assert!(bad(|c| c.hours = Some(MAX_HOURS + 1)));
        // This computer: always the logged-on identity.
        let mut local = remote();
        local.computer = String::new();
        assert!(local.validate().is_err());
        // `\\srv01` is `srv01`; IPv6 and names with dots are fine.
        let mut c = remote();
        c.computer = "\\\\srv01".into();
        assert!(c.validate().is_ok());
        assert_eq!(c.target().computer(), "srv01");
        c.computer = "fe80::1".into();
        assert!(c.validate().is_ok());
        // Defaults for what a stored configuration may leave out; no field for a secret.
        let parsed: WinEventConfig = serde_json::from_str(r#"{"channel":"System"}"#).unwrap();
        assert_eq!(parsed.hours, Some(DEFAULT_HOURS));
        assert!(parsed.xml);
        assert_eq!(parsed.auth, WinAuth::Current);
        let all: WinEventConfig =
            serde_json::from_str(r#"{"channel":"System","hours":null,"password":"x"}"#).unwrap();
        assert_eq!(all.since_ms(), None);
        let v = serde_json::to_value(remote()).unwrap();
        assert!(v.get("password").is_none() && v.get("secret").is_none());
        assert_eq!(config().since_ms(), Some(86_400_000));
    }

    #[test]
    fn users_domains_and_keychain_accounts() {
        let t = remote().target();
        assert_eq!(t.user_and_domain(), (Some("CORP"), "ops"));
        let upn = WinTarget {
            user: "ops@corp.example".into(),
            ..t.clone()
        };
        assert_eq!(upn.user_and_domain(), (None, "ops@corp.example"));
        let a = t.account();
        assert!(a.starts_with("winevent:password:"), "{a}");
        assert!(!a.contains("ops") && !a.contains("srv01"));
        // Case and the leading backslashes do not matter, the scope does.
        let same = WinTarget {
            computer: "\\\\SRV01.corp.example".into(),
            user: "corp\\OPS".into(),
            ..t.clone()
        };
        assert_eq!(same.account(), a);
        assert_ne!(
            a,
            crate::remote::secrets::account(SecretKind::Password, "corp\\ops@srv01.corp.example")
        );
    }

    #[test]
    fn errors_say_what_to_do() {
        let local = config().target();
        let e = app_error(ApiError::new(5, "EvtQuery"), &local, Some("Security"));
        assert_eq!(e.code, ErrorCode::PermissionDenied);
        assert!(e.message.contains("Event Log Readers"), "{}", e.message);
        assert!(e.message.contains("Administratorrechte"));
        assert_eq!(e.path.as_deref(), Some("Security"));
        let e = app_error(ApiError::new(15007, "EvtQuery"), &local, Some("Foo"));
        assert_eq!(e.code, ErrorCode::NotFound);
        let r = remote().target();
        let e = app_error(ApiError::new(1326, "EvtQuery"), &r, Some("System"));
        assert_eq!(e.code, ErrorCode::SecretRequired);
        assert!(e.remote.as_ref().unwrap().wrong);
        let current = WinTarget {
            auth: WinAuth::Current,
            ..r.clone()
        };
        assert_eq!(
            app_error(ApiError::new(1326, "EvtQuery"), &current, None).code,
            ErrorCode::AuthFailed
        );
        let e = app_error(ApiError::new(5, "EvtQuery"), &r, Some("System"));
        assert_eq!(e.code, ErrorCode::PermissionDenied);
        assert!(e.message.contains("auf srv01.corp.example") && e.message.contains("Anmeldedaten"));
        assert!(!e.message.contains("Rechteerhöhung"), "{}", e.message);
        let e = app_error(ApiError::new(1722, "EvtQuery"), &r, None);
        assert_eq!(e.code, ErrorCode::ConnectionFailed);
        assert!(e.message.contains("Remoteereignisprotokollverwaltung"));
        assert_eq!(
            app_error(ApiError::new(31, "EvtRender"), &local, None).code,
            ErrorCode::Io
        );
    }

    #[test]
    fn passwords_are_asked_for_and_kept_only_on_request() {
        let store = MemoryStore::default();
        let ok = FakeLog::opener(FakeLog::default(), "pässwört 🔑");
        // No password: asked for, nothing connected.
        let e = WinEventSource::open_with(remote(), &Credentials::default(), Some(&store), &ok)
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::SecretRequired);
        assert!(!e.remote.unwrap().wrong);
        // A wrong one: refused, never stored, even when asked to.
        let wrong = Credentials {
            secret: Some(Secret::new("falsch")),
            remember: true,
            trust_fingerprint: None,
        };
        let e = WinEventSource::open_with(remote(), &wrong, Some(&store), &ok).unwrap_err();
        assert_eq!(e.code, ErrorCode::SecretRequired);
        assert!(e.remote.as_ref().unwrap().wrong);
        assert!(!e.message.contains("falsch"));
        assert!(store.is_empty());
        // The right one without the tick: works, not stored.
        let right = Credentials {
            secret: Some(Secret::new("pässwört 🔑")),
            remember: false,
            trust_fingerprint: None,
        };
        assert!(WinEventSource::open_with(remote(), &right, Some(&store), &ok).is_ok());
        assert!(store.is_empty());
        // With the tick: stored after it worked, and found the next time.
        let keep = Credentials {
            remember: true,
            ..right
        };
        let source = WinEventSource::open_with(remote(), &keep, Some(&store), &ok).unwrap();
        assert_eq!(store.len(), 1);
        assert!(!format!("{source:?}").contains("pässwört"));
        assert!(
            WinEventSource::open_with(remote(), &Credentials::default(), Some(&store), &ok).is_ok()
        );
        forget(&remote().target(), &store).unwrap();
        assert!(store.is_empty());
        // The logged-on identity needs no password and never touches the keychain.
        assert!(WinEventSource::open_with(config(), &Credentials::default(), None, &ok).is_ok());
    }

    #[test]
    fn a_missing_right_shows_in_the_dialog() {
        let denied = FakeLog {
            query_error: Some(5),
            ..FakeLog::default()
        };
        let opener = FakeLog::opener(denied, "");
        let mut c = config();
        c.channel = "Security".into();
        let e = WinEventSource::open_with(c, &Credentials::default(), None, &opener).unwrap_err();
        assert_eq!(e.code, ErrorCode::PermissionDenied);
        assert!(e.message.contains("Ereignisprotokollleser"));
    }

    #[test]
    fn channels_are_sorted_with_the_usual_ones_first() {
        let list = sort_channels(vec![
            "Microsoft-Windows-PowerShell/Operational".into(),
            "system".into(),
            "Security".into(),
            "Application".into(),
            "HardwareEvents".into(),
            "".into(),
            "bad\nname".into(),
            "Application".into(),
        ]);
        assert_eq!(
            list,
            [
                "Application",
                "system",
                "Security",
                "HardwareEvents",
                "Microsoft-Windows-PowerShell/Operational"
            ]
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn elsewhere_it_says_windows_only() {
        const { assert!(!SUPPORTED) };
        let e = prepare(config(), &Credentials::default(), None).unwrap_err();
        assert_eq!(e.code, ErrorCode::Unsupported);
        assert!(e.message.contains("nur unter Windows"));
        let e = channels(&config().target(), &Credentials::default(), None).unwrap_err();
        assert_eq!(e.code, ErrorCode::Unsupported);
        // Its profile is not offered for choice here, and never guessed for a JSON file.
        let manager = crate::session::SessionManager::default();
        assert!(manager
            .profiles()
            .iter()
            .all(|p| p.id != crate::profile::WINEVENT_PROFILE));
        let json =
            "{\"timestamp\":\"2026-01-01T00:00:00Z\",\"level\":\"info\",\"message\":\"x\"}\n";
        assert_eq!(
            crate::profile::suggest_profile(json.lines().map(str::as_bytes)),
            "jsonl"
        );
    }
}
