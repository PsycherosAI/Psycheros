//! User configuration persisted under `<launcher_data_dir>/config.json`.
//!
//! Stored fields:
//! - `port` — daemon HTTP port (default 3000)
//! - `entity_name`, `user_name`, `timezone` — first-run wizard inputs that
//!   psycheros's settings UI also exposes. The launcher seeds them so the
//!   daemon's `general-settings.json` exists from the first boot.
//! - `autostart_installed` — mirrors the OS supervisor state; cheaper to
//!   read than `launchctl list` on every UI render
//! - `bundled_source_version` — version of the source tree currently
//!   extracted to `<launcher_data_dir>/source/`. Used to decide whether
//!   a post-shell-update extraction is needed.
//!
//! Phase 1 (this scaffold): config exists in shape only. Phase 2 wires it
//! into the first-run flow per docs/architecture.md.

use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherConfig {
    pub port: u16,
    pub entity_name: String,
    pub user_name: String,
    pub timezone: String,
    pub autostart_installed: bool,
    pub bundled_source_version: Option<String>,
}

impl Default for LauncherConfig {
    fn default() -> Self {
        Self {
            port: crate::daemon::DAEMON_PORT,
            entity_name: "Assistant".into(),
            user_name: "You".into(),
            timezone: "UTC".into(),
            autostart_installed: false,
            bundled_source_version: None,
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

#[allow(dead_code)]
fn _config_path_for_tests(dir: &Path) -> std::path::PathBuf {
    dir.join("config.json")
}
