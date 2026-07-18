//! Tauri command surface — the frontend's RPC API.
//!
//! Each `#[tauri::command]` is callable from JS via
//! `window.__TAURI__.core.invoke(name, args)`. Errors returned as
//! `Result<T, String>` because Tauri's IPC layer requires `Serialize`able
//! errors and `String` is the simplest form that's still actionable in the
//! UI. Module-internal code uses richer error types (`SupervisorError`,
//! `io::Error`); we stringify at the IPC boundary.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app::state::AppState;
use crate::app::update_watcher::UPDATE_EVENT;
use crate::bundle;
use crate::config::{self, LauncherConfig};
use crate::daemon::{self, DaemonStatus};
use crate::http;
use crate::paths;
use crate::proc::hidden_command;
#[cfg(target_os = "macos")]
use crate::supervisor::launcher_agent;
#[cfg(target_os = "windows")]
use crate::supervisor::launcher_agent_win;
use crate::supervisor::{default_supervisor, DaemonConfig, RuntimeInfo, ServiceSupervisor};

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

/// Install in autostart mode — daemon runs at every login + auto-restarts
/// on crash. Bound to the "Install autostart" button on the NotInstalled
/// manager card. Also persists `daemon_mode = Autostart` so future renders
/// know which controls to show.
///
/// Assumes `save_initial_config` has already written
/// `<data>/.psycheros/general-settings.json` — `needs_first_run` gates
/// the install flow on first-run completion, so this holds in the
/// normal install path. The launcher does not re-seed here: psycheros's
/// settings file is the single source of truth and may have been edited
/// via psycheros's own UI between install steps.
#[tauri::command]
pub fn install_autostart(app: AppHandle) -> Result<DaemonStatus, String> {
    stage_windows_runner_if_needed(&app)?;
    let cfg = build_daemon_config()?;
    default_supervisor()
        .install_autostart(&cfg)
        .map_err(|e| e.to_string())?;
    persist_daemon_mode(config::DaemonMode::Autostart);
    install_launcher_agent_best_effort();
    Ok(daemon::probe())
}

/// Install in manual mode — daemon doesn't run at login and doesn't
/// auto-restart on crash, but starts immediately on install (the user
/// just clicked, they probably want it on). Bound to the "Install for
/// manual start/stop" button on the NotInstalled card.
///
/// Same assumption about `save_initial_config` as `install_autostart`.
#[tauri::command]
pub fn install_manual(app: AppHandle) -> Result<DaemonStatus, String> {
    stage_windows_runner_if_needed(&app)?;
    let cfg = build_daemon_config()?;
    default_supervisor()
        .install_manual(&cfg)
        .map_err(|e| e.to_string())?;
    persist_daemon_mode(config::DaemonMode::Manual);
    install_launcher_agent_best_effort();
    Ok(daemon::probe())
}

/// Self-heal: stage the daemon-runner sidecar into the stable launcher-
/// data-dir path if it isn't already there. Catches the "user installed
/// the launcher before the runner sidecar existed, then upgraded"
/// scenario — `needs_first_run` returns false because the source clone
/// is intact, so the standard first-run staging path never re-runs.
///
/// No-op on macOS / Linux (those platforms don't use a runner) and when
/// the runner is already present.
fn stage_windows_runner_if_needed(_app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let dest = paths::bundled_runner_path();
        if dest.exists() {
            return Ok(());
        }
        let sidecar_runner = resolve_sidecar_runner(_app)?;
        bundle::stage_bundled_binary(&sidecar_runner, &dest)
            .map_err(|e| format!("stage daemon runner: {e}"))?;
    }
    Ok(())
}

/// Uninstall — unregisters and stops the daemon. Mode-agnostic; works
/// whether the user originally installed via autostart or manual.
/// Bound to the "Uninstall" button across all post-install states.
#[tauri::command]
pub fn uninstall_autostart() -> Result<DaemonStatus, String> {
    default_supervisor()
        .uninstall()
        .map_err(|e| e.to_string())?;
    uninstall_launcher_agent_best_effort();
    Ok(daemon::probe())
}

/// Install the launcher's own launchd agent so the tray icon is
/// available at login independent of whether the user opens the .app.
/// Best-effort: a failure here doesn't roll back the daemon install
/// (the daemon works fine without the agent — just no auto-start tray).
/// Dev-mode launches that aren't running from a .app bundle are silently
/// skipped — see [`supervisor::launcher_agent`].
#[cfg(target_os = "macos")]
fn install_launcher_agent_best_effort() {
    match launcher_agent::install() {
        Ok(true) => eprintln!("[launcher] launcher agent installed"),
        Ok(false) => {} // dev-mode skip, message already logged
        Err(e) => eprintln!("[launcher] launcher agent install failed: {e}"),
    }
}

#[cfg(target_os = "windows")]
fn install_launcher_agent_best_effort() {
    match launcher_agent_win::install() {
        Ok(true) => eprintln!("[launcher] launcher agent installed"),
        Ok(false) => {} // dev-mode skip, message already logged
        Err(e) => eprintln!("[launcher] launcher agent install failed: {e}"),
    }
}

#[cfg(target_os = "linux")]
fn install_launcher_agent_best_effort() {
    // Linux launcher-agent stub not yet implemented. The daemon
    // supervisor stub also defers; the launcher agent will follow
    // whenever the systemd impl lands.
}

/// Counterpart to [`install_launcher_agent_best_effort`] — called on
/// daemon uninstall so the two services stay paired (both present or
/// both absent).
#[cfg(target_os = "macos")]
fn uninstall_launcher_agent_best_effort() {
    if let Err(e) = launcher_agent::uninstall() {
        eprintln!("[launcher] launcher agent uninstall failed: {e}");
    }
}

#[cfg(target_os = "windows")]
fn uninstall_launcher_agent_best_effort() {
    if let Err(e) = launcher_agent_win::uninstall() {
        eprintln!("[launcher] launcher agent uninstall failed: {e}");
    }
}

#[cfg(target_os = "linux")]
fn uninstall_launcher_agent_best_effort() {}

/// Start the daemon. Universal control — works for both autostart
/// (restarts a user-stopped session) and manual (kicks off a stopped
/// daemon). Bound to the "Start daemon" button on the Stopped card.
#[tauri::command]
pub fn start_daemon() -> Result<DaemonStatus, String> {
    // Re-sign native plugins + Deno binary for macOS Tahoe compatibility
    // on every start, not just first-run. Existing installations whose
    // launcher binary updated skip first-run entirely, so this is the
    // self-heal path for Tahoe users who already had the daemon installed
    // before the codesign fix shipped.
    bundle::repair_plug_cache_signatures();

    default_supervisor()
        .start_daemon()
        .map_err(|e| e.to_string())?;
    Ok(daemon::probe())
}

/// Stop the daemon. Session-scoped unload — for autostart the daemon
/// comes back at next login, for manual it stays stopped. Bound to the
/// "Stop daemon" button on the Running card.
#[tauri::command]
pub fn stop_daemon() -> Result<DaemonStatus, String> {
    default_supervisor()
        .stop_daemon()
        .map_err(|e| e.to_string())?;
    Ok(daemon::probe())
}

/// Read the persisted daemon mode (autostart vs manual). The frontend
/// uses this to render mode-appropriate copy (e.g., explaining why
/// "Stop" behaves differently in autostart mode).
#[tauri::command]
pub fn get_daemon_mode() -> String {
    let mode = config::load()
        .map(|c| c.effective_mode())
        .unwrap_or_default();
    match mode {
        config::DaemonMode::Autostart => "autostart".to_string(),
        config::DaemonMode::Manual => "manual".to_string(),
    }
}

/// Return the most recent N lines from the daemon's stderr log. Used by
/// the manager's live log panel on init, before the watcher's first
/// emission arrives. `max_lines` is a UI cap; `tail_bytes` bounds the
/// disk read (so we don't slurp a 100MB log every render).
#[tauri::command]
pub fn recent_daemon_log_lines(max_lines: Option<usize>, tail_bytes: Option<u64>) -> Vec<String> {
    let max = max_lines.unwrap_or(100);
    let bytes = tail_bytes.unwrap_or(64 * 1024);
    crate::app::log_tailer::recent_lines(max, bytes)
}

/// Internal helper: write the chosen mode into config.json on every
/// install. Silent best-effort — if the write fails the user can still
/// use the launcher, the mode just defaults to Autostart on next read.
fn persist_daemon_mode(mode: config::DaemonMode) {
    let mut cfg = config::load().unwrap_or_default();
    cfg.daemon_mode = Some(mode);
    if let Err(e) = config::save(&cfg) {
        eprintln!("[launcher] persist daemon_mode failed: {e}");
    }
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
///
/// The port comes from `config.json` (falling back to [`daemon::DAEMON_PORT`]
/// on missing or malformed config) so the probe, the install, and the
/// backup/restore HTTP calls all agree on a single source of truth.
fn build_daemon_config() -> Result<DaemonConfig, String> {
    // Pre-create dirs the supervisor will reference. Keeps the supervisor
    // impls free of "create dir if missing" noise.
    std::fs::create_dir_all(paths::data_dir()).map_err(|e| format!("create data dir: {e}"))?;
    std::fs::create_dir_all(paths::log_dir()).map_err(|e| format!("create log dir: {e}"))?;

    let cfg = config::load().unwrap_or_default();
    let port = cfg.port;

    Ok(DaemonConfig {
        label: "ai.psycheros.daemon".to_string(),
        deno_path: resolve_deno_path()?,
        source_dir: resolve_source_dir()?,
        data_dir: paths::data_dir(),
        log_dir: paths::log_dir(),
        port,
        entity_core_dir: None,
        entity_core_data_dir: Some(paths::entity_core_data_dir()),
        tahoe_compat: cfg.tahoe_compat,
    })
}

/// Resolve the Deno binary the service definition should reference.
///
/// Lookup order:
/// 1. The bundled Deno staged at `<launcher_data_dir>/bin/deno` — the
///    production answer; first-run setup puts it there.
/// 2. Whatever `which deno` / `where deno` returns on the user's PATH —
///    the dev fallback.
fn resolve_deno_path() -> Result<PathBuf, String> {
    if paths::bundled_deno_path().exists() {
        return Ok(paths::bundled_deno_path());
    }
    if let Some(p) = find_on_path("deno") {
        return Ok(p);
    }
    Err(setup_artifact_error(
        "my Deno runtime",
        &paths::bundled_deno_path(),
    ))
}

/// Resolve the psycheros source directory the daemon's `projectRoot` points
/// at.
///
/// Lookup order:
/// 1. The launcher-managed extracted source at
///    `<launcher_data_dir>/source/packages/psycheros/` — the production
///    answer; first-run setup extracts it there.
/// 2. The `PSYCHEROS_SRC_DIR` env var — the dev fallback.
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
            "PSYCHEROS_SRC_DIR is set to {} but src/main.ts isn't there. \
             Point it at an existing psycheros package root.",
            p.display(),
        ));
    }
    Err(setup_artifact_error(
        "my source files",
        &paths::source_dir(),
    ))
}

/// User-facing message for a missing first-run artifact. In dev (when
/// `PSYCHEROS_SRC_DIR` is set), surfaces enough detail for the developer
/// to fix it; in prod, points the user at "restart to re-run setup,"
/// which is what `needs_first_run`'s artifact check will deliver.
fn setup_artifact_error(what: &str, expected_path: &Path) -> String {
    let in_dev = std::env::var("PSYCHEROS_SRC_DIR").is_ok();
    if in_dev {
        format!(
            "{what} aren't where I expect them.\n\n\
             • Expected at: {}\n\n\
             Run `./scripts/setup.sh` from packages/launcher-v2/ to stage \
             dev assets, or set PSYCHEROS_SRC_DIR / pre-stage the bundled \
             Deno at the expected path.",
            expected_path.display(),
        )
    } else {
        format!(
            "{what} aren't where I expect them — my setup looks incomplete.\n\n\
             Quit Psycheros and reopen it to redo first-run setup. If the \
             problem repeats, reinstall from the latest release."
        )
    }
}

/// Cross-platform `which`-style lookup. Returns the first hit from the
/// system's standard binary-lookup command (`which` on Unix, `where` on
/// Windows), or None if not found. Verifies the result exists on disk so
/// we don't return stale entries.
fn find_on_path(binary: &str) -> Option<PathBuf> {
    let lookup_cmd = if cfg!(windows) { "where" } else { "which" };
    let out = hidden_command(lookup_cmd).arg(binary).output().ok()?;
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

// ---------------------------------------------------------------------------
// First-run orchestration
// ---------------------------------------------------------------------------

/// Payload of the `first-run-progress` event the frontend listens to while
/// the bootstrap runs. Tagged enum so the JS side can dispatch on `kind`.
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FirstRunProgress {
    /// A new phase has started — frontend uses this to swap the headline.
    Phase { phase: &'static str },
    /// A line of stderr from a child subprocess (git progress, deno cache).
    /// The frontend doesn't care which subprocess; it renders all of them
    /// in the same ticker. Phase context is provided by the prior `Phase`
    /// event.
    Line { line: String },
    /// All phases done. Frontend transitions to the manager card.
    Done,
}

/// Returns true when the bootstrap (clone + stage Deno + warm cache)
/// has not been completed for the current installation.
///
/// Falls through to "not needed" in dev mode (`PSYCHEROS_SRC_DIR` set), so
/// devs running from a clone don't see the wizard.
///
/// In production, both the config flag *and* the on-disk artifacts must
/// be present — a half-completed bootstrap (config saved but clone
/// interrupted) re-triggers the wizard rather than crashing later when
/// the user clicks "Install autostart". The `.git/` check also catches
/// installs from the pre-git-clone era (when the source dir was tarball
/// extraction): those existing users get a fresh re-bootstrap that
/// turns the source dir into a proper clone, self-healing.
#[tauri::command]
pub fn needs_first_run() -> bool {
    if std::env::var("PSYCHEROS_SRC_DIR").is_ok() {
        return false;
    }
    let version_recorded = match config::load() {
        Ok(cfg) => cfg.bundled_source_version.is_some(),
        Err(_) => false,
    };
    let source_root = paths::launcher_data_dir().join("source");
    let artifacts_present = source_root.join(".git").exists()
        && paths::source_dir().join("src/main.ts").exists()
        && paths::bundled_deno_path().exists();
    !(version_recorded && artifacts_present)
}

/// Persist user-supplied fields from the welcome wizard.
///
/// The launcher does not cache these values — they go straight into
/// psycheros's own `<data>/.psycheros/general-settings.json`, which is
/// the single source of truth. Caching them on the launcher side caused
/// drift the moment the user edited their entity name via psycheros's
/// settings UI; the launcher's stale copy would then re-stamp the file
/// on next install/restart and undo the edit.
///
/// Called BEFORE `first_run` so the inputs survive if extract/cache-warm
/// fails — the user doesn't have to re-type them on retry.
#[tauri::command]
pub fn save_initial_config(
    entity_name: String,
    user_name: String,
    timezone: String,
) -> Result<(), String> {
    let settings = GeneralSettings {
        entity_name,
        user_name,
        timezone,
    };
    write_general_settings(&settings)
        .map_err(|e| format!("seed psycheros general-settings: {e}"))?;
    Ok(())
}

/// Shape of psycheros's `general-settings.json`. Mirrors the
/// `GeneralSettings` type in `packages/psycheros/src/server/routes.ts`
/// — keep the field names in sync (camelCase via the serde rename).
///
/// Owned `String` fields so the same struct serves both the seed path
/// (writing from wizard inputs) and the read path (`read_general_settings`
/// command, used by the wizard pre-fill in `first-run.js` and by future
/// diagnostics / settings cards).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    pub entity_name: String,
    pub user_name: String,
    pub timezone: String,
}

/// Path to psycheros's `general-settings.json`. Pure helper — used by
/// both the read and write paths so we never let the filename drift.
fn general_settings_path() -> PathBuf {
    paths::data_dir()
        .join(".psycheros")
        .join("general-settings.json")
}

/// Write psycheros's `<data>/.psycheros/general-settings.json`.
/// Always overwrites — the wizard is the canonical user-intent moment;
/// no other launcher path writes this file (psycheros's own settings UI
/// is the post-install editor of record).
fn write_general_settings(settings: &GeneralSettings) -> Result<(), String> {
    let path = general_settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let mut json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("serialize general-settings: {e}"))?;
    json.push('\n');
    std::fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

/// Read psycheros's `<data>/.psycheros/general-settings.json`. Returns
/// `Ok(None)` if the file doesn't exist yet (fresh install, before the
/// wizard has run). Used by the wizard's pre-fill (`first-run.js` calls
/// this on re-run after a wipe) and will be reused by the diagnostics
/// + settings cards as those land.
///
/// Direct disk read rather than going through psycheros's HTTP API,
/// because the launcher needs this to work when the daemon is down.
#[tauri::command]
pub fn read_general_settings() -> Result<Option<GeneralSettings>, String> {
    let path = general_settings_path();
    if !path.exists() {
        return Ok(None);
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let settings: GeneralSettings =
        serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))?;
    Ok(Some(settings))
}

/// Public Psycheros source repo. Hardcoded so the launcher's storage
/// layout doesn't depend on user-editable config — making the source
/// URL configurable invites people pointing at forks they don't trust.
const SOURCE_REPO_URL: &str = "https://github.com/PsycherosAI/Psycheros";

/// Prefix for the tagged-release tags the launcher tracks. The launcher
/// only updates on commits that the maintainers explicitly tag —
/// in-flight `main` commits without a `psycheros-v*` tag aren't shipped
/// to users. The prefix is stripped before semver parsing
/// ([`bundle::query_latest_tag`]).
///
/// Effective prefix depends on the user's configured update channel
/// (`Stable` → `psycheros-v`; `Beta` → `psycheros-beta-v`). Use
/// `effective_tag_prefix()` rather than this constant when the call
/// path can vary by user choice.
const SOURCE_TAG_PREFIX: &str = "psycheros-v";

/// The currently-configured update channel's tag prefix. Resolves
/// to `psycheros-v` for `Stable` (default), `psycheros-beta-v` for
/// `Beta`. Cached in the [`LauncherConfig`] so a channel switch is
/// instant on next update check.
fn effective_tag_prefix() -> &'static str {
    config::load()
        .map(|cfg| cfg.effective_channel().tag_prefix())
        .unwrap_or(SOURCE_TAG_PREFIX)
}

/// Run the first-run bootstrap: clone Psycheros source at the latest
/// channel tag → stage the sidecar Deno → warm Deno's dep cache →
/// record the installed tag name (not the SHA) in
/// `LauncherConfig.bundled_source_version`.
///
/// Emits `first-run-progress` events throughout. Idempotent: running it
/// a second time fast-forwards an existing clone (or re-clones if the
/// source dir is missing), then re-stages Deno (overwrite) and re-warms
/// the cache. Safe to re-run as part of post-update bootstrapping.
///
/// All filesystem + subprocess work happens on a blocking thread so the
/// Tauri async runtime stays responsive to other IPCs (especially
/// `daemon_status`, which the watcher pings every 2s).
#[tauri::command]
pub async fn first_run(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_first_run_blocking(app))
        .await
        .map_err(|e| format!("first-run task crashed: {e}"))?
}

fn run_first_run_blocking(app: AppHandle) -> Result<(), String> {
    let sidecar_deno = resolve_sidecar_deno(&app)?;
    let source_root = paths::launcher_data_dir().join("source");

    // Resolve the latest tagged release on upstream. No tags = nothing to
    // install — surface that as a friendly error rather than a git
    // "ref not found" later in the clone step.
    let tag_prefix = effective_tag_prefix();
    let latest_tag = bundle::query_latest_tag(SOURCE_REPO_URL, tag_prefix)
        .map_err(|e| format!("look up latest Psycheros release: {e}"))?
        .ok_or_else(|| {
            format!(
                "I couldn't find any tagged Psycheros releases on \
                 {SOURCE_REPO_URL} (looking for tags matching \
                 `{tag_prefix}*`). The launcher needs at least one \
                 tagged release before I can install — wait for the next \
                 release and try again."
            )
        })?;

    // Phase 1: clone Psycheros source at the resolved tag.
    let _ = app.emit(
        "first-run-progress",
        FirstRunProgress::Phase { phase: "clone" },
    );
    let _head_sha = {
        let app = app.clone();
        bundle::clone_or_fetch_source(SOURCE_REPO_URL, &latest_tag, &source_root, move |line| {
            let _ = app.emit(
                "first-run-progress",
                FirstRunProgress::Line {
                    line: line.to_string(),
                },
            );
        })
        .map_err(|e| format!("clone Psycheros source: {e}"))?
    };

    // Phase 2: stage Deno binary to the stable launcher-managed path.
    let _ = app.emit(
        "first-run-progress",
        FirstRunProgress::Phase {
            phase: "stage-deno",
        },
    );
    let deno_dest = paths::bundled_deno_path();
    bundle::stage_bundled_deno(&sidecar_deno, &deno_dest)
        .map_err(|e| format!("stage bundled deno: {e}"))?;

    // Phase 2.5 (Windows-only): stage the daemon-runner sidecar so the
    // Task Scheduler action has a stable path to invoke. macOS / Linux
    // service definitions reference deno directly via their plist /
    // unit-file Exec entries — no runner needed there.
    #[cfg(target_os = "windows")]
    {
        let sidecar_runner = resolve_sidecar_runner(&app)?;
        let runner_dest = paths::bundled_runner_path();
        bundle::stage_bundled_binary(&sidecar_runner, &runner_dest)
            .map_err(|e| format!("stage daemon runner: {e}"))?;
    }

    // Phase 3: warm Deno's dep cache. The slow one.
    let _ = app.emit(
        "first-run-progress",
        FirstRunProgress::Phase {
            phase: "warm-cache",
        },
    );
    {
        let app = app.clone();
        bundle::warm_deno_cache(&deno_dest, &paths::source_dir(), move |line| {
            let _ = app.emit(
                "first-run-progress",
                FirstRunProgress::Line {
                    line: line.to_string(),
                },
            );
        })
        .map_err(|e| format!("warm deno cache: {e}"))?;
    }

    // Phase 3.5: re-sign native plugins for macOS Tahoe compatibility.
    // Tahoe enforces Team ID matching on dlopen(); the official Deno binary
    // and prebuilt native plugins carry different Team IDs. Ad-hoc re-signing
    // both (done for Deno in stage_bundled_binary, for plugins here) aligns
    // them.
    bundle::repair_plug_cache_signatures();

    // Record completion. `bundled_source_version` is the tag name we
    // cloned (e.g. `psycheros-v0.3.3`). Update detection compares the
    // stored tag against `query_latest_tag` to decide whether to offer
    // an update — both sides are tag names, not SHAs.
    let mut cfg: LauncherConfig = config::load().unwrap_or_default();
    cfg.bundled_source_version = Some(latest_tag);
    config::save(&cfg).map_err(|e| format!("save config: {e}"))?;

    let _ = app.emit("first-run-progress", FirstRunProgress::Done);
    Ok(())
}

/// Resolve a sidecar binary that ships as a Tauri `externalBin`.
///
/// Tauri 2 places sidecars in different locations depending on platform
/// and build mode:
///   - macOS bundled (.app): `Contents/MacOS/<basename>` — NOT in
///     `Contents/Resources/`
///   - macOS dev (`cargo tauri dev`): next to the debug binary in
///     `target/debug/`
///   - Windows bundled: alongside the main `.exe`
///
/// We try multiple resolution strategies in order: Tauri's Resource
/// directory, the current executable's parent, and the executable's
/// parent walked up to the `.app` bundle root's `Contents/MacOS/`.
fn resolve_sidecar_binary(
    app: &AppHandle,
    basename: &str,
    extra_candidates: &[&str],
) -> Result<PathBuf, String> {
    let triple = current_target_triple();
    if triple.is_empty() {
        return Err(format!(
            "no bundled {basename} sidecar for target (os={}, arch={})",
            std::env::consts::OS,
            std::env::consts::ARCH,
        ));
    }
    let exe_suffix = if cfg!(windows) { ".exe" } else { "" };
    let mut candidates: Vec<String> = vec![
        format!("{basename}{exe_suffix}"),
        format!("{basename}-{triple}{exe_suffix}"),
        format!("binaries/{basename}{exe_suffix}"),
        format!("binaries/{basename}-{triple}{exe_suffix}"),
    ];
    candidates.extend(extra_candidates.iter().map(|s| s.to_string()));

    let mut checked_dirs: Vec<String> = Vec::new();

    // Strategy 1: Tauri's Resource directory (Contents/Resources/ on macOS,
    // or target/debug/ in dev mode).
    if let Ok(resource_dir) = app.path().resolve("", BaseDirectory::Resource) {
        for name in &candidates {
            let p = resource_dir.join(name);
            if p.exists() {
                return Ok(p);
            }
        }
        checked_dirs.push(resource_dir.display().to_string());
    }

    // Strategy 2: current executable's parent directory. On macOS bundled
    // apps, the exe is at Contents/MacOS/<app-name>, so the parent is
    // Contents/MacOS/ where Tauri 2 actually places sidecars.
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            for name in &candidates {
                let p = exe_dir.join(name);
                if p.exists() {
                    return Ok(p);
                }
            }
            checked_dirs.push(exe_dir.display().to_string());

            // Strategy 3: on macOS, if the exe is deep inside a .app bundle
            // (e.g. after translocation), walk up to find Contents/MacOS/.
            // Normal path: <bundle>/Contents/MacOS/<app> — parent is already
            // Contents/MacOS/ (handled above).  Translocated or unusual
            // layouts may nest deeper.
            let mut dir = exe_dir.to_path_buf();
            while let Some(parent) = dir.parent() {
                if parent.file_name().is_some_and(|n| n == "Contents")
                    && dir.file_name().is_some_and(|n| n == "MacOS")
                {
                    for name in &candidates {
                        let p = dir.join(name);
                        if p.exists() {
                            return Ok(p);
                        }
                    }
                    checked_dirs.push(dir.display().to_string());
                    break;
                }
                dir = parent.to_path_buf();
            }
        }
    }

    Err(format!(
        "bundled {basename} sidecar not found \
         (version {}, triple={triple}, checked dirs: [{}], \
         candidates: [{}])",
        env!("CARGO_PKG_VERSION"),
        checked_dirs.join(", "),
        candidates.join(", "),
    ))
}

/// Resolve the bundled Deno sidecar. Thin wrapper around
/// [`resolve_sidecar_binary`].
fn resolve_sidecar_deno(app: &AppHandle) -> Result<PathBuf, String> {
    resolve_sidecar_binary(app, "deno", &[])
}

/// Resolve the Windows-only `psycheros-daemon-runner` sidecar staged via
/// Tauri's `externalBin`. Falls back to the launcher's `target/debug`
/// sibling for `cargo tauri dev` where the binary builds via Cargo's
/// normal `[[bin]]` mechanism but isn't bundled into the resource dir.
#[cfg(target_os = "windows")]
fn resolve_sidecar_runner(app: &AppHandle) -> Result<PathBuf, String> {
    // Try the bundled-resource form first (production / staged dev
    // builds where setup.ps1 copied the binary into
    // `src-tauri/binaries/`).
    if let Ok(p) = resolve_sidecar_binary(app, "psycheros-daemon-runner", &[]) {
        return Ok(p);
    }
    // Dev fallback: sibling of the launcher's own .exe in target/.
    if let Ok(launcher_exe) = std::env::current_exe() {
        if let Some(parent) = launcher_exe.parent() {
            let candidate = parent.join("psycheros-daemon-runner.exe");
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }
    Err("psycheros-daemon-runner.exe missing. In dev: run \
         `cargo build --bin psycheros-daemon-runner` first. In prod: \
         setup.ps1 should have staged it into src-tauri/binaries/."
        .to_string())
}

// ---------------------------------------------------------------------------
// Update detection + apply (Phase A.2.b — A.2.c lands the apply path)
// ---------------------------------------------------------------------------

/// Snapshot the frontend uses to render the "updates available" affordance.
/// Returned by `check_for_updates`.
///
/// Tag-based: `current_version` and `latest_version` are tag names
/// (e.g. `psycheros-v0.3.3`), not SHAs. The launcher tracks tags now,
/// not branch HEADs.
#[derive(Debug, Serialize, Clone)]
pub struct UpdateInfo {
    /// The tag currently installed (from `config.bundled_source_version`).
    /// `None` if first-run hasn't completed yet — the frontend won't
    /// render an update prompt in that case anyway.
    pub current_version: Option<String>,
    /// The highest matching tag on the public source repo. `None` only
    /// when upstream has no `psycheros-v*` tags at all — the launcher
    /// reports a friendly error in that case.
    pub latest_version: Option<String>,
    /// True iff `latest_version` is `Some` and differs from
    /// `current_version`. False when either side is unset or both match.
    pub update_available: bool,
}

/// Check whether the public Psycheros repo has commits beyond what's on
/// disk. Pure read — runs `git ls-remote` without touching the local
/// clone state, so it's safe to call from a background poll.
///
/// Network-bound (~1s under normal conditions, can hang on a flaky
/// connection). The frontend should call this on a long interval
/// (~hours), not every render.
#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(check_for_updates_blocking)
        .await
        .map_err(|e| format!("check_for_updates task crashed: {e}"))?
}

/// Synchronous core of `check_for_updates`. Exposed `pub(crate)` so the
/// background update watcher in `app::update_watcher` can call it from
/// its polling loop without going through the IPC layer.
pub(crate) fn check_for_updates_blocking() -> Result<UpdateInfo, String> {
    let latest_version = bundle::query_latest_tag(SOURCE_REPO_URL, effective_tag_prefix())
        .map_err(|e| format!("query latest tag: {e}"))?;

    let current_version = config::load()
        .ok()
        .and_then(|cfg| cfg.bundled_source_version);

    let update_available = match (&current_version, &latest_version) {
        (Some(local), Some(latest)) => local != latest,
        _ => false,
    };

    Ok(UpdateInfo {
        current_version,
        latest_version,
        update_available,
    })
}

/// Payload of the `source-update-progress` event emitted while
/// `apply_source_update` runs. Shape matches `FirstRunProgress` so the
/// frontend can reuse its ticker rendering logic.
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SourceUpdateProgress {
    Phase { phase: &'static str },
    Line { line: String },
    Done { new_version: String },
}

/// Apply a source update. With `target_tag = None`, resolves the latest
/// tag on the configured channel (default behavior for the "Update now"
/// banner). With `target_tag = Some("psycheros-v0.3.2")`, installs that
/// specific tag — used by the version picker for pinning or rolling
/// forward/back to a known release.
///
/// Flow: snapshot `.psycheros/` → fetch + reset the source clone to the
/// target tag → run the inter-version migration script (if present) →
/// re-warm Deno's dep cache → restart the daemon → record the tag in
/// `LauncherConfig.bundled_source_version` and append an
/// `UpdateHistoryEntry`. Emits `source-update-progress` events
/// throughout.
///
/// State in `<data>/identity`, `.psycheros/`, and the vault is preserved
/// across the update. Migrations may rewrite parts of it, but only when
/// a maintainer ships a versioned migration script in the source tree.
#[tauri::command]
pub async fn apply_source_update(app: AppHandle, target_tag: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || apply_source_update_blocking(app, target_tag))
        .await
        .map_err(|e| format!("apply_source_update task crashed: {e}"))?
}

fn apply_source_update_blocking(app: AppHandle, target_tag: Option<String>) -> Result<(), String> {
    let source_root = paths::launcher_data_dir().join("source");

    // Either the user picked a specific tag (Install version) or we
    // resolve the latest on the configured channel. Re-resolving each
    // time lets the latest-path always converge on the freshest
    // upstream — important when the user clicked "Update" hours after
    // the watcher first detected the new tag.
    let latest_tag = match target_tag {
        Some(t) => t,
        None => bundle::query_latest_tag(SOURCE_REPO_URL, effective_tag_prefix())
            .map_err(|e| format!("look up latest Psycheros release: {e}"))?
            .ok_or_else(|| {
                "Couldn't find any tagged Psycheros releases upstream while \
                 trying to apply an update."
                    .to_string()
            })?,
    };

    // Phase 0: snapshot the pre-update entity data so rollback is
    // possible (§5.21 / §5.22). Best-effort — failure here doesn't
    // abort the update, just leaves snapshot_id=None in the history
    // entry. The data dir can be tens of MB; the copy happens before
    // the daemon restart so files aren't being mutated underneath us.
    let _ = app.emit(
        "source-update-progress",
        SourceUpdateProgress::Phase { phase: "snapshot" },
    );
    let snapshot_id = match create_pre_update_snapshot() {
        Ok(id) => Some(id),
        Err(e) => {
            let _ = app.emit(
                "source-update-progress",
                SourceUpdateProgress::Line {
                    line: format!("snapshot failed (rollback not available): {e}"),
                },
            );
            None
        }
    };
    let previous_tag = config::load()
        .ok()
        .and_then(|cfg| cfg.bundled_source_version);

    // Phase 1: fetch + reset to the latest tag.
    let _ = app.emit(
        "source-update-progress",
        SourceUpdateProgress::Phase { phase: "fetch" },
    );
    let _new_sha = {
        let app = app.clone();
        bundle::clone_or_fetch_source(SOURCE_REPO_URL, &latest_tag, &source_root, move |line| {
            let _ = app.emit(
                "source-update-progress",
                SourceUpdateProgress::Line {
                    line: line.to_string(),
                },
            );
        })
        .map_err(|e| format!("fetch updated source: {e}"))?
    };

    // Phase 1.5: run any migration script the new source ships for
    // this from→to transition. §5.20. The script is a Deno program at
    // `<source_root>/migrations/<from>-to-<to>.ts`, invoked with the
    // user's data dir as its only argument; the maintainer keeps
    // these scripts idempotent so a partial-run retry is safe.
    //
    // Missing-file is the normal case (most version bumps don't need
    // migrations); only an actual script execution failure aborts
    // the update.
    if let Some(prev_tag) = config::load().ok().and_then(|c| c.bundled_source_version) {
        let _ = app.emit(
            "source-update-progress",
            SourceUpdateProgress::Phase { phase: "migrate" },
        );
        let app_clone = app.clone();
        run_migration_if_present(
            &source_root,
            &prev_tag,
            &latest_tag,
            &paths::data_dir(),
            move |line| {
                let _ = app_clone.emit(
                    "source-update-progress",
                    SourceUpdateProgress::Line {
                        line: line.to_string(),
                    },
                );
            },
        )
        .map_err(|e| format!("run migration script: {e}"))?;
    }

    // Phase 2: re-warm cache. Incremental — fast when deno.lock is
    // unchanged, real work when new deps landed.
    let _ = app.emit(
        "source-update-progress",
        SourceUpdateProgress::Phase {
            phase: "warm-cache",
        },
    );
    {
        let app = app.clone();
        bundle::warm_deno_cache(
            &paths::bundled_deno_path(),
            &paths::source_dir(),
            move |line| {
                let _ = app.emit(
                    "source-update-progress",
                    SourceUpdateProgress::Line {
                        line: line.to_string(),
                    },
                );
            },
        )
        .map_err(|e| format!("warm deno cache after update: {e}"))?;
    }

    // Phase 3: restart daemon so it picks up new code. No-op if not
    // installed/loaded — the user may have updated source before
    // installing autostart.
    let _ = app.emit(
        "source-update-progress",
        SourceUpdateProgress::Phase { phase: "restart" },
    );
    default_supervisor()
        .restart()
        .map_err(|e| format!("restart daemon: {e}"))?;

    // Persist the new tag so check_for_updates returns
    // update_available=false on the next call. Also append a history
    // entry capturing the snapshot ID + previous tag, for the history
    // viewer + rollback path.
    let mut cfg: LauncherConfig = config::load().unwrap_or_default();
    cfg.bundled_source_version = Some(latest_tag.clone());
    cfg.record_update(config::UpdateHistoryEntry {
        tag: latest_tag.clone(),
        applied_at: chrono_like_timestamp(),
        previous_tag,
        snapshot_id,
    });
    config::save(&cfg).map_err(|e| format!("save config: {e}"))?;

    // Prune older snapshots so the .snapshots/ directory doesn't grow
    // unbounded over years of updates. Keep parity with the history
    // cap — anything beyond UPDATE_HISTORY_LIMIT is unreachable from
    // the viewer anyway.
    if let Err(e) = prune_snapshots(config::UPDATE_HISTORY_LIMIT) {
        eprintln!("[launcher] snapshot prune failed (non-fatal): {e}");
    }

    // Force-clear update affordances now that the update has applied —
    // the background watcher won't poll again for ~3 hours, so the
    // banner and toast would otherwise look stale until then.
    let _ = app.emit(
        UPDATE_EVENT,
        &UpdateInfo {
            current_version: Some(latest_tag.clone()),
            latest_version: Some(latest_tag.clone()),
            update_available: false,
        },
    );
    crate::app::update_watcher::remove_toast(&app);

    let _ = app.emit(
        "source-update-progress",
        SourceUpdateProgress::Done {
            new_version: latest_tag,
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/// Snapshot the diagnostics card renders. Pure read of launcher state +
/// supervisor introspection + a recursive disk-usage walk over the data
/// dir. Built fresh on every call (no caching) — the disk walk is the
/// slowest part and finishes well under 100ms for realistic data dirs.
#[derive(Debug, Serialize, Clone)]
pub struct Diagnostics {
    /// Launcher version from `CARGO_PKG_VERSION` at compile time.
    pub launcher_version: &'static str,
    /// Currently-installed psycheros source tag, e.g. `psycheros-v0.3.3`.
    /// `None` before first-run completes.
    pub source_version: Option<String>,
    /// Daemon state derived from probe() — `not_installed` / `stopped` /
    /// `installed` / `running`. Stringified for the frontend.
    pub daemon_state: &'static str,
    /// Resolved daemon mode: `autostart` or `manual`.
    pub daemon_mode: &'static str,
    /// Best-effort PID + last exit status from the supervisor.
    pub runtime: RuntimeInfo,
    /// Whether psycheros's HTTP port is currently bound. Mirrors the
    /// probe's port-bound signal — surfaced separately so the UI can
    /// show "Running on port 3000" vs "Service loaded, port not bound".
    pub port_bound: bool,
    /// The HTTP port the launcher tells the supervisor to bind.
    pub port: u16,
    /// Absolute paths the launcher reads/writes. Each is shown next to
    /// an "Open in Finder" affordance.
    pub paths: DiagnosticsPaths,
    /// Recursive disk usage of the data dir, in bytes. `None` if the
    /// walk failed (e.g. permissions); UI shows "—" in that case.
    pub data_dir_size_bytes: Option<u64>,
    /// Upstream source the launcher tracks. Display-only.
    pub upstream_repo_url: &'static str,
    /// Tag prefix the launcher filters on when polling for updates.
    pub upstream_tag_prefix: &'static str,
    /// Supervisor's service label (e.g. `ai.psycheros.daemon`).
    pub service_label: String,
}

/// Filesystem paths surfaced in the diagnostics card. Separated from the
/// top-level Diagnostics so the frontend can iterate them generically when
/// rendering "Open in Finder" buttons.
#[derive(Debug, Serialize, Clone)]
pub struct DiagnosticsPaths {
    pub launcher_data_dir: String,
    pub data_dir: String,
    pub source_dir: String,
    pub log_dir: String,
    pub config_path: String,
}

/// Gather a complete diagnostics snapshot for the manager's diagnostics
/// card. Blocking work (filesystem walk + `launchctl list`) is moved to
/// a blocking thread so the Tauri runtime stays responsive.
#[tauri::command]
pub async fn get_diagnostics() -> Result<Diagnostics, String> {
    tauri::async_runtime::spawn_blocking(get_diagnostics_blocking)
        .await
        .map_err(|e| format!("diagnostics task crashed: {e}"))
}

fn get_diagnostics_blocking() -> Diagnostics {
    let status = daemon::probe();
    let cfg = config::load().unwrap_or_default();
    let supervisor = default_supervisor();
    let runtime = supervisor.query_runtime_info();
    let data_dir_size_bytes = dir_size_bytes(&paths::data_dir()).ok();

    Diagnostics {
        launcher_version: env!("CARGO_PKG_VERSION"),
        source_version: cfg.bundled_source_version.clone(),
        daemon_state: status.state.as_str(),
        daemon_mode: match cfg.effective_mode() {
            config::DaemonMode::Autostart => "autostart",
            config::DaemonMode::Manual => "manual",
        },
        runtime,
        port_bound: status.state == daemon::DaemonState::Running,
        port: cfg.port,
        paths: DiagnosticsPaths {
            launcher_data_dir: paths::launcher_data_dir().display().to_string(),
            data_dir: paths::data_dir().display().to_string(),
            source_dir: paths::source_dir().display().to_string(),
            log_dir: paths::log_dir().display().to_string(),
            config_path: paths::config_path().display().to_string(),
        },
        data_dir_size_bytes,
        upstream_repo_url: SOURCE_REPO_URL,
        upstream_tag_prefix: effective_tag_prefix(),
        service_label: supervisor.label().to_string(),
    }
}

/// Recursive byte count of `root`. Returns `Ok(0)` if `root` doesn't
/// exist (fresh install before any data has been written). Skips
/// directory entries it can't stat — partial results are more useful
/// than a hard error in the diagnostics card.
fn dir_size_bytes(root: &Path) -> std::io::Result<u64> {
    if !root.exists() {
        return Ok(0);
    }
    let mut total: u64 = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(meta.len());
            }
        }
    }
    Ok(total)
}

/// Reveal a filesystem path in the OS's native file manager.
///
/// macOS: `open <path>` → Finder. Linux: `xdg-open <path>` → user's
/// default file manager (Nautilus, Dolphin, etc.). Windows: `explorer`.
/// Each shells out without quoting per-platform path quirks because the
/// underlying tool's argv handling already does the right thing.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("path doesn't exist: {path}"));
    }
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    // Deliberately use std::process::Command directly (not hidden_command)
    // — the user clicked "Reveal" / "Open in file manager" and the
    // window IS the affordance they want. explorer.exe is a windowed-
    // subsystem app so CREATE_NO_WINDOW wouldn't hide its file-manager
    // window anyway, but routing through hidden_command would be
    // misleading at the call-site level.
    std::process::Command::new(opener)
        .arg(&p)
        .spawn()
        .map_err(|e| format!("spawn {opener}: {e}"))?;
    Ok(())
}

/// Open a URL in the user's default browser. Like `open_path` but for
/// HTTP(S) URLs — on Windows we must use `cmd /C start` because `explorer`
/// only handles filesystem paths.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        // hidden_command prevents the console flash on release builds.
        crate::proc::hidden_command("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("spawn cmd: {e}"))?;
    } else {
        let opener = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        std::process::Command::new(opener)
            .arg(&url)
            .spawn()
            .map_err(|e| format!("spawn {opener}: {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Mode + channel — runtime switching
// ---------------------------------------------------------------------------

/// Switch the daemon's run mode without forcing the user through
/// uninstall/reinstall. Overwrites the plist with the new mode's
/// content (handled inside `install_autostart` / `install_manual` —
/// `write_and_load_plist` unloads + writes + reloads, so an already-
/// installed service flips cleanly). Persists the new mode in
/// config.json.
///
/// `mode` is the lowercase serde tag — `"autostart"` or `"manual"`.
/// Anything else returns an error.
#[tauri::command]
pub fn set_daemon_mode(mode: String) -> Result<DaemonStatus, String> {
    let new_mode = match mode.as_str() {
        "autostart" => config::DaemonMode::Autostart,
        "manual" => config::DaemonMode::Manual,
        other => return Err(format!("unknown daemon mode: {other}")),
    };
    let cfg = build_daemon_config()?;
    // `set_mode_only` writes the new plist content without unloading
    // or restarting the daemon — the previous design called
    // `install_autostart` / `install_manual`, which both unload +
    // write + load + start. That restart cascaded through the daemon's
    // HTTP connections, the entity-core MCP child, and the chat
    // surface's reconnect logic; every mode toggle would briefly
    // leave the chat in a "Memory sync is offline" state until
    // entity-core finished re-initializing. The mode preference only
    // affects login-time behavior, so rewriting the plist on disk is
    // sufficient — launchd picks up the new RunAtLoad / KeepAlive at
    // next session load.
    default_supervisor()
        .set_mode_only(&cfg, new_mode)
        .map_err(|e| e.to_string())?;
    persist_daemon_mode(new_mode);
    Ok(daemon::probe())
}

/// Persist the user's update channel selection. The next call into
/// `check_for_updates` / `apply_source_update` / `query_latest_tag`
/// picks up the new tag prefix automatically via
/// `effective_tag_prefix()`.
#[tauri::command]
pub fn set_update_channel(channel: String) -> Result<(), String> {
    let new_channel = match channel.as_str() {
        "stable" => config::UpdateChannel::Stable,
        "beta" => config::UpdateChannel::Beta,
        other => return Err(format!("unknown update channel: {other}")),
    };
    let mut cfg = config::load().unwrap_or_default();
    cfg.update_channel = Some(new_channel);
    config::save(&cfg).map_err(|e| format!("save config: {e}"))
}

/// Read the persisted update channel as a serde string (`stable` or
/// `beta`) for the settings UI to render with the right toggle state.
#[tauri::command]
pub fn get_update_channel() -> String {
    let channel = config::load()
        .map(|cfg| cfg.effective_channel())
        .unwrap_or_default();
    match channel {
        config::UpdateChannel::Stable => "stable".to_string(),
        config::UpdateChannel::Beta => "beta".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Tahoe VM nonsense workaround
// ---------------------------------------------------------------------------

/// Whether the macOS Tahoe JITless workaround is enabled. Returned as a
/// bool for the settings UI toggle state.
#[tauri::command]
pub fn get_tahoe_compat() -> bool {
    config::load().map(|cfg| cfg.tahoe_compat).unwrap_or(false)
}

/// Toggle the macOS Tahoe JITless workaround. Persists the choice,
/// rewrites the plist (so `DENO_V8_FLAGS=--jitless` appears or
/// disappears from the env block), and restarts the daemon if it's
/// currently running so the change takes effect immediately.
#[tauri::command]
pub fn set_tahoe_compat(enabled: bool) -> Result<(), String> {
    // 1. Persist the new value.
    let mut cfg = config::load().unwrap_or_default();
    cfg.tahoe_compat = enabled;
    config::save(&cfg).map_err(|e| format!("save config: {e}"))?;

    // 2. Re-sign native plugins + Deno binary (Tahoe Team ID fix).
    bundle::repair_plug_cache_signatures();

    // 3. Rewrite the plist + restart (no-ops when not installed / not loaded).
    let daemon_cfg = build_daemon_config()?;
    let mode = cfg.effective_mode();
    let sup = default_supervisor();
    let _ = sup.set_mode_only(&daemon_cfg, mode);
    let _ = sup.restart();
    Ok(())
}

// ---------------------------------------------------------------------------
// Data management — backup, restore, wipe, re-init
// ---------------------------------------------------------------------------

/// Outcome of a backup operation. Returned to the frontend so it can
/// surface the resulting filename + byte count.
#[derive(Debug, Serialize, Clone)]
pub struct BackupResult {
    pub path: String,
    pub size_bytes: u64,
}

/// Trigger psycheros's entity-data export and stream the result to
/// the user's Downloads dir. The daemon must be Running — the export
/// is a live operation against the daemon's in-memory + on-disk state.
///
/// Filename is `psycheros-backup-<RFC3339 timestamp>.zip` so multiple
/// backups don't collide. Existing files are not overwritten — if a
/// collision somehow occurs (sub-second clicks), the second write
/// errors and the user sees that.
#[tauri::command]
pub async fn backup_data() -> Result<BackupResult, String> {
    tauri::async_runtime::spawn_blocking(backup_data_blocking)
        .await
        .map_err(|e| format!("backup task crashed: {e}"))?
}

/// Synchronous core of `backup_data`. Exposed `pub` so integration
/// tests in `tests/` can drive it directly without spinning up the
/// Tauri runtime.
pub fn backup_data_blocking() -> Result<BackupResult, String> {
    let cfg = config::load().unwrap_or_default();
    let resp = http::request_localhost(cfg.port, "POST", "/api/admin/entity-data/export", &[], "")
        .map_err(|e| format!("export request failed: {e}. Is the daemon running?"))?;
    if !resp.is_success() {
        return Err(format!(
            "export endpoint returned HTTP {} — body: {}",
            resp.status,
            String::from_utf8_lossy(&resp.body)
                .chars()
                .take(200)
                .collect::<String>(),
        ));
    }

    let download_dir = paths::download_dir()
        .ok_or_else(|| "couldn't resolve the Downloads directory on this system".to_string())?;
    std::fs::create_dir_all(&download_dir).map_err(|e| format!("create Downloads dir: {e}"))?;
    let ts = chrono_like_timestamp();
    let filename = format!("psycheros-backup-{ts}.zip");
    let dest = download_dir.join(&filename);
    if dest.exists() {
        return Err(format!(
            "a file named {} already exists in Downloads — wait a second and try again",
            filename
        ));
    }
    std::fs::write(&dest, &resp.body)
        .map_err(|e| format!("write backup to {}: {e}", dest.display()))?;

    Ok(BackupResult {
        path: dest.display().to_string(),
        size_bytes: resp.body.len() as u64,
    })
}

/// RFC3339-ish timestamp without colons (so it's a valid filename on
/// every OS). `2026-05-19T14-30-12Z` rather than `…T14:30:12Z`.
///
/// Avoids pulling in `chrono` for one timestamp call. UNIX timestamp
/// is good enough for ordering; we render it human-readable via
/// SystemTime → component math.
fn chrono_like_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Days since epoch + seconds-of-day. The civil-from-days algorithm
    // (Howard Hinnant) gives us Y/M/D without a calendar library.
    let secs_of_day = (now % 86_400) as u32;
    let days_since_epoch = (now / 86_400) as i64;
    let (y, m, d) = civil_from_days(days_since_epoch);
    let h = secs_of_day / 3600;
    let mn = (secs_of_day % 3600) / 60;
    let s = secs_of_day % 60;
    format!("{y:04}-{m:02}-{d:02}T{h:02}-{mn:02}-{s:02}Z")
}

/// Howard Hinnant's days-from-civil inverse. Days are days since
/// 1970-01-01 (UNIX epoch); returns `(year, month, day)`.
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 {
        z / 146_097
    } else {
        (z - 146_096) / 146_097
    };
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = (y + if m <= 2 { 1 } else { 0 }) as i32;
    (year, m, d)
}

/// Outcome of a restore. `result_message` carries through psycheros's
/// own status string ("imported 47 memories, 12 conversations…") so
/// the UI can surface it as-is rather than synthesizing one.
#[derive(Debug, Serialize, Clone)]
pub struct RestoreResult {
    pub success: bool,
    pub result_message: String,
}

/// Restore a previously-exported zip into psycheros. The user picks
/// the zip via the frontend's file picker (tauri-plugin-dialog), the
/// path comes through as a string here, and we POST the bytes to
/// psycheros's import endpoint. On success the daemon restarts so
/// in-memory state matches the freshly-imported data.
#[tauri::command]
pub async fn restore_data(path: String) -> Result<RestoreResult, String> {
    tauri::async_runtime::spawn_blocking(move || restore_data_blocking(path))
        .await
        .map_err(|e| format!("restore task crashed: {e}"))?
}

/// Synchronous core of `restore_data`. Exposed `pub` so integration
/// tests in `tests/` can drive it directly without spinning up the
/// Tauri runtime. `supervisor.restart()` is idempotent and no-ops
/// when no plist exists, so tests running against a tempdir HOME
/// stay clean.
pub fn restore_data_blocking(path: String) -> Result<RestoreResult, String> {
    let cfg = config::load().unwrap_or_default();
    let bytes = std::fs::read(&path).map_err(|e| format!("read backup file: {e}"))?;

    let resp = http::request_localhost(
        cfg.port,
        "POST",
        "/api/admin/entity-data/import",
        &bytes,
        "application/zip",
    )
    .map_err(|e| format!("import request failed: {e}. Is the daemon running?"))?;

    if !resp.is_success() {
        return Err(format!(
            "import endpoint returned HTTP {} — body: {}",
            resp.status,
            String::from_utf8_lossy(&resp.body)
                .chars()
                .take(400)
                .collect::<String>(),
        ));
    }

    // Psycheros returns { success: bool, error?: string, message?: string,
    // summary?: object }. We surface the salient pieces back to the UI
    // and let the frontend render the details.
    #[derive(Deserialize)]
    struct ImportResp {
        success: bool,
        #[serde(default)]
        message: String,
        #[serde(default)]
        error: String,
    }
    let parsed: ImportResp =
        serde_json::from_slice(&resp.body).map_err(|e| format!("parse import response: {e}"))?;

    // Restart the daemon so in-memory caches (the LLM client, MCP
    // session, scheduler, RAG indexes) re-read from the freshly
    // imported data rather than staying on pre-import state.
    if parsed.success {
        default_supervisor()
            .restart()
            .map_err(|e| format!("daemon restart after import: {e}"))?;
    }

    let result_message = if parsed.success {
        if parsed.message.is_empty() {
            "Restore complete; daemon restarted.".to_string()
        } else {
            format!("{}; daemon restarted.", parsed.message)
        }
    } else if !parsed.error.is_empty() {
        parsed.error.clone()
    } else {
        "Import reported failure with no error message.".to_string()
    };

    Ok(RestoreResult {
        success: parsed.success,
        result_message,
    })
}

/// Erase psycheros's entity data — runtime SQLite, settings JSONs,
/// vault docs, generated images, memories, identity files. The user
/// must have typed the confirmation phrase (frontend-side); we don't
/// re-check here, but the destructive scope is documented in the
/// roadmap so future contributors don't accidentally call this.
///
/// Stops the daemon first (file locks). Preserves the data root dir
/// itself so the supervisor's WorkingDirectory still resolves.
/// `<data>/identity/` is included so a re-bootstrap re-templates
/// identity files cleanly. The launcher's own config.json under
/// `<launcher_data_dir>/config.json` (which holds port + daemon mode
/// + bundled_source_version) is NOT touched — wiping it would force
/// the user back through first-run.
#[tauri::command]
pub fn wipe_entity_data() -> Result<(), String> {
    // Best-effort daemon stop. The launcher proceeds even if the
    // daemon was already down — wipe is idempotent.
    let _ = default_supervisor().stop_daemon();

    clear_dir_contents(&paths::data_dir()).map_err(|e| format!("clear data dir: {e}"))?;
    // The identity dir lives directly under launcher_data_dir/data
    // (psycheros resolves it relative to dataRoot), so the above
    // already covers it — but if a future psycheros refactor moves
    // identity elsewhere, the launcher's first-run re-bootstrap
    // is the recovery path.
    Ok(())
}

/// Erase the cloned source + entity identity, then rebootstrap. Used
/// when the user wants a clean source re-template without losing
/// memories / vault data. Stops the daemon, deletes source/, deletes
/// `<data>/identity/`, restores `bundled_source_version = None` so
/// `needs_first_run` returns true on next launch, and uninstalls the
/// supervisor service (so the user can pick autostart/manual again
/// after re-bootstrap).
///
/// Doesn't actually run the bootstrap inline — the next manager-card
/// render will see `needs_first_run = true` and route through
/// `first_run` again. That keeps this command synchronous and lets
/// the user confirm naming + bootstrap progress in the wizard.
#[tauri::command]
pub fn reinit_psycheros() -> Result<(), String> {
    let supervisor = default_supervisor();
    let _ = supervisor.stop_daemon();
    let _ = supervisor.uninstall();

    let source_root = paths::launcher_data_dir().join("source");
    if source_root.exists() {
        std::fs::remove_dir_all(&source_root).map_err(|e| format!("remove source dir: {e}"))?;
    }

    let identity_dir = paths::data_dir().join("identity");
    if identity_dir.exists() {
        std::fs::remove_dir_all(&identity_dir).map_err(|e| format!("remove identity dir: {e}"))?;
    }

    // Bundled deno binary stays in place — same launcher, same binary.
    // `needs_first_run` checks both `bundled_source_version` AND on-disk
    // artifacts, so clearing the version is sufficient to re-trigger
    // the wizard.
    let mut cfg = config::load().unwrap_or_default();
    cfg.bundled_source_version = None;
    config::save(&cfg).map_err(|e| format!("save config: {e}"))?;

    Ok(())
}

/// Recursively remove every entry inside `dir` while keeping `dir`
/// itself. Returns Ok(()) if `dir` doesn't exist (idempotent).
///
/// Implemented via `remove_dir_all` per top-level entry rather than
/// `remove_dir_all(dir)` + `create_dir_all(dir)` because the latter
/// loses any extended attributes / permissions the daemon's
/// WorkingDirectory might rely on (notably the macOS `data` quota
/// attributes).
fn clear_dir_contents(dir: &Path) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(&path)?;
        } else {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Update history + snapshots (§5.18 + §5.21)
// ---------------------------------------------------------------------------

/// Return the persisted update history, most recent first. Used by
/// the Updates card to render the timeline. Filters out entries whose
/// referenced snapshot directories have been pruned — those entries
/// stay in config.json for human history but can't serve as rollback
/// targets, so callers can rely on `snapshot_id: Some(_)` meaning the
/// snapshot still exists on disk.
#[tauri::command]
pub fn get_update_history() -> Vec<config::UpdateHistoryEntry> {
    let cfg = config::load().unwrap_or_default();
    let snapshot_root = paths::launcher_data_dir().join(".snapshots");
    cfg.update_history
        .into_iter()
        .map(|mut entry| {
            if let Some(id) = &entry.snapshot_id {
                if !snapshot_root.join(id).exists() {
                    entry.snapshot_id = None;
                }
            }
            entry
        })
        .collect()
}

/// Copy `<data>/.psycheros/` to
/// `<launcher_data_dir>/.snapshots/<timestamp>/`. Returns the snapshot
/// ID (the timestamp portion) on success.
///
/// The directory might not exist (e.g. the user has wiped data) — in
/// that case the snapshot is "empty" (just an empty dir) and rollback
/// to that point would effectively re-empty the data dir. Tracking
/// the snapshot anyway is consistent: the history viewer says "we
/// updated from X to Y at time T" regardless of what was on disk.
fn create_pre_update_snapshot() -> std::io::Result<String> {
    let snapshot_id = chrono_like_timestamp();
    let snapshot_dir = paths::launcher_data_dir()
        .join(".snapshots")
        .join(&snapshot_id);
    let source = paths::data_dir().join(".psycheros");

    std::fs::create_dir_all(&snapshot_dir)?;
    if source.exists() {
        copy_dir_recursive(&source, &snapshot_dir.join(".psycheros"))?;
    }
    Ok(snapshot_id)
}

/// Recursively copy `src` → `dst`. Pure Rust so the same path works
/// on macOS / Linux / Windows without shelling out (cp/xcopy/robocopy
/// have subtly different flag sets across OSes). Preserves directory
/// structure but not file metadata beyond what `std::fs::copy` does
/// (mode + mtime on Unix).
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if file_type.is_file() {
            std::fs::copy(&src_path, &dst_path)?;
        }
        // Symlinks: skipped intentionally. The launcher doesn't
        // create them and psycheros doesn't either, so the only way
        // to encounter one is user-introduced — and following it
        // could escape `.psycheros/` into arbitrary disk locations.
    }
    Ok(())
}

/// Atomic restoration of snapshot files to the active data directory.
/// Copies the files from `snap_psy` to a temp directory next to `data_psy` first,
/// then performs a safe rename swap, falling back to restoring the backup if rename fails.
fn restore_directory_atomically(snap_psy: &Path, data_psy: &Path) -> Result<(), String> {
    let parent = data_psy
        .parent()
        .ok_or_else(|| "No parent directory for data path".to_string())?;
    let temp_data_psy = parent.join(".psycheros.tmp");
    let old_data_psy = parent.join(".psycheros.old");

    if temp_data_psy.exists() {
        std::fs::remove_dir_all(&temp_data_psy)
            .map_err(|e| format!("clear stale temp directory: {e}"))?;
    }

    if snap_psy.exists() {
        // Copy to temporary directory under the same parent
        copy_dir_recursive(snap_psy, &temp_data_psy)
            .map_err(|e| format!("restore snapshot files: {e}"))?;

        // Perform the atomic swap:
        // 1. Move the current directory to a backup location (.psycheros.old)
        if data_psy.exists() {
            if old_data_psy.exists() {
                std::fs::remove_dir_all(&old_data_psy)
                    .map_err(|e| format!("clear old backup directory: {e}"))?;
            }
            std::fs::rename(data_psy, &old_data_psy)
                .map_err(|e| format!("backup current directory: {e}"))?;
        }

        // 2. Promote the temporary directory to the active location
        if let Err(e) = std::fs::rename(&temp_data_psy, data_psy) {
            // Rollback the swap if promotion fails
            if old_data_psy.exists() {
                let _ = std::fs::rename(&old_data_psy, data_psy);
            }
            return Err(format!("promote temp directory: {e}"));
        }

        // 3. Clean up the backup directory
        if old_data_psy.exists() {
            let _ = std::fs::remove_dir_all(&old_data_psy);
        }
    } else {
        // If snapshot has no .psycheros/, we just clean up the active directory
        if data_psy.exists() {
            std::fs::remove_dir_all(data_psy)
                .map_err(|e| format!("clear current .psycheros: {e}"))?;
        }
    }
    Ok(())
}

/// Run `<source_root>/migrations/<from>-to-<to>.ts` if it exists.
/// Quiet no-op when the file is absent (the normal case). When
/// present, invokes the bundled Deno with `-A` and the user's data
/// dir as its sole argument, streaming stderr line-by-line through
/// `on_progress` so the update ticker reflects what the migration
/// is doing.
///
/// Migrations are maintained by whoever cuts the release — they're
/// expected to be idempotent (so a partial-run retry just continues
/// from where it left off) and to confine writes to the data dir
/// (so a failure leaves source clean and rollback intact).
fn run_migration_if_present(
    source_root: &Path,
    from_tag: &str,
    to_tag: &str,
    data_dir: &Path,
    mut on_progress: impl FnMut(&str),
) -> Result<(), String> {
    let script = source_root
        .join("migrations")
        .join(format!("{from_tag}-to-{to_tag}.ts"));
    if !script.exists() {
        return Ok(());
    }
    let deno = paths::bundled_deno_path();
    if !deno.exists() {
        return Err(format!(
            "bundled Deno missing at {} — can't run migration",
            deno.display()
        ));
    }

    on_progress(&format!("running migration {from_tag} → {to_tag}",));

    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use std::sync::mpsc::channel;

    let mut child = hidden_command(&deno)
        .args(["run", "-A"])
        .arg(&script)
        .arg(data_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn deno: {e}"))?;

    let (tx, rx) = channel::<String>();

    let tx_stdout = tx.clone();
    let stdout_opt = child.stdout.take();
    let stdout_handle = std::thread::spawn(move || {
        if let Some(stdout) = stdout_opt {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let _ = tx_stdout.send(line);
            }
        }
    });

    let tx_stderr = tx;
    let stderr_opt = child.stderr.take();
    let stderr_handle = std::thread::spawn(move || {
        if let Some(stderr) = stderr_opt {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let _ = tx_stderr.send(line);
            }
        }
    });

    while let Ok(line) = rx.recv() {
        on_progress(&line);
    }

    let _ = stdout_handle.join();
    let _ = stderr_handle.join();

    let status = child.wait().map_err(|e| format!("wait deno: {e}"))?;
    if !status.success() {
        return Err(format!(
            "migration script exited with {status} — leaving source + data \
             unchanged. The maintainer's migration is responsible for \
             being idempotent so a retry resumes safely."
        ));
    }
    on_progress("migration completed");
    Ok(())
}

/// Keep the `keep` most-recent snapshots; delete the rest. Run after
/// `record_update` truncates the history vec so on-disk state stays
/// in sync with config.json's view. Failure is non-fatal — the worst
/// case is some stale dirs on disk that the history viewer never
/// references.
fn prune_snapshots(keep: usize) -> std::io::Result<()> {
    let snapshot_root = paths::launcher_data_dir().join(".snapshots");
    if !snapshot_root.exists() {
        return Ok(());
    }
    let mut entries: Vec<_> = std::fs::read_dir(&snapshot_root)?
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .collect();
    // Names are RFC3339-ish timestamps, lexicographic sort = chronological.
    entries.sort_by_key(|e| e.file_name());
    let count = entries.len();
    if count <= keep {
        return Ok(());
    }
    for entry in entries.into_iter().take(count - keep) {
        let _ = std::fs::remove_dir_all(entry.path());
    }
    Ok(())
}

/// List every released tag on the configured update channel, most
/// recent first. Powers the "Install a specific version" picker
/// (§5.17). Network-bound — runs `git ls-remote --tags` against the
/// public source repo. Frontend should not call this on every render;
/// fetch on card open + on demand.
#[tauri::command]
pub async fn list_available_tags() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        bundle::list_tags(SOURCE_REPO_URL, effective_tag_prefix())
            .map_err(|e| format!("list tags: {e}"))
    })
    .await
    .map_err(|e| format!("list_available_tags task crashed: {e}"))?
}

/// Restore from a snapshot recorded by `apply_source_update`. Stops
/// the daemon, replaces `<data>/.psycheros/` with the snapshot's
/// contents, resets the source clone to the historical tag, warms
/// the deno cache (in case of dep-version drift between the
/// historical and current tag), then restarts the daemon.
///
/// `history_index` is the position in `get_update_history()`'s
/// returned list (0 = most recent). The launcher reads that list,
/// finds the entry, and uses its snapshot_id + tag. Failing the
/// lookup (e.g. the user passed an out-of-range index, or the
/// snapshot was pruned between viewer render and click) returns a
/// user-actionable error.
#[tauri::command]
pub async fn rollback_to_snapshot(app: AppHandle, history_index: usize) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rollback_to_snapshot_blocking(app, history_index))
        .await
        .map_err(|e| format!("rollback task crashed: {e}"))?
}

fn rollback_to_snapshot_blocking(app: AppHandle, history_index: usize) -> Result<(), String> {
    let history = config::load().unwrap_or_default().update_history;
    let entry = history.get(history_index).cloned().ok_or_else(|| {
        format!("no history entry at index {history_index} — list refreshed since you clicked?")
    })?;
    let snapshot_id = entry.snapshot_id.clone().ok_or_else(|| {
        "no snapshot recorded for that update — rollback isn't available.".to_string()
    })?;
    let snapshot_dir = paths::launcher_data_dir()
        .join(".snapshots")
        .join(&snapshot_id);
    if !snapshot_dir.exists() {
        return Err(format!(
            "snapshot directory was pruned ({}). Rollback isn't available.",
            snapshot_dir.display(),
        ));
    }

    let _ = app.emit(
        "source-update-progress",
        SourceUpdateProgress::Phase {
            phase: "rollback-stop",
        },
    );
    // Best-effort stop. The supervisor needs the file locks released
    // before we replace .psycheros/ underneath the daemon.
    let _ = default_supervisor().stop_daemon();

    let _ = app.emit(
        "source-update-progress",
        SourceUpdateProgress::Phase {
            phase: "rollback-restore-data",
        },
    );
    let data_psy = paths::data_dir().join(".psycheros");
    let snap_psy = snapshot_dir.join(".psycheros");
    restore_directory_atomically(&snap_psy, &data_psy)?;
    // If the snapshot had no .psycheros/ (e.g. taken before any
    // psycheros state existed), we just leave data_psy absent — the
    // daemon will recreate it on next boot.

    let _ = app.emit(
        "source-update-progress",
        SourceUpdateProgress::Phase {
            phase: "rollback-source",
        },
    );
    let source_root = paths::launcher_data_dir().join("source");
    let app_clone = app.clone();
    bundle::clone_or_fetch_source(SOURCE_REPO_URL, &entry.tag, &source_root, move |line| {
        let _ = app_clone.emit(
            "source-update-progress",
            SourceUpdateProgress::Line {
                line: line.to_string(),
            },
        );
    })
    .map_err(|e| format!("reset source to {}: {e}", entry.tag))?;

    let _ = app.emit(
        "source-update-progress",
        SourceUpdateProgress::Phase {
            phase: "rollback-warm-cache",
        },
    );
    let app_clone = app.clone();
    bundle::warm_deno_cache(
        &paths::bundled_deno_path(),
        &paths::source_dir(),
        move |line| {
            let _ = app_clone.emit(
                "source-update-progress",
                SourceUpdateProgress::Line {
                    line: line.to_string(),
                },
            );
        },
    )
    .map_err(|e| format!("warm deno cache after rollback: {e}"))?;

    // Stamp the rolled-back tag as current. We deliberately do NOT
    // append a new history entry — rollback isn't a new update event,
    // it's restoring an old one. The history viewer still shows the
    // original updates, and the bundled_source_version field reflects
    // where we are now.
    let mut cfg: LauncherConfig = config::load().unwrap_or_default();
    cfg.bundled_source_version = Some(entry.tag.clone());
    config::save(&cfg).map_err(|e| format!("save config: {e}"))?;

    let _ = app.emit(
        "source-update-progress",
        SourceUpdateProgress::Phase {
            phase: "rollback-restart",
        },
    );
    default_supervisor()
        .start_daemon()
        .map_err(|e| format!("start daemon after rollback: {e}"))?;

    let _ = app.emit(
        "source-update-progress",
        SourceUpdateProgress::Done {
            new_version: entry.tag,
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Self-repair affordances (§5.11-§5.14)
// ---------------------------------------------------------------------------

/// What's holding a TCP port we tried to bind. Used by the warnings
/// panel to give the user a concrete "process X is holding port 3000"
/// message rather than the cryptic "daemon won't start" surface.
#[derive(Debug, Serialize, Clone)]
pub struct PortConflict {
    pub pid: u32,
    pub command: String,
}

/// Check whether something other than us is bound to `port`. Returns
/// `Some(PortConflict)` when a process is listening on the port,
/// `None` when the port is free (or we can't determine — silent
/// failure mode, the warning panel just won't add the "held by X"
/// detail in that case).
///
/// macOS: shells out to `lsof -i :<port> -P -n -sTCP:LISTEN -Fpc`.
/// `-Fpc` requests fielded output with `p<pid>` and `c<command>` on
/// alternating lines — easier to parse than the default columnar
/// format which varies across macOS versions.
///
/// Windows: uses `netstat -ano` to find the PID holding the port,
/// then `tasklist /FI "PID eq <pid>" /FO CSV /NH` to resolve the
/// process image name. Both ship with every supported Windows
/// release; neither requires admin.
///
/// Linux: returns `None` for now (the systemd-user supervisor stub
/// doesn't get to the port-conflict state either — see
/// docs/supervisors.md).
#[tauri::command]
pub fn check_port_conflict(port: u16) -> Option<PortConflict> {
    // One per-OS helper per branch — keeps each platform's flow
    // linear, lets cargo clippy be strict (no needless returns), and
    // makes the unused-on-this-OS arms obvious to readers.
    #[cfg(target_os = "macos")]
    {
        check_port_conflict_macos(port)
    }
    #[cfg(target_os = "windows")]
    {
        check_port_conflict_windows(port)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = port;
        None
    }
}

#[cfg(target_os = "macos")]
fn check_port_conflict_macos(port: u16) -> Option<PortConflict> {
    let out = hidden_command("lsof")
        .args([
            "-i",
            &format!(":{port}"),
            "-P",
            "-n",
            "-sTCP:LISTEN",
            "-Fpc",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_lsof_fielded(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(target_os = "windows")]
fn check_port_conflict_windows(port: u16) -> Option<PortConflict> {
    let netstat = hidden_command("netstat").args(["-ano"]).output().ok()?;
    if !netstat.status.success() {
        return None;
    }
    let pid = parse_netstat_listener_pid(&String::from_utf8_lossy(&netstat.stdout), port)?;
    let command = resolve_pid_image_name(pid).unwrap_or_else(|| format!("pid {pid}"));
    Some(PortConflict { pid, command })
}

/// Resolve a Windows process image name from its PID via
/// `tasklist /FI "PID eq <pid>" /FO CSV /NH`. Returns `None` on any
/// failure — the caller falls back to "pid N" copy. Split out so the
/// unit test can drive the parsing logic without a live process.
#[cfg(target_os = "windows")]
fn resolve_pid_image_name(pid: u32) -> Option<String> {
    let out = hidden_command("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_tasklist_csv_image(&String::from_utf8_lossy(&out.stdout))
}

/// Parse `netstat -ano` output, return the PID of the first LISTENING
/// TCP socket bound to `port`. `netstat -ano` rows look like:
///
/// ```text
///   TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       12345
///   TCP    [::]:3000              [::]:0                 LISTENING       12345
/// ```
///
/// We match on TCP + the local-address column ending in `:PORT` + the
/// LISTENING state. UDP is ignored (no concept of LISTENING) and
/// non-LISTENING TCP rows (ESTABLISHED, TIME_WAIT) are ignored — only
/// the listener "owns" the port.
#[cfg(target_os = "windows")]
fn parse_netstat_listener_pid(text: &str, port: u16) -> Option<u32> {
    let suffix = format!(":{port}");
    for line in text.lines() {
        let line = line.trim_start();
        if !line.starts_with("TCP") {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        // Expected layout: [TCP, local_addr, foreign_addr, state, pid].
        if fields.len() < 5 {
            continue;
        }
        if fields[3] != "LISTENING" {
            continue;
        }
        if !fields[1].ends_with(&suffix) {
            continue;
        }
        if let Ok(pid) = fields[4].parse::<u32>() {
            return Some(pid);
        }
    }
    None
}

/// Parse a single-row `tasklist /FO CSV /NH` line into the image name
/// (first quoted column). The format is `"image","pid","session"...`
/// — strip the leading quote, take up to the next quote.
#[cfg(target_os = "windows")]
fn parse_tasklist_csv_image(text: &str) -> Option<String> {
    let first_line = text.lines().next()?.trim();
    let rest = first_line.strip_prefix('"')?;
    let end = rest.find('"')?;
    let image = &rest[..end];
    if image.is_empty() {
        None
    } else {
        Some(image.to_string())
    }
}

/// Parse `lsof -F pc` output into a PortConflict.
///
/// Fielded output looks like:
///
/// ```text
/// p12345
/// cnode
/// p67890
/// csome-other
/// ```
///
/// We return the first p/c pair (lsof can return multiple if several
/// processes bind the same port; the first is good enough for the
/// "blame the offender" UX).
#[cfg(target_os = "macos")]
fn parse_lsof_fielded(text: &str) -> Option<PortConflict> {
    let mut pid: Option<u32> = None;
    let mut command: Option<String> = None;
    for line in text.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.trim().parse().ok();
        } else if let Some(c) = line.strip_prefix('c') {
            command = Some(c.trim().to_string());
        }
        if let (Some(p), Some(c)) = (pid, &command) {
            return Some(PortConflict {
                pid: p,
                command: c.clone(),
            });
        }
    }
    None
}

/// macOS only — invoke `xcode-select --install`. This pops the
/// system's Command Line Tools installer dialog; the user accepts +
/// downloads ~500 MB. We don't try to monitor the install — `xcode-
/// select` returns immediately after spawning the dialog. The
/// frontend offers a "Try first-run again" affordance for the user
/// to re-bootstrap once the install completes.
///
/// On Linux + Windows: no-op (those platforms ship git via the OS
/// package manager — different remediation flow, deferred until
/// those supervisors get implemented).
#[tauri::command]
pub fn install_xcode_clt() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err(
            "Xcode Command Line Tools is a macOS concept; this OS uses a different remediation."
                .to_string(),
        );
    }
    hidden_command("xcode-select")
        .arg("--install")
        .spawn()
        .map_err(|e| format!("spawn xcode-select: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Microphone permission — moved to `mic_plugin.rs`.
//
// Tauri 2's ACL only resolves plugin-namespaced commands for remote origins
// (http://localhost:3000), so the command lives in a tiny plugin now. See
// `mic_plugin.rs` for the rationale + the AVCaptureDevice pre-grant code.
// ---------------------------------------------------------------------------

/// Target triple of the currently-running launcher binary. Used to pick
/// the right per-triple sidecar Deno from `Resources/`. Lives above
/// the test module per clippy's `items_after_test_module` lint.
fn current_target_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else {
        ""
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_lsof_fielded_output() {
        let text = "p12345\ncnode\n";
        let conflict = parse_lsof_fielded(text).unwrap();
        assert_eq!(conflict.pid, 12345);
        assert_eq!(conflict.command, "node");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_lsof_with_multiple_processes() {
        let text = "p12345\ncfirst-binder\np67890\ncsecond-binder";
        let conflict = parse_lsof_fielded(text).unwrap();
        // We return the first p/c pair — the "loudest blame" wins.
        assert_eq!(conflict.pid, 12345);
        assert_eq!(conflict.command, "first-binder");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn returns_none_on_empty_lsof_output() {
        assert!(parse_lsof_fielded("").is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn returns_none_when_only_one_field_present() {
        // PID without a command line is incomplete; we'd rather return
        // nothing than render "pid 12345 (?)" in the warning panel.
        assert!(parse_lsof_fielded("p12345").is_none());
    }

    // ─── netstat parser (Windows port-conflict detection) ──────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn parses_netstat_ipv4_listener() {
        // Real netstat -ano output, IPv4 listener row.
        let canned = "\nActive Connections\n\n\
                      \x20 Proto  Local Address          Foreign Address        State           PID\n\
                      \x20 TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       12345\n\
                      \x20 TCP    127.0.0.1:54321        127.0.0.1:3000         ESTABLISHED     67890\n";
        assert_eq!(parse_netstat_listener_pid(canned, 3000), Some(12345));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parses_netstat_ipv6_listener() {
        // IPv6 listener (the row Tauri-style services usually print).
        let canned =
            "  TCP    [::]:3000              [::]:0                 LISTENING       12345\n";
        assert_eq!(parse_netstat_listener_pid(canned, 3000), Some(12345));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn netstat_ignores_non_listening_rows() {
        // ESTABLISHED/TIME_WAIT rows can also reference the same port
        // as the foreign address — those don't OWN the port. Only
        // LISTENING rows should match.
        let canned = "  TCP    127.0.0.1:54321        127.0.0.1:3000         ESTABLISHED     67890\n\
                      \x20 TCP    127.0.0.1:54322        127.0.0.1:3000         TIME_WAIT       0\n";
        assert!(parse_netstat_listener_pid(canned, 3000).is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn netstat_returns_none_when_port_not_bound() {
        let canned =
            "  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       11111\n";
        assert!(parse_netstat_listener_pid(canned, 3000).is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn netstat_ignores_udp_rows() {
        // UDP doesn't have a LISTENING state; netstat shows `*:*` for
        // the foreign address. We bind TCP, so UDP listeners are
        // irrelevant even if they happen to share the port number.
        let canned =
            "  UDP    0.0.0.0:3000           *:*                                    99999\n";
        assert!(parse_netstat_listener_pid(canned, 3000).is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn netstat_returns_first_listener_when_dual_stack() {
        // A daemon that binds both IPv4 and IPv6 produces two rows
        // with the same PID; either is fine to return.
        let canned = "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       42\n\
                      \x20 TCP    [::]:3000              [::]:0                 LISTENING       42\n";
        assert_eq!(parse_netstat_listener_pid(canned, 3000), Some(42));
    }

    // ─── tasklist CSV parser (Windows process-name resolution) ──────────

    #[cfg(target_os = "windows")]
    #[test]
    fn parses_tasklist_csv_image() {
        let canned = "\"deno.exe\",\"12345\",\"Console\",\"1\",\"42,116 K\"\r\n";
        assert_eq!(
            parse_tasklist_csv_image(canned).as_deref(),
            Some("deno.exe")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn tasklist_handles_image_with_spaces() {
        // Windows allows spaces in image names ("Microsoft Edge.exe").
        // CSV quoting protects them.
        let canned = "\"Microsoft Edge.exe\",\"23456\",\"Console\",\"1\",\"112,348 K\"\r\n";
        assert_eq!(
            parse_tasklist_csv_image(canned).as_deref(),
            Some("Microsoft Edge.exe")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn tasklist_returns_none_on_empty_input() {
        assert!(parse_tasklist_csv_image("").is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn tasklist_returns_none_on_malformed_row() {
        // Missing closing quote — defensive against unexpected output.
        assert!(parse_tasklist_csv_image("\"deno.exe").is_none());
    }

    // ─── Timestamps + civil_from_days ──────────────────────────────────

    #[test]
    fn civil_from_days_epoch_is_1970_01_01() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }

    #[test]
    fn civil_from_days_handles_leap_year_2020() {
        // 2020-02-29 was day 18_321 since the epoch. Pre-computed —
        // a regression here would reveal the date-math going wrong
        // around leap-year boundaries.
        let days_to_feb_29_2020 = 18_321;
        assert_eq!(civil_from_days(days_to_feb_29_2020), (2020, 2, 29));
    }

    #[test]
    fn chrono_like_timestamp_format_is_filename_safe() {
        let ts = chrono_like_timestamp();
        // YYYY-MM-DDTHH-MM-SSZ, total 20 chars. No colons (would
        // break Windows filenames), no slashes, no spaces.
        assert_eq!(ts.len(), 20, "timestamp had wrong length: {ts}");
        assert!(ts.ends_with('Z'), "timestamp didn't end with Z: {ts}");
        assert!(
            !ts.contains(':'),
            "timestamp contained ':' — would break Windows filenames: {ts}"
        );
        assert_eq!(
            ts.chars().filter(|&c| c == '-').count(),
            4,
            "timestamp had wrong number of dashes (2 in date + 2 in time, T separates them): {ts}"
        );
        assert_eq!(
            ts.chars().filter(|&c| c == 'T').count(),
            1,
            "timestamp had wrong number of T separators: {ts}"
        );
    }

    // ─── copy_dir_recursive ──────────────────────────────────────────

    #[test]
    fn copy_dir_recursive_preserves_nested_structure() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        // Build src tree:
        //   src/a.txt
        //   src/nested/b.txt
        //   src/nested/deep/c.bin
        std::fs::write(src.path().join("a.txt"), b"top-level").unwrap();
        std::fs::create_dir_all(src.path().join("nested/deep")).unwrap();
        std::fs::write(src.path().join("nested/b.txt"), b"one level").unwrap();
        std::fs::write(src.path().join("nested/deep/c.bin"), b"\x00\x01\x02\x03").unwrap();

        copy_dir_recursive(src.path(), &dst.path().join("snap")).unwrap();

        let snap = dst.path().join("snap");
        assert_eq!(std::fs::read(snap.join("a.txt")).unwrap(), b"top-level");
        assert_eq!(
            std::fs::read(snap.join("nested/b.txt")).unwrap(),
            b"one level"
        );
        assert_eq!(
            std::fs::read(snap.join("nested/deep/c.bin")).unwrap(),
            b"\x00\x01\x02\x03"
        );
    }

    #[test]
    fn copy_dir_recursive_creates_target_when_missing() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("only.txt"), b"only").unwrap();

        // Target dir doesn't exist yet — copy_dir_recursive should
        // create it. Catches the "forgot to mkdir before write"
        // regression class.
        let target = dst.path().join("does/not/exist/yet");
        assert!(!target.exists());

        copy_dir_recursive(src.path(), &target).unwrap();
        assert_eq!(std::fs::read(target.join("only.txt")).unwrap(), b"only");
    }

    // ─── prune_snapshots ──────────────────────────────────────────────

    #[test]
    fn prune_snapshots_keeps_n_most_recent() {
        let launcher_dir = tempfile::tempdir().unwrap();
        // Override the launcher data dir for this test. Note: env
        // mutation is per-test-process; unit tests share a process
        // so concurrent prune-* tests could trample each other.
        // Cargo defaults to serial-within-suite for these, and
        // we keep the snapshot count distinct per test so even with
        // overlap the assertions still hold.
        std::env::set_var("PSYCHEROS_LAUNCHER_DATA_DIR", launcher_dir.path());

        let snapshots = launcher_dir.path().join(".snapshots");
        std::fs::create_dir_all(&snapshots).unwrap();
        // Names sort lexicographically = chronologically.
        for name in &[
            "2025-01-01T00-00-00Z",
            "2025-06-01T00-00-00Z",
            "2026-01-01T00-00-00Z",
        ] {
            std::fs::create_dir(snapshots.join(name)).unwrap();
            std::fs::write(snapshots.join(name).join("marker"), name.as_bytes()).unwrap();
        }

        prune_snapshots(2).unwrap();

        // The oldest (2025-01) should be gone; the two newest remain.
        assert!(!snapshots.join("2025-01-01T00-00-00Z").exists());
        assert!(snapshots.join("2025-06-01T00-00-00Z").exists());
        assert!(snapshots.join("2026-01-01T00-00-00Z").exists());
    }

    #[test]
    fn prune_snapshots_noop_when_under_keep() {
        let launcher_dir = tempfile::tempdir().unwrap();
        std::env::set_var("PSYCHEROS_LAUNCHER_DATA_DIR", launcher_dir.path());

        let snapshots = launcher_dir.path().join(".snapshots");
        std::fs::create_dir_all(&snapshots).unwrap();
        std::fs::create_dir(snapshots.join("only-one")).unwrap();

        prune_snapshots(5).unwrap();
        assert!(snapshots.join("only-one").exists());
    }

    #[test]
    fn prune_snapshots_noop_when_dir_absent() {
        let launcher_dir = tempfile::tempdir().unwrap();
        std::env::set_var("PSYCHEROS_LAUNCHER_DATA_DIR", launcher_dir.path());
        // .snapshots/ deliberately not created.
        prune_snapshots(3).unwrap();
    }

    // ─── create_pre_update_snapshot ──────────────────────────────────

    #[test]
    fn create_pre_update_snapshot_captures_data_psycheros_tree() {
        let launcher_dir = tempfile::tempdir().unwrap();
        std::env::set_var("PSYCHEROS_LAUNCHER_DATA_DIR", launcher_dir.path());

        // Seed a fake `.psycheros/` under the data dir with known
        // structure. paths::data_dir() resolves to
        // <launcher_dir>/data per the env override.
        let psy_dir = launcher_dir.path().join("data").join(".psycheros");
        std::fs::create_dir_all(psy_dir.join("vault/documents")).unwrap();
        std::fs::create_dir_all(psy_dir.join("plugins/example/state")).unwrap();
        std::fs::write(psy_dir.join("settings.json"), br#"{"ok":true}"#).unwrap();
        std::fs::write(psy_dir.join("vault/documents/note.md"), b"hello").unwrap();
        std::fs::write(psy_dir.join("plugins/example/state/cache.json"), b"{}").unwrap();

        let snapshot_id = create_pre_update_snapshot()
            .expect("snapshot should succeed against a populated data dir");

        // Snapshot landed under .snapshots/<id>/.psycheros/ — same
        // tree as the source, byte-for-byte.
        let snap_root = launcher_dir
            .path()
            .join(".snapshots")
            .join(&snapshot_id)
            .join(".psycheros");
        assert_eq!(
            std::fs::read(snap_root.join("settings.json")).unwrap(),
            br#"{"ok":true}"#
        );
        assert_eq!(
            std::fs::read(snap_root.join("vault/documents/note.md")).unwrap(),
            b"hello"
        );
        assert_eq!(
            std::fs::read(snap_root.join("plugins/example/state/cache.json")).unwrap(),
            b"{}"
        );
    }

    #[test]
    fn create_pre_update_snapshot_handles_absent_data_dir() {
        let launcher_dir = tempfile::tempdir().unwrap();
        std::env::set_var("PSYCHEROS_LAUNCHER_DATA_DIR", launcher_dir.path());
        // No data/.psycheros/ at all — snapshot should still succeed
        // and produce an empty snapshot dir (the rollback semantics
        // then restore to "no .psycheros/", which is what we want
        // for a fresh-install user).
        let snapshot_id = create_pre_update_snapshot().expect("snapshot should succeed");
        let snap_root = launcher_dir.path().join(".snapshots").join(&snapshot_id);
        assert!(snap_root.exists(), "snapshot dir should be created");
        assert!(
            !snap_root.join(".psycheros").exists(),
            "no source → no .psycheros/ in the snapshot"
        );
    }

    #[test]
    fn restore_directory_atomically_success() {
        let parent = tempfile::tempdir().unwrap();
        let snap_psy = parent.path().join("snap/.psycheros");
        let data_psy = parent.path().join("data/.psycheros");

        std::fs::create_dir_all(snap_psy.join("vault")).unwrap();
        std::fs::write(snap_psy.join("settings.json"), b"new-settings").unwrap();
        std::fs::write(snap_psy.join("vault/note.md"), b"new-note").unwrap();

        std::fs::create_dir_all(data_psy.join("vault")).unwrap();
        std::fs::write(data_psy.join("settings.json"), b"old-settings").unwrap();
        std::fs::write(data_psy.join("vault/note.md"), b"old-note").unwrap();

        restore_directory_atomically(&snap_psy, &data_psy).unwrap();

        // Target active directory matches snapshot content
        assert_eq!(
            std::fs::read_to_string(data_psy.join("settings.json")).unwrap(),
            "new-settings"
        );
        assert_eq!(
            std::fs::read_to_string(data_psy.join("vault/note.md")).unwrap(),
            "new-note"
        );

        // Temporary and backup folders are cleaned up
        assert!(!parent.path().join("data/.psycheros.tmp").exists());
        assert!(!parent.path().join("data/.psycheros.old").exists());
    }

    #[test]
    fn restore_directory_atomically_absent_snapshot() {
        let parent = tempfile::tempdir().unwrap();
        let snap_psy = parent.path().join("snap/.psycheros"); // Doesn't exist
        let data_psy = parent.path().join("data/.psycheros");

        std::fs::create_dir_all(&data_psy).unwrap();
        std::fs::write(data_psy.join("settings.json"), b"old-settings").unwrap();

        restore_directory_atomically(&snap_psy, &data_psy).unwrap();

        // Data directory is cleared/absent
        assert!(!data_psy.exists());
    }
}
