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

/// A line for the test harness, which reads the app's stdout.
#[tauri::command]
pub fn e2e_report(message: String) {
    let mut out = std::io::stdout();
    let _ = writeln!(out, "E2E {message}");
    let _ = out.flush();
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
    }
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(false);
    builder
}
