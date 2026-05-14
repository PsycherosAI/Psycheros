//! Daemon detection + control.
//!
//! The launcher never owns the daemon process. It only **observes** the
//! daemon's state (via TCP probe + supervisor query) and **directs** the OS
//! supervisor to start/stop it. This separation is the architectural
//! foundation of the v2 launcher — see docs/architecture.md.
//!
//! Modules:
//! - [`status`] — point-in-time daemon state probe
//! - [`navigation`] — webview navigation helper that respects user-summon state

pub mod navigation;
pub mod status;

pub use status::{probe, DaemonState, DaemonStatus};

/// Default port the daemon binds. Overridable via the launcher's config —
/// but for now we just use 3000 since that's psycheros's longstanding default.
pub const DAEMON_PORT: u16 = 3000;
