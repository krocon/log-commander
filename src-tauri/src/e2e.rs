//! Debug builds only: runs a scenario script inside the real webview against the real backend, for
//! `npm run e2e` (see scripts/e2e/). Release builds do not contain this module.

use std::io::Write;

const SCRIPT_ENV: &str = "LC_E2E_SCRIPT";
/// Set by `run.mjs --foreground` (frame measurements of the spikes need a visible, unobscured window).
const FOREGROUND_ENV: &str = "LC_E2E_FOREGROUND";

/// The scenario, if this run is an end-to-end test.
pub fn scenario() -> Option<String> {
    let path = std::env::var_os(SCRIPT_ENV)?;
    std::fs::read_to_string(path).ok()
}

/// This run is an end-to-end test (the harness set the scenario).
pub fn scenario_active() -> bool {
    std::env::var_os(SCRIPT_ENV).is_some()
}

/// A line for the test harness, which reads the app's stdout.
#[tauri::command]
pub fn e2e_report(message: String) {
    let mut out = std::io::stdout();
    let _ = writeln!(out, "E2E {message}");
    let _ = out.flush();
}

static SFTP_SERVERS: std::sync::Mutex<Vec<crate::remote::testserver::TestSftp>> =
    std::sync::Mutex::new(Vec::new());

/// Starts an SFTP server in the process for the scenario (prompt 017) serving `root`, with host key
/// `seed`, on `port` (0: any); returns its port. User and password: `remote::testserver`.
#[tauri::command]
pub fn e2e_sftp_server(root: String, seed: u8, port: Option<u16>) -> Result<u16, String> {
    if !scenario_active() {
        return Err("only in end-to-end runs".into());
    }
    let server = crate::remote::testserver::start(root.into(), port.unwrap_or(0), seed, None)
        .map_err(|e| e.to_string())?;
    let port = server.port;
    SFTP_SERVERS.lock().map_err(|e| e.to_string())?.push(server);
    Ok(port)
}

/// Stops the scenario's SFTP server on `port` (it went away; another one may take the port).
#[tauri::command]
pub fn e2e_sftp_stop(port: u16) -> Result<(), String> {
    let stopped: Vec<_> = {
        let mut servers = SFTP_SERVERS.lock().map_err(|e| e.to_string())?;
        let (stop, keep): (Vec<_>, Vec<_>) = servers.drain(..).partition(|s| s.port == port);
        *servers = keep;
        stop
    };
    for server in &stopped {
        server.stop();
    }
    Ok(())
}

/// An end-to-end run opens its window behind the other windows and without focus, and on macOS does
/// not activate the app at launch, so the test does not take over the screen. The window stays a normal
/// visible one: WebKit throttles hidden windows (the scenario waits with MutationObserver and
/// MessageChannel, not animation frames). `LC_E2E_FOREGROUND` keeps the usual start.
pub fn keep_in_background(
    builder: tauri::Builder<tauri::Wry>,
    context: &mut tauri::Context<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    if std::env::var_os(FOREGROUND_ENV).is_some() {
        return builder;
    }
    for window in &mut context.config_mut().app.windows {
        window.focus = false;
        window.always_on_bottom = true;
        // Visible from the start (the app shows a hidden window with its colour scheme, prompt 020): showing
        // it later could bring it to the front.
        window.visible = true;
    }
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(false);
    builder
}
