//! Linux systemd-user supervisor (stub — see docs/supervisors.md).
//!
//! This impl is intentionally a stub. The shape is right; the body returns
//! `NotImplemented`. The next implementer should:
//!
//! 1. Generate a systemd user unit at
//!    `~/.config/systemd/user/psycheros.service`. The `[Service]` block needs
//!    `ExecStart=<deno> run -A src/main.ts`, `WorkingDirectory=<source_dir>`,
//!    `Environment=PSYCHEROS_DATA_DIR=...` (one Environment line per var),
//!    `Restart=on-failure`, `RestartSec=2`. `[Install]` block: `WantedBy=default.target`.
//! 2. Run `systemctl --user daemon-reload` after writing the unit so the new
//!    file is picked up.
//! 3. Run `systemctl --user enable --now psycheros.service` to register +
//!    start. `is_loaded()` shells out to `systemctl --user is-enabled
//!    psycheros.service` (exit 0 = enabled).
//! 4. `uninstall()`: `systemctl --user disable --now psycheros.service` then
//!    `rm` the unit file + `daemon-reload`.
//!
//! ## The lingering caveat
//!
//! Out of the box, systemd user services stop when the user's last login
//! session ends — i.e., killing the daemon when the user logs out. To get
//! the "persistent across sessions" semantics the launcher promises, the
//! user has to run `sudo loginctl enable-linger $USER` ONCE.
//!
//! That's the only sudo step in the entire Linux flow. Two options for the
//! manager UI:
//!
//! - **Document it** — first-run wizard tells the user to run the command,
//!   provides the exact text. Cleanest, no auto-escalation.
//! - **Fall back to `~/.config/autostart/<file>.desktop`** when linger isn't
//!   available — gives "starts at login" but loses crash-restart.
//!
//! Default to documenting linger. See docs/supervisors.md for the rationale.
//!
//! ## Logs
//!
//! Logs go to the systemd journal — `journalctl --user -u psycheros.service`.
//! The manager's "View logs" affordance on Linux shells out to that command;
//! there are no flat log files like launchd produces. See docs/supervisors.md.

use std::path::PathBuf;

use super::{DaemonConfig, ServiceSupervisor, SupervisorError};

pub struct SystemdUserSupervisor {
    label: String,
}

impl SystemdUserSupervisor {
    pub fn new() -> Self {
        Self {
            label: "psycheros.service".to_string(),
        }
    }
}

impl Default for SystemdUserSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl ServiceSupervisor for SystemdUserSupervisor {
    fn install(&self, _cfg: &DaemonConfig) -> Result<(), SupervisorError> {
        Err(SupervisorError::NotImplemented)
    }

    fn uninstall(&self) -> Result<(), SupervisorError> {
        Err(SupervisorError::NotImplemented)
    }

    fn is_loaded(&self) -> bool {
        false
    }

    fn log_paths(&self) -> Vec<PathBuf> {
        // Real impl will return `journalctl --user -u psycheros.service`
        // affordances rather than file paths — see module doc.
        Vec::new()
    }

    fn label(&self) -> &str {
        &self.label
    }
}
