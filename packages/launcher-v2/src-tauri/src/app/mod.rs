//! Tauri app wiring — builder setup, menu wiring, watcher thread.
//!
//! Pulls everything together: registers Tauri commands, builds the native
//! menu, kicks off the daemon-status watcher, and registers the menu event
//! handler that toggles the user-summon flag.
//!
//! The watcher is a plain `std::thread` (not a tokio task). It polls
//! [`daemon::probe`] every 2s, emits a `daemon-status-changed` event when
//! the state transitions, and drives the webview navigation via
//! [`daemon::navigation::drive`]. The frontend listens for the event to
//! update its own UI; navigation is driven from Rust so cross-origin
//! restrictions don't bite.

pub mod menu;
pub mod state;

use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::daemon::{self, DaemonState};
use state::AppState;

/// Event name emitted to the frontend on every daemon-state transition.
pub const STATUS_EVENT: &str = "daemon-status-changed";

/// Polling interval for the watcher. 2s is the sweet spot — fast enough
/// that "click install → see chat" feels instant once the daemon binds
/// the port, slow enough that we're not pegging launchctl on every tick.
const WATCHER_INTERVAL: Duration = Duration::from_secs(2);

/// Spawn the daemon-status watcher. Idempotent w.r.t. the AppState — only
/// emits / navigates on state transitions.
pub fn spawn_status_watcher(handle: AppHandle) {
    thread::spawn(move || {
        let mut last: Option<DaemonState> = None;
        loop {
            let status = daemon::probe();

            if Some(status.state) != last {
                eprintln!("[launcher] daemon state -> {:?}", status.state);

                if let Err(e) = handle.emit(STATUS_EVENT, status) {
                    eprintln!("[launcher] emit failed: {e}");
                }
                daemon::navigation::drive(&handle, status);
                last = Some(status.state);
            }

            thread::sleep(WATCHER_INTERVAL);
        }
    });
}

/// Handle a menu event. Routed from the global `on_menu_event` handler.
pub fn handle_menu_event(handle: &AppHandle, menu_id: &str) {
    if menu_id == menu::PREFERENCES_ID {
        let state = handle.state::<AppState>();
        // Toggle user_summoned and re-navigate to honor the new view choice.
        let now = !state.user_summoned.load(Ordering::SeqCst);
        state.user_summoned.store(now, Ordering::SeqCst);
        eprintln!("[launcher] Cmd+, -> user_summoned={now}");
        daemon::navigation::drive(handle, daemon::probe());
    }
}
