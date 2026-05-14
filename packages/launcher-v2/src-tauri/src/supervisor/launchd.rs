//! macOS launchd user-agent supervisor.
//!
//! Writes a plist to `~/Library/LaunchAgents/<label>.plist` and uses
//! `launchctl load -w` / `launchctl unload -w` to activate it. Runs as a
//! **user agent**, not a system daemon — no sudo, no escalation prompt.
//!
//! Plist semantics:
//! - `RunAtLoad=true` + `KeepAlive=true` — daemon starts immediately on
//!   load and is auto-restarted by launchd on any exit (crash or otherwise).
//! - `StandardOutPath` / `StandardErrorPath` — launchd redirects stdio to
//!   these files; the manager's log viewer tails them.
//! - `EnvironmentVariables` — passes `PSYCHEROS_DATA_DIR`, `HOME`, `PATH`,
//!   plus entity-core path overrides. launchd starts processes with no
//!   shell context, so we must set PATH explicitly.
//! - `WorkingDirectory` — the source bundle directory. Psycheros's
//!   `projectRoot` defaults to `Deno.cwd()` so this is where it'll look
//!   for templates, `web/`, the vec0 extension's `lib/`, etc.
//!
//! Notes on the plist contract:
//! - `launchctl list <label>` exits 0 if loaded, 113 if not. We parse exit
//!   status, not stdout text — the format differs across macOS versions.
//! - `KeepAlive=true` means there is no "stop temporarily" — `launchctl
//!   stop` is a no-op against KeepAlive. Real off-switch is `unload -w`.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use super::{DaemonConfig, ServiceSupervisor, SupervisorError};

pub struct LaunchdSupervisor {
    label: String,
}

impl LaunchdSupervisor {
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

    /// Build the plist XML from the daemon config.
    ///
    /// The plist is hand-rolled rather than using a plist crate because the
    /// surface is small, the XML is stable across macOS versions, and one
    /// less dep is one less attack surface.
    fn render_plist(&self, cfg: &DaemonConfig) -> String {
        let (stdout, stderr) = Self::log_files(&cfg.log_dir);

        // Build EnvironmentVariables block — only include keys that have
        // meaningful values, since launchd treats empty strings as set.
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
        <string>src/main.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{source}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
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
            env_block = env_block,
        )
    }
}

impl Default for LaunchdSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl ServiceSupervisor for LaunchdSupervisor {
    fn install(&self, cfg: &DaemonConfig) -> Result<(), SupervisorError> {
        // Ensure log dir + LaunchAgents dir exist.
        fs::create_dir_all(&cfg.log_dir)?;
        let plist = self.plist_path()?;
        if let Some(parent) = plist.parent() {
            fs::create_dir_all(parent)?;
        }

        // Idempotent: if already loaded, unload first so the new config takes
        // effect rather than silently ignoring.
        if self.is_loaded() {
            let _ = Command::new("launchctl")
                .args(["unload", "-w"])
                .arg(&plist)
                .output();
        }

        // Write fresh plist + load.
        fs::write(&plist, self.render_plist(cfg))?;

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

    fn uninstall(&self) -> Result<(), SupervisorError> {
        let plist = self.plist_path()?;
        if !plist.exists() {
            return Ok(()); // Idempotent — already absent.
        }

        // Best-effort unload; we want to remove the plist regardless so the
        // system ends up in a known-clean state.
        let _ = Command::new("launchctl")
            .args(["unload", "-w"])
            .arg(&plist)
            .output();

        fs::remove_file(&plist)?;
        Ok(())
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

    fn log_paths(&self) -> Vec<PathBuf> {
        let data = crate::paths::launcher_data_dir();
        let log_dir = data.join("logs");
        let (stdout, stderr) = Self::log_files(&log_dir);
        vec![stdout, stderr]
    }

    fn label(&self) -> &str {
        &self.label
    }
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
