//! OS service-supervisor abstraction.
//!
//! The launcher delegates daemon lifecycle (install, start, restart-on-crash,
//! uninstall) to the OS-native service supervisor — launchd on macOS,
//! systemd-user on Linux, Task Scheduler on Windows. The launcher itself
//! never owns the daemon process; that decoupling is the whole point of
//! the v2 architecture (see docs/architecture.md).
//!
//! ## Trait surface
//!
//! All three supervisor implementations share the [`ServiceSupervisor`]
//! trait. The trait deliberately exposes the smallest possible surface —
//! enough for the launcher's UI to drive install/uninstall and observe
//! state, but not enough to leak per-OS quirks into the manager surface.
//!
//! ## Default supervisor
//!
//! [`DefaultSupervisor`] is the type alias for the current OS's impl,
//! selected at compile time. The frontend never knows which it is.

use std::path::PathBuf;

use thiserror::Error;

#[cfg(target_os = "macos")]
mod launchd;

#[cfg(target_os = "linux")]
mod systemd;

#[cfg(target_os = "windows")]
mod task_scheduler;

#[cfg(target_os = "macos")]
pub use launchd::LaunchdSupervisor as DefaultSupervisor;

#[cfg(target_os = "linux")]
pub use systemd::SystemdUserSupervisor as DefaultSupervisor;

#[cfg(target_os = "windows")]
pub use task_scheduler::TaskSchedulerSupervisor as DefaultSupervisor;

// ============================================================================
// Public surface
// ============================================================================

/// Inputs needed to register the daemon with the OS supervisor.
///
/// Constructed by `daemon::lifecycle` from the user's persisted config plus
/// the launcher's bundled paths. The supervisor turns this into the OS-native
/// service definition (plist / unit file / scheduled task).
#[derive(Debug, Clone)]
pub struct DaemonConfig {
    /// Reverse-DNS label used by the OS supervisor to identify the service.
    pub label: String,
    /// Absolute path to the bundled Deno binary (or system Deno in dev).
    pub deno_path: PathBuf,
    /// Path to the psycheros source bundle (where `src/main.ts` lives).
    /// Set as the service's working directory + the value of psycheros's
    /// `projectRoot`.
    pub source_dir: PathBuf,
    /// Path to user-mutable runtime state. Passed to the daemon as
    /// `PSYCHEROS_DATA_DIR` — see psycheros's PSYCHEROS_DATA_DIR refactor.
    pub data_dir: PathBuf,
    /// Where stdout/stderr land. The manager's log viewer tails these.
    pub log_dir: PathBuf,
    /// HTTP port the daemon binds to. Default 3000.
    pub port: u16,
    /// Optional path to entity-core source (for `PSYCHEROS_ENTITY_CORE_PATH`).
    /// When None, psycheros falls back to its sibling-package convention.
    pub entity_core_dir: Option<PathBuf>,
    /// Optional override for entity-core's data directory.
    /// When None, defaults to `<data_dir>/entity-core/data`.
    pub entity_core_data_dir: Option<PathBuf>,
}

/// Errors a supervisor can return. All variants are user-presentable.
#[derive(Debug, Error)]
pub enum SupervisorError {
    #[error("filesystem operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("supervisor command failed: {0}")]
    Command(String),
    #[error("service definition is malformed: {0}")]
    Malformed(String),
    #[error("not yet implemented on this platform")]
    NotImplemented,
}

/// What the manager surface can do with the daemon's OS-supervisor record.
///
/// Implementations must be idempotent: `install` when already installed
/// succeeds, `uninstall` when not installed succeeds. This makes the manager
/// UI tolerant of inconsistent on-disk state (e.g. plist exists but isn't
/// loaded).
pub trait ServiceSupervisor: Send + Sync {
    /// Register the service with the OS supervisor and start it immediately.
    /// On crash, the OS supervisor restarts it automatically.
    fn install(&self, cfg: &DaemonConfig) -> Result<(), SupervisorError>;

    /// Unregister the service. Stops the daemon as a side effect.
    fn uninstall(&self) -> Result<(), SupervisorError>;

    /// Whether the service is currently registered with the OS supervisor.
    /// Independent of whether the daemon is actually running right now —
    /// see `daemon::status` for the combined view.
    fn is_loaded(&self) -> bool;

    /// Paths to stdout/stderr log files. The manager surface tails these.
    fn log_paths(&self) -> Vec<PathBuf>;

    /// Service identifier (label / unit name / task name) the supervisor
    /// uses. Surfaced in diagnostics + the manager's "Service info" view.
    fn label(&self) -> &str;
}

/// Construct the default supervisor for this OS.
///
/// All supervisors are stateless w.r.t. their own data — they re-read the
/// OS supervisor's state on every call rather than caching. This keeps
/// the manager UI's state in lockstep with what the OS thinks.
pub fn default_supervisor() -> DefaultSupervisor {
    DefaultSupervisor::new()
}
