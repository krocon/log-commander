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
//! - `commands`: the thin Tauri command layer; everything else is free of Tauri

pub mod commands;
#[cfg(debug_assertions)]
pub mod e2e;
pub mod encoding;
pub mod error;
pub mod fields;
pub mod filter;
pub mod indexer;
pub mod level;
pub mod merge;
pub mod model;
pub mod overview;
pub mod platform;
pub mod profile;
pub mod session;
pub mod tail;
pub mod timestamp;

use session::SessionManager;
use tauri::menu::{Menu, MenuItem, SubmenuBuilder};
use tauri::Emitter;

const MENU_OPEN: &str = "open-log";
const MENU_OPEN_PATH: &str = "open-log-path";
const MENU_MERGE: &str = "merge-logs";

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    let builder = match e2e::scenario() {
        Some(script) => builder.on_page_load(move |webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = webview.eval(&script);
            }
        }),
        None => builder,
    };
    builder
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(SessionManager::default())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id() == MENU_OPEN {
                let _ = app.emit("menu-open", ());
            } else if event.id() == MENU_OPEN_PATH {
                let _ = app.emit("menu-open-path", ());
            } else if event.id() == MENU_MERGE {
                let _ = app.emit("menu-merge", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_log,
            commands::open_merged,
            commands::inspect_merge_source,
            commands::resort,
            commands::close_log,
            commands::get_lines,
            commands::set_filter,
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
            commands::get_entry,
            commands::copy_lines,
            commands::set_keep_on_rotate,
            commands::set_frozen,
            commands::list_profiles,
            commands::set_custom_profiles,
            #[cfg(debug_assertions)]
            e2e::e2e_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Log Commander");
}

/// The platform's default menu plus File → Open…, Open Path… and Merge Files…
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
    let file = menu.items()?.into_iter().find_map(|item| {
        let submenu = item.as_submenu()?;
        (submenu.text().ok()? == "File").then(|| submenu.clone())
    });
    match file {
        Some(file) => file.insert_items(&[&open, &open_path, &merge], 0)?,
        None => menu.append(
            &SubmenuBuilder::new(app, "File")
                .item(&open)
                .item(&open_path)
                .item(&merge)
                .build()?,
        )?,
    }
    Ok(menu)
}
