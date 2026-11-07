//! Thin command layer: argument mapping only, the logic lives in the session.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::export::{ExportFormat, ExportJobs, ExportRange, ExportRequest};
use crate::extract::{ExtractRule, FieldSuggestion, RulePreview};
use crate::filter::{SearchMode, SearchQuery};
use crate::filter_expr::FilterExpr;
use crate::level::Level;
use crate::merge::MergeSource;
use crate::model::{
    Anchor, ColumnSet, EntryDetail, EntryRange, ExportProgress, ExportState, FieldPreview,
    FilterInfo, FindHit, LogLine, MergeCandidate, Overview, ReportResult, ReportSchema,
    SessionInfo, SessionUpdate, Stats, TimeHit, Timeline, ViewInfo,
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

/// Starts a source without a file (prompt 016, e.g. a syslog listener) and opens its spool as a
/// tab. Errors of the configuration (port in use, address) come back before anything runs.
#[tauri::command]
pub async fn open_source(
    app: AppHandle,
    config: crate::sources::SourceConfig,
    keep: Option<bool>,
    credentials: Option<crate::remote::Credentials>,
    on_update: Channel<SessionUpdate>,
) -> AppResult<SessionInfo> {
    blocking(move || {
        let manager = app.state::<SessionManager>();
        let sink = Box::new(move |update: SessionUpdate| {
            let _ = on_update.send(update);
        });
        manager.open_source(
            config,
            keep.unwrap_or(false),
            credentials.unwrap_or_default(),
            OpenOptions::default(),
            sink,
        )
    })
    .await
}

/// Hosts of `~/.ssh/config` for the remote dialog (prompt 017; aliases without wildcards).
#[tauri::command]
pub async fn remote_hosts(
    state: State<'_, SessionManager>,
) -> AppResult<Vec<crate::remote::ssh_config::HostConfig>> {
    let hub = state.remote()?;
    blocking(move || Ok(hub.hosts())).await
}

/// A folder on the server for the dialog's file browser; connects like `open_source` (same errors
/// for host keys and secrets), the connection is shared with the files opened afterwards.
#[tauri::command]
pub async fn remote_list_dir(
    state: State<'_, SessionManager>,
    target: crate::remote::Target,
    credentials: Option<crate::remote::Credentials>,
    path: String,
) -> AppResult<crate::remote::RemoteListing> {
    let hub = state.remote()?;
    blocking(move || hub.list(&target, &credentials.unwrap_or_default(), &path)).await
}

/// Removes the stored password and passphrase of a target from the keychain.
#[tauri::command]
pub async fn forget_remote_secret(
    state: State<'_, SessionManager>,
    target: crate::remote::Target,
) -> AppResult<()> {
    let hub = state.remote()?;
    blocking(move || hub.forget(&target)).await
}

/// Keep the spool of a source when its tab closes (prompt 016).
#[tauri::command]
pub async fn set_spool_keep(
    state: State<'_, SessionManager>,
    session_id: u64,
    keep: bool,
) -> AppResult<()> {
    session(&state, session_id)?.set_spool_keep(keep)
}

/// Total size of a spool in MB (settings), for sources opened from now on.
#[tauri::command]
pub async fn set_spool_limit(state: State<'_, SessionManager>, megabytes: u64) -> AppResult<()> {
    state.set_spool_limit(megabytes.saturating_mul(crate::spool::MIB));
    Ok(())
}

/// Kept spools (`spool/kept` in the cache folder): how many and their size, for the settings.
#[tauri::command]
pub async fn kept_spools(state: State<'_, SessionManager>) -> AppResult<crate::model::KeptSpools> {
    let root = state.spool_root()?;
    blocking(move || {
        let (count, bytes) = root.kept_usage();
        Ok(crate::model::KeptSpools { count, bytes })
    })
    .await
}

/// Deletes the kept spools; returns how many went.
#[tauri::command]
pub async fn delete_kept_spools(state: State<'_, SessionManager>) -> AppResult<u32> {
    let root = state.spool_root()?;
    blocking(move || Ok(root.delete_kept())).await
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

/// Lines of a view (`view_id`, default 0 = the tab of the file, prompt 013).
#[tauri::command]
pub async fn get_lines(
    state: State<'_, SessionManager>,
    session_id: u64,
    view: LogView,
    start: usize,
    count: usize,
    view_id: Option<u32>,
) -> AppResult<Vec<LogLine>> {
    let session = session(&state, session_id)?;
    let filtered = matches!(view, LogView::Filtered);
    blocking(move || session.get_lines_of(view_id.unwrap_or(0), filtered, start, count)).await
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
    view_id: Option<u32>,
) -> AppResult<FilterInfo> {
    let session = session(&state, session_id)?;
    let query = SearchQuery {
        text: search,
        is_regex,
        case_sensitive,
    };
    blocking(move || {
        let own = session.view_filter(&levels, &query, mode, sources, expr.as_ref());
        session.set_view_filter(view_id.unwrap_or(0), own)
    })
    .await
}

/// A filter as a tab of its own (prompt 013): a view below `parent_view_id` that shows its result and
/// filters further with its own filter (same arguments as `set_filter`). Updates go to `on_update`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn open_view(
    state: State<'_, SessionManager>,
    session_id: u64,
    parent_view_id: u32,
    levels: Vec<Level>,
    search: String,
    is_regex: bool,
    case_sensitive: bool,
    mode: SearchMode,
    sources: Option<u16>,
    expr: Option<FilterExpr>,
    on_update: Channel<SessionUpdate>,
) -> AppResult<ViewInfo> {
    let session = session(&state, session_id)?;
    let query = SearchQuery {
        text: search,
        is_regex,
        case_sensitive,
    };
    blocking(move || {
        let own = session.view_filter(&levels, &query, mode, sources, expr.as_ref());
        let sink = Box::new(move |update: SessionUpdate| {
            let _ = on_update.send(update);
        });
        session.open_view(parent_view_id, own, sink)
    })
    .await
}

/// Closes one view; its children keep their filter. The last tab of a file closes with `close_log`.
#[tauri::command]
pub async fn close_view(
    state: State<'_, SessionManager>,
    session_id: u64,
    view_id: u32,
) -> AppResult<()> {
    session(&state, session_id)?.close_view(view_id)
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
pub async fn get_stats(
    state: State<'_, SessionManager>,
    session_id: u64,
    view_id: Option<u32>,
) -> AppResult<Stats> {
    session(&state, session_id)?.stats_of(view_id.unwrap_or(0))
}

#[tauri::command]
pub async fn find_next(
    state: State<'_, SessionManager>,
    session_id: u64,
    from_line: Option<u32>,
    query: SearchQuery,
    view_id: Option<u32>,
) -> AppResult<Option<FindHit>> {
    let session = session(&state, session_id)?;
    blocking(move || session.find_in(view_id.unwrap_or(0), from_line, &query, true)).await
}

#[tauri::command]
pub async fn find_prev(
    state: State<'_, SessionManager>,
    session_id: u64,
    from_line: Option<u32>,
    query: SearchQuery,
    view_id: Option<u32>,
) -> AppResult<Option<FindHit>> {
    let session = session(&state, session_id)?;
    blocking(move || session.find_in(view_id.unwrap_or(0), from_line, &query, false)).await
}

#[tauri::command]
pub async fn get_position(
    state: State<'_, SessionManager>,
    session_id: u64,
    line: u32,
    view_id: Option<u32>,
) -> AppResult<u32> {
    session(&state, session_id)?.position_in(view_id.unwrap_or(0), line)
}

/// What the overview ruler draws: level bits per pixel bucket and where the given lines are.
#[tauri::command]
pub async fn get_overview(
    state: State<'_, SessionManager>,
    session_id: u64,
    buckets: usize,
    lines: Vec<u32>,
    view_id: Option<u32>,
) -> AppResult<Overview> {
    session(&state, session_id)?.overview_of(view_id.unwrap_or(0), buckets, &lines)
}

/// The timeline (prompt 014): entries of the whole file per time bucket, from the time summary.
#[tauri::command]
pub async fn get_timeline(
    state: State<'_, SessionManager>,
    session_id: u64,
    from: Option<i64>,
    to: Option<i64>,
    buckets: usize,
) -> AppResult<Timeline> {
    session(&state, session_id)?.timeline(from, to, buckets)
}

/// The first entry at or after a time (microseconds, UTC) in the view; reads the heads of one chunk.
#[tauri::command]
pub async fn position_at_time(
    state: State<'_, SessionManager>,
    session_id: u64,
    ts: i64,
    view_id: Option<u32>,
) -> AppResult<Option<TimeHit>> {
    let session = session(&state, session_id)?;
    blocking(move || session.position_at_time(view_id.unwrap_or(0), ts)).await
}

/// Next or previous entry of one of `levels` in the view, from the summary, without reading text.
#[tauri::command]
pub async fn find_level(
    state: State<'_, SessionManager>,
    session_id: u64,
    from_position: Option<u32>,
    forward: bool,
    levels: Vec<Level>,
    view_id: Option<u32>,
) -> AppResult<Option<FindHit>> {
    session(&state, session_id)?.find_level_in(
        view_id.unwrap_or(0),
        from_position,
        forward,
        &levels,
    )
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
    view_id: Option<u32>,
) -> AppResult<String> {
    let session = session(&state, session_id)?;
    blocking(move || match view {
        Some(LogView::All) => session.copy_all_lines(first, last),
        _ => session.copy_lines_of(view_id.unwrap_or(0), first, last),
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

// ---- Export, anchors and workspaces (prompt 015) ----

/// Writes a view, a selection or the whole file into `target_path` as a background job; returns its
/// id at once. Progress (at most every 100 ms, and the end) goes to `on_progress`. The target is
/// checked first (absolute, extension of the format, not the open log itself).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_view(
    app: AppHandle,
    session_id: u64,
    view_id: Option<u32>,
    range: ExportRange,
    format: ExportFormat,
    columns: Option<Vec<String>>,
    target_path: String,
    on_progress: Channel<ExportProgress>,
) -> AppResult<u64> {
    let session = session(&app.state::<SessionManager>(), session_id)?;
    let request = ExportRequest {
        view: view_id.unwrap_or(0),
        range,
        format,
        columns: columns.unwrap_or_default(),
        target: PathBuf::from(target_path),
    };
    let checked = request.clone();
    let check_session = Arc::clone(&session);
    blocking(move || {
        let target = crate::export::validate_target(&checked.target, checked.format)?;
        crate::export::check_not_source(&target, &check_session)
    })
    .await?;
    let (job, cancel) = app.state::<ExportJobs>().start(&request.target)?;
    let handle = app.clone();
    std::thread::Builder::new()
        .name(format!("export-{job}"))
        .spawn(move || {
            let result = crate::export::run_export(&session, &request, job, &cancel, |p| {
                let _ = on_progress.send(p.clone());
            });
            if let Err(error) = result {
                let _ = on_progress.send(ExportProgress {
                    job_id: job,
                    state: ExportState::Failed,
                    lines: 0,
                    total: 0,
                    bytes: 0,
                    path: request.target.display().to_string(),
                    error: Some(error),
                });
            }
            handle.state::<ExportJobs>().finish(job);
        })
        .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?;
    Ok(job)
}

/// Stops a running export; its temporary file is removed. False if it is over already.
#[tauri::command]
pub async fn cancel_export(jobs: State<'_, ExportJobs>, job_id: u64) -> AppResult<bool> {
    Ok(jobs.cancel(job_id))
}

/// Anchors of lines (bookmarks, notes, scroll position of a workspace); `None` past the end.
#[tauri::command]
pub async fn line_anchors(
    state: State<'_, SessionManager>,
    session_id: u64,
    lines: Vec<u32>,
) -> AppResult<Vec<Option<Anchor>>> {
    let session = session(&state, session_id)?;
    blocking(move || session.line_anchors(&lines)).await
}

/// The lines of anchors in the file as it is now; `None` where none fits.
#[tauri::command]
pub async fn resolve_anchors(
    state: State<'_, SessionManager>,
    session_id: u64,
    anchors: Vec<Anchor>,
) -> AppResult<Vec<Option<u32>>> {
    let session = session(&state, session_id)?;
    blocking(move || session.resolve_anchors(&anchors)).await
}

/// The text of a `.lcw` file (at most 8 MB); the frontend validates it.
#[tauri::command]
pub async fn read_workspace(path: String) -> AppResult<String> {
    blocking(move || crate::workspace::read(&PathBuf::from(path))).await
}

/// Writes a `.lcw` file (and only such a file).
#[tauri::command]
pub async fn write_workspace(path: String, content: String) -> AppResult<()> {
    blocking(move || crate::workspace::write(&PathBuf::from(path), &content)).await
}

/// Whether native dialogs may take scripted answers (`window.__lcDialogPaths`): only in a debug
/// build running an end-to-end scenario, never in a release build.
#[tauri::command]
pub fn scripted_dialogs() -> bool {
    #[cfg(debug_assertions)]
    {
        crate::e2e::scenario_active()
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

/// Which of the files of a workspace exist (network paths are never touched).
#[tauri::command]
pub async fn probe_paths(paths: Vec<String>) -> AppResult<Vec<crate::workspace::PathProbe>> {
    blocking(move || crate::workspace::probe(&paths)).await
}
