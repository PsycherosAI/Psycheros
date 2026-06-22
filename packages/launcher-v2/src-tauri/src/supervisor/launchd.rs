//! macOS launchd user-agent supervisor.
//!
//! Writes a plist to `~/Library/LaunchAgents/<label>.plist` and uses
//! `launchctl load`/`unload` to drive it. Runs as a **user agent**, not a
//! system daemon — no sudo, no escalation prompt.
//!
//! ## Plist semantics by mode
//!
//! - **Autostart** (`RunAtLoad=true` + `KeepAlive=true`) — daemon starts
//!   immediately on plist load and is auto-respawned by launchd on any
//!   exit (crash or otherwise). The `KeepAlive` makes a real "stop"
//!   impossible via `launchctl stop` (launchd immediately respawns), so
//!   "stop" is wrapped as a session-scoped unload — daemon goes away
//!   for the current session, comes back at next login.
//! - **Manual** (`RunAtLoad=false`, `KeepAlive` omitted) — daemon
//!   doesn't start at plist load and isn't auto-respawned. User drives
//!   start/stop via `launchctl start/stop`.
//!
//! ## Persistent vs. session-scoped flags
//!
//! `launchctl (un)load -w` writes to the persistent enabled/disabled
//! list keyed by label. Without `-w`, the change only lasts the current
//! session.
//!
//! - **install / uninstall** use `-w` because the user's choice to
//!   add/remove the service should survive logout.
//! - **start_daemon** uses `-w` defensively in case something else
//!   disabled the service.
//! - **stop_daemon** does NOT use `-w` — autostart users clicking Stop
//!   want their daemon back at next login.
//!
//! ## Logs
//!
//! `StandardOutPath` / `StandardErrorPath` redirect daemon stdio to
//! files under `cfg.log_dir`. The manager surface's live log panel
//! tails them.
//!
//! ## Traps
//!
//! - `launchctl list <label>` exits 0 if loaded, 113 if not. We parse
//!   exit status, not stdout text — the format varies across macOS
//!   versions.
//! - `launchctl load -w` on an already-loaded plist errors. Always
//!   check `is_loaded()` first or unload before re-loading.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use super::{DaemonConfig, RuntimeInfo, ServiceSupervisor, SupervisorError};
use crate::config::DaemonMode;

/// macOS supervisor backed by `launchd` user agents. The label is the
/// plist's `Label` value and the basename of the file under
/// `~/Library/LaunchAgents/`. See [`docs/supervisors.md`](../../docs/supervisors.md)
/// for the plist contract.
pub struct LaunchdSupervisor {
    label: String,
}

/// Which plist flavor to render. Local to this module — the trait
/// stays mode-agnostic; callers pick which install method to invoke,
/// and the impl maps that to the right plist content.
#[derive(Clone, Copy)]
enum PlistMode {
    Autostart,
    Manual,
}

impl LaunchdSupervisor {
    /// Construct a supervisor bound to the canonical `ai.psycheros.daemon`
    /// label. The label is the only piece of supervisor state — every
    /// `launchctl` call is parameterized by it.
    pub fn new() -> Self {
        Self {
            label: "ai.psycheros.daemon".to_string(),
        }
    }

    /// Resolve the plist path under `~/Library/LaunchAgents/`.
    fn plist_path(&self) -> Result<PathBuf, SupervisorError> {
        let home = dirs::home_dir()
            .ok_or_else(|| SupervisorError::Command("HOME directory not resolvable".into()))?;
        Ok(home
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", self.label)))
    }

    /// Resolve standard log file paths under the daemon's log_dir.
    fn log_files(log_dir: &std::path::Path) -> (PathBuf, PathBuf) {
        (
            log_dir.join("daemon.stdout.log"),
            log_dir.join("daemon.stderr.log"),
        )
    }

    /// Build the plist XML for the given mode.
    ///
    /// Hand-rolled rather than using a plist crate because the surface
    /// is small, the XML is stable across macOS versions, and one less
    /// dep is one less attack surface.
    fn render_plist(&self, cfg: &DaemonConfig, mode: PlistMode) -> String {
        let (stdout, stderr) = Self::log_files(&cfg.log_dir);

        let mut env_pairs: Vec<(String, String)> = vec![
            (
                "HOME".into(),
                dirs::home_dir()
                    .map(|p| p.display().to_string())
                    .unwrap_or_default(),
            ),
            (
                "PATH".into(),
                "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin".into(),
            ),
            (
                "PSYCHEROS_DATA_DIR".into(),
                cfg.data_dir.display().to_string(),
            ),
            ("PSYCHEROS_PORT".into(), cfg.port.to_string()),
        ];
        if let Some(ec) = &cfg.entity_core_dir {
            env_pairs.push((
                "PSYCHEROS_ENTITY_CORE_PATH".into(),
                ec.display().to_string(),
            ));
        }
        if let Some(ec_data) = &cfg.entity_core_data_dir {
            env_pairs.push((
                "PSYCHEROS_ENTITY_CORE_DATA_DIR".into(),
                ec_data.display().to_string(),
            ));
        }
        env_pairs.push((
            "PSYCHEROS_MCP_COMMAND".into(),
            cfg.deno_path.display().to_string(),
        ));
        if cfg.tahoe_compat {
            // --jitless: skip JIT CodeRange allocation (original Tahoe fix).
            // NOTE: a previous attempt added --sandbox=off here. V8 doesn't
            // expose the sandbox as a runtime flag in this version
            // ("V8 did not recognize flag '--sandbox=off'"), so it was
            // removed. Sandbox is a compile-time decision in modern V8.
            env_pairs.push(("DENO_V8_FLAGS".into(), "--jitless".into()));
        }

        let env_block = env_pairs
            .iter()
            .map(|(k, v)| {
                format!(
                    "        <key>{}</key>\n        <string>{}</string>",
                    k,
                    escape_xml(v)
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        let mode_keys = match mode {
            PlistMode::Autostart => {
                "<key>RunAtLoad</key>\n    <true/>\n    <key>KeepAlive</key>\n    <true/>"
            }
            // Manual: daemon doesn't start at plist load, no auto-respawn.
            // User drives the lifecycle via launchctl start/stop.
            PlistMode::Manual => "<key>RunAtLoad</key>\n    <false/>",
        };

        let v8_flags_arg = if cfg.tahoe_compat {
            "        <string>--v8-flags=--jitless</string>\n"
        } else {
            ""
        };

        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{deno}</string>
        <string>run</string>
        <string>-A</string>
{v8_flags_arg}
        <string>src/main.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{source}</string>
    {mode_keys}
    <key>StandardOutPath</key>
    <string>{stdout}</string>
    <key>StandardErrorPath</key>
    <string>{stderr}</string>
    <key>EnvironmentVariables</key>
    <dict>
{env_block}
    </dict>
</dict>
</plist>
"#,
            label = self.label,
            deno = escape_xml(&cfg.deno_path.display().to_string()),
            source = escape_xml(&cfg.source_dir.display().to_string()),
            stdout = escape_xml(&stdout.display().to_string()),
            stderr = escape_xml(&stderr.display().to_string()),
            mode_keys = mode_keys,
            v8_flags_arg = v8_flags_arg,
            env_block = env_block,
        )
    }

    /// Write the plist + load it via `launchctl load -w`. Shared by
    /// both install_autostart and install_manual; the mode parameter
    /// controls the plist content.
    fn write_and_load_plist(
        &self,
        cfg: &DaemonConfig,
        mode: PlistMode,
    ) -> Result<(), SupervisorError> {
        fs::create_dir_all(&cfg.log_dir)?;
        let plist = self.plist_path()?;
        if let Some(parent) = plist.parent() {
            fs::create_dir_all(parent)?;
        }

        // Idempotent: if already loaded, unload first so the new config
        // (possibly with a different mode) takes effect.
        if self.is_loaded() {
            let _ = Command::new("launchctl")
                .args(["unload", "-w"])
                .arg(&plist)
                .output();
        }

        fs::write(&plist, self.render_plist(cfg, mode))?;

        let out = Command::new("launchctl")
            .args(["load", "-w"])
            .arg(&plist)
            .output()?;
        if !out.status.success() {
            return Err(SupervisorError::Command(format!(
                "launchctl load failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        Ok(())
    }
}

impl Default for LaunchdSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl LaunchdSupervisor {
    /// Map config-layer mode to local plist-render mode.
    fn plist_mode(mode: DaemonMode) -> PlistMode {
        match mode {
            DaemonMode::Autostart => PlistMode::Autostart,
            DaemonMode::Manual => PlistMode::Manual,
        }
    }
}

impl ServiceSupervisor for LaunchdSupervisor {
    fn install_autostart(&self, cfg: &DaemonConfig) -> Result<(), SupervisorError> {
        // RunAtLoad=true in the plist makes load start the daemon
        // immediately — no separate `launchctl start` needed.
        self.write_and_load_plist(cfg, PlistMode::Autostart)
    }

    fn install_manual(&self, cfg: &DaemonConfig) -> Result<(), SupervisorError> {
        // Manual-mode plist has RunAtLoad=false, so load alone doesn't
        // start the daemon. The user just clicked Install — they
        // probably want it on right now — so kick it off explicitly.
        self.write_and_load_plist(cfg, PlistMode::Manual)?;
        let out = Command::new("launchctl")
            .args(["start", &self.label])
            .output()?;
        if !out.status.success() {
            return Err(SupervisorError::Command(format!(
                "launchctl start (after manual install) failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        Ok(())
    }

    fn uninstall(&self) -> Result<(), SupervisorError> {
        let plist = self.plist_path()?;
        if !plist.exists() {
            return Ok(()); // Idempotent — already absent.
        }

        // Best-effort unload; we want to remove the plist regardless so
        // the system ends up in a known-clean state.
        let _ = Command::new("launchctl")
            .args(["unload", "-w"])
            .arg(&plist)
            .output();

        fs::remove_file(&plist)?;
        Ok(())
    }

    fn set_mode_only(&self, cfg: &DaemonConfig, mode: DaemonMode) -> Result<(), SupervisorError> {
        // **Just write the file.** No unload, no load, no start, no
        // stop. launchd reads the plist at next session load (i.e.,
        // next login) — which is exactly when `RunAtLoad` matters. The
        // currently-running daemon is left undisturbed, so the chat
        // surface stays connected, entity-core MCP stays alive, and no
        // cascade of reconnect failures fires across the stack. The
        // `KeepAlive` change becomes effective at the next daemon
        // start (login / manual restart / crash); for the common
        // "set my autostart preference" use case the user almost
        // never notices the delay.
        //
        // The plist must already exist (the user installed earlier);
        // if it doesn't, surface that clearly rather than silently
        // creating a half-state.
        let plist = self.plist_path()?;
        if !plist.exists() {
            return Err(SupervisorError::Command(
                "service isn't installed — nothing to update".into(),
            ));
        }
        if let Some(parent) = plist.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&plist, self.render_plist(cfg, Self::plist_mode(mode)))?;
        Ok(())
    }

    fn is_installed(&self) -> bool {
        // Mode-agnostic — both autostart and manual installs leave a
        // plist file behind. The probe layer combines this with
        // is_loaded() and port-bound to derive the surfaced state.
        self.plist_path().map(|p| p.exists()).unwrap_or(false)
    }

    fn is_loaded(&self) -> bool {
        // `launchctl list <label>` exits 0 when registered, 113 otherwise.
        // Parse exit status, not stdout — the latter varies across macOS
        // versions and is meant for human readers, not parsing.
        Command::new("launchctl")
            .args(["list", &self.label])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }

    fn start_daemon(&self) -> Result<(), SupervisorError> {
        let plist = self.plist_path()?;
        if !plist.exists() {
            return Err(SupervisorError::Command(
                "Cannot start — service isn't installed. Install it first.".into(),
            ));
        }

        // Load the plist if not already loaded. `-w` defensively
        // re-enables the service in case something put it in the
        // disabled list (e.g., a prior `launchctl unload -w` from the
        // terminal). On already-loaded plists, `launchctl load` errors,
        // so we skip when is_loaded() is true.
        if !self.is_loaded() {
            let out = Command::new("launchctl")
                .args(["load", "-w"])
                .arg(&plist)
                .output()?;
            if !out.status.success() {
                return Err(SupervisorError::Command(format!(
                    "launchctl load (during start) failed: {}",
                    String::from_utf8_lossy(&out.stderr)
                )));
            }
        }

        // Kick the daemon. For autostart mode the daemon is already
        // running from RunAtLoad, so this is a no-op. For manual mode
        // (RunAtLoad=false) this is what actually starts the process.
        let out = Command::new("launchctl")
            .args(["start", &self.label])
            .output()?;
        if !out.status.success() {
            return Err(SupervisorError::Command(format!(
                "launchctl start failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        Ok(())
    }

    fn stop_daemon(&self) -> Result<(), SupervisorError> {
        if !self.is_loaded() {
            return Ok(()); // Idempotent — already stopped.
        }

        let plist = self.plist_path()?;
        // Session-scoped unload. The plist file stays, the persistent
        // enabled flag stays. At next login the service reloads — for
        // autostart mode the daemon comes back automatically, for
        // manual mode it's reloaded but doesn't auto-start (RunAtLoad
        // is false, and we don't fire launchctl start on next login).
        let out = Command::new("launchctl")
            .arg("unload")
            .arg(&plist)
            .output()?;
        if !out.status.success() {
            return Err(SupervisorError::Command(format!(
                "launchctl unload (during stop) failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        Ok(())
    }

    fn restart(&self) -> Result<(), SupervisorError> {
        let plist = self.plist_path()?;
        if !plist.exists() {
            // No service registration to restart.
            return Ok(());
        }
        if !self.is_loaded() {
            // Plist on disk but not loaded — nothing running to restart.
            return Ok(());
        }

        // `launchctl unload -w` + `launchctl load -w` cycles the service
        // by plist path — avoids needing to construct `gui/<uid>/<label>`
        // service-target strings. Both flag pairs are no-net-change in
        // disabled-state, so the service stays enabled across the cycle.
        let _ = Command::new("launchctl")
            .args(["unload", "-w"])
            .arg(&plist)
            .output();
        let out = Command::new("launchctl")
            .args(["load", "-w"])
            .arg(&plist)
            .output()?;
        if !out.status.success() {
            return Err(SupervisorError::Command(format!(
                "launchctl load (during restart) failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        Ok(())
    }

    fn log_paths(&self) -> Vec<PathBuf> {
        let data = crate::paths::launcher_data_dir();
        let log_dir = data.join("logs");
        let (stdout, stderr) = Self::log_files(&log_dir);
        vec![stdout, stderr]
    }

    fn label(&self) -> &str {
        &self.label
    }

    fn query_runtime_info(&self) -> RuntimeInfo {
        // `launchctl list <label>` prints a plist-ish dict when the
        // service is loaded:
        //
        //   {
        //       "Label" = "ai.psycheros.daemon";
        //       "PID" = 12345;            // present only when running
        //       "LastExitStatus" = 0;     // present after first exit
        //       "OnDemand" = false;
        //       ...
        //   };
        //
        // Exit 113 when the label isn't registered at all. The actual
        // parsing lives in `parse_launchctl_list` as a free function so
        // unit tests can exercise it against canned launchctl output
        // without needing a live service to query.
        let Ok(out) = Command::new("launchctl")
            .args(["list", &self.label])
            .output()
        else {
            return RuntimeInfo::default();
        };
        if !out.status.success() {
            return RuntimeInfo::default();
        }
        parse_launchctl_list(&String::from_utf8_lossy(&out.stdout))
    }
}

/// Parse `launchctl list <label>` output into PID + LastExitStatus.
/// Tolerant by design: a parse failure returns the default
/// `RuntimeInfo` rather than erroring — the diagnostics card can
/// always render "—" for fields the parser couldn't extract.
///
/// The format is stable across all macOS versions where launchctl is
/// user-driven (10.10+); the fields we care about appear on their own
/// lines with exact prefixes `"PID" = ` and `"LastExitStatus" = `.
fn parse_launchctl_list(text: &str) -> RuntimeInfo {
    let mut info = RuntimeInfo::default();
    for raw_line in text.lines() {
        let line = raw_line.trim().trim_end_matches(';');
        if let Some(rest) = line.strip_prefix("\"PID\" = ") {
            info.pid = rest.trim_end_matches(';').trim().parse().ok();
        } else if let Some(rest) = line.strip_prefix("\"LastExitStatus\" = ") {
            info.last_exit_status = rest.trim_end_matches(';').trim().parse().ok();
        }
    }
    info
}

/// Minimal XML attribute/element-text escaping for the plist content. None of
/// our generated paths should contain these characters in practice, but if
/// the user installs into a path with weird characters we don't want to
/// produce a malformed plist.
fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Build a DaemonConfig with sensible defaults for plist-render
    /// tests. Individual tests override fields they care about.
    fn fixture_cfg() -> DaemonConfig {
        DaemonConfig {
            label: "ai.psycheros.daemon".to_string(),
            deno_path: PathBuf::from("/Users/me/Library/Application Support/Psycheros/bin/deno"),
            source_dir: PathBuf::from(
                "/Users/me/Library/Application Support/Psycheros/source/packages/psycheros",
            ),
            data_dir: PathBuf::from("/Users/me/Library/Application Support/Psycheros/data"),
            log_dir: PathBuf::from("/Users/me/Library/Application Support/Psycheros/logs"),
            port: 3000,
            entity_core_dir: None,
            entity_core_data_dir: Some(PathBuf::from(
                "/Users/me/Library/Application Support/Psycheros/data/entity-core",
            )),
            tahoe_compat: false,
        }
    }

    // ─── render_plist mode-specific keys ───────────────────────────────

    #[test]
    fn autostart_plist_has_runatload_and_keepalive() {
        let sup = LaunchdSupervisor::new();
        let xml = sup.render_plist(&fixture_cfg(), PlistMode::Autostart);
        // Both keys present and both true — daemon runs at every login
        // AND auto-respawns on crash.
        assert!(
            xml.contains("<key>RunAtLoad</key>"),
            "autostart plist missing RunAtLoad key"
        );
        assert!(
            xml.contains("<key>KeepAlive</key>"),
            "autostart plist missing KeepAlive key — daemon wouldn't \
             auto-restart on crash"
        );
        // Smoke: the bool values should follow each key as <true/>.
        // We don't want either to be <false/>.
        assert!(
            !xml.contains("<key>KeepAlive</key>\n    <false/>"),
            "KeepAlive=false would defeat autostart's crash-restart"
        );
    }

    #[test]
    fn manual_plist_has_no_keepalive_and_runatload_false() {
        let sup = LaunchdSupervisor::new();
        let xml = sup.render_plist(&fixture_cfg(), PlistMode::Manual);
        // RunAtLoad false: daemon doesn't start at plist load.
        assert!(
            xml.contains("<key>RunAtLoad</key>\n    <false/>"),
            "manual plist should have RunAtLoad=false"
        );
        // No KeepAlive entry: launchctl stop is the off switch.
        assert!(
            !xml.contains("<key>KeepAlive</key>"),
            "manual plist shouldn't have KeepAlive — would make stop \
             impossible"
        );
    }

    // ─── render_plist content surface ─────────────────────────────────

    #[test]
    fn plist_includes_deno_program_arguments() {
        let sup = LaunchdSupervisor::new();
        let cfg = fixture_cfg();
        let xml = sup.render_plist(&cfg, PlistMode::Autostart);

        // Deno path is the first ProgramArgument.
        assert!(xml.contains(&format!("<string>{}</string>", cfg.deno_path.display())));
        // Argument vector: `deno run -A src/main.ts`.
        assert!(xml.contains("<string>run</string>"));
        assert!(xml.contains("<string>-A</string>"));
        assert!(xml.contains("<string>src/main.ts</string>"));
    }

    #[test]
    fn plist_sets_working_directory_to_source_dir() {
        let sup = LaunchdSupervisor::new();
        let cfg = fixture_cfg();
        let xml = sup.render_plist(&cfg, PlistMode::Autostart);

        // WorkingDirectory is what makes `src/main.ts` resolve. Without
        // this, the daemon launches from `/` and dies immediately.
        let block = format!(
            "<key>WorkingDirectory</key>\n    <string>{}</string>",
            cfg.source_dir.display()
        );
        assert!(
            xml.contains(&block),
            "plist missing or malformed WorkingDirectory block"
        );
    }

    #[test]
    fn plist_propagates_psycheros_env_vars() {
        let sup = LaunchdSupervisor::new();
        let cfg = fixture_cfg();
        let xml = sup.render_plist(&cfg, PlistMode::Autostart);

        // The daemon reads its data dir + port + entity-core data dir
        // from these env vars. Plist must propagate them.
        assert!(
            xml.contains(&format!(
                "<key>PSYCHEROS_DATA_DIR</key>\n        <string>{}</string>",
                cfg.data_dir.display()
            )),
            "PSYCHEROS_DATA_DIR env var missing or malformed in plist"
        );
        assert!(
            xml.contains(&format!(
                "<key>PSYCHEROS_PORT</key>\n        <string>{}</string>",
                cfg.port
            )),
            "PSYCHEROS_PORT env var missing in plist"
        );
        assert!(
            xml.contains("PSYCHEROS_ENTITY_CORE_DATA_DIR"),
            "PSYCHEROS_ENTITY_CORE_DATA_DIR missing in plist"
        );
    }

    #[test]
    fn plist_writes_stdout_and_stderr_paths_under_log_dir() {
        let sup = LaunchdSupervisor::new();
        let cfg = fixture_cfg();
        let xml = sup.render_plist(&cfg, PlistMode::Autostart);

        // The log tailer reads from these exact filenames; renaming
        // either would break the live-log-panel feature.
        let stdout = cfg.log_dir.join("daemon.stdout.log");
        let stderr = cfg.log_dir.join("daemon.stderr.log");
        assert!(
            xml.contains(&format!("<string>{}</string>", stdout.display())),
            "stdout path missing from plist"
        );
        assert!(
            xml.contains(&format!("<string>{}</string>", stderr.display())),
            "stderr path missing from plist"
        );
    }

    #[test]
    fn plist_label_matches_supervisor_label() {
        let sup = LaunchdSupervisor::new();
        let cfg = fixture_cfg();
        let xml = sup.render_plist(&cfg, PlistMode::Autostart);
        let block = format!("<key>Label</key>\n    <string>{}</string>", sup.label);
        assert!(
            xml.contains(&block),
            "plist Label doesn't match supervisor label (would orphan the service)"
        );
    }

    // ─── escape_xml ──────────────────────────────────────────────────

    #[test]
    fn escape_xml_handles_all_five_xml_chars() {
        assert_eq!(escape_xml("a&b"), "a&amp;b");
        assert_eq!(escape_xml("a<b"), "a&lt;b");
        assert_eq!(escape_xml("a>b"), "a&gt;b");
        assert_eq!(escape_xml("a\"b"), "a&quot;b");
        // Ampersand must be escaped FIRST — otherwise re-escape would
        // double-encode (& → &amp; → &amp;amp;). Verify order via a
        // string that would tickle a bad implementation.
        assert_eq!(escape_xml("&lt;"), "&amp;lt;");
    }

    #[test]
    fn render_plist_escapes_paths_with_ampersands() {
        let sup = LaunchdSupervisor::new();
        let mut cfg = fixture_cfg();
        // Hypothetical user with `&` in their home dir name. Without
        // escape we'd produce malformed XML; with escape it parses.
        cfg.deno_path = PathBuf::from("/Users/A&B/deno");
        let xml = sup.render_plist(&cfg, PlistMode::Autostart);
        assert!(
            xml.contains("/Users/A&amp;B/deno"),
            "ampersand wasn't XML-escaped in deno path"
        );
        assert!(
            !xml.contains("/Users/A&B/deno"),
            "raw ampersand leaked into the plist — would fail launchd parse"
        );
    }

    // ─── tahoe_compat env var ──────────────────────────────────────

    #[test]
    fn tahoe_compat_false_excludes_deno_v8_flags() {
        let sup = LaunchdSupervisor::new();
        let xml = sup.render_plist(&fixture_cfg(), PlistMode::Autostart);
        assert!(
            !xml.contains("DENO_V8_FLAGS"),
            "DENO_V8_FLAGS env var should not appear when tahoe_compat is false"
        );
        assert!(
            !xml.contains("--v8-flags=--jitless"),
            "--v8-flags=--jitless argument should not appear when tahoe_compat is false"
        );
    }

    #[test]
    fn tahoe_compat_true_includes_deno_v8_flags() {
        let sup = LaunchdSupervisor::new();
        let mut cfg = fixture_cfg();
        cfg.tahoe_compat = true;
        let xml = sup.render_plist(&cfg, PlistMode::Autostart);
        assert!(
            xml.contains("<key>DENO_V8_FLAGS</key>\n        <string>--jitless</string>"),
            "DENO_V8_FLAGS=--jitless env var should appear when tahoe_compat is true"
        );
        assert!(
            xml.contains("<string>--v8-flags=--jitless</string>"),
            "--v8-flags=--jitless should appear as a ProgramArgument when tahoe_compat is true"
        );
    }

    // ─── parse_launchctl_list ────────────────────────────────────────

    #[test]
    fn parse_launchctl_list_extracts_pid_and_last_exit() {
        let canned = r#"{
            "Label" = "ai.psycheros.daemon";
            "PID" = 12345;
            "LastExitStatus" = 0;
            "OnDemand" = false;
        };"#;
        let info = parse_launchctl_list(canned);
        assert_eq!(info.pid, Some(12345));
        assert_eq!(info.last_exit_status, Some(0));
    }

    #[test]
    fn parse_launchctl_list_handles_negative_exit_status() {
        // launchd reports SIGKILL exits as negative values. Make sure
        // the parser handles them (would silently drop with .ok() on
        // a u32 → i32 mismatch).
        let canned = r#"{
            "Label" = "ai.psycheros.daemon";
            "LastExitStatus" = -9;
        };"#;
        let info = parse_launchctl_list(canned);
        assert_eq!(info.last_exit_status, Some(-9));
        assert!(info.pid.is_none(), "no PID line → pid stays None");
    }

    #[test]
    fn parse_launchctl_list_returns_default_on_empty_input() {
        let info = parse_launchctl_list("");
        assert!(info.pid.is_none());
        assert!(info.last_exit_status.is_none());
    }

    #[test]
    fn parse_launchctl_list_ignores_unknown_fields() {
        // Many fields show up in real output (Program, ProgramArguments,
        // LimitLoadToSessionType, etc.). Parser must skip them silently.
        let canned = r#"{
            "Program" = "/some/binary";
            "ProgramArguments" = (
                "/some/binary";
                "arg1";
            );
            "PID" = 42;
        };"#;
        let info = parse_launchctl_list(canned);
        assert_eq!(info.pid, Some(42));
    }

    // ─── plist_path resolution ───────────────────────────────────────

    #[test]
    fn plist_path_resolves_under_home_library_launchagents() {
        // HOME override so the test is hermetic. The `dirs` crate's
        // home_dir on macOS honors $HOME (falls back to NSHomeDirectory
        // only when HOME is unset). Setting it here redirects the
        // plist path entirely off the user's real LaunchAgents dir.
        let fake_home = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", fake_home.path());

        let sup = LaunchdSupervisor::new();
        let path = sup.plist_path().expect("plist_path resolves under HOME");
        let expected = fake_home
            .path()
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", sup.label));
        assert_eq!(path, expected);
    }
}
