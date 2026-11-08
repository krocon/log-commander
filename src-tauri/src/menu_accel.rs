//! Native menu accelerators from the keymap (prompt 021). The frontend owns the keymap (defaults per OS plus the
//! user's override) and sends the shortcut of each menu entry in its notation (`Mod+Shift+O`); this module turns
//! it into a Tauri accelerator. Free of Tauri: the menu itself is changed in `commands.rs`.

/// Menu entries that are actions (their menu id is the action id of `action-catalog.ts`). Nothing else can be
/// changed from the frontend.
pub const MENU_ACTIONS: &[&str] = &[
    "OPEN_FILE",
    "OPEN_PATH",
    "OPEN_SOURCE",
    "OPEN_REMOTE",
    "MERGE_FILES",
    "EXPORT",
    "OPEN_WORKSPACE",
    "SAVE_WORKSPACE",
    "CLOSE_TAB",
    "COLOR_SCHEME",
    "OPEN_SHORTCUTS",
];

/// Longest shortcut text accepted (the frontend's limit too).
pub const MAX_SHORTCUT: usize = 64;

/// The Tauri accelerator for a keymap shortcut, `None` when a menu cannot or must not carry it: chords, keys
/// without a name in the menu, and plain keys or Alt+key (a menu would take them from text fields; ⌥ types
/// characters on macOS). Only one stroke with Mod/Ctrl, or an F-key.
pub fn native_accelerator(shortcut: &str, macos: bool) -> Option<String> {
    let shortcut = shortcut.trim();
    if shortcut.is_empty() || shortcut.len() > MAX_SHORTCUT || shortcut.contains(' ') {
        return None;
    }
    // A "+" key is written "Mod++": no menu name for it.
    if shortcut.ends_with("++") {
        return None;
    }
    let mut parts: Vec<&str> = shortcut.split('+').collect();
    let key = parts.pop()?;
    let (mut command, mut ctrl, mut alt, mut shift) = (false, false, false, false);
    for p in parts {
        match p {
            "Mod" => command = true,
            "Ctrl" => ctrl = true,
            "Alt" => alt = true,
            "Shift" => shift = true,
            _ => return None,
        }
    }
    let function_key = key.len() > 1 && key.starts_with('F') && key[1..].parse::<u8>().is_ok();
    if !(command || ctrl || function_key) {
        return None;
    }
    let key = native_key(key)?;
    let mut out = Vec::new();
    if command {
        out.push("CmdOrCtrl");
    }
    // `Ctrl` is the real Control key on macOS only; elsewhere the frontend writes it as `Mod`.
    if ctrl && (macos || !command) {
        out.push("Ctrl");
    }
    if alt {
        out.push("Alt");
    }
    if shift {
        out.push("Shift");
    }
    out.push(&key);
    Some(out.join("+"))
}

/// Keys of the keymap notation that have a name in a menu accelerator.
fn native_key(key: &str) -> Option<String> {
    let mut chars = key.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return (c.is_ascii_alphanumeric() || "`\\[],.=-';/".contains(c))
            .then(|| c.to_ascii_uppercase().to_string());
    }
    if let Some(n) = key.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()) {
        return (1..=24).contains(&n).then(|| key.to_string());
    }
    const NAMED: &[&str] = &[
        "Enter",
        "Tab",
        "Escape",
        "Backspace",
        "Delete",
        "Insert",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Space",
    ];
    NAMED.contains(&key).then(|| key.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mod_becomes_cmd_or_ctrl() {
        assert_eq!(
            native_accelerator("Mod+Shift+O", true).as_deref(),
            Some("CmdOrCtrl+Shift+O")
        );
        assert_eq!(
            native_accelerator("Mod+Shift+O", false).as_deref(),
            Some("CmdOrCtrl+Shift+O")
        );
        assert_eq!(
            native_accelerator("Mod+Alt+T", true).as_deref(),
            Some("CmdOrCtrl+Alt+T")
        );
        assert_eq!(
            native_accelerator("Mod+,", true).as_deref(),
            Some("CmdOrCtrl+,")
        );
        assert_eq!(
            native_accelerator("Mod+o", false).as_deref(),
            Some("CmdOrCtrl+O")
        );
    }

    #[test]
    fn the_real_control_key_on_macos() {
        assert_eq!(
            native_accelerator("Ctrl+Tab", true).as_deref(),
            Some("Ctrl+Tab")
        );
        assert_eq!(
            native_accelerator("Mod+Ctrl+D", true).as_deref(),
            Some("CmdOrCtrl+Ctrl+D")
        );
        // Elsewhere Ctrl is Mod; both at once say nothing more.
        assert_eq!(
            native_accelerator("Mod+Ctrl+D", false).as_deref(),
            Some("CmdOrCtrl+D")
        );
    }

    #[test]
    fn function_keys_need_no_modifier() {
        assert_eq!(native_accelerator("F5", true).as_deref(), Some("F5"));
        assert_eq!(
            native_accelerator("Shift+F10", false).as_deref(),
            Some("Shift+F10")
        );
    }

    #[test]
    fn chords_and_plain_keys_stay_with_the_page() {
        for s in [
            "Mod+K T", "P", "Shift+E", "Alt+O", "Space", "Escape", "?", ">", "",
        ] {
            assert_eq!(native_accelerator(s, true), None, "{s}");
            assert_eq!(native_accelerator(s, false), None, "{s}");
        }
    }

    #[test]
    fn unknown_or_broken_notation_is_refused() {
        for s in [
            "Mod+",
            "Mod++",
            "Hyper+O",
            "Mod+?",
            "Mod+ContextMenu",
            "Mod+F99",
            "Mod+NumpadAdd",
            "Mod+ä",
        ] {
            assert_eq!(native_accelerator(s, true), None, "{s}");
        }
        let long = format!("Mod+{}", "A".repeat(80));
        assert_eq!(native_accelerator(&long, true), None);
    }

    /// The menu entries are the actions marked `menu: true` in the frontend's catalogue, no more, no less.
    #[test]
    fn menu_actions_match_the_catalogue() {
        let catalogue = include_str!("../../src/app/core/actions/action-catalog.ts");
        let mut marked: Vec<&str> = catalogue
            .split("id: '")
            .skip(1)
            .filter(|entry| entry.split('}').next().unwrap_or("").contains("menu: true"))
            .filter_map(|entry| entry.split('\'').next())
            .collect();
        marked.sort_unstable();
        let mut ours = MENU_ACTIONS.to_vec();
        ours.sort_unstable();
        assert_eq!(marked, ours);
    }

    #[test]
    fn every_menu_action_is_named_once() {
        let mut ids = MENU_ACTIONS.to_vec();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), MENU_ACTIONS.len());
        assert!(MENU_ACTIONS
            .iter()
            .all(|id| id.chars().all(|c| c.is_ascii_uppercase() || c == '_')));
    }
}
