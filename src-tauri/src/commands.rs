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

/// Windows event logs can be read here (prompt 018): the dialog offers the kind only then.
#[tauri::command]
pub fn winevent_supported() -> bool {
    crate::sources::winevent::SUPPORTED
}

/// The event log channels of this or another computer (prompt 018); connects like `open_source`
/// (same errors for passwords and rights).
#[tauri::command]
pub async fn winevent_channels(
    state: State<'_, SessionManager>,
    target: crate::sources::winevent::WinTarget,
    credentials: Option<crate::remote::Credentials>,
) -> AppResult<Vec<String>> {
    let store = state.remote().ok().map(|hub| hub.secret_store());
    blocking(move || {
        crate::sources::winevent::channels(
            &target,
            &credentials.unwrap_or_default(),
            store.as_deref(),
        )
    })
    .await
}

/// Removes the stored password of a remote computer for Windows events from the keychain.
#[tauri::command]
pub async fn forget_winevent_secret(
    state: State<'_, SessionManager>,
    target: crate::sources::winevent::WinTarget,
) -> AppResult<()> {
    let store = state.remote()?.secret_store();
    blocking(move || crate::sources::winevent::forget(&target, store.as_ref())).await
}

/// The first rows of a database query as they will be spooled (prompt 019): connects, checks the
/// query and the columns like `open_source` (same errors for passwords and TLS), nothing is kept.
#[tauri::command]
pub async fn db_preview(
    state: State<'_, SessionManager>,
    config: crate::sources::database::DbConfig,
    credentials: Option<crate::remote::Credentials>,
) -> AppResult<crate::sources::database::DbPreview> {
    let store = state.remote().ok().map(|hub| hub.secret_store());
    blocking(move || {
        crate::sources::database::preview(
            &config,
            &credentials.unwrap_or_default(),
            store.as_deref(),
        )
    })
    .await
}

/// Tables and views for „Tabelle wählen“ (prompt 019); only the connection settings count.
#[tauri::command]
pub async fn db_tables(
    state: State<'_, SessionManager>,
    config: crate::sources::database::DbConfig,
    credentials: Option<crate::remote::Credentials>,
) -> AppResult<Vec<crate::sources::database::driver::TableName>> {
    let store = state.remote().ok().map(|hub| hub.secret_store());
    blocking(move || {
        crate::sources::database::tables(
            &config,
            &credentials.unwrap_or_default(),
            store.as_deref(),
        )
    })
    .await
}

/// Removes the stored password of a database server from the keychain.
#[tauri::command]
pub async fn forget_db_secret(
    state: State<'_, SessionManager>,
    config: crate::sources::database::DbConfig,
) -> AppResult<()> {
    let store = state.remote()?.secret_store();
    blocking(move || crate::sources::database::forget(&config, store.as_ref())).await
}

/// Keep the spool of a source when its tab closes (prompt 016).
#[tauri::command]
pub async fn set_spool_keep(
    state: State<'_, SessionManager>,
    session_id: u64,
    keep: bool,
    seq: Option<u64>,
) -> AppResult<()> {
    session(&state, session_id)?.set_spool_keep_at(keep, seq)
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
    seq: Option<u64>,
) -> AppResult<FilterInfo> {
    let session = session(&state, session_id)?;
    let query = SearchQuery {
        text: search,
        is_regex,
        case_sensitive,
    };
    blocking(move || {
        let own = session.view_filter(&levels, &query, mode, sources, expr.as_ref());
        session.set_view_filter_at(view_id.unwrap_or(0), own, seq)
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
    seq: Option<u64>,
) -> AppResult<FilterInfo> {
    let session = session(&state, session_id)?;
    let profile = state.profile(&profile_id)?;
    blocking(move || session.set_profile_at(&profile, seq)).await
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
    seq: Option<u64>,
) -> AppResult<()> {
    session(&state, session_id)?.set_keep_on_rotate_at(keep, seq)
}

#[tauri::command]
pub async fn set_frozen(
    state: State<'_, SessionManager>,
    session_id: u64,
    frozen: bool,
    seq: Option<u64>,
) -> AppResult<()> {
    session(&state, session_id)?.set_frozen_at(frozen, seq)
}

#[tauri::command]
pub async fn list_profiles(state: State<'_, SessionManager>) -> AppResult<Vec<Profile>> {
    Ok(state.profiles())
}

#[tauri::command]
pub async fn set_custom_profiles(
    state: State<'_, SessionManager>,
    profiles: Vec<Profile>,
    seq: Option<u64>,
) -> AppResult<()> {
    state.set_custom_profiles_at(profiles, seq)
}

/// Extraction rules for the profile of a session (prompt 011), right away for every open session of
/// that profile. Returns the new columns of the session.
#[tauri::command]
pub async fn set_extract_rules(
    app: AppHandle,
    session_id: u64,
    rules: Vec<ExtractRule>,
    seq: Option<u64>,
) -> AppResult<ColumnSet> {
    blocking(move || {
        app.state::<SessionManager>()
            .set_extract_rules_at(session_id, rules, seq)
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
    user: Option<String>,
    keep_fields: Option<bool>,
) -> AppResult<ReportSchema> {
    let session = session(&state, session_id)?;
    blocking(move || {
        session.open_report_for(
            user.as_deref().unwrap_or(""),
            fields,
            keep_fields.unwrap_or(false),
        )
    })
    .await
}

/// The dashboard is hidden: no more catching up (the file stays until the tab closes).
#[tauri::command]
pub async fn close_report(
    state: State<'_, SessionManager>,
    session_id: u64,
    user: Option<String>,
) -> AppResult<()> {
    let session = session(&state, session_id)?;
    blocking(move || {
        session.close_report_for(user.as_deref().unwrap_or(""));
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

/// `#rrggbb` as its channels; anything else (short forms, names, `rgb()`, whitespace) is refused.
pub fn parse_hex_rgb(color: &str) -> Option<(u8, u8, u8)> {
    let hex = color.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    Some((channel(0)?, channel(2)?, channel(4)?))
}

/// Prompt 020: the window frame follows the colour scheme. `dark` forces the frame's appearance; `None`
/// (follow the system) leaves it to the system, because the frame's appearance also sets the webview's
/// `prefers-color-scheme` and a forced one would no longer follow the system. The window starts hidden
/// (`visible: false`) so a light scheme does not flash dark; the first call shows it.
#[tauri::command]
pub fn set_window_chrome(app: AppHandle, color: String, dark: Option<bool>) -> AppResult<()> {
    let (r, g, b) = parse_hex_rgb(&color)
        .ok_or_else(|| AppError::new(ErrorCode::Unsupported, "not a #rrggbb colour"))?;
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let io = |e: tauri::Error| AppError::new(ErrorCode::Io, e.to_string());
    let theme = dark.map(|d| {
        if d {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }
    });
    window.set_theme(theme).map_err(io)?;
    window
        .set_background_color(Some(tauri::window::Color(r, g, b, 255)))
        .map_err(io)?;
    show_main(&app);
    Ok(())
}

/// One menu entry (an action id of `MENU_ACTIONS`) and its shortcut in the keymap notation, `None` = none.
#[derive(Debug, Clone, Deserialize)]
pub struct MenuAccelerator {
    pub id: String,
    pub shortcut: Option<String>,
}

/// Prompt 021: the accelerators of the menu entries follow the keymap. Shortcuts a menu cannot carry (chords,
/// plain keys) leave the entry without one; the page handles them. Unknown ids are refused.
#[tauri::command]
pub fn set_menu_accelerators(app: AppHandle, items: Vec<MenuAccelerator>) -> AppResult<()> {
    use crate::menu_accel::{native_accelerator, MENU_ACTIONS};
    if items.len() > MENU_ACTIONS.len() {
        return Err(AppError::new(
            ErrorCode::Unsupported,
            "too many menu entries",
        ));
    }
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let macos = cfg!(target_os = "macos");
    for item in items {
        if !MENU_ACTIONS.contains(&item.id.as_str()) {
            return Err(AppError::new(ErrorCode::Unsupported, "not a menu entry"));
        }
        let accelerator = item
            .shortcut
            .as_deref()
            .and_then(|s| native_accelerator(s, macos));
        if let Some(entry) = find_menu_item(&menu.items().unwrap_or_default(), &item.id) {
            entry
                .set_accelerator(accelerator)
                .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?;
        }
    }
    Ok(())
}

/// A menu item by id, in submenus too (`Menu::get` only looks at the top level).
fn find_menu_item<R: tauri::Runtime>(
    items: &[tauri::menu::MenuItemKind<R>],
    id: &str,
) -> Option<tauri::menu::MenuItem<R>> {
    for item in items {
        if let Some(plain) = item.as_menuitem() {
            if plain.id() == id {
                return Some(plain.clone());
            }
        } else if let Some(sub) = item.as_submenu() {
            if let Some(found) = find_menu_item(&sub.items().unwrap_or_default(), id) {
                return Some(found);
            }
        }
    }
    None
}

/// Shows the main window if it is still hidden (after the first scheme, or after a time limit).
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible().unwrap_or(true) {
            let _ = window.show();
        }
    }
}

// ---------------------------------------------------------------- prompt 022: AI control over MCP

/// What goes to the frontend over the channel of `subscribe_mcp`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpEvent {
    /// A tool call to run; answer with `mcp_reply`.
    #[serde(rename_all = "camelCase")]
    Call {
        call_id: u64,
        tool: String,
        args: serde_json::Value,
    },
    /// The bridge or its connections changed.
    Status { info: McpInfo },
}

/// AI control as the settings and the status bar show it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInfo {
    /// The bridge is open (a port and the endpoint file exist).
    pub enabled: bool,
    pub connections: usize,
    /// The sidecar next to the app program, `None` = missing.
    pub sidecar: Option<String>,
    /// A debug build: a missing sidecar is built with `cargo build -p lc-mcp`.
    pub debug: bool,
}

type McpChannel = Arc<std::sync::Mutex<Option<Channel<McpEvent>>>>;

/// The bridge of the process, the calls in flight and the frontend's channel.
#[derive(Default)]
pub struct McpState {
    host: std::sync::Mutex<Option<lc_mcp::host::Host>>,
    calls: Arc<crate::mcp::Calls>,
    channel: McpChannel,
}

impl McpState {
    fn connections(&self) -> Option<usize> {
        self.host
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|h| h.connections())
    }

    /// Closes the bridge (quitting): port closed, connections cut, endpoint file removed.
    pub fn shutdown(&self) {
        self.host.lock().unwrap_or_else(|e| e.into_inner()).take();
        self.calls
            .fail_all("not_running", "Log Commander is closing");
    }
}

struct TauriFrontend {
    channel: McpChannel,
}

impl crate::mcp::Frontend for TauriFrontend {
    fn send(&self, id: u64, tool: &str, args: &serde_json::Value) -> bool {
        let channel = self.channel.lock().unwrap_or_else(|e| e.into_inner());
        channel.as_ref().is_some_and(|c| {
            c.send(McpEvent::Call {
                call_id: id,
                tool: tool.to_owned(),
                args: args.clone(),
            })
            .is_ok()
        })
    }
}

struct McpBridge {
    router: crate::mcp::Router<TauriFrontend>,
}

impl lc_mcp::host::Handler for McpBridge {
    fn call(
        &self,
        tool: &str,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value, lc_mcp::bridge::BridgeError> {
        self.router.call(tool, args)
    }

    fn status(&self, connections: usize) {
        let channel = self
            .router
            .frontend
            .channel
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(c) = channel.as_ref() {
            let _ = c.send(McpEvent::Status {
                info: McpInfo {
                    enabled: true,
                    connections,
                    sidecar: mcp_sidecar_path().map(|p| p.to_string_lossy().into_owned()),
                    debug: cfg!(debug_assertions),
                },
            });
        }
    }
}

/// `log-commander-mcp[.exe]` next to the app program (where `bundle.externalBin` and `cargo build` put it).
pub fn mcp_sidecar_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let p = exe
        .parent()?
        .join(format!("log-commander-mcp{}", std::env::consts::EXE_SUFFIX));
    p.is_file().then_some(p)
}

fn mcp_info_of(state: &McpState) -> McpInfo {
    let connections = state.connections();
    McpInfo {
        enabled: connections.is_some(),
        connections: connections.unwrap_or(0),
        sidecar: mcp_sidecar_path().map(|p| p.to_string_lossy().into_owned()),
        debug: cfg!(debug_assertions),
    }
}

/// `LOG_COMMANDER_MCP_ENDPOINT` (tests, e2e) or `<app config>/mcp.json`.
fn mcp_endpoint_file(app: &AppHandle) -> AppResult<PathBuf> {
    if let Some(p) = std::env::var_os(lc_mcp::bridge::ENDPOINT_ENV).filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(p));
    }
    app.path()
        .app_config_dir()
        .map(|d| d.join(lc_mcp::bridge::ENDPOINT_FILE))
        .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))
}

/// The frontend listens for tool calls; a new channel (reload) replaces the old one, calls of the old one fail.
#[tauri::command]
pub fn subscribe_mcp(state: State<'_, McpState>, on_event: Channel<McpEvent>) -> McpInfo {
    state
        .calls
        .fail_all("not_running", "the window of Log Commander was reloaded");
    *state.channel.lock().unwrap_or_else(|e| e.into_inner()) = Some(on_event);
    mcp_info_of(&state)
}

/// Opens or closes the bridge (setting „KI-Steuerung“). Off: no port, no endpoint file, every connection cut.
#[tauri::command]
pub fn mcp_set_enabled(
    app: AppHandle,
    state: State<'_, McpState>,
    enabled: bool,
) -> AppResult<McpInfo> {
    let mut host = state.host.lock().unwrap_or_else(|e| e.into_inner());
    match (enabled, host.is_some()) {
        (true, false) => {
            let file = mcp_endpoint_file(&app)?;
            let bridge = McpBridge {
                router: crate::mcp::Router::new(
                    TauriFrontend {
                        channel: state.channel.clone(),
                    },
                    state.calls.clone(),
                ),
            };
            let started = lc_mcp::host::Host::start(Arc::new(bridge), &file)
                .map_err(|e| AppError::from_io(&e, &file))?;
            *host = Some(started);
        }
        (false, true) => {
            *host = None;
            state
                .calls
                .fail_all("not_running", "AI control was turned off");
        }
        _ => {}
    }
    drop(host);
    Ok(mcp_info_of(&state))
}

#[tauri::command]
pub fn mcp_info(state: State<'_, McpState>) -> McpInfo {
    mcp_info_of(&state)
}

/// The frontend's answer to call `call_id`.
#[tauri::command]
pub fn mcp_reply(
    state: State<'_, McpState>,
    call_id: u64,
    result: Option<serde_json::Value>,
    error: Option<lc_mcp::bridge::BridgeError>,
) {
    let r = match error {
        Some(e) => Err(e),
        None => Ok(result.unwrap_or(serde_json::Value::Null)),
    };
    state.calls.complete(call_id, r);
}

/// „Trennen“: closes every connection; the bridge stays open for a new one.
#[tauri::command]
pub fn mcp_disconnect(state: State<'_, McpState>) {
    if let Some(h) = state
        .host
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        h.disconnect();
    }
}

/// „Verbindung testen“: starts the sidecar like an MCP client, handshake and one `get_workspace`.
#[tauri::command]
pub async fn mcp_probe() -> AppResult<lc_mcp::probe::Probe> {
    let Some(sidecar) = mcp_sidecar_path() else {
        return Err(AppError::new(
            ErrorCode::NotFound,
            "log-commander-mcp is missing next to the app",
        ));
    };
    tauri::async_runtime::spawn_blocking(move || {
        lc_mcp::probe::probe(&sidecar, std::time::Duration::from_secs(5))
    })
    .await
    .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))
}

#[cfg(test)]
mod chrome_tests {
    use super::parse_hex_rgb;

    #[test]
    fn only_six_digit_hex_is_a_window_colour() {
        assert_eq!(parse_hex_rgb("#14171c"), Some((0x14, 0x17, 0x1c)));
        assert_eq!(parse_hex_rgb("#FBFBFC"), Some((0xfb, 0xfb, 0xfc)));
        for bad in [
            "",
            "#",
            "14171c",
            "#fff",
            "#14171c00",
            "#14171g",
            " #14171c",
            "#14171c ",
            "red",
            "rgb(1, 2, 3)",
            "#ü1717",
            "#+1+1+1",
        ] {
            assert_eq!(parse_hex_rgb(bad), None, "{bad:?}");
        }
    }
}
