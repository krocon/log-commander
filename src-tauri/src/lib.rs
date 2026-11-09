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
pub mod mcp;
pub mod menu_accel;
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

// Menu ids are action ids (prompt 021, `menu_accel::MENU_ACTIONS`): a chosen entry runs that action.
const MENU_OPEN: &str = "OPEN_FILE";
const MENU_OPEN_PATH: &str = "OPEN_PATH";
const MENU_MERGE: &str = "MERGE_FILES";
const MENU_EXPORT: &str = "EXPORT";
const MENU_WORKSPACE_OPEN: &str = "OPEN_WORKSPACE";
const MENU_WORKSPACE_SAVE: &str = "SAVE_WORKSPACE";
const MENU_OPEN_SOURCE: &str = "OPEN_SOURCE";
const MENU_OPEN_REMOTE: &str = "OPEN_REMOTE";
const MENU_CLOSE_TAB: &str = "CLOSE_TAB";
const MENU_COLOR_SCHEME: &str = "COLOR_SCHEME";
const MENU_SHORTCUTS: &str = "OPEN_SHORTCUTS";
/// The window starts hidden (prompt 020) and is shown with the first colour scheme; at the latest then.
const SHOW_FALLBACK: std::time::Duration = std::time::Duration::from_secs(1);

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
        // The window starts hidden until its colour scheme is on (prompt 020): restoring "visible" would
        // show it before that.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .manage(SessionManager::default())
        .manage(export::ExportJobs::default())
        .manage(commands::McpState::default())
        .setup(|app| {
            // Prompt 020: a frontend that never applies a scheme must not leave the window hidden.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(SHOW_FALLBACK);
                commands::show_main(&handle);
            });
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
            let id = event.id().as_ref();
            if menu_accel::MENU_ACTIONS.contains(&id) {
                let _ = app.emit("menu-action", id);
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
            commands::db_preview,
            commands::db_tables,
            commands::forget_db_secret,
            commands::set_window_chrome,
            commands::set_menu_accelerators,
            commands::subscribe_mcp,
            commands::mcp_set_enabled,
            commands::mcp_info,
            commands::mcp_reply,
            commands::mcp_disconnect,
            commands::mcp_probe,
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
                // Prompt 022: the AI bridge closes, its endpoint file goes.
                app.state::<commands::McpState>().shutdown();
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

/// The platform's default menu plus File → Open…, Open Path…, Open Source…, Open Remote File…, Merge Files…, Export…, Open Workspace…,
/// Save Workspace… and Close Tab, View → Colour Scheme…, Help → Keyboard Shortcuts…. The accelerators are the
/// defaults; the frontend sets the keymap's with `set_menu_accelerators` (prompt 021).
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
    let close_tab = MenuItem::with_id(app, MENU_CLOSE_TAB, "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
    let separator2 = tauri::menu::PredefinedMenuItem::separator(app)?;
    // Prompt 021: on macOS the default menu gives ⌘W to "Close Window"; ⌘W closes a tab here (as before), so the
    // menu says so, and the window closes with its button or ⌘Q.
    #[cfg(target_os = "macos")]
    remove_close_window(&menu)?;
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
                &separator2,
                &close_tab,
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
                .item(&separator2)
                .item(&close_tab)
                .build()?,
        )?,
    }
    // Prompt 020: View → Colour Scheme… opens the picker (Cmd/Ctrl+Alt+T in the frontend).
    let scheme = MenuItem::with_id(
        app,
        MENU_COLOR_SCHEME,
        "Colour Scheme…",
        true,
        Some("CmdOrCtrl+Alt+T"),
    )?;
    let view = menu.items()?.into_iter().find_map(|item| {
        let submenu = item.as_submenu()?;
        (submenu.text().ok()? == "View").then(|| submenu.clone())
    });
    match view {
        Some(view) => view.insert(&scheme, 0)?,
        None => menu.append(&SubmenuBuilder::new(app, "View").item(&scheme).build()?)?,
    }
    // Prompt 021: Help → Keyboard Shortcuts… (the editor); its accelerator follows the keymap too.
    let shortcuts = MenuItem::with_id(
        app,
        MENU_SHORTCUTS,
        "Keyboard Shortcuts…",
        true,
        Some("CmdOrCtrl+Shift+K"),
    )?;
    let help = menu.items()?.into_iter().find_map(|item| {
        let submenu = item.as_submenu()?;
        (submenu.text().ok()? == "Help").then(|| submenu.clone())
    });
    match help {
        Some(help) => help.insert(&shortcuts, 0)?,
        None => menu.append(&SubmenuBuilder::new(app, "Help").item(&shortcuts).build()?)?,
    }
    Ok(menu)
}

/// Removes the default "Close Window" entries (File and Window menu on macOS), which own ⌘W.
#[cfg(target_os = "macos")]
fn remove_close_window<R: tauri::Runtime>(menu: &Menu<R>) -> tauri::Result<()> {
    for top in menu.items()? {
        let Some(sub) = top.as_submenu() else {
            continue;
        };
        for item in sub.items()? {
            let close = item
                .as_predefined_menuitem()
                .and_then(|p| p.text().ok())
                .is_some_and(|text| text.replace('&', "") == "Close Window");
            if close {
                sub.remove(&item)?;
            }
        }
    }
    Ok(())
}
