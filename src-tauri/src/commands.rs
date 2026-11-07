//! Thin command layer: argument mapping only, the logic lives in the session.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::extract::{ExtractRule, FieldSuggestion, RulePreview};
use crate::filter::{SearchMode, SearchQuery};
use crate::filter_expr::FilterExpr;
use crate::level::Level;
use crate::merge::MergeSource;
use crate::model::{
    ColumnSet, EntryDetail, EntryRange, FieldPreview, FilterInfo, FindHit, LogLine, MergeCandidate,
    Overview, ReportResult, ReportSchema, SessionInfo, SessionUpdate, Stats,
};
use crate::profile::Profile;
use crate::session::{LogSession, OpenOptions, SessionManager};
use serde::Deserialize;
use std::collections::HashMap;
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
            ..OpenOptions::default()
        };
        let sink = Box::new(move |update: SessionUpdate| {
            // A closed webview just stops listening.
            let _ = on_update.send(update);
        });
        manager.open(&PathBuf::from(path), options, sink)
    })
    .await
}

/// One file of a merge as the dialog sends it; without a profile the suggestion applies.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSourceArg {
    pub path: String,
    pub profile_id: Option<String>,
}

/// Opens 2 to 16 files as one tab, their entries in time order (prompt 006).
#[tauri::command]
pub async fn open_merged(
    app: AppHandle,
    sources: Vec<MergeSourceArg>,
    keep_on_rotate: Option<bool>,
    on_update: Channel<SessionUpdate>,
) -> AppResult<SessionInfo> {
    blocking(move || {
        let manager = app.state::<SessionManager>();
        let sources = sources
            .into_iter()
            .map(|s| {
                Ok(MergeSource {
                    path: PathBuf::from(s.path),
                    profile: s.profile_id.map(|id| manager.profile(&id)).transpose()?,
                })
            })
            .collect::<AppResult<Vec<_>>>()?;
        let options = OpenOptions {
            keep_on_rotate: keep_on_rotate.unwrap_or(true),
            ..OpenOptions::default()
        };
        let sink = Box::new(move |update: SessionUpdate| {
            let _ = on_update.send(update);
        });
        manager.open_merged(sources, options, sink)
    })
    .await
}

/// Profile suggestion, encoding and first/last time of a file, for the merge dialog.
#[tauri::command]
pub async fn inspect_merge_source(path: String) -> AppResult<MergeCandidate> {
    blocking(move || crate::merge::inspect(&PathBuf::from(path))).await
}

/// Merges all files of a merge again, late entries in their place (new epoch).
#[tauri::command]
pub async fn resort(state: State<'_, SessionManager>, session_id: u64) -> AppResult<()> {
    session(&state, session_id)?.resort()
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
#[allow(clippy::too_many_arguments)]
pub async fn set_filter(
    state: State<'_, SessionManager>,
    session_id: u64,
    levels: Vec<Level>,
    search: String,
    is_regex: bool,
    case_sensitive: bool,
    mode: SearchMode,
    sources: Option<u16>,
    expr: Option<FilterExpr>,
) -> AppResult<FilterInfo> {
    let session = session(&state, session_id)?;
    let query = SearchQuery {
        text: search,
        is_regex,
        case_sensitive,
    };
    blocking(move || session.set_filter_expr(&levels, &query, mode, sources, expr.as_ref())).await
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
pub async fn get_columns(
    state: State<'_, SessionManager>,
    session_id: u64,
) -> AppResult<ColumnSet> {
    Ok(session(&state, session_id)?.columns())
}

/// Tries a profile's layout on one line (settings dialog), without saving anything.
#[tauri::command]
pub async fn preview_fields(profile: Profile, line: String) -> AppResult<FieldPreview> {
    blocking(move || crate::fields::preview(&profile, &line)).await
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

/// What the overview ruler draws: level bits per pixel bucket and where the given lines are.
#[tauri::command]
pub async fn get_overview(
    state: State<'_, SessionManager>,
    session_id: u64,
    buckets: usize,
    lines: Vec<u32>,
) -> AppResult<Overview> {
    session(&state, session_id)?.overview(buckets, &lines)
}

/// Next or previous entry of one of `levels` in the view, from the summary, without reading text.
#[tauri::command]
pub async fn find_level(
    state: State<'_, SessionManager>,
    session_id: u64,
    from_position: Option<u32>,
    forward: bool,
    levels: Vec<Level>,
) -> AppResult<Option<FindHit>> {
    Ok(session(&state, session_id)?.find_level(from_position, forward, &levels))
}

#[tauri::command]
pub async fn get_entry_range(
    state: State<'_, SessionManager>,
    session_id: u64,
    line: u32,
) -> AppResult<EntryRange> {
    Ok(session(&state, session_id)?.entry_range(line))
}

/// The whole entry of a line for the detail panel, without filter and cut after 1 MiB.
#[tauri::command]
pub async fn get_entry(
    state: State<'_, SessionManager>,
    session_id: u64,
    line: u32,
) -> AppResult<EntryDetail> {
    let session = session(&state, session_id)?;
    blocking(move || session.get_entry(line)).await
}

/// The lines between two line numbers as text; `view: all` ignores the filter (default: filtered).
#[tauri::command]
pub async fn copy_lines(
    state: State<'_, SessionManager>,
    session_id: u64,
    first: u32,
    last: u32,
    view: Option<LogView>,
) -> AppResult<String> {
    let session = session(&state, session_id)?;
    blocking(move || match view {
        Some(LogView::All) => session.copy_all_lines(first, last),
        _ => session.copy_lines(first, last),
    })
    .await
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

/// Extraction rules for the profile of a session (prompt 011), right away for every open session of
/// that profile. Returns the new columns of the session.
#[tauri::command]
pub async fn set_extract_rules(
    app: AppHandle,
    session_id: u64,
    rules: Vec<ExtractRule>,
) -> AppResult<ColumnSet> {
    blocking(move || {
        app.state::<SessionManager>()
            .set_extract_rules(session_id, rules)
    })
    .await
}

/// All rules from the settings, per profile id, at start.
#[tauri::command]
pub async fn load_extract_rules(
    app: AppHandle,
    rules: HashMap<String, Vec<ExtractRule>>,
) -> AppResult<()> {
    blocking(move || {
        app.state::<SessionManager>().load_extract_rules(rules);
        Ok(())
    })
    .await
}

/// Candidates for rules from a sample of entry heads over the whole file.
#[tauri::command]
pub async fn suggest_fields(
    state: State<'_, SessionManager>,
    session_id: u64,
) -> AppResult<Vec<FieldSuggestion>> {
    let session = session(&state, session_id)?;
    blocking(move || session.suggest_fields()).await
}

/// A rule tried on some lines (the whole line is the source), for the dialog: checks it, too.
#[tauri::command]
pub async fn preview_extract_rule(rule: ExtractRule, lines: Vec<String>) -> AppResult<RulePreview> {
    blocking(move || {
        if lines.len() > 5000 {
            return Err(AppError::new(ErrorCode::TooLarge, "at most 5000 lines"));
        }
        crate::extract::preview(&rule, &lines)
    })
    .await
}

/// The dashboard of a tab is shown (prompt 012): builds the database the first time, keeps it up to
/// date every 5 s while open. `fields`: column ids to store (`None`: the numbers).
#[tauri::command]
pub async fn open_report(
    state: State<'_, SessionManager>,
    session_id: u64,
    fields: Option<Vec<String>>,
) -> AppResult<ReportSchema> {
    let session = session(&state, session_id)?;
    blocking(move || session.open_report(fields)).await
}

/// The dashboard is hidden: no more catching up (the file stays until the tab closes).
#[tauri::command]
pub async fn close_report(state: State<'_, SessionManager>, session_id: u64) -> AppResult<()> {
    let session = session(&state, session_id)?;
    blocking(move || {
        session.close_report();
        Ok(())
    })
    .await
}

/// One read-only SQL query on the dashboard database; a newer query of the same `slot` (panel)
/// stops an older one.
#[tauri::command]
pub async fn run_report(
    state: State<'_, SessionManager>,
    session_id: u64,
    sql: String,
    slot: Option<String>,
) -> AppResult<ReportResult> {
    let session = session(&state, session_id)?;
    blocking(move || session.run_report(&sql, slot.as_deref().unwrap_or(""))).await
}

/// Columns of the dashboard table and the fields that could be added.
#[tauri::command]
pub async fn get_report_schema(
    state: State<'_, SessionManager>,
    session_id: u64,
) -> AppResult<ReportSchema> {
    let session = session(&state, session_id)?;
    blocking(move || session.report_schema()).await
}
