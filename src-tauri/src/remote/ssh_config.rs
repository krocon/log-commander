//! A subset of `~/.ssh/config` (prompt 017): host aliases for the dialog, and user, port, host name and
//! key files of a host.
//!
//! Supported: `Host` (patterns with `*`, `?`, `!`), `HostName`, `User`, `Port`, `IdentityFile` (`~`,
//! `%d`, `%u`, `%h`, `%r`, `%%`), `Include` (relative to `~/.ssh`, `*`/`?` in the file name, depth 5,
//! 64 files). The first value wins, as in OpenSSH. `Match` blocks are skipped as a whole and never
//! evaluated (so `Match exec` never runs anything). `ProxyCommand`, `ProxyJump`, `LocalCommand` and
//! `KnownHostsCommand` are **never executed**; a host with a proxy is reported as unsupported.
//! Everything else is ignored.

use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_INCLUDE_DEPTH: usize = 5;
const MAX_FILES: usize = 64;
/// Larger config files are not read (a config is a few KB).
const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Condition {
    /// Before the first `Host`/`Match`: applies to every host.
    All,
    Host(Vec<String>),
    /// A `Match` block: never applies (not evaluated).
    Never,
}

#[derive(Debug, Clone)]
struct Entry {
    condition: usize,
    key: String,
    value: String,
}

/// A parsed config: blocks with their entries in file order (includes inlined).
#[derive(Debug, Default, Clone)]
pub struct SshConfig {
    conditions: Vec<Condition>,
    entries: Vec<Entry>,
}

/// What the config says about one host.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    /// The alias as typed.
    pub alias: String,
    /// `HostName`, else the alias.
    pub host_name: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_files: Vec<String>,
    /// `ProxyJump` or `ProxyCommand` is set: not supported (never run).
    pub proxy: bool,
}

/// Where `~`, `%d`, `%u` point.
#[derive(Debug, Clone)]
pub struct Environment {
    pub home: PathBuf,
    pub local_user: String,
}

impl Environment {
    pub fn current() -> Option<Self> {
        let home = home_dir()?;
        let local_user = std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .unwrap_or_default();
        Some(Self { home, local_user })
    }

    pub fn ssh_dir(&self) -> PathBuf {
        self.home.join(".ssh")
    }
}

pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let var = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let var = std::env::var_os("HOME");
    var.filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Splits `Key value`, `Key=value` and `Key "quoted value"`; None for comments and empty lines.
fn split_line(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(line.len());
    let key = line[..end].to_ascii_lowercase();
    let mut rest = line[end..].trim_start();
    if let Some(r) = rest.strip_prefix('=') {
        rest = r.trim_start();
    }
    Some((key, rest.trim().to_string()))
}

/// Arguments of a value: whitespace separated, double quotes group.
fn args(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut any = false;
    for c in value.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                any = true;
            }
            c if c.is_whitespace() && !quoted => {
                if any {
                    out.push(std::mem::take(&mut cur));
                    any = false;
                }
            }
            c => {
                cur.push(c);
                any = true;
            }
        }
    }
    if any {
        out.push(cur);
    }
    out
}

/// `*` and `?` glob, case-insensitive.
fn glob(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some('*') => (0..=t.len()).any(|i| go(&p[1..], &t[i..])),
            Some('?') => !t.is_empty() && go(&p[1..], &t[1..]),
            Some(c) => t.first() == Some(c) && go(&p[1..], &t[1..]),
        }
    }
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    go(&p, &t)
}

fn host_matches(patterns: &[String], host: &str) -> bool {
    let mut positive = false;
    for p in patterns {
        if let Some(neg) = p.strip_prefix('!') {
            if glob(neg, host) {
                return false;
            }
        } else if glob(p, host) {
            positive = true;
        }
    }
    positive
}

impl SshConfig {
    /// Parses a config text; `include` reads an included file (None: not readable).
    pub fn parse(text: &str, include: &dyn Fn(&str) -> Vec<String>) -> Self {
        let mut config = SshConfig {
            conditions: vec![Condition::All],
            entries: Vec::new(),
        };
        let mut files = 1;
        config.parse_into(text, include, 0, 0, &mut files);
        config
    }

    fn parse_into(
        &mut self,
        text: &str,
        include: &dyn Fn(&str) -> Vec<String>,
        depth: usize,
        mut current: usize,
        files: &mut usize,
    ) -> usize {
        for line in text.lines() {
            let Some((key, value)) = split_line(line) else {
                continue;
            };
            match key.as_str() {
                "host" => {
                    self.conditions.push(Condition::Host(args(&value)));
                    current = self.conditions.len() - 1;
                }
                "match" => {
                    self.conditions.push(Condition::Never);
                    current = self.conditions.len() - 1;
                }
                "include" => {
                    if depth >= MAX_INCLUDE_DEPTH {
                        continue;
                    }
                    for pattern in args(&value) {
                        for text in include(&pattern) {
                            if *files >= MAX_FILES {
                                break;
                            }
                            *files += 1;
                            current = self.parse_into(&text, include, depth + 1, current, files);
                        }
                    }
                }
                _ => self.entries.push(Entry {
                    condition: current,
                    key,
                    value,
                }),
            }
        }
        current
    }

    /// Reads `~/.ssh/config` with its includes; empty if there is none.
    pub fn load(env: &Environment) -> Self {
        let path = env.ssh_dir().join("config");
        let Some(text) = read_small(&path) else {
            return Self::default();
        };
        let ssh_dir = env.ssh_dir();
        let home = env.home.clone();
        Self::parse(&text, &move |pattern| {
            include_files(&ssh_dir, &home, pattern)
                .iter()
                .filter_map(|p| read_small(p))
                .collect()
        })
    }

    fn applies(&self, condition: usize, host: &str) -> bool {
        match &self.conditions[condition] {
            Condition::All => true,
            Condition::Host(patterns) => host_matches(patterns, host),
            Condition::Never => false,
        }
    }

    /// What applies to `alias` (first value wins, key files add up).
    pub fn resolve(&self, alias: &str, env: &Environment) -> HostConfig {
        let mut out = HostConfig {
            alias: alias.into(),
            ..Default::default()
        };
        let mut host_name: Option<String> = None;
        let mut files = Vec::new();
        for e in self
            .entries
            .iter()
            .filter(|e| self.applies(e.condition, alias))
        {
            let first = args(&e.value).into_iter().next().unwrap_or_default();
            match e.key.as_str() {
                "hostname" if host_name.is_none() && !first.is_empty() => {
                    host_name = Some(first.replace("%h", alias).replace("%%", "%"));
                }
                "user" if out.user.is_none() && !first.is_empty() => out.user = Some(first),
                "port" if out.port.is_none() => out.port = first.parse().ok().filter(|p| *p > 0),
                "identityfile" if !first.is_empty() => files.push(first),
                "proxyjump" | "proxycommand" if !first.eq_ignore_ascii_case("none") => {
                    out.proxy = true;
                }
                _ => {}
            }
        }
        out.host_name = host_name.unwrap_or_else(|| alias.into());
        let remote_user = out.user.clone().unwrap_or_else(|| env.local_user.clone());
        out.identity_files = files
            .iter()
            .filter_map(|f| expand_tokens(f, env, &out.host_name, &remote_user))
            .collect();
        out
    }

    /// Host aliases without wildcards, in file order, for the dialog.
    pub fn aliases(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for c in &self.conditions {
            if let Condition::Host(patterns) = c {
                for p in patterns {
                    if !p.contains(['*', '?', '!'])
                        && !out.iter().any(|o| o.eq_ignore_ascii_case(p))
                    {
                        out.push(p.clone());
                    }
                }
            }
        }
        out
    }
}

/// `~`, `%d`, `%u`, `%h`, `%r`, `%%`; None for other tokens (the entry is left out).
fn expand_tokens(value: &str, env: &Environment, host: &str, remote_user: &str) -> Option<String> {
    let home = env.home.to_string_lossy();
    let value = if value == "~" {
        home.to_string()
    } else if let Some(rest) = value.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        value.to_string()
    };
    let mut out = String::new();
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next()? {
            '%' => out.push('%'),
            'd' => out.push_str(&home),
            'u' => out.push_str(&env.local_user),
            'h' => out.push_str(host),
            'r' => out.push_str(remote_user),
            _ => return None,
        }
    }
    Some(out)
}

fn read_small(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// The files an `Include` names: relative to `~/.ssh`, `~` expanded, wildcards in the file name only,
/// sorted like OpenSSH (glob order).
fn include_files(ssh_dir: &Path, home: &Path, pattern: &str) -> Vec<PathBuf> {
    let path = if pattern == "~" {
        home.to_path_buf()
    } else if let Some(rest) = pattern.strip_prefix("~/") {
        home.join(rest)
    } else if Path::new(pattern).is_absolute() {
        PathBuf::from(pattern)
    } else {
        ssh_dir.join(pattern)
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !name.contains(['*', '?']) {
        return vec![path];
    }
    let Some(dir) = path.parent() else {
        return Vec::new();
    };
    if dir.to_string_lossy().contains(['*', '?']) {
        return Vec::new();
    }
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| glob(&name, &e.file_name().to_string_lossy()))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    found.sort();
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> Environment {
        Environment {
            home: PathBuf::from("/home/me"),
            local_user: "me".into(),
        }
    }

    fn parse(text: &str) -> SshConfig {
        SshConfig::parse(text, &|_| Vec::new())
    }

    #[test]
    fn first_value_wins_and_patterns_match() {
        let c = parse(
            "# comment\n\
             Host web web.prod\n  HostName 10.0.0.5\n  User deploy\n  Port 2222\n  IdentityFile ~/.ssh/web_%r\n\
             Host *.prod !db.prod\n  User ops\n  Port=2200\n\
             Host *\n  User fallback\n  IdentityFile \"%d/.ssh/id ed25519\"\n",
        );
        let web = c.resolve("web", &env());
        assert_eq!(web.host_name, "10.0.0.5");
        assert_eq!(web.user.as_deref(), Some("deploy"));
        assert_eq!(web.port, Some(2222));
        assert_eq!(
            web.identity_files,
            vec!["/home/me/.ssh/web_deploy", "/home/me/.ssh/id ed25519"]
        );
        assert!(!web.proxy);
        let api = c.resolve("api.prod", &env());
        assert_eq!(api.user.as_deref(), Some("ops"));
        assert_eq!(api.port, Some(2200));
        assert_eq!(api.host_name, "api.prod");
        // Negation: db.prod is not *.prod here.
        let db = c.resolve("db.prod", &env());
        assert_eq!(db.user.as_deref(), Some("fallback"));
        assert_eq!(db.port, None);
        assert_eq!(c.aliases(), vec!["web", "web.prod"]);
        assert!(glob("W?b*", "web.prod"));
    }

    #[test]
    fn match_blocks_and_proxies_are_never_run() {
        let c = parse(
            "Match exec \"touch /tmp/pwned\"\n  User evil\n\
             Host jump\n  ProxyJump bastion\n\
             Host cmd\n  ProxyCommand ssh -W %h:%p bastion\n\
             Host plain\n  ProxyCommand none\n  LocalCommand rm -rf ~\n",
        );
        assert_eq!(c.resolve("x", &env()).user, None);
        assert!(c.resolve("jump", &env()).proxy);
        assert!(c.resolve("cmd", &env()).proxy);
        assert!(!c.resolve("plain", &env()).proxy);
        // Unknown tokens leave the key file out instead of guessing.
        let k = parse("Host a\n IdentityFile ~/.ssh/%C\n IdentityFile %h.key\n");
        assert_eq!(k.resolve("a", &env()).identity_files, vec!["a.key"]);
    }

    #[test]
    fn includes_are_inlined_with_a_depth_limit() {
        let c = SshConfig::parse("Include conf.d/*\nHost b\n User bee\n", &|p| {
            assert_eq!(p, "conf.d/*");
            vec!["Host a\n User ay\n Include conf.d/*\n".into()]
        });
        assert_eq!(c.resolve("a", &env()).user.as_deref(), Some("ay"));
        assert_eq!(c.resolve("b", &env()).user.as_deref(), Some("bee"));
        assert!(c.aliases().len() >= 2);
    }

    #[test]
    fn include_files_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let ssh = dir.path().join(".ssh");
        std::fs::create_dir_all(ssh.join("conf.d")).unwrap();
        std::fs::write(ssh.join("conf.d/b.conf"), "Host bb\n Port 2\n").unwrap();
        std::fs::write(ssh.join("conf.d/a.conf"), "Host aa\n Port 1\n").unwrap();
        std::fs::write(ssh.join("conf.d/skip.txt"), "Host zz\n").unwrap();
        std::fs::write(ssh.join("config"), "Include conf.d/*.conf\n").unwrap();
        let env = Environment {
            home: dir.path().to_path_buf(),
            local_user: "me".into(),
        };
        let c = SshConfig::load(&env);
        assert_eq!(c.aliases(), vec!["aa", "bb"]);
        assert_eq!(c.resolve("bb", &env).port, Some(2));
        assert!(SshConfig::load(&Environment {
            home: dir.path().join("none"),
            local_user: String::new()
        })
        .aliases()
        .is_empty());
    }
}
