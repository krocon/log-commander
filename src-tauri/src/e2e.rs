//! Debug builds only: runs a scenario script inside the real webview against the real backend, for
//! `npm run e2e` (see scripts/e2e/). Release builds do not contain this module.

use std::io::Write;

const SCRIPT_ENV: &str = "LC_E2E_SCRIPT";

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
