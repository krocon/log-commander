//! Update check: asks GitHub for the latest release and compares it with this build. Only a hint, nothing is
//! downloaded or installed. The one request the app makes that is not a source the user opened: it runs on the
//! menu entry, and at start only when the setting says so (off by default, the frontend decides).
//!
//! What the answer may do is narrow: only `tag_name` is read, it must be `v1.2.3`, and the page that opens in the
//! browser is built here from those three numbers, never taken from the answer or from the frontend.

use crate::error::{AppError, AppResult, ErrorCode};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;

/// Latest release that is neither a draft nor a pre-release.
pub const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/krocon/log-commander/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/krocon/log-commander/releases";
/// Whole request, from resolving the name to the last byte.
const TIMEOUT: Duration = Duration::from_secs(10);
/// A release answer is some 10 KB plus the release notes.
const MAX_BODY: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// This build, e.g. `1.0.0`.
    pub current: String,
    /// The latest release, without the `v`.
    pub latest: String,
    pub newer: bool,
}

/// `major.minor.patch` of `1.2.3` or `v1.2.3`; a suffix (`-rc.1`, `+build`) is ignored. Nothing else is a
/// version here.
pub fn parse_version(text: &str) -> Option<[u64; 3]> {
    let text = text.trim();
    let text = text.strip_prefix('v').unwrap_or(text);
    let core = text.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let mut out = [0u64; 3];
    for slot in &mut out {
        let part = parts.next()?;
        if part.is_empty() || part.len() > 9 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *slot = part.parse().ok()?;
    }
    parts.next().is_none().then_some(out)
}

fn version_text(v: [u64; 3]) -> String {
    format!("{}.{}.{}", v[0], v[1], v[2])
}

/// The version in the answer of the releases API.
pub fn latest_in(body: &str) -> Option<[u64; 3]> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    parse_version(json.get("tag_name")?.as_str()?)
}

/// The page of a release (`version` as the check returned it), or of the latest one.
pub fn release_page(version: Option<&str>) -> String {
    match version.and_then(parse_version) {
        Some(v) => format!("{RELEASES_PAGE}/tag/v{}", version_text(v)),
        None => format!("{RELEASES_PAGE}/latest"),
    }
}

pub fn check(current: &str) -> AppResult<UpdateInfo> {
    check_at(LATEST_RELEASE_API, current, true)
}

/// `env_proxy`: honour `HTTPS_PROXY` and friends (tests talk to a local server directly).
pub fn check_at(url: &str, current: &str, env_proxy: bool) -> AppResult<UpdateInfo> {
    let failed = |message: String| AppError::new(ErrorCode::ConnectionFailed, message);
    let Some(current_version) = parse_version(current) else {
        return Err(failed(format!("own version unreadable: {current}")));
    };
    let body = fetch(url, current, env_proxy).map_err(|e| failed(describe(&e)))?;
    let latest =
        latest_in(&body).ok_or_else(|| failed("the answer names no release version".into()))?;
    Ok(UpdateInfo {
        current: version_text(current_version),
        latest: version_text(latest),
        newer: latest > current_version,
    })
}

fn fetch(url: &str, current: &str, env_proxy: bool) -> Result<String, ureq::Error> {
    // The roots of the OS (a company proxy with its own CA works), ring like the rest of the app.
    let tls = ureq::tls::TlsConfig::builder()
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .unversioned_rustls_crypto_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .build();
    let mut config = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .https_only(url.starts_with("https://"))
        .max_redirects(3)
        .user_agent(format!("log-commander/{current}"))
        .tls_config(tls);
    if !env_proxy {
        config = config.proxy(None);
    }
    let agent: ureq::Agent = config.build().into();
    agent
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .call()?
        .body_mut()
        .with_config()
        .limit(MAX_BODY)
        .read_to_string()
}

fn describe(error: &ureq::Error) -> String {
    match error {
        // 403/429: the rate limit of the API (60 an hour per address without a login).
        ureq::Error::StatusCode(code @ (403 | 429)) => {
            format!("GitHub refuses for now (HTTP {code}), try again later")
        }
        ureq::Error::StatusCode(code) => format!("GitHub answers with HTTP {code}"),
        ureq::Error::Timeout(_) => "no answer in time".into(),
        ureq::Error::HostNotFound => "api.github.com not found (offline?)".into(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn versions_are_three_numbers_with_an_optional_v() {
        assert_eq!(parse_version("1.2.3"), Some([1, 2, 3]));
        assert_eq!(parse_version("v10.0.12"), Some([10, 0, 12]));
        assert_eq!(parse_version(" v1.2.3-rc.1 "), Some([1, 2, 3]));
        assert_eq!(parse_version("1.2.3+build.5"), Some([1, 2, 3]));
        for bad in [
            "",
            "v",
            "1.2",
            "1.2.3.4",
            "1.2.x",
            "1..3",
            "-1.2.3",
            "1.2.3/../..",
            "1.2.9999999999",
            "V1.2.3",
        ] {
            assert_eq!(parse_version(bad), None, "{bad}");
        }
    }

    #[test]
    fn versions_compare_by_number_not_by_text() {
        assert!(parse_version("1.10.0") > parse_version("1.9.9"));
        assert!(parse_version("2.0.0") > parse_version("1.99.99"));
        assert!(parse_version("1.0.0") == parse_version("v1.0.0"));
    }

    #[test]
    fn only_the_tag_of_the_answer_is_read() {
        assert_eq!(
            latest_in(r#"{"tag_name":"v1.4.0","html_url":"https://evil.example/"}"#),
            Some([1, 4, 0])
        );
        assert_eq!(latest_in(r#"{"tag_name":"nightly"}"#), None);
        assert_eq!(latest_in(r#"{"tag_name":7}"#), None);
        assert_eq!(latest_in(r#"{"message":"Not Found"}"#), None);
        assert_eq!(latest_in("<html>"), None);
    }

    #[test]
    fn the_page_is_built_from_the_numbers() {
        assert_eq!(
            release_page(Some("1.4.0")),
            "https://github.com/krocon/log-commander/releases/tag/v1.4.0"
        );
        let latest = "https://github.com/krocon/log-commander/releases/latest";
        assert_eq!(release_page(None), latest);
        assert_eq!(release_page(Some("../../evil")), latest);
        assert_eq!(release_page(Some("1.4.0?x=https://evil.example")), latest);
    }

    /// Answers one request with `response` and hands back what was asked.
    fn serve_once(response: String) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/latest", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 1024];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = stream.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        (url, server)
    }

    fn ok(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn a_newer_release_is_reported() {
        let (url, server) = serve_once(ok(r#"{"tag_name":"v1.1.0"}"#));
        let info = check_at(&url, "1.0.0", false).unwrap();
        assert_eq!(
            info,
            UpdateInfo {
                current: "1.0.0".into(),
                latest: "1.1.0".into(),
                newer: true
            }
        );
        let request = server.join().unwrap().to_ascii_lowercase();
        assert!(
            request.contains("user-agent: log-commander/1.0.0"),
            "{request}"
        );
        assert!(
            request.contains("accept: application/vnd.github+json"),
            "{request}"
        );
    }

    #[test]
    fn the_same_or_an_older_release_is_not_newer() {
        for (latest, current) in [("v1.0.0", "1.0.0"), ("v0.9.0", "1.0.0")] {
            let (url, server) = serve_once(ok(&format!(r#"{{"tag_name":"{latest}"}}"#)));
            assert!(!check_at(&url, current, false).unwrap().newer);
            server.join().unwrap();
        }
    }

    #[test]
    fn a_refusal_and_a_strange_answer_are_errors() {
        let (url, server) = serve_once(
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
        );
        let error = check_at(&url, "1.0.0", false).unwrap_err();
        assert_eq!(error.code, ErrorCode::ConnectionFailed);
        assert!(error.message.contains("403"), "{}", error.message);
        server.join().unwrap();

        let (url, server) = serve_once(ok(r#"{"tag_name":"latest"}"#));
        let error = check_at(&url, "1.0.0", false).unwrap_err();
        assert_eq!(error.code, ErrorCode::ConnectionFailed);
        server.join().unwrap();
    }

    /// By hand, needs the network: `cargo test --lib update:: -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn asks_github() {
        let info = check("0.0.1").unwrap();
        println!("{info:?}");
        assert!(info.newer);
    }

    #[test]
    fn nobody_listening_is_an_error() {
        // A port that was free a moment ago: bound, read, closed.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let error = check_at(&format!("http://127.0.0.1:{port}/latest"), "1.0.0", false);
        assert_eq!(error.unwrap_err().code, ErrorCode::ConnectionFailed);
    }
}
