//! Application-wide state shared across Tauri commands and the watcher.
//!
//! The state struct is intentionally small. The view-mode logic in
//! particular hinges on a single `AtomicBool` — `user_summoned` —
//! distinguishing two reasons the splash can be visible:
//!
//! - **Auto-fallback** (`user_summoned == false`): the daemon isn't running,
//!   so the splash is shown out of necessity. When daemon recovers, auto-
//!   navigate to chat.
//! - **Explicit summon** (`user_summoned == true`): the user pressed `Cmd+,`
//!   or clicked "Manager" while daemon was up. Stay on splash until they
//!   click "Back to chat" or press the accelerator again.
//!
//! See docs/frontend.md for the full state machine.

use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

pub struct AppState {
    /// When true, lock the webview to the splash regardless of daemon state.
    pub user_summoned: AtomicBool,
    /// The Tauri-asset URL the launcher splash was originally served from.
    /// In dev mode this is `http://127.0.0.1:<random>/`; in production it's
    /// `tauri://localhost/`. Captured at startup so we can navigate back
    /// from any origin (including `http://localhost:3000` after we've
    /// navigated forward to the daemon).
    pub splash_url: String,
    /// The URL most recently navigated to. Used to skip no-op
    /// `location.replace(sameURL)` calls that would otherwise wipe in-
    /// progress splash JS state.
    pub last_navigated: Mutex<String>,
}

impl AppState {
    pub fn new(splash_url: String) -> Self {
        Self {
            user_summoned: AtomicBool::new(false),
            splash_url: splash_url.clone(),
            last_navigated: Mutex::new(splash_url),
        }
    }
}
