//! Thin command layer: argument mapping only, the logic lives in the session.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::filter::{SearchMode, SearchQuery};
use crate::level::Level;
use crate::model::{EntryRange, FilterInfo, FindHit, LogLine, SessionInfo, SessionUpdate, Stats};
use crate::profile::Profile;
use crate::session::{LogSession, OpenOptions, SessionManager};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LogView {
    All,
    Filtered,
}

/// File access and scans must not block a runtime worker.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?
}

fn session(manager: &SessionManager, id: u64) -> AppResult<Arc<LogSession>> {
    manager.session(id)
}

#[tauri::command]
pub async fn open_log(
    app: AppHandle,
    path: String,
    keep_on_rotate: Option<bool>,
    on_update: Channel<SessionUpdate>,
) -> AppResult<SessionInfo> {
    blocking(move || {
        let manager = app.state::<SessionManager>();
        let options = OpenOptions {
            keep_on_rotate: keep_on_rotate.unwrap_or(true),
        };
        let sink = Box::new(move |update: SessionUpdate| {
            // A closed webview just stops listening.
            let _ = on_update.send(update);
        });
        manager.open(&PathBuf::from(path), options, sink)
    })
    .await
}

#[tauri::command]
pub async fn close_log(app: AppHandle, session_id: u64) -> AppResult<()> {
    blocking(move || app.state::<SessionManager>().close(session_id)).await
}

#[tauri::command]
pub async fn get_lines(
    state: State<'_, SessionManager>,
    session_id: u64,
    view: LogView,
    start: usize,
    count: usize,
) -> AppResult<Vec<LogLine>> {
    let session = session(&state, session_id)?;
    blocking(move || session.get_lines(matches!(view, LogView::Filtered), start, count)).await
}

#[tauri::command]
pub async fn set_filter(
    state: State<'_, SessionManager>,
    session_id: u64,
    levels: Vec<Level>,
    search: String,
    is_regex: bool,
    case_sensitive: bool,
    mode: SearchMode,
) -> AppResult<FilterInfo> {
    let session = session(&state, session_id)?;
    let query = SearchQuery {
        text: search,
        is_regex,
        case_sensitive,
    };
    blocking(move || session.set_filter(&levels, &query, mode)).await
}

#[tauri::command]
pub async fn set_profile(
    state: State<'_, SessionManager>,
    session_id: u64,
    profile_id: String,
) -> AppResult<FilterInfo> {
    let session = session(&state, session_id)?;
    let profile = state.profile(&profile_id)?;
    blocking(move || session.set_profile(&profile)).await
}

#[tauri::command]
pub async fn get_stats(state: State<'_, SessionManager>, session_id: u64) -> AppResult<Stats> {
    Ok(session(&state, session_id)?.stats())
}

#[tauri::command]
pub async fn find_next(
    state: State<'_, SessionManager>,
    session_id: u64,
    from_line: Option<u32>,
    query: SearchQuery,
) -> AppResult<Option<FindHit>> {
    let session = session(&state, session_id)?;
    blocking(move || session.find(from_line, &query, true)).await
}

#[tauri::command]
pub async fn find_prev(
    state: State<'_, SessionManager>,
    session_id: u64,
    from_line: Option<u32>,
    query: SearchQuery,
) -> AppResult<Option<FindHit>> {
    let session = session(&state, session_id)?;
    blocking(move || session.find(from_line, &query, false)).await
}

#[tauri::command]
pub async fn get_position(
    state: State<'_, SessionManager>,
    session_id: u64,
    line: u32,
) -> AppResult<u32> {
    Ok(session(&state, session_id)?.position_of_line(line))
}

#[tauri::command]
pub async fn get_entry_range(
    state: State<'_, SessionManager>,
    session_id: u64,
    line: u32,
) -> AppResult<EntryRange> {
    Ok(session(&state, session_id)?.entry_range(line))
}

#[tauri::command]
pub async fn copy_lines(
    state: State<'_, SessionManager>,
    session_id: u64,
    first: u32,
    last: u32,
) -> AppResult<String> {
    let session = session(&state, session_id)?;
    blocking(move || session.copy_lines(first, last)).await
}

#[tauri::command]
pub async fn set_keep_on_rotate(
    state: State<'_, SessionManager>,
    session_id: u64,
    keep: bool,
) -> AppResult<()> {
    session(&state, session_id)?.set_keep_on_rotate(keep);
    Ok(())
}

#[tauri::command]
pub async fn set_frozen(
    state: State<'_, SessionManager>,
    session_id: u64,
    frozen: bool,
) -> AppResult<()> {
    session(&state, session_id)?.set_frozen(frozen);
    Ok(())
}

#[tauri::command]
pub async fn list_profiles(state: State<'_, SessionManager>) -> AppResult<Vec<Profile>> {
    Ok(state.profiles())
}

#[tauri::command]
pub async fn set_custom_profiles(
    state: State<'_, SessionManager>,
    profiles: Vec<Profile>,
) -> AppResult<()> {
    state.set_custom_profiles(profiles)
}
