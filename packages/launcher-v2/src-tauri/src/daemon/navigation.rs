//! Webview navigation helper.
//!
//! Drives the chat-vs-manager view flip from Rust rather than JS, for two
//! reasons:
//!
//! 1. **Cross-origin navigation is restricted in the webview.** Once the
//!    webview is on `http://localhost:3000` (psycheros UI), JS in that
//!    context can't easily navigate back to `tauri://localhost` (our local
//!    splash) because of CORS. `webview.eval()` from Rust has no such
//!    restrictions — it just executes JS in whatever context is loaded.
//! 2. **Single source of truth.** The Rust side knows daemon state and the
//!    `user_summoned` flag; JS does not. Centralizing navigation here means
//!    state transitions are atomic with the navigation that reflects them.
//!
//! The navigation respects [`AppState::user_summoned`] — when the user has
//! explicitly pressed `Cmd+,` to view the manager, daemon state changes
//! must NOT auto-bounce them back to chat. See docs/frontend.md for the
//! view-mode state machine.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager};

use super::DaemonStatus;
use crate::app::state::AppState;
use crate::daemon::DaemonState;

/// Navigate the main webview to either the chat URL (daemon up + user not
/// holding the manager view) or the launcher's local splash URL.
///
/// Skips eval entirely when the target equals the last navigated URL —
/// `location.replace(sameURL)` triggers a hard reload that wipes splash JS
/// state and looks like a glitch.
pub fn drive(handle: &AppHandle, status: DaemonStatus) {
    let state = handle.state::<AppState>();
    let summoned = state.user_summoned.load(Ordering::SeqCst);

    let target = if summoned || status.state != DaemonState::Running {
        state.splash_url.clone()
    } else {
        format!("http://localhost:{}/", status.port)
    };

    // De-dupe to avoid the spurious-reload anti-pattern.
    {
        let mut last = state.last_navigated.lock().expect("nav mutex poisoned");
        if *last == target {
            return;
        }
        *last = target.clone();
    }

    if let Some(window) = handle.get_webview_window("main") {
        let js = format!("window.location.replace('{}')", target);
        match window.eval(&js) {
            Ok(()) => eprintln!(
                "[launcher] navigate -> {} (state={:?}, summoned={})",
                target, status.state, summoned
            ),
            Err(e) => eprintln!("[launcher] webview.eval failed: {e}"),
        }
    } else {
        eprintln!("[launcher] no main window to navigate");
    }
}
