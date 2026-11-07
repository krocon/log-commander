//! Passwords and key passphrases (prompt 017).
//!
//! [`Secret`] hides its text in `Debug`, has no `Serialize` (it can never travel back to the frontend,
//! into a file or into an update) and is wiped when dropped. Persistent only in the keychain of the OS
//! (macOS Keychain, Windows Credential Manager, Secret Service on Linux), only when the user asks for it
//! and only after the login worked. Account names are hashes, so neither host nor user stand in the
//! keychain's metadata (readable without unlocking it).

use parking_lot::Mutex;
use serde::{Deserialize, Deserializer};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::OnceLock;
use zeroize::Zeroizing;

pub const SERVICE: &str = "io.github.krocon.logcommander";
/// Longer secrets are refused (no SSH password or passphrase needs more).
pub const MAX_SECRET_CHARS: usize = 1024;

/// A password or passphrase. `Debug` prints `***`, there is no `Serialize`, the text is wiped on drop.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    pub fn new(text: impl Into<String>) -> Self {
        Secret(Zeroizing::new(text.into()))
    }

    /// The text itself, only to hand it to the SSH library.
    pub fn expose(&self) -> &str {
        self.0.as_str()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(***)")
    }
}

impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = Zeroizing::new(String::deserialize(d)?);
        if text.chars().count() > MAX_SECRET_CHARS {
            return Err(serde::de::Error::custom("secret too long"));
        }
        Ok(Secret(text))
    }
}

/// What a secret is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretKind {
    /// The login password of `user@host:port`.
    Password,
    /// The passphrase of a key file.
    Passphrase,
}

/// The keychain account of a secret: `sftp:password:<hash>`; `subject` is `user@host:port` for a
/// password and the key file's path for a passphrase.
pub fn account(kind: SecretKind, subject: &str) -> String {
    let hash = Sha256::digest(subject.as_bytes());
    let hex: String = hash[..8].iter().map(|b| format!("{b:02x}")).collect();
    let tag = match kind {
        SecretKind::Password => "password",
        SecretKind::Passphrase => "passphrase",
    };
    format!("sftp:{tag}:{hex}")
}

/// Why the keychain could not be used; never contains the secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError(pub String);

pub trait SecretStore: Send + Sync {
    fn available(&self) -> bool;
    fn get(&self, account: &str) -> Result<Option<Secret>, StoreError>;
    fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError>;
    /// A missing entry is fine.
    fn delete(&self, account: &str) -> Result<(), StoreError>;
}

/// The keychain of the OS through `keyring-core`.
pub struct KeyringStore {
    ready: Result<(), StoreError>,
}

#[cfg(target_os = "macos")]
fn native_store() -> Result<std::sync::Arc<keyring_core::CredentialStore>, String> {
    apple_native_keyring_store::keychain::Store::new()
        .map(|s| s as std::sync::Arc<keyring_core::CredentialStore>)
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn native_store() -> Result<std::sync::Arc<keyring_core::CredentialStore>, String> {
    windows_native_keyring_store::Store::new()
        .map(|s| s as std::sync::Arc<keyring_core::CredentialStore>)
        .map_err(|e| e.to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn native_store() -> Result<std::sync::Arc<keyring_core::CredentialStore>, String> {
    dbus_secret_service_keyring_store::Store::new()
        .map(|s| s as std::sync::Arc<keyring_core::CredentialStore>)
        .map_err(|e| e.to_string())
}

impl KeyringStore {
    fn new() -> Self {
        let ready = native_store()
            .map(keyring_core::set_default_store)
            .map_err(StoreError);
        Self { ready }
    }

    fn entry(&self, account: &str) -> Result<keyring_core::Entry, StoreError> {
        self.ready.clone()?;
        keyring_core::Entry::new(SERVICE, account).map_err(|e| StoreError(e.to_string()))
    }
}

impl SecretStore for KeyringStore {
    fn available(&self) -> bool {
        self.ready.is_ok()
    }

    fn get(&self, account: &str) -> Result<Option<Secret>, StoreError> {
        match self.entry(account)?.get_password() {
            Ok(text) => Ok(Some(Secret::new(Zeroizing::new(text).as_str()))),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(StoreError(e.to_string())),
        }
    }

    fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError> {
        self.entry(account)?
            .set_password(secret.expose())
            .map_err(|e| StoreError(e.to_string()))
    }

    fn delete(&self, account: &str) -> Result<(), StoreError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(StoreError(e.to_string())),
        }
    }
}

/// The keychain of the OS, set up on first use (a prompt to unlock may block: call off the runtime).
pub fn system_store() -> &'static KeyringStore {
    static STORE: OnceLock<KeyringStore> = OnceLock::new();
    STORE.get_or_init(KeyringStore::new)
}

/// A keychain in memory: tests, e2e runs (which must not touch the real keychain).
#[derive(Default)]
pub struct MemoryStore {
    entries: Mutex<HashMap<String, Secret>>,
}

impl MemoryStore {
    pub fn len(&self) -> usize {
        self.entries.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl SecretStore for MemoryStore {
    fn available(&self) -> bool {
        true
    }
    fn get(&self, account: &str) -> Result<Option<Secret>, StoreError> {
        Ok(self.entries.lock().get(account).cloned())
    }
    fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError> {
        self.entries.lock().insert(account.into(), secret.clone());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), StoreError> {
        self.entries.lock().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounts_name_neither_host_nor_user() {
        let a = account(SecretKind::Password, "alice@db.example.com:22");
        assert!(a.starts_with("sftp:password:"), "{a}");
        assert_eq!(a.len(), "sftp:password:".len() + 16);
        assert!(!a.contains("alice") && !a.contains("example"));
        assert_ne!(
            a,
            account(SecretKind::Password, "alice@db.example.com:2222")
        );
        assert!(account(SecretKind::Passphrase, "/k").starts_with("sftp:passphrase:"));
    }

    #[test]
    fn secrets_never_show() {
        let s = Secret::new("hunter2-Qx7");
        assert_eq!(format!("{s:?}"), "Secret(***)");
        let long = format!("\"{}\"", "x".repeat(MAX_SECRET_CHARS + 1));
        assert!(serde_json::from_str::<Secret>(&long).is_err());
        let ok: Secret = serde_json::from_str("\"pässwört 🔑\"").unwrap();
        assert_eq!(ok.expose(), "pässwört 🔑");
    }

    #[test]
    fn memory_store() {
        let s = MemoryStore::default();
        assert_eq!(s.get("a").unwrap(), None);
        s.set("a", &Secret::new("x")).unwrap();
        assert_eq!(s.get("a").unwrap().unwrap().expose(), "x");
        s.delete("a").unwrap();
        s.delete("a").unwrap();
        assert!(s.is_empty());
    }
}

/// The real keychain, by hand: `LC_KEYCHAIN_TEST=1 cargo test --lib -- --ignored real_keychain`.
#[cfg(test)]
mod real {
    use super::*;

    #[test]
    #[ignore]
    fn real_keychain() {
        if std::env::var("LC_KEYCHAIN_TEST").is_err() {
            return;
        }
        let s = system_store();
        assert!(s.available(), "{:?}", s.ready);
        let a = format!("sftp:test:{}", std::process::id());
        assert_eq!(s.get(&a).unwrap(), None);
        s.set(&a, &Secret::new("pässwört 🔑")).unwrap();
        assert_eq!(s.get(&a).unwrap().unwrap().expose(), "pässwört 🔑");
        s.delete(&a).unwrap();
        assert_eq!(s.get(&a).unwrap(), None);
    }
}
