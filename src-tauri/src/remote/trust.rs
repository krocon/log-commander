//! Host keys (prompt 017), after files-and-folders-tauri (design 034 E5, review 034 #3), with a
//! known_hosts parser of our own (security review 017 M1: russh's parser misses tabs, markers, patterns,
//! case and makes a file with one odd line unreadable, which would turn a changed key into "unknown").
//!
//! Checked against `~/.ssh/known_hosts` (read only: servers the user already trusts in a terminal) and
//! the app's own `known_hosts` (same parser). A key the user confirmed goes into the app's file only.
//!
//! Decision for `host:port` and the presented key:
//! 1. an `@revoked` line (host pattern matching) with this key → **Revoked**, hard refusal;
//! 2. a usable line for the host with this key → **Known**;
//! 3. anything else recorded for the host (another key or type, a line whose key cannot be read, an
//!    `@cert-authority` line, an unknown marker) or a file that cannot be read → **Changed**, hard
//!    refusal with the reason;
//! 4. nothing at all → **Unknown** (the dialog asks to confirm the fingerprint).
//!
//! Format as OpenSSH: fields split on any whitespace, `#` comments, host lists with commas, patterns
//! `*`/`?` and negation `!`, `[host]:port` for ports other than 22, hashed hosts `|1|salt|hash`
//! (HMAC-SHA1), host names compared in lower case, markers `@revoked` and `@cert-authority`.

use data_encoding::BASE64;
use hmac::{Hmac, KeyInit, Mac};
use russh::keys::PublicKey;
use std::io;
use std::path::{Path, PathBuf};

/// Larger known_hosts files are not read (and count as unreadable: refused, not "unknown").
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// Why a host key is refused although something is recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeReason {
    /// Another key (or key type) is recorded for the host.
    OtherKey,
    /// A line for the host whose key cannot be read.
    Unusable,
    /// An `@cert-authority` line for the host (host certificates are not supported).
    CertAuthority,
    /// A line for the host with a marker this app does not know.
    UnknownMarker,
    /// The known_hosts file cannot be read (or is too large).
    Unreadable,
}

impl ChangeReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeReason::OtherKey => "other_key",
            ChangeReason::Unusable => "unusable",
            ChangeReason::CertAuthority => "cert_authority",
            ChangeReason::UnknownMarker => "unknown_marker",
            ChangeReason::Unreadable => "unreadable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyCheck {
    Known,
    Unknown,
    /// Something else is recorded for this host in `file`, line `line` (1-based; 0: the file).
    Changed {
        file: PathBuf,
        line: usize,
        reason: ChangeReason,
    },
    /// The key is marked `@revoked` in `file`, line `line`.
    Revoked {
        file: PathBuf,
        line: usize,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Marker {
    None,
    Revoked,
    CertAuthority,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Hosts {
    /// `|1|salt|hash`
    Hashed { salt: Vec<u8>, hash: Vec<u8> },
    /// Comma separated patterns, lower case.
    Patterns(Vec<String>),
}

/// One meaningful line of a known_hosts file.
#[derive(Debug, Clone)]
struct Entry {
    line: usize,
    marker: Marker,
    hosts: Hosts,
    /// None: the key cannot be read (still "recorded" for its host).
    key: Option<PublicKey>,
}

/// Parses a known_hosts text; never fails (odd lines become entries without a key).
fn parse(text: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split_ascii_whitespace();
        let Some(mut first) = fields.next() else {
            continue;
        };
        let marker = if let Some(m) = first.strip_prefix('@') {
            let marker = match m {
                "revoked" => Marker::Revoked,
                "cert-authority" => Marker::CertAuthority,
                _ => Marker::Unknown,
            };
            match fields.next() {
                Some(next) => first = next,
                None => continue,
            }
            marker
        } else {
            Marker::None
        };
        let hosts = parse_hosts(first);
        let key = match (fields.next(), fields.next()) {
            (Some(kind), Some(b64)) => PublicKey::from_openssh(&format!("{kind} {b64}")).ok(),
            _ => None,
        };
        out.push(Entry {
            line: i + 1,
            marker,
            hosts,
            key,
        });
    }
    out
}

fn parse_hosts(field: &str) -> Hosts {
    if let Some(rest) = field.strip_prefix("|1|") {
        if let Some((salt, hash)) = rest.split_once('|') {
            if let (Ok(salt), Ok(hash)) = (
                BASE64.decode(salt.as_bytes()),
                BASE64.decode(hash.as_bytes()),
            ) {
                return Hosts::Hashed { salt, hash };
            }
        }
        // A broken hash matches nothing (it cannot be told whose it was).
        return Hosts::Patterns(Vec::new());
    }
    Hosts::Patterns(
        field
            .split(',')
            .filter(|p| !p.is_empty())
            .map(|p| p.to_lowercase())
            .collect(),
    )
}

/// `*` and `?` glob (input already lower case).
fn glob(pattern: &str, text: &str) -> bool {
    fn go(p: &[u8], t: &[u8]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some(b'*') => (0..=t.len()).any(|i| go(&p[1..], &t[i..])),
            Some(b'?') => !t.is_empty() && go(&p[1..], &t[1..]),
            Some(c) => t.first() == Some(c) && go(&p[1..], &t[1..]),
        }
    }
    go(pattern.as_bytes(), text.as_bytes())
}

/// The name of `host:port` in a known_hosts file: `host`, or `[host]:port` for other ports.
pub fn host_name(host: &str, port: u16) -> String {
    let host = host.to_lowercase();
    if port == 22 {
        host
    } else {
        format!("[{host}]:{port}")
    }
}

impl Hosts {
    fn matches(&self, name: &str) -> bool {
        match self {
            Hosts::Hashed { salt, hash } => {
                let Ok(mut mac) = <Hmac<sha1::Sha1> as KeyInit>::new_from_slice(salt) else {
                    return false;
                };
                mac.update(name.as_bytes());
                mac.verify_slice(hash).is_ok()
            }
            Hosts::Patterns(patterns) => {
                let mut positive = false;
                for p in patterns {
                    if let Some(neg) = p.strip_prefix('!') {
                        if glob(neg, name) {
                            return false;
                        }
                    } else if glob(p, name) {
                        positive = true;
                    }
                }
                positive
            }
        }
    }
}

fn same_key(a: &PublicKey, b: &PublicKey) -> bool {
    a.key_data() == b.key_data()
}

/// Where host keys are looked up and recorded.
#[derive(Debug, Clone)]
pub struct KnownHosts {
    /// `~/.ssh/known_hosts`, read only.
    pub user: Option<PathBuf>,
    /// The app's own file.
    pub app: PathBuf,
}

/// The entries of one file, or why it cannot be used.
enum FileEntries {
    Missing,
    Unreadable,
    Entries(Vec<Entry>),
}

fn read_entries(file: &Path) -> FileEntries {
    match std::fs::metadata(file) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => FileEntries::Missing,
        Err(_) => FileEntries::Unreadable,
        Ok(m) if !m.is_file() || m.len() > MAX_FILE_BYTES => FileEntries::Unreadable,
        Ok(_) => match std::fs::read(file) {
            Ok(bytes) => FileEntries::Entries(parse(&String::from_utf8_lossy(&bytes))),
            Err(_) => FileEntries::Unreadable,
        },
    }
}

impl KnownHosts {
    fn files(&self) -> impl Iterator<Item = &Path> {
        self.user
            .as_deref()
            .into_iter()
            .chain(std::iter::once(self.app.as_path()))
            .filter(|f| !f.as_os_str().is_empty())
    }

    /// Checks `key` for `host:port` against both files (see the module documentation).
    pub fn check(&self, host: &str, port: u16, key: &PublicKey) -> HostKeyCheck {
        let name = host_name(host, port);
        let mut known = false;
        let mut changed: Option<HostKeyCheck> = None;
        for file in self.files() {
            let entries = match read_entries(file) {
                FileEntries::Missing => continue,
                FileEntries::Unreadable => {
                    changed.get_or_insert(HostKeyCheck::Changed {
                        file: file.to_path_buf(),
                        line: 0,
                        reason: ChangeReason::Unreadable,
                    });
                    continue;
                }
                FileEntries::Entries(entries) => entries,
            };
            for e in entries.iter().filter(|e| e.hosts.matches(&name)) {
                let reason = match (&e.marker, &e.key) {
                    (Marker::Revoked, Some(k)) if same_key(k, key) => {
                        return HostKeyCheck::Revoked {
                            file: file.to_path_buf(),
                            line: e.line,
                        };
                    }
                    // A revoked other key says nothing about this one.
                    (Marker::Revoked, _) => continue,
                    (Marker::None, Some(k)) if same_key(k, key) => {
                        known = true;
                        continue;
                    }
                    (Marker::None, Some(_)) => ChangeReason::OtherKey,
                    (Marker::None, None) => ChangeReason::Unusable,
                    (Marker::CertAuthority, _) => ChangeReason::CertAuthority,
                    (Marker::Unknown, _) => ChangeReason::UnknownMarker,
                };
                changed.get_or_insert(HostKeyCheck::Changed {
                    file: file.to_path_buf(),
                    line: e.line,
                    reason,
                });
            }
        }
        if known {
            HostKeyCheck::Known
        } else {
            changed.unwrap_or(HostKeyCheck::Unknown)
        }
    }

    /// Usable keys recorded for this host.
    fn recorded_keys(&self, host: &str, port: u16) -> Vec<PublicKey> {
        let name = host_name(host, port);
        self.files()
            .filter_map(|f| match read_entries(f) {
                FileEntries::Entries(e) => Some(e),
                _ => None,
            })
            .flatten()
            .filter(|e| e.marker == Marker::None && e.hosts.matches(&name))
            .filter_map(|e| e.key)
            .collect()
    }

    /// Host-key algorithms to offer, those recorded for this host first (like OpenSSH): a server
    /// then shows the key the user already trusts.
    pub fn preferred_algorithms(&self, host: &str, port: u16) -> Vec<russh::keys::Algorithm> {
        let types: Vec<_> = self
            .recorded_keys(host, port)
            .into_iter()
            .map(|k| k.algorithm())
            .collect();
        let (mut first, rest): (Vec<_>, Vec<_>) = russh::Preferred::DEFAULT
            .key
            .iter()
            .cloned()
            .partition(|a| types.iter().any(|t| same_type(a, t)));
        first.extend(rest);
        first
    }

    /// Records a confirmed key in the app's file (created private, host in lower case).
    pub fn learn(&self, host: &str, port: u16, key: &PublicKey) -> io::Result<()> {
        if self.app.as_os_str().is_empty() {
            return Err(io::Error::other(
                "no config folder for the app's known_hosts",
            ));
        }
        let new = !self.app.exists();
        if new {
            if let Some(dir) = self.app.parent() {
                std::fs::create_dir_all(dir)?;
            }
            crate::spool::create_private_file(&self.app, false)?;
            std::fs::write(
                &self.app,
                "# Host keys confirmed in Log Commander (~/.ssh/known_hosts is only read)\n",
            )?;
        }
        let line = format!(
            "{} {}\n",
            host_name(host, port),
            key.to_openssh()
                .map_err(|e| io::Error::other(e.to_string()))?
        );
        let mut text = std::fs::read_to_string(&self.app)?;
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&line);
        std::fs::write(&self.app, text)
    }
}

/// `SHA256:…` like `ssh-keygen -l`.
pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(russh::keys::HashAlg::Sha256).to_string()
}

fn same_type(a: &russh::keys::Algorithm, b: &russh::keys::Algorithm) -> bool {
    use russh::keys::Algorithm::Rsa;
    matches!((a, b), (Rsa { .. }, Rsa { .. })) || a == b
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn key(seed: u8) -> PublicKey {
        russh::keys::PrivateKey::from(russh::keys::ssh_key::private::Ed25519Keypair::from_seed(
            &[seed; 32],
        ))
        .public_key()
        .clone()
    }

    fn openssh(seed: u8) -> String {
        key(seed).to_openssh().unwrap()
    }

    /// A known_hosts with `text` as the user's file.
    fn with_user(text: &str) -> (tempfile::TempDir, KnownHosts) {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("known_hosts");
        std::fs::write(&user, text).unwrap();
        let known = KnownHosts {
            user: Some(user),
            app: dir.path().join("app_known_hosts"),
        };
        (dir, known)
    }

    fn changed(check: HostKeyCheck) -> (usize, ChangeReason) {
        match check {
            HostKeyCheck::Changed { line, reason, .. } => (line, reason),
            other => panic!("not changed: {other:?}"),
        }
    }

    #[test]
    fn known_unknown_changed_and_the_apps_file() {
        let dir = tempfile::tempdir().unwrap();
        let known = KnownHosts {
            user: Some(dir.path().join("user_known_hosts")),
            app: dir.path().join("app").join("known_hosts"),
        };
        assert_eq!(known.check("h", 22, &key(1)), HostKeyCheck::Unknown);
        known.learn("H", 2222, &key(1)).unwrap();
        assert_eq!(known.check("h", 2222, &key(1)), HostKeyCheck::Known);
        // Another port is another host.
        assert_eq!(known.check("h", 22, &key(1)), HostKeyCheck::Unknown);
        assert_eq!(
            changed(known.check("h", 2222, &key(2))),
            (2, ChangeReason::OtherKey)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&known.app).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // The user's file is read, never written.
        let user = known.user.clone().unwrap();
        std::fs::write(&user, format!("# mine\nu {}\n", openssh(2))).unwrap();
        let before = std::fs::read(&user).unwrap();
        assert_eq!(known.check("u", 22, &key(2)), HostKeyCheck::Known);
        assert_eq!(
            known.check("u", 22, &key(1)),
            HostKeyCheck::Changed {
                file: user.clone(),
                line: 2,
                reason: ChangeReason::OtherKey
            }
        );
        assert_eq!(std::fs::read(&user).unwrap(), before);
        assert!(fingerprint(&key(1)).starts_with("SHA256:"));
    }

    #[test]
    fn tabs_multiple_spaces_comments_and_empty_lines() {
        let k = openssh(1);
        let (kind, b64) = k.split_once(' ').unwrap();
        let (_d, known) = with_user(&format!(
            "\n# comment\n   \nh1\t{kind}\t{b64}\nh2    {kind}   {b64}   a comment\n  h3 {kind} {b64}\n"
        ));
        for h in ["h1", "h2", "h3"] {
            assert_eq!(known.check(h, 22, &key(1)), HostKeyCheck::Known, "{h}");
            assert_eq!(
                changed(known.check(h, 22, &key(2))).1,
                ChangeReason::OtherKey,
                "{h}"
            );
        }
    }

    #[test]
    fn host_names_lists_ports_and_case() {
        let (_d, known) = with_user(&format!(
            "Web.Example.COM,10.0.0.5 {}\n[DB.example.com]:2222 {}\n",
            openssh(1),
            openssh(2)
        ));
        assert_eq!(
            known.check("web.example.com", 22, &key(1)),
            HostKeyCheck::Known
        );
        assert_eq!(
            known.check("WEB.example.com", 22, &key(1)),
            HostKeyCheck::Known
        );
        assert_eq!(known.check("10.0.0.5", 22, &key(1)), HostKeyCheck::Known);
        assert_eq!(
            known.check("db.example.com", 2222, &key(2)),
            HostKeyCheck::Known
        );
        assert_eq!(
            known.check("db.example.com", 22, &key(2)),
            HostKeyCheck::Unknown
        );
        assert_eq!(changed(known.check("db.example.com", 2222, &key(1))).0, 2);
    }

    #[test]
    fn patterns_and_negation() {
        let (_d, known) = with_user(&format!("*.corp,!evil.corp {}\n", openssh(1)));
        assert_eq!(known.check("a.corp", 22, &key(1)), HostKeyCheck::Known);
        assert_eq!(
            changed(known.check("b.corp", 22, &key(2))).1,
            ChangeReason::OtherKey
        );
        assert_eq!(known.check("evil.corp", 22, &key(2)), HostKeyCheck::Unknown);
        assert_eq!(known.check("corp", 22, &key(2)), HostKeyCheck::Unknown);
        let (_d2, q) = with_user(&format!("web? {}\n", openssh(1)));
        assert_eq!(q.check("web1", 22, &key(1)), HostKeyCheck::Known);
        assert_eq!(q.check("web12", 22, &key(1)), HostKeyCheck::Unknown);
    }

    #[test]
    fn hashed_hosts() {
        // `ssh-keygen -H` style: |1|base64(salt)|base64(HMAC-SHA1(salt, name))
        let salt = [7u8; 20];
        let hashed = |name: &str| {
            let mut mac = <Hmac<sha1::Sha1> as KeyInit>::new_from_slice(&salt).unwrap();
            mac.update(name.as_bytes());
            format!(
                "|1|{}|{}",
                BASE64.encode(&salt),
                BASE64.encode(&mac.finalize().into_bytes())
            )
        };
        let (_d, known) = with_user(&format!(
            "{} {}\n{} {}\n|1|broken|x {}\n",
            hashed("secret.example.com"),
            openssh(1),
            hashed("[secret.example.com]:2200"),
            openssh(2),
            openssh(3)
        ));
        assert_eq!(
            known.check("Secret.Example.com", 22, &key(1)),
            HostKeyCheck::Known
        );
        assert_eq!(changed(known.check("secret.example.com", 22, &key(3))).0, 1);
        assert_eq!(
            known.check("secret.example.com", 2200, &key(2)),
            HostKeyCheck::Known
        );
        assert_eq!(known.check("other", 22, &key(3)), HostKeyCheck::Unknown);
    }

    #[test]
    fn revoked_keys_are_refused_even_when_also_trusted() {
        let (_d, known) = with_user(&format!(
            "h {}\n@revoked * {}\n@revoked\tother {}\n",
            openssh(1),
            openssh(1),
            openssh(2)
        ));
        assert!(matches!(
            known.check("h", 22, &key(1)),
            HostKeyCheck::Revoked { line: 2, .. }
        ));
        // A revocation for another host pattern does not apply; a revoked other key changes nothing.
        let (_d2, k2) = with_user(&format!(
            "@revoked other {}\nh {}\n",
            openssh(1),
            openssh(1)
        ));
        assert_eq!(k2.check("h", 22, &key(1)), HostKeyCheck::Known);
    }

    #[test]
    fn cert_authority_broken_and_unknown_marker_lines_count_as_recorded() {
        let (_d, ca) = with_user(&format!("@cert-authority *.corp {}\n", openssh(9)));
        assert_eq!(
            changed(ca.check("a.corp", 22, &key(1))),
            (1, ChangeReason::CertAuthority)
        );
        assert_eq!(ca.check("elsewhere", 22, &key(1)), HostKeyCheck::Unknown);
        let (_d2, broken) = with_user(&format!(
            "h ssh-ed25519 AAAA!!notbase64\nh\ng {}\n",
            openssh(1)
        ));
        assert_eq!(
            changed(broken.check("h", 22, &key(1))),
            (1, ChangeReason::Unusable)
        );
        // One broken line does not make the rest of the file invisible.
        assert_eq!(broken.check("g", 22, &key(1)), HostKeyCheck::Known);
        assert_eq!(
            changed(broken.check("g", 22, &key(2))).1,
            ChangeReason::OtherKey
        );
        let (_d3, marker) = with_user(&format!("@future h {}\n", openssh(1)));
        assert_eq!(
            changed(marker.check("h", 22, &key(1))).1,
            ChangeReason::UnknownMarker
        );
        // A usable matching line wins over a broken one (OpenSSH: any match is trust).
        let (_d4, both) = with_user(&format!("h ssh-ed25519 broken\nh {}\n", openssh(1)));
        assert_eq!(both.check("h", 22, &key(1)), HostKeyCheck::Known);
    }

    #[test]
    fn an_unreadable_file_is_no_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("known_hosts");
        std::fs::create_dir(&user).unwrap(); // a folder: cannot be read as a file
        let known = KnownHosts {
            user: Some(user),
            app: dir.path().join("app"),
        };
        assert_eq!(
            changed(known.check("h", 22, &key(1))),
            (0, ChangeReason::Unreadable)
        );
    }

    const ECDSA: &str = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBDn1mtNhxd8S4u+/ll3B1QPZhGeMs0f0Bw0nMP3cfH0L+XTKV1rhVRzmx2NZI1lo8FUCAsPfe4TwO/pbABtsfNY=";

    #[test]
    fn another_key_type_than_recorded_is_a_change() {
        let (_d, known) = with_user(&format!("# comment\n[h]:2222 {ECDSA}\n"));
        assert_eq!(
            changed(known.check("h", 2222, &key(1))),
            (2, ChangeReason::OtherKey)
        );
        assert_eq!(known.check("other", 2222, &key(1)), HostKeyCheck::Unknown);
        let order = known.preferred_algorithms("h", 2222);
        assert_eq!(order[0].as_str(), "ecdsa-sha2-nistp256");
        assert_eq!(order.len(), russh::Preferred::DEFAULT.key.len());
    }
}
