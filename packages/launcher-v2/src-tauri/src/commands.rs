//! Tauri command surface — the frontend's RPC API.
//!
//! Each `#[tauri::command]` is callable from JS via
//! `window.__TAURI__.core.invoke(name, args)`. Errors returned as
//! `Result<T, String>` because Tauri's IPC layer requires `Serialize`able
//! errors and `String` is the simplest form that's still actionable in the
//! UI. Module-internal code uses richer error types (`SupervisorError`,
//! `io::Error`); we stringify at the IPC boundary.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, State};

use crate::app::state::AppState;
use crate::daemon::{self, DaemonStatus};
use crate::paths;
use crate::supervisor::{default_supervisor, DaemonConfig, ServiceSupervisor};

// ---------------------------------------------------------------------------
// Daemon observation
// ---------------------------------------------------------------------------

/// Point-in-time daemon state. Frontend calls this on page load to render
/// the right initial UI; the watcher pushes `daemon-status-changed` events
/// for subsequent updates.
#[tauri::command]
pub fn daemon_status() -> DaemonStatus {
    daemon::probe()
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

/// Install autostart — registers the daemon with the OS supervisor and
/// starts it immediately. The user's "Install autostart" button hits this.
#[tauri::command]
pub fn install_autostart() -> Result<DaemonStatus, String> {
    let cfg = build_daemon_config()?;
    default_supervisor()
        .install(&cfg)
        .map_err(|e| e.to_string())?;
    Ok(daemon::probe())
}

/// Uninstall autostart — unregisters and stops the daemon. The user's
/// "Uninstall autostart" button hits this.
#[tauri::command]
pub fn uninstall_autostart() -> Result<DaemonStatus, String> {
    default_supervisor()
        .uninstall()
        .map_err(|e| e.to_string())?;
    Ok(daemon::probe())
}

// ---------------------------------------------------------------------------
// View mode (chat ↔ manager toggle)
// ---------------------------------------------------------------------------

/// Set the view mode explicitly from the frontend.
///
/// `"manager"` locks the splash; `"chat"` releases the lock and (if daemon
/// is up) auto-navigates back to chat. The frontend's "Back to chat" button
/// calls this with `"chat"`; the menu's Preferences accelerator toggles via
/// `app::handle_menu_event` instead.
#[tauri::command]
pub fn set_view_mode(
    handle: AppHandle,
    state: State<'_, AppState>,
    mode: &str,
) -> Result<(), String> {
    let want_summoned = mode == "manager";
    state.user_summoned.store(want_summoned, Ordering::SeqCst);
    daemon::navigation::drive(&handle, daemon::probe());
    Ok(())
}

// ---------------------------------------------------------------------------
// Internal config construction
// ---------------------------------------------------------------------------

/// Resolve everything the supervisor needs to register the daemon, falling
/// back from production-managed paths to dev conventions. Each failure
/// mode returns a user-actionable error string — the manager UI surfaces
/// these directly, so they have to be informative.
fn build_daemon_config() -> Result<DaemonConfig, String> {
    // Pre-create dirs the supervisor will reference. Keeps the supervisor
    // impls free of "create dir if missing" noise.
    std::fs::create_dir_all(paths::data_dir())
        .map_err(|e| format!("create data dir: {e}"))?;
    std::fs::create_dir_all(paths::log_dir())
        .map_err(|e| format!("create log dir: {e}"))?;

    Ok(DaemonConfig {
        label: "ai.psycheros.daemon".to_string(),
        deno_path: resolve_deno_path()?,
        source_dir: resolve_source_dir()?,
        data_dir: paths::data_dir(),
        log_dir: paths::log_dir(),
        port: daemon::DAEMON_PORT,
        entity_core_dir: None,
        entity_core_data_dir: Some(paths::entity_core_data_dir()),
    })
}

/// Resolve the Deno binary the service definition should reference.
///
/// Lookup order:
/// 1. The bundled Deno staged at `<launcher_data_dir>/bin/deno` — the
///    production answer once Phase 2 (first-run flow) is wired up.
/// 2. Whatever `which deno` / `where deno` returns on the user's PATH —
///    the dev answer.
fn resolve_deno_path() -> Result<PathBuf, String> {
    if paths::bundled_deno_path().exists() {
        return Ok(paths::bundled_deno_path());
    }
    find_on_path("deno").ok_or_else(|| {
        format!(
            "No Deno binary found.\n\n\
             • Expected bundled Deno at: {}\n\
             • And `which deno` returned nothing on PATH.\n\n\
             Install Deno from https://deno.land or run scripts/setup.sh to \
             stage a sidecar copy for dev use.",
            paths::bundled_deno_path().display(),
        )
    })
}

/// Resolve the psycheros source directory the daemon's `projectRoot` points
/// at.
///
/// Lookup order:
/// 1. The launcher-managed extracted source at
///    `<launcher_data_dir>/source/packages/psycheros/` — the production
///    answer once Phase 2 (first-run flow) is wired up.
/// 2. The `PSYCHEROS_SRC_DIR` env var — the dev answer.
fn resolve_source_dir() -> Result<PathBuf, String> {
    if paths::source_dir().join("src/main.ts").exists() {
        return Ok(paths::source_dir());
    }
    if let Ok(env_dir) = std::env::var("PSYCHEROS_SRC_DIR") {
        let p = PathBuf::from(env_dir);
        if p.join("src/main.ts").exists() {
            return Ok(p);
        }
        return Err(format!(
            "PSYCHEROS_SRC_DIR is set to {} but no src/main.ts is there.",
            p.display(),
        ));
    }
    Err(format!(
        "No psycheros source bundle found.\n\n\
         • Expected extracted source at: {}\n\
         • And PSYCHEROS_SRC_DIR env var is unset.\n\n\
         Either: (a) wait for the Phase 2 first-run flow to extract the \
         bundled source, or (b) set PSYCHEROS_SRC_DIR to point at an \
         existing psycheros source directory.",
        paths::source_dir().display(),
    ))
}

/// Cross-platform `which`-style lookup. Returns the first hit from the
/// system's standard binary-lookup command (`which` on Unix, `where` on
/// Windows), or None if not found. Verifies the result exists on disk so
/// we don't return stale entries.
fn find_on_path(binary: &str) -> Option<PathBuf> {
    let lookup_cmd = if cfg!(windows) { "where" } else { "which" };
    let out = Command::new(lookup_cmd).arg(binary).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8(out.stdout).ok()?;
    let first_line = stdout.lines().next()?.trim();
    if first_line.is_empty() {
        return None;
    }
    let path = PathBuf::from(first_line);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}
