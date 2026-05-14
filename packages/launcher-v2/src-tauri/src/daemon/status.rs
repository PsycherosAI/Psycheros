//! Daemon state probe.
//!
//! Daemon state is the **intersection** of two signals:
//! - Is the port bound? (TCP probe to `127.0.0.1:PORT`)
//! - Is the service registered with the OS supervisor?
//!
//! The two-signal model lets the manager surface distinguish three cases
//! the user cares about, plus one transient:
//!
//! | port up | supervisor loaded | state            | meaning                          |
//! | ------- | ----------------- | ---------------- | -------------------------------- |
//! | yes     | yes               | `Running`        | daemon is healthy                |
//! | yes     | no                | `Running`        | daemon started manually (ok!)    |
//! | no      | yes               | `Installed`      | service registered, still booting (or crashlooping) |
//! | no      | no                | `NotInstalled`   | offer "Install autostart"        |
//!
//! "Daemon started manually" is treated as `Running` so a user who likes
//! `deno task start` from a terminal still gets a working chat UI — the
//! launcher just doesn't try to install autostart over their existing run.

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use serde::Serialize;

use super::DAEMON_PORT;
use crate::supervisor::{default_supervisor, ServiceSupervisor};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DaemonState {
    /// No service registered, no port bound. Offer install.
    NotInstalled,
    /// Service registered but port not yet bound. Either booting (~5–10s
    /// after install) or crashlooping (manager should surface logs).
    Installed,
    /// Port bound — daemon is responding. Whether the service is registered
    /// doesn't matter to the user at this point; chat just works.
    Running,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct DaemonStatus {
    pub state: DaemonState,
    pub port: u16,
    pub supervisor_loaded: bool,
}

/// Point-in-time probe. Cheap (<10ms typical), safe to call on a watcher
/// loop every few seconds.
pub fn probe() -> DaemonStatus {
    let port_up = port_is_listening(DAEMON_PORT);
    let supervisor_loaded = default_supervisor().is_loaded();

    let state = match (supervisor_loaded, port_up) {
        (_, true) => DaemonState::Running,
        (true, false) => DaemonState::Installed,
        (false, false) => DaemonState::NotInstalled,
    };

    DaemonStatus {
        state,
        port: DAEMON_PORT,
        supervisor_loaded,
    }
}

fn port_is_listening(port: u16) -> bool {
    let addr: SocketAddr = match format!("127.0.0.1:{port}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}
