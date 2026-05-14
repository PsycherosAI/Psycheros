//! Psycheros launcher v2 — entry point.
//!
//! The launcher is a Tauri 2 desktop app that:
//!
//! 1. Detects an existing psycheros daemon via TCP + OS-supervisor probe.
//! 2. Drives the chat client by navigating the webview to `localhost:3000`
//!    when the daemon is up.
//! 3. Falls back to a manager surface (install autostart, view logs,
//!    configure) when the daemon is down — or when the user explicitly
//!    summons it via `Cmd+,`.
//! 4. Never owns the daemon process directly — installs an OS-native
//!    service definition (launchd plist / systemd unit / Task Scheduler
//!    task) and lets the OS supervise.
//!
//! See `docs/architecture.md` for the full design. See `CLAUDE.md` for the
//! load-bearing wirings to know before editing this code.

pub mod app;
pub mod bundle;
pub mod commands;
pub mod config;
pub mod daemon;
pub mod paths;
pub mod supervisor;

use tauri::Manager;

use app::state::AppState;

/// Entry point invoked from `main.rs`. Builds the Tauri app, registers
/// commands and menu, captures splash URL into app state, spawns the
/// daemon-status watcher, runs the event loop.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::daemon_status,
            commands::install_autostart,
            commands::uninstall_autostart,
            commands::set_view_mode,
        ])
        .setup(|app| {
            // Capture the splash URL at startup so we can navigate back to
            // it from `http://localhost:3000` later. Dev mode uses a random
            // local port (e.g. http://127.0.0.1:1430/); production uses
            // tauri://localhost/. Either way, window.url() returns the
            // resolved value.
            let window = app.get_webview_window("main").ok_or("no main window")?;
            let splash_url = window.url().map_err(|e| e.to_string())?.to_string();

            app.manage(AppState::new(splash_url));

            // Install native menu (macOS menu bar / Linux+Windows in-window).
            let menu = app::menu::build_menu(app)?;
            app.set_menu(menu)?;

            // Menu events → handle_menu_event, which toggles user_summoned
            // and re-drives navigation.
            let menu_handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                app::handle_menu_event(&menu_handle, &event.id().0);
            });

            // Daemon-status watcher.
            app::spawn_status_watcher(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri build failed")
        .run(|_app_handle, _event| {
            // The daemon is OS-supervised — closing the launcher does NOT
            // stop it. That's the whole architectural commitment.
        });
}
