//! Release-bundle extraction + bundled-deno staging.
//!
//! At build time, CI produces `release-bundle.tar.gz` containing pruned
//! source (psycheros + entity-core + scheduler) and embeds it as a Tauri
//! resource (see `tauri.conf.json` → `bundle.resources`). At runtime on
//! first launch (or post-shell-update), the launcher:
//!
//! 1. Extracts `release-bundle.tar.gz` to `<launcher_data_dir>/source/`.
//! 2. Copies the bundled Deno binary (Tauri sidecar) to
//!    `<launcher_data_dir>/bin/deno` (a stable path the service definition
//!    can reference; the binary inside the .app moves on each auto-update).
//! 3. Populates Deno's dep cache by running `deno cache src/main.ts`
//!    against the extracted source (slow — ~30-60s — needs a progress UI).
//!
//! This module is the **shape** for that flow. The bodies are currently
//! stubs returning `NotImplemented` so the package compiles cleanly. The
//! actual logic lands during Phase 2 (First-run flow). See
//! docs/architecture.md for the full state-flow diagram.

use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum BundleError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("not yet implemented — phase 2 work")]
    NotImplemented,
}

/// Extract the embedded `release-bundle.tar.gz` resource to the launcher
/// data dir. Idempotent — if the target source dir is already populated
/// and the version matches, this is a no-op.
pub fn extract_release_bundle(
    _bundle_path: &std::path::Path,
    _target: &std::path::Path,
) -> Result<(), BundleError> {
    Err(BundleError::NotImplemented)
}

/// Copy the bundled Deno binary from its Tauri-sidecar location to the
/// stable launcher-data-dir path. The plist / unit file / scheduled task
/// references the stable path, so it survives shell auto-updates.
pub fn stage_bundled_deno(
    _sidecar_path: &std::path::Path,
    _dest: &std::path::Path,
) -> Result<(), BundleError> {
    Err(BundleError::NotImplemented)
}

/// Run `deno cache src/main.ts` from the extracted source dir to populate
/// Deno's dep cache. This is the slow step — must surface progress in the
/// first-run UI.
pub fn warm_deno_cache(_source_dir: &std::path::Path) -> Result<(), BundleError> {
    Err(BundleError::NotImplemented)
}

/// Where the embedded `release-bundle.tar.gz` lives at runtime (Tauri
/// resource path). Resolved via `app.path().resolve()` once the app is
/// up; this helper centralizes the name so it doesn't drift.
pub fn release_bundle_resource_name() -> PathBuf {
    PathBuf::from("resources/release-bundle.tar.gz")
}
