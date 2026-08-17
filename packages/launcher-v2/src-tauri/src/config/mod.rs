//! User configuration persisted under `<launcher_data_dir>/config.json`.
//!
//! Stored fields:
//! - `port` — daemon HTTP port (default 3000)
//! - `daemon_mode` — autostart vs. manual. Determines the plist's
//!   `RunAtLoad`/`KeepAlive` semantics; the launcher UI also uses this
//!   to decide which controls to render. `None` is treated as Autostart
//!   for legacy configs written before this field existed.
//! - `bundled_source_version` — tag of the source tree currently cloned
//!   to `<launcher_data_dir>/source/`. Used by `check_for_updates`.
//! - `update_channel` — `Stable` (tracks `psycheros-v*` tags) or `Beta`
//!   (tracks `psycheros-beta-v*` tags). Affects what `query_latest_tag`
//!   filters on. `None` is treated as `Stable` for legacy configs.
//! - `update_history` — append-only list of past source updates, each
//!   with the tag, an ISO timestamp, the prior tag (for human "what
//!   was I on before" context), and an optional snapshot_id pointing
//!   to a pre-update `.psycheros/` snapshot under
//!   `<launcher_data_dir>/.snapshots/`. Capped at the
//!   [`UPDATE_HISTORY_LIMIT`] most recent entries.
//!
//! Wizard inputs (entity name, user name, timezone) are NOT cached here.
//! They live in psycheros's own `<data>/.psycheros/general-settings.json`,
//! which is the single source of truth — the launcher reads from it on
//! demand for display and writes to it directly from the first-run
//! wizard. Caching them on the launcher side caused drift the moment the
//! user edited them via psycheros's settings UI.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::paths;

/// Whether the daemon runs at every login (autostart) or only when the
/// user manually starts it. The launcher persists this choice in
/// `config.json` and renders mode-aware controls.
///
/// Lowercase serde tags keep the JSON file readable by humans.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DaemonMode {
    /// Runs at every login (`RunAtLoad=true`), respawns on crash
    /// (`KeepAlive=true`). The OG launcher behavior.
    #[default]
    Autostart,
    /// Loaded into launchd but not started at login. User toggles via
    /// the manager's Start/Stop controls.
    Manual,
}

/// Which release channel the launcher tracks for source updates.
/// `Stable` filters on `psycheros-v*` tags (vetted releases); `Beta`
/// filters on `psycheros-beta-v*` (release-candidates, pre-flight by
/// maintainers).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    #[default]
    Stable,
    Beta,
}

/// Maximum number of update history entries kept in `config.json`.
/// Beyond this, the oldest entries get dropped. Same cap applies to
/// on-disk snapshots (see `bundle::prune_snapshots`).
pub const UPDATE_HISTORY_LIMIT: usize = 10;

/// One past source-update event. Renders in the history viewer + acts
/// as a rollback target (when `snapshot_id` is present and the
/// snapshot directory still exists).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateHistoryEntry {
    /// The tag we updated *to* — e.g. `psycheros-v0.3.3`.
    pub tag: String,
    /// RFC3339-ish UTC timestamp without colons (`2026-05-19T14-30-12Z`)
    /// for filesystem-safe sortable display.
    pub applied_at: String,
    /// What we were on before this update — useful for the "previously
    /// installed: …" line in the viewer. `None` for the first update
    /// after first-run (no prior version was tracked).
    pub previous_tag: Option<String>,
    /// Subdirectory under `<launcher_data_dir>/.snapshots/` containing
    /// the pre-update copy of `.psycheros/`. `None` means snapshot
    /// failed or was disabled — rollback isn't available for that
    /// entry. The directory name doubles as the snapshot ID.
    pub snapshot_id: Option<String>,
}

impl UpdateChannel {
    /// The tag prefix to filter on when querying for the latest
    /// release on this channel. Matches the maintainer's tagging
    /// convention on the public Psycheros repo.
    pub fn tag_prefix(&self) -> &'static str {
        match self {
            Self::Stable => "psycheros-v",
            Self::Beta => "psycheros-beta-v",
        }
    }
}

/// Persisted launcher state. Wizard inputs (entity / user name, timezone)
/// are NOT in here — see module docs. Unknown fields in `config.json`
/// (e.g. the legacy `entity_name`/`user_name`/`timezone` from older
/// launcher builds) are silently ignored by serde and dropped on next
/// save, so the upgrade path is automatic.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherConfig {
    /// Port the daemon binds and the launcher probes. Single source of
    /// truth — flows into the supervisor's plist via `build_daemon_config`,
    /// into the state probe via `daemon::status::probe`, and into the
    /// backup/restore HTTP calls. Default 3000 ([`crate::daemon::DAEMON_PORT`]);
    /// changing it requires a daemon reinstall to take effect.
    pub port: u16,
    /// Optional so configs written before this field existed parse
    /// cleanly. Callers should treat `None` as `DaemonMode::Autostart`
    /// (the historical behavior).
    #[serde(default)]
    pub daemon_mode: Option<DaemonMode>,
    pub bundled_source_version: Option<String>,
    /// Optional so configs written before this field existed parse
    /// cleanly. `None` is treated as `UpdateChannel::Stable`.
    #[serde(default)]
    pub update_channel: Option<UpdateChannel>,
    /// Append-only history of source updates. Most recent first;
    /// callers writing into this should use
    /// [`LauncherConfig::record_update`] which handles the cap.
    /// Older configs without this field deserialize to an empty vec.
    #[serde(default)]
    pub update_history: Vec<UpdateHistoryEntry>,
    /// macOS Tahoe workaround: when true, `DENO_V8_FLAGS=--jitless` is
    /// injected into the launchd plist's EnvironmentVariables to bypass
    /// V8's CodeRange reservation crash on Tahoe's broken VM subsystem.
    #[serde(default)]
    pub tahoe_compat: bool,
}

impl Default for LauncherConfig {
    fn default() -> Self {
        Self {
            port: crate::daemon::DAEMON_PORT,
            daemon_mode: None,
            bundled_source_version: None,
            update_channel: None,
            update_history: Vec::new(),
            tahoe_compat: false,
        }
    }
}

impl LauncherConfig {
    /// Resolve the effective mode, defaulting to Autostart for legacy
    /// configs that never wrote the field.
    pub fn effective_mode(&self) -> DaemonMode {
        self.daemon_mode.unwrap_or_default()
    }

    /// Resolve the effective update channel, defaulting to Stable for
    /// legacy configs.
    pub fn effective_channel(&self) -> UpdateChannel {
        self.update_channel.unwrap_or_default()
    }

    /// Prepend a new history entry, capping the vec at
    /// [`UPDATE_HISTORY_LIMIT`]. Caller is responsible for `save()`-ing
    /// after.
    pub fn record_update(&mut self, entry: UpdateHistoryEntry) {
        self.update_history.insert(0, entry);
        if self.update_history.len() > UPDATE_HISTORY_LIMIT {
            self.update_history.truncate(UPDATE_HISTORY_LIMIT);
        }
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("malformed config.json: {0}")]
    Parse(#[from] serde_json::Error),
}

/// Read `config.json`, falling back to defaults if absent.
pub fn load() -> Result<LauncherConfig, ConfigError> {
    let path = paths::config_path();
    if !path.exists() {
        return Ok(LauncherConfig::default());
    }
    let text = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&text)?)
}

/// Persist `config.json`. Creates the parent directory if missing.
pub fn save(cfg: &LauncherConfig) -> Result<(), ConfigError> {
    let path = paths::config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(cfg)?;
    std::fs::write(&path, text)?;
    Ok(())
}

/// Helper: check if config exists. Used by the first-run wizard to decide
/// whether to show the welcome screen.
pub fn exists() -> bool {
    paths::config_path().exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_update_caps_at_history_limit() {
        let mut cfg = LauncherConfig::default();
        // Push more than the limit so we exercise the truncation.
        for i in 0..(UPDATE_HISTORY_LIMIT + 5) {
            cfg.record_update(UpdateHistoryEntry {
                tag: format!("psycheros-v0.0.{i}"),
                applied_at: format!("2026-05-{:02}T00-00-00Z", (i % 28) + 1),
                previous_tag: None,
                snapshot_id: None,
            });
        }
        assert_eq!(
            cfg.update_history.len(),
            UPDATE_HISTORY_LIMIT,
            "history should be capped at UPDATE_HISTORY_LIMIT"
        );
        // Newest first — the entry pushed last should be index 0.
        assert_eq!(
            cfg.update_history[0].tag,
            format!("psycheros-v0.0.{}", UPDATE_HISTORY_LIMIT + 4)
        );
    }

    #[test]
    fn effective_mode_defaults_to_autostart() {
        let cfg = LauncherConfig::default();
        assert_eq!(cfg.effective_mode(), DaemonMode::Autostart);
    }

    #[test]
    fn effective_mode_returns_persisted_when_set() {
        let cfg = LauncherConfig {
            daemon_mode: Some(DaemonMode::Manual),
            ..Default::default()
        };
        assert_eq!(cfg.effective_mode(), DaemonMode::Manual);
    }

    #[test]
    fn effective_channel_defaults_to_stable() {
        let cfg = LauncherConfig::default();
        assert_eq!(cfg.effective_channel(), UpdateChannel::Stable);
    }

    #[test]
    fn update_channel_tag_prefixes() {
        assert_eq!(UpdateChannel::Stable.tag_prefix(), "psycheros-v");
        assert_eq!(UpdateChannel::Beta.tag_prefix(), "psycheros-beta-v");
    }

    #[test]
    fn legacy_config_with_extra_fields_parses_cleanly() {
        // serde silently ignores unknown fields by default. This is
        // load-bearing for the §5.1 migration: old configs that
        // carried entity_name/user_name/timezone parse fine and
        // those fields drop out on next save. Any future
        // #[serde(deny_unknown_fields)] would break this — keep an
        // explicit test as a tripwire.
        let json = r#"{
            "port": 3000,
            "entity_name": "Atlas",
            "user_name": "Rowan",
            "timezone": "America/Los_Angeles",
            "daemon_mode": "manual",
            "bundled_source_version": "psycheros-v0.3.3"
        }"#;
        let cfg: LauncherConfig = serde_json::from_str(json).expect("parse legacy config");
        assert_eq!(cfg.port, 3000);
        assert_eq!(cfg.effective_mode(), DaemonMode::Manual);
        assert_eq!(
            cfg.bundled_source_version.as_deref(),
            Some("psycheros-v0.3.3")
        );
        // The legacy fields silently disappeared, as intended.
    }

    #[test]
    fn tahoe_compat_defaults_to_false() {
        let cfg = LauncherConfig::default();
        assert!(!cfg.tahoe_compat);
    }

    #[test]
    fn tahoe_compat_roundtrips() {
        let json = r#"{"port":3000,"tahoe_compat":true}"#;
        let cfg: LauncherConfig = serde_json::from_str(json).expect("parse");
        assert!(cfg.tahoe_compat);
    }
}
