//! Native macOS menu bar + accelerators.
//!
//! macOS users expect the standard app menu (Psycheros / File / Edit /
//! View / Window / Help) at the top of the screen. The launcher's only
//! custom item is **Preferences…** (Cmd+,) under the app menu, which
//! flips the webview between chat and manager.
//!
//! On Linux and Windows, Tauri also exposes a menu bar within the window
//! frame; the same menu structure renders there.
//!
//! Menu event handling lives in [`crate::app::handle_menu_event`].

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

/// Menu item ID for the Preferences/Manager toggle. Matched in the
/// `on_menu_event` handler.
pub const PREFERENCES_ID: &str = "preferences";

pub fn build_menu(app: &tauri::App) -> tauri::Result<Menu<tauri::Wry>> {
    let preferences = MenuItemBuilder::new("Preferences…")
        .id(PREFERENCES_ID)
        .accelerator("Cmd+,")
        .build(app)?;

    let about = PredefinedMenuItem::about(app, None, None)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, None)?;

    let app_submenu = SubmenuBuilder::new(app, "Psycheros")
        .item(&about)
        .item(&separator)
        .item(&preferences)
        .item(&separator)
        .item(&quit)
        .build()?;

    MenuBuilder::new(app).item(&app_submenu).build()
}
