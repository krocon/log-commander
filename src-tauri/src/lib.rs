//! Log Commander backend. The Rust side holds the data (a line index per open file); the frontend
//! only ever shows a window of it.
//!
//! - `session`: open files, queries, background jobs
//! - `tail`: following a file (notify + polling, partial lines, truncation, rotation)
//! - `indexer`: line index, block splitter, reading text back
//! - `level`, `profile`: level detection
//! - `fields`, `timestamp`: format detection, fields of a line, timestamps
//! - `filter`: filtered line list, text search
//! - `merge`: several files as one session, in time order
//! - `report_db`: the dashboard database (SQLite) and its guarded queries
//! - `export`, `anchor`, `workspace`: export jobs, anchored lines, workspace files (prompt 015)
//! - `spool`, `sources`: sources without a file (syslog …) write a spool the session follows (016)
//! - `commands`: the thin Tauri command layer; everything else is free of Tauri

pub mod anchor;
pub mod commands;
#[cfg(debug_assertions)]
pub mod e2e;
pub mod encoding;
pub mod error;
pub mod export;
pub mod extract;
pub mod fields;
pub mod filter;
pub mod filter_expr;
pub mod indexer;
pub mod level;
pub mod merge;
pub mod model;
pub mod overview;
pub mod platform;
pub mod profile;
pub mod remote;
pub mod report_db;
pub mod session;
pub mod sources;
pub mod spool;
pub mod tail;
pub mod timeline;
pub mod timestamp;
pub mod views;
pub mod workspace;

use session::SessionManager;
use tauri::menu::{Menu, MenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager};

const MENU_OPEN: &str = "open-log";
const MENU_OPEN_PATH: &str = "open-log-path";
const MENU_MERGE: &str = "merge-logs";
const MENU_EXPORT: &str = "export-log";
const MENU_WORKSPACE_OPEN: &str = "workspace-open";
const MENU_WORKSPACE_SAVE: &str = "workspace-save";
const MENU_OPEN_SOURCE: &str = "open-source";
const MENU_OPEN_REMOTE: &str = "open-remote";

pub fn run() {
    #[allow(unused_mut)] // changed by end-to-end runs (debug builds) only
    let mut context = tauri::generate_context!();
    let builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    let builder = match e2e::scenario() {
        Some(script) => {
            e2e::keep_in_background(builder, &mut context).on_page_load(move |webview, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished {
                    let _ = webview.eval(&script);
                }
            })
        }
        None => builder,
    };
    builder
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(SessionManager::default())
        .manage(export::ExportJobs::default())
        .setup(|app| {
            // Dashboard databases (prompt 012) live in this process's cache folder; what a crashed
            // process left behind is removed here.
            match app.path().app_cache_dir() {
                Ok(cache) => match report_db::ReportDir::prepare(&cache) {
                    Ok(dir) => {
                        app.state::<SessionManager>()
                            .set_report_dir(dir.path.clone());
                        app.manage(dir);
                    }
                    Err(e) => eprintln!("no folder for dashboards: {e}"),
                },
                Err(e) => eprintln!("no cache folder: {e}"),
            }
            // Spools of sources (prompt 016), cleaned up like the dashboards.
            if let Ok(cache) = app.path().app_cache_dir() {
                match spool::SpoolRoot::prepare(&cache) {
                    Ok(root) => app
                        .state::<SessionManager>()
                        .set_spool_root(std::sync::Arc::new(root)),
                    Err(e) => eprintln!("no folder for spools: {e}"),
                }
            }
            // SSH (prompt 017): host keys the user confirmed go into the app's own known_hosts,
            // `~/.ssh/known_hosts` is only read. End-to-end runs use neither the user's files nor
            // the real keychain.
            let hub = remote_hub(app.path().app_config_dir().ok());
            let hub = std::sync::Arc::new(hub);
            remote::start_sweeper(std::sync::Arc::downgrade(&hub));
            app.state::<SessionManager>().set_remote(hub);
            Ok(())
        })
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id() == MENU_OPEN {
                let _ = app.emit("menu-open", ());
            } else if event.id() == MENU_OPEN_PATH {
                let _ = app.emit("menu-open-path", ());
            } else if event.id() == MENU_MERGE {
                let _ = app.emit("menu-merge", ());
            } else if event.id() == MENU_EXPORT {
                let _ = app.emit("menu-export", ());
            } else if event.id() == MENU_WORKSPACE_OPEN {
                let _ = app.emit("menu-workspace-open", ());
            } else if event.id() == MENU_WORKSPACE_SAVE {
                let _ = app.emit("menu-workspace-save", ());
            } else if event.id() == MENU_OPEN_SOURCE {
                let _ = app.emit("menu-open-source", ());
            } else if event.id() == MENU_OPEN_REMOTE {
                let _ = app.emit("menu-open-remote", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_log,
            commands::open_merged,
            commands::open_source,
            commands::set_spool_keep,
            commands::set_spool_limit,
            commands::kept_spools,
            commands::delete_kept_spools,
            commands::inspect_merge_source,
            commands::resort,
            commands::close_log,
            commands::get_lines,
            commands::set_filter,
            commands::open_view,
            commands::close_view,
            commands::set_profile,
            commands::get_columns,
            commands::preview_fields,
            commands::get_stats,
            commands::find_next,
            commands::find_prev,
            commands::get_position,
            commands::get_entry_range,
            commands::get_overview,
            commands::find_level,
            commands::get_timeline,
            commands::position_at_time,
            commands::get_entry,
            commands::copy_lines,
            commands::set_keep_on_rotate,
            commands::set_frozen,
            commands::list_profiles,
            commands::set_custom_profiles,
            commands::set_extract_rules,
            commands::load_extract_rules,
            commands::suggest_fields,
            commands::preview_extract_rule,
            commands::open_report,
            commands::close_report,
            commands::run_report,
            commands::get_report_schema,
            commands::export_view,
            commands::cancel_export,
            commands::line_anchors,
            commands::resolve_anchors,
            commands::read_workspace,
            commands::write_workspace,
            commands::probe_paths,
            commands::scripted_dialogs,
            commands::remote_hosts,
            commands::remote_list_dir,
            commands::forget_remote_secret,
            commands::winevent_supported,
            commands::winevent_channels,
            commands::forget_winevent_secret,
            #[cfg(debug_assertions)]
            e2e::e2e_report,
            #[cfg(debug_assertions)]
            e2e::e2e_sftp_server,
            #[cfg(debug_assertions)]
            e2e::e2e_sftp_stop,
        ])
        .build(context)
        .expect("error while building Log Commander")
        .run(|app, event| {
            // Prompt 015: an export running while the app quits leaves no temporary file.
            if let tauri::RunEvent::Exit = event {
                app.state::<export::ExportJobs>().shutdown();
                // Prompt 016: listeners stop, spools are deleted or kept as chosen.
                app.state::<SessionManager>().close_all();
            }
        });
}

fn remote_hub(config_dir: Option<std::path::PathBuf>) -> remote::Hub {
    #[cfg(debug_assertions)]
    if e2e::scenario_active() {
        let dir = std::env::temp_dir().join(format!("lc-e2e-ssh-{}", std::process::id()));
        return remote::Hub::new(
            remote::trust::KnownHosts {
                user: None,
                app: dir.join("known_hosts"),
            },
            None,
            std::sync::Arc::new(remote::secrets::MemoryStore::default()),
        );
    }
    let env = remote::ssh_config::Environment::current();
    // Without a config folder nothing can be recorded (an unknown host key stays an error).
    let app = config_dir
        .map(|d| d.join("known_hosts"))
        .unwrap_or_default();
    remote::Hub::new(
        remote::trust::KnownHosts {
            user: env.as_ref().map(|e| e.ssh_dir().join("known_hosts")),
            app,
        },
        env,
        std::sync::Arc::new(SystemStore),
    )
}

/// The OS keychain behind the hub's store trait (set up on first use, not at start).
struct SystemStore;

impl remote::secrets::SecretStore for SystemStore {
    fn available(&self) -> bool {
        remote::secrets::system_store().available()
    }
    fn get(
        &self,
        account: &str,
    ) -> Result<Option<remote::secrets::Secret>, remote::secrets::StoreError> {
        remote::secrets::system_store().get(account)
    }
    fn set(
        &self,
        account: &str,
        secret: &remote::secrets::Secret,
    ) -> Result<(), remote::secrets::StoreError> {
        remote::secrets::system_store().set(account, secret)
    }
    fn delete(&self, account: &str) -> Result<(), remote::secrets::StoreError> {
        remote::secrets::system_store().delete(account)
    }
}

/// The platform's default menu plus File → Open…, Open Path…, Open Source…, Open Remote File…, Merge Files…, Export…, Open Workspace…
/// and Save Workspace…
fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let open = MenuItem::with_id(app, MENU_OPEN, "Open…", true, Some("CmdOrCtrl+O"))?;
    let open_path = MenuItem::with_id(
        app,
        MENU_OPEN_PATH,
        "Open Path…",
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let merge = MenuItem::with_id(
        app,
        MENU_MERGE,
        "Merge Files…",
        true,
        Some("CmdOrCtrl+Shift+M"),
    )?;
    let open_source = MenuItem::with_id(
        app,
        MENU_OPEN_SOURCE,
        "Open Source…",
        true,
        Some("CmdOrCtrl+Shift+L"),
    )?;
    let open_remote = MenuItem::with_id(
        app,
        MENU_OPEN_REMOTE,
        "Open Remote File…",
        true,
        Some("CmdOrCtrl+Shift+H"),
    )?;
    let export = MenuItem::with_id(app, MENU_EXPORT, "Export…", true, Some("CmdOrCtrl+Shift+E"))?;
    let workspace_open = MenuItem::with_id(
        app,
        MENU_WORKSPACE_OPEN,
        "Open Workspace…",
        true,
        None::<&str>,
    )?;
    let workspace_save = MenuItem::with_id(
        app,
        MENU_WORKSPACE_SAVE,
        "Save Workspace…",
        true,
        None::<&str>,
    )?;
    let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
    let file = menu.items()?.into_iter().find_map(|item| {
        let submenu = item.as_submenu()?;
        (submenu.text().ok()? == "File").then(|| submenu.clone())
    });
    match file {
        Some(file) => file.insert_items(
            &[
                &open,
                &open_path,
                &open_source,
                &open_remote,
                &merge,
                &export,
                &separator,
                &workspace_open,
                &workspace_save,
            ],
            0,
        )?,
        None => menu.append(
            &SubmenuBuilder::new(app, "File")
                .item(&open)
                .item(&open_path)
                .item(&open_source)
                .item(&open_remote)
                .item(&merge)
                .item(&export)
                .item(&separator)
                .item(&workspace_open)
                .item(&workspace_save)
                .build()?,
        )?,
    }
    Ok(menu)
}
