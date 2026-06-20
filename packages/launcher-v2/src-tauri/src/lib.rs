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
pub mod http;
pub mod macos_media;
pub mod mic_plugin;
pub mod paths;
pub mod proc;
pub mod supervisor;

use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

use app::state::AppState;

/// Build the global-shortcut plugin instance pre-configured with the
/// preferences chord (Ctrl+, on Windows/Linux, Cmd+, on macOS) bound
/// to the same `handle_menu_event` path the menu accelerator targets.
///
/// We register the binding at plugin-build time (via `with_shortcut`)
/// rather than dynamically inside `setup()` because the plugin's
/// builder API treats handlers as construction-time inputs — the
/// shortcut and its handler ship together as a single registered
/// unit.
///
/// Window-focus gating happens inside the handler: if the main
/// window isn't focused (i.e., the user is in a different app), the
/// chord is a no-op. This restores the menu-accelerator semantic
/// "fires only when the app is foregrounded" that Tauri 2 macOS
/// menus do natively and Tauri 2 Windows menus do not (WebView2
/// captures the chord before the menu chain sees it).
fn register_preferences_shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    // Ctrl on Windows/Linux, Cmd (Super) on macOS. The plugin's
    // `Modifiers` are explicit per-OS rather than a `CmdOrCtrl`
    // alias — match the platform conditionally so the binding lands
    // on the right modifier without a cross-platform string-parse
    // layer.
    #[cfg(target_os = "macos")]
    let modifiers = Modifiers::SUPER;
    #[cfg(not(target_os = "macos"))]
    let modifiers = Modifiers::CONTROL;

    let preferences_shortcut = Shortcut::new(Some(modifiers), Code::Comma);

    tauri_plugin_global_shortcut::Builder::new()
        .with_shortcut(preferences_shortcut)
        .expect("preferences shortcut should be a valid Modifier+Code pair")
        .with_handler(move |app, shortcut, event| {
            if shortcut != &preferences_shortcut {
                return;
            }
            if event.state() != ShortcutState::Pressed {
                return;
            }
            // Focus gate: this is an OS-level hotkey, so it fires
            // even when our app isn't on top. Match menu-accelerator
            // semantics by ignoring the chord when the user is
            // looking at someone else's window.
            let focused = app
                .get_webview_window("main")
                .and_then(|w| w.is_focused().ok())
                .unwrap_or(false);
            if !focused {
                return;
            }
            app::handle_menu_event(app, app::menu::PREFERENCES_ID);
        })
        .build()
}

/// Headless smoke check — exercises the command surface without
/// starting a Tauri webview, exits 0 on success. Intended as a CI
/// gate: catches panics in any of the read-only commands, panics
/// during launcher-data-dir resolution, and serialization breaks of
/// any persisted config field. Hermetic via `PSYCHEROS_LAUNCHER
/// _DATA_DIR` override so it doesn't touch the real user state.
///
/// What it deliberately doesn't catch: Tauri builder panics (those
/// require a display server to reproduce; covered by the dev-build
/// run + integration tests). Anything requiring a live daemon
/// (backup/restore — covered by `tests/backup_restore.rs`).
///
/// Invoked via `psycheros-launcher --smoke`. Returns the process
/// exit code as `i32` — callers can `std::process::exit` on the
/// returned value.
pub fn smoke() -> i32 {
    use std::panic::AssertUnwindSafe;
    eprintln!("[smoke] starting…");

    // Hermetic env so the smoke run doesn't touch the user's real
    // `~/Library/Application Support/Psycheros/`. tmp.join is fine
    // even if the dir doesn't exist yet — the resolved path-dir
    // commands all create-on-demand.
    let smoke_root =
        std::env::temp_dir().join(format!("psycheros-launcher-smoke-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&smoke_root);
    std::env::set_var("PSYCHEROS_LAUNCHER_DATA_DIR", &smoke_root);

    let mut failures = 0;
    let mut check =
        |name: &str, f: Box<dyn FnOnce() + std::panic::UnwindSafe>| match std::panic::catch_unwind(
            AssertUnwindSafe(f),
        ) {
            Ok(_) => eprintln!("[smoke] {name}: OK"),
            Err(payload) => {
                failures += 1;
                let msg = payload
                    .downcast_ref::<&'static str>()
                    .copied()
                    .or_else(|| payload.downcast_ref::<String>().map(|s| s.as_str()))
                    .unwrap_or("(non-string panic payload)");
                eprintln!("[smoke] {name}: PANIC — {msg}");
            }
        };

    // Each closure exercises one command. `Box<dyn FnOnce>` so the
    // closures can have different captured-context lifetimes.
    check(
        "daemon_status",
        Box::new(|| {
            let _ = commands::daemon_status();
        }),
    );
    check(
        "get_update_channel",
        Box::new(|| {
            let _ = commands::get_update_channel();
        }),
    );
    check(
        "get_daemon_mode",
        Box::new(|| {
            let _ = commands::get_daemon_mode();
        }),
    );
    check(
        "read_general_settings (absent file)",
        Box::new(|| {
            let _ = commands::read_general_settings();
        }),
    );
    check(
        "get_update_history (empty)",
        Box::new(|| {
            let _ = commands::get_update_history();
        }),
    );
    check(
        "check_port_conflict (unused port)",
        Box::new(|| {
            // Port 65534 is unlikely to be bound on any CI runner.
            // Even if it is, the result is "Some(PortConflict)" rather
            // than a panic — we only fail this check on panic, not on
            // a non-None result.
            let _ = commands::check_port_conflict(65534);
        }),
    );
    check(
        "recent_daemon_log_lines (no log file)",
        Box::new(|| {
            let _ = commands::recent_daemon_log_lines(Some(10), Some(1024));
        }),
    );
    check(
        "config save+load round-trip",
        Box::new(|| {
            let cfg = config::LauncherConfig {
                port: 31415,
                daemon_mode: Some(config::DaemonMode::Manual),
                update_channel: Some(config::UpdateChannel::Beta),
                ..Default::default()
            };
            config::save(&cfg).expect("save smoke config");
            let loaded = config::load().expect("load smoke config");
            assert_eq!(loaded.port, 31415, "port didn't round-trip");
            assert_eq!(
                loaded.effective_mode(),
                config::DaemonMode::Manual,
                "mode didn't round-trip"
            );
            assert_eq!(
                loaded.effective_channel(),
                config::UpdateChannel::Beta,
                "channel didn't round-trip"
            );
        }),
    );

    let _ = std::fs::remove_dir_all(&smoke_root);

    if failures > 0 {
        eprintln!("[smoke] FAILED — {failures} check(s) panicked");
        1
    } else {
        eprintln!("[smoke] OK — all checks passed");
        0
    }
}

/// Entry point invoked from `main.rs`. Builds the Tauri app, registers
/// commands and menu, captures splash URL into app state, spawns the
/// daemon-status watcher, runs the event loop.
///
/// `--no-window` (passed by the launcher's launchd plist when auto-started
/// at login) boots the launcher silently into Accessory mode: no dock
/// icon, no window, just the tray icon. Without the flag (user
/// double-clicked the .app or ran from a terminal), the window is shown
/// at startup and the activation policy is Regular.
pub fn run() {
    let show_window_on_start = !std::env::args().any(|a| a == "--no-window");

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        // Global shortcut plugin: registers an OS-level Ctrl+, /
        // Cmd+, hotkey so the preferences chord fires even when
        // WebView2 (Windows) has focus and would otherwise swallow
        // the keystroke before the menu accelerator chain sees it.
        // The handler is gated on window focus so we don't react when
        // the user is in a different app.
        .plugin(register_preferences_shortcut_plugin())
        // Mic permission plugin. Lives outside the main `commands.rs`
        // surface because Tauri 2's ACL only resolves plugin-namespaced
        // commands for remote origins (http://localhost:3000 from the
        // daemon-loaded voice UI). See `mic_plugin.rs`.
        .plugin(crate::mic_plugin::init());

    // WebDriver server for E2E testing — opt-in via the `webdriver`
    // cargo feature, off in release builds. When enabled, exposes a
    // W3C WebDriver endpoint on 127.0.0.1:4445 that wdio/selenium
    // clients connect to. See `e2e/README.md`.
    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    builder
        // Auto-updater for the .app shell binary is NOT initialized.
        // tauri-plugin-updater requires a real Ed25519 signing key +
        // manifest endpoint + CI signing step — without all three the
        // plugin either crashes at startup (refuses to deserialize a
        // null config) or is functionally inert. We don't ship inert.
        //
        // When the maintainer is ready:
        //   1. `tauri signer generate -w ~/.tauri/psycheros.key` —
        //      private key stored out of band.
        //   2. Add `plugins.updater = { pubkey, endpoints }` to
        //      `tauri.conf.json` with the public key + a real URL
        //      hosting `latest.json`.
        //   3. Add a CI step to .github/workflows/release.yml that
        //      runs `tauri signer sign` against the built .app.tar.gz
        //      and publishes the signed file + latest.json to the
        //      endpoint URL.
        //   4. Add back the `.plugin(tauri_plugin_updater::Builder
        //      ::new().build())` line here.
        //
        // Source-side updates (psycheros release tags) flow through
        // `apply_source_update` independently of this plugin and are
        // fully functional today.
        .invoke_handler(tauri::generate_handler![
            commands::daemon_status,
            commands::install_autostart,
            commands::install_manual,
            commands::uninstall_autostart,
            commands::start_daemon,
            commands::stop_daemon,
            commands::get_daemon_mode,
            commands::recent_daemon_log_lines,
            commands::set_view_mode,
            commands::needs_first_run,
            commands::save_initial_config,
            commands::read_general_settings,
            commands::first_run,
            commands::check_for_updates,
            commands::apply_source_update,
            commands::get_diagnostics,
            commands::open_path,
            commands::open_url,
            commands::backup_data,
            commands::restore_data,
            commands::wipe_entity_data,
            commands::reinit_psycheros,
            commands::check_port_conflict,
            commands::install_xcode_clt,
            commands::set_daemon_mode,
            commands::set_update_channel,
            commands::get_update_channel,
            commands::get_update_history,
            commands::list_available_tags,
            commands::rollback_to_snapshot,
            commands::get_tahoe_compat,
            commands::set_tahoe_compat,
        ])
        .on_window_event(|window, event| {
            // Closing the manager window doesn't unconditionally quit
            // the launcher: if the daemon is Running the tray icon is
            // up and the launcher has a reason to stay alive. If the
            // daemon is NOT running, there's no tray either — closing
            // the window leaves the launcher with no surfaces, so it
            // exits via the post-hide surfaces check.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let handle = window.app_handle().clone();
                app::set_manager_visible(&handle, false);
                app::tray::maybe_exit_on_window_hidden(&handle);
            }
        })
        .setup(move |app| {
            // Capture the splash URL at startup so we can navigate back to
            // it from `http://localhost:3000` later. Dev mode uses a random
            // local port (e.g. http://127.0.0.1:1430/); production uses
            // tauri://localhost/. Either way, window.url() returns the
            // resolved value.
            let window = app.get_webview_window("main").ok_or("no main window")?;
            let splash_url = window.url().map_err(|e| e.to_string())?.to_string();

            app.manage(AppState::new(splash_url));

            // macOS-only: flip WKWebView's private media-capture flags so
            // `navigator.mediaDevices` exists inside the desktop webview.
            // Bug context + private-API rationale in `macos_media.rs`.
            // No-op on Windows/Linux.
            crate::macos_media::enable_media_capture(&window);

            // Install native menu (macOS menu bar / Linux+Windows in-window).
            let menu = app::menu::build_menu(app)?;
            app.set_menu(menu)?;

            // Menu events → handle_menu_event, which toggles user_summoned
            // and re-drives navigation.
            let menu_handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                app::handle_menu_event(&menu_handle, &event.id().0);
            });

            // System tray icon — macOS menu bar, Windows notification
            // area. Adds a persistent presence with state-aware menu
            // (Start/Stop/View logs/Quit). The icon asset and template-
            // mode are branched per-OS in `app::tray::install` so the
            // Windows render isn't an illegible monochrome blob.
            // Errors logged but non-fatal: the launcher still works
            // without the tray.
            if let Err(e) = app::tray::install(app.handle()) {
                eprintln!("[launcher] tray install failed: {e}");
            }

            // Apply the initial window-visibility + activation policy
            // choice from the launch context. Auto-started by the OS
            // supervisor (launchd on macOS, Task Scheduler on Windows)
            // via `--no-window`: boots silent into the tray. User-
            // launched (no flag): shows the window with the dock /
            // taskbar icon.
            app::set_manager_visible(app.handle(), show_window_on_start);

            // Daemon-status watcher.
            app::spawn_status_watcher(app.handle().clone());

            // Source-update watcher. Polls GitHub every few hours and
            // emits `update-available` / injects an in-window toast
            // when a new tag is available upstream.
            app::update_watcher::spawn_update_watcher(app.handle().clone());

            // Daemon log tailer. Reads new lines from the daemon's
            // stderr log every ~1.5s and emits `daemon-log-line` for
            // the manager card's live log panel.
            app::log_tailer::spawn_log_tailer(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri build failed")
        .run(|app_handle, event| {
            // The daemon is OS-supervised — closing the launcher does NOT
            // stop it. That's the whole architectural commitment.
            //
            // `Reopen` fires when the user clicks the launcher's dock
            // icon (while it's still in the dock) or re-launches the .app
            // while the process is already running. Either is a strong
            // signal that the user wants the window back, so we re-show
            // it and flip the activation policy back to Regular.
            //
            // macOS-only: Tauri 2 only emits `RunEvent::Reopen` on
            // macOS (it's a Cocoa NSApplicationDelegate notification).
            // On Windows the equivalent — re-running the .exe while one
            // instance already lives — is normally handled by a single-
            // instance plugin or by ignoring the second process. We
            // ignore it for now; the `Reopen` arm stays cfg'd out.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                app::set_manager_visible(app_handle, true);
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app_handle, event);
            }
        });
}
