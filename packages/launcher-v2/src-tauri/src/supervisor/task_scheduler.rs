//! Windows Task Scheduler user-task supervisor.
//!
//! Registers the daemon as a user-context scheduled task (no admin
//! required, no UAC prompt). The supervisor never owns the daemon
//! process — it asks Task Scheduler to manage start/restart/stop and
//! observes the resulting state, mirroring the macOS launchd posture.
//!
//! ## Task definition by mode
//!
//! - **Autostart** — `<LogonTrigger>` fires the task at every user logon;
//!   `<RestartOnFailure Count=3 Interval=PT1M/>` covers crash-restart
//!   (the closest Task Scheduler analog to launchd's `KeepAlive`). The
//!   restart is weaker than launchd: it counts non-zero exits and gives
//!   up after `Count` retries, with no crash-loop throttling. Interval
//!   has a one-minute schema minimum (Task Scheduler rejects sub-minute
//!   durations), so the first restart after a crash is up to 60s later
//!   than launchd's near-instant respawn. The manager surface polls
//!   more aggressively on Windows to compensate (`docs/supervisors.md`).
//! - **Manual** — empty `<Triggers/>` block (the task doesn't fire on
//!   its own) and no `<RestartOnFailure>` element. The user drives
//!   start/stop via the manager's buttons; `schtasks /Run` and
//!   `/End` are the universal control plane.
//!
//! ## stdout/stderr redirection + clean Stop
//!
//! Task Scheduler's `<Exec>` action has no native stdio redirection,
//! and Windows doesn't cascade kill across process boundaries — a
//! naive `.cmd` wrapper that spawned deno would survive `schtasks /End`
//! only at the cmd.exe level, leaving deno as an orphan still holding
//! the port. Both problems are solved by the `psycheros-daemon-runner`
//! sidecar:
//!
//! - The runner is a small `#![windows_subsystem = "windows"]` binary
//!   (no console attached, so no window flashes up at start).
//! - It creates a Win32 Job Object with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assigns itself, then spawns
//!   deno with `CREATE_NO_WINDOW`. Children inherit job membership.
//! - When `schtasks /End` kills the runner, the OS kernel walks the
//!   job and terminates deno. Stop is reliable.
//! - The runner opens `daemon.stdout.log` and `daemon.stderr.log` in
//!   append mode and hands the file handles to deno. The launcher's
//!   log_tailer reads the same files the macOS impl produces.
//!
//! See `src/bin/psycheros-daemon-runner.rs` for the runner itself.
//!
//! ## XML encoding
//!
//! `schtasks.exe /Create /XML` reads UTF-16 LE with BOM. UTF-8 is
//! rejected with a cryptic "the task XML is malformed" error. Write
//! goes through [`write_utf16_le_with_bom`] which encodes the rendered
//! string and prepends `0xFF 0xFE`.
//!
//! ## What we don't try to expose
//!
//! - **PID + runtime info**: `schtasks /Query /FO LIST /V` doesn't
//!   include the process PID for a running task. The trait's
//!   default `query_runtime_info` impl returns `None, None`; we
//!   override only to parse `Last Result` (the daemon's last exit
//!   code), which schtasks does expose.
//! - **Network triggers, idle conditions, hibernation triggers**:
//!   the daemon is persistent — none of these are useful and they
//!   add surface that's easy to mis-configure.
//!
//! ## SmartScreen
//!
//! Unsigned `.exe`/`.msi` trigger SmartScreen on first run. Documented
//! in [`docs/release.md`]: right-click → Properties → Unblock, then
//! "More info → Run anyway." Same posture as macOS Gatekeeper.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use super::{DaemonConfig, RuntimeInfo, ServiceSupervisor, SupervisorError};
use crate::config::DaemonMode;
use crate::paths;
use crate::proc::hidden_command;

/// Canonical task name registered in Task Scheduler. Visible in the
/// Task Scheduler Library root under this exact name.
const TASK_LABEL: &str = "Psycheros";

/// Windows supervisor backed by Task Scheduler. The label is the only
/// piece of state — every `schtasks.exe` call is parameterized by it.
pub struct TaskSchedulerSupervisor {
    label: String,
}

/// Which task flavor to render. Local to this module — the trait stays
/// mode-agnostic; callers pick which install method to invoke, and the
/// impl maps that to the right XML content.
#[derive(Clone, Copy)]
enum TaskMode {
    Autostart,
    Manual,
}

impl TaskSchedulerSupervisor {
    /// Construct a supervisor bound to the canonical `Psycheros` task
    /// name. The label is exposed via [`ServiceSupervisor::label`] for
    /// the diagnostics card.
    pub fn new() -> Self {
        Self {
            label: TASK_LABEL.to_string(),
        }
    }

    /// Resolve stdout/stderr file paths under the daemon's log_dir.
    /// Filenames match the macOS launchd impl on purpose — the
    /// log_tailer + manager card share one set of names across all
    /// supervisor backends.
    fn log_files(log_dir: &Path) -> (PathBuf, PathBuf) {
        (
            log_dir.join("daemon.stdout.log"),
            log_dir.join("daemon.stderr.log"),
        )
    }

    /// Render the `<Arguments>` payload that schtasks passes to the
    /// runner sidecar. The runner's argv is:
    ///
    /// ```text
    /// <deno_path> <source_dir> <stdout_log> <stderr_log> [KEY=VALUE ...]
    /// ```
    ///
    /// Each token is wrapped in double quotes so paths with spaces
    /// (`C:\\Users\\<user>\\AppData\\...`) survive `CommandLineToArgvW`
    /// reconstruction on the runner side. Embedded double quotes are
    /// stripped (no path of ours produces them).
    fn render_runner_arguments(cfg: &DaemonConfig) -> String {
        let (stdout, stderr) = Self::log_files(&cfg.log_dir);
        let mut tokens: Vec<String> = vec![
            quote_argv(&cfg.deno_path.display().to_string()),
            quote_argv(&cfg.source_dir.display().to_string()),
            quote_argv(&stdout.display().to_string()),
            quote_argv(&stderr.display().to_string()),
            quote_argv(&format!("PSYCHEROS_DATA_DIR={}", cfg.data_dir.display())),
            quote_argv(&format!("PSYCHEROS_PORT={}", cfg.port)),
        ];
        if let Some(ec) = &cfg.entity_core_dir {
            tokens.push(quote_argv(&format!(
                "PSYCHEROS_ENTITY_CORE_PATH={}",
                ec.display()
            )));
        }
        if let Some(ec_data) = &cfg.entity_core_data_dir {
            tokens.push(quote_argv(&format!(
                "PSYCHEROS_ENTITY_CORE_DATA_DIR={}",
                ec_data.display()
            )));
        }
        tokens.push(quote_argv(&format!(
            "PSYCHEROS_MCP_COMMAND={}",
            cfg.deno_path.display()
        )));
        tokens.join(" ")
    }

    /// Render the Task Scheduler XML.
    ///
    /// Hand-rolled rather than reaching for a crate because the surface
    /// is small, the schema is stable across Windows versions back to
    /// 8.1, and one less dep is one less attack surface. The format
    /// reference is documented at
    /// <https://learn.microsoft.com/windows/win32/taskschd/task-scheduler-schema>.
    ///
    /// `enabled` controls the `<Enabled>` element in the Settings
    /// block. Install paths always pass `true` (a new install should
    /// start enabled). `set_mode_only` reads the live state via
    /// `is_loaded()` and passes that — so re-registering the task to
    /// flip Autostart/Manual doesn't accidentally un-stop a daemon
    /// the user had explicitly stopped.
    fn render_task_xml(cfg: &DaemonConfig, mode: TaskMode, user: &str, enabled: bool) -> String {
        let triggers = match mode {
            TaskMode::Autostart => format!(
                "    <LogonTrigger>\r\n\
                 \x20     <Enabled>true</Enabled>\r\n\
                 \x20     <UserId>{user}</UserId>\r\n\
                 \x20   </LogonTrigger>\r\n",
                user = escape_xml(user),
            ),
            TaskMode::Manual => String::new(),
        };

        // RestartOnFailure is the closest Task Scheduler analog to
        // launchd's KeepAlive. Manual mode deliberately omits it —
        // "manual" means the daemon stays off until the user starts
        // it. A crashed manual daemon staying down matches the macOS
        // manual-mode behavior.
        // Task Scheduler's RestartOnFailure schema requires Interval
        // to be at least one minute (PT1M). Values smaller than PT1M
        // — including the launchd-typical PT5S — are rejected at
        // schtasks /Create time with a generic "incorrectly formatted
        // or out of range" error pointing at the Interval element.
        // We pay one minute of additional crash-detection latency vs
        // launchd; that's the cost of the schema constraint.
        let restart_block = match mode {
            TaskMode::Autostart => {
                "    <RestartOnFailure>\r\n\
                                    \x20     <Interval>PT1M</Interval>\r\n\
                                    \x20     <Count>3</Count>\r\n\
                                    \x20   </RestartOnFailure>\r\n"
            }
            TaskMode::Manual => "",
        };

        let runner = paths::bundled_runner_path();
        let runner_args = Self::render_runner_arguments(cfg);

        // Task Scheduler XML namespace is fixed by Microsoft; the
        // version attribute "1.4" is supported on Windows 10+. We
        // intentionally do NOT set UseUnifiedSchedulingEngine — it's
        // incompatible with the <RestartOnFailure> Interval/Count
        // schema and causes /Create to reject the XML when autostart
        // mode emits the restart block (see CLAUDE.md "Traps that
        // bite"). The legacy engine works on every supported Windows
        // version and pays only a small Event Log noise cost.
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\r\n\
             <Task version=\"1.4\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\r\n\
             \x20 <RegistrationInfo>\r\n\
             \x20   <Description>Psycheros persistent entity daemon</Description>\r\n\
             \x20   <Author>Psycheros</Author>\r\n\
             \x20   <URI>\\{label}</URI>\r\n\
             \x20 </RegistrationInfo>\r\n\
             \x20 <Triggers>\r\n\
             {triggers}\
             \x20 </Triggers>\r\n\
             \x20 <Principals>\r\n\
             \x20   <Principal id=\"Author\">\r\n\
             \x20     <UserId>{user}</UserId>\r\n\
             \x20     <LogonType>InteractiveToken</LogonType>\r\n\
             \x20     <RunLevel>LeastPrivilege</RunLevel>\r\n\
             \x20   </Principal>\r\n\
             \x20 </Principals>\r\n\
             \x20 <Settings>\r\n\
             \x20   <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\r\n\
             \x20   <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\r\n\
             \x20   <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\r\n\
             \x20   <AllowHardTerminate>true</AllowHardTerminate>\r\n\
             \x20   <StartWhenAvailable>true</StartWhenAvailable>\r\n\
             \x20   <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\r\n\
             \x20   <IdleSettings>\r\n\
             \x20     <StopOnIdleEnd>false</StopOnIdleEnd>\r\n\
             \x20     <RestartOnIdle>false</RestartOnIdle>\r\n\
             \x20   </IdleSettings>\r\n\
             \x20   <AllowStartOnDemand>true</AllowStartOnDemand>\r\n\
             \x20   <Enabled>{enabled}</Enabled>\r\n\
             \x20   <Hidden>false</Hidden>\r\n\
             \x20   <RunOnlyIfIdle>false</RunOnlyIfIdle>\r\n\
             \x20   <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>\r\n\
             \x20   <WakeToRun>false</WakeToRun>\r\n\
             \x20   <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\r\n\
             \x20   <Priority>7</Priority>\r\n\
             {restart_block}\
             \x20 </Settings>\r\n\
             \x20 <Actions Context=\"Author\">\r\n\
             \x20   <Exec>\r\n\
             \x20     <Command>{cmd}</Command>\r\n\
             \x20     <Arguments>{args}</Arguments>\r\n\
             \x20     <WorkingDirectory>{cwd}</WorkingDirectory>\r\n\
             \x20   </Exec>\r\n\
             \x20 </Actions>\r\n\
             </Task>\r\n",
            label = TASK_LABEL,
            user = escape_xml(user),
            triggers = triggers,
            restart_block = restart_block,
            cmd = escape_xml(&runner.display().to_string()),
            args = escape_xml(&runner_args),
            cwd = escape_xml(&cfg.source_dir.display().to_string()),
        )
    }

    /// Render the XML and register the task with Task Scheduler.
    ///
    /// 1. Pre-create log_dir.
    /// 2. Verify the runner sidecar exists at the stable path — the
    ///    task XML references it absolutely, and a missing runner
    ///    would mean every task fire silently fails.
    /// 3. Render the XML, write to a tempfile encoded UTF-16 LE
    ///    with BOM (schtasks /XML requirement).
    /// 4. `schtasks /Create /XML <tmp> /TN <label> /F` — `/F`
    ///    silently overwrites an existing registration, which makes
    ///    install idempotent.
    /// 5. Autostart: run the task immediately so the user doesn't
    ///    have to wait for next login to see the daemon come up.
    fn write_and_register(
        &self,
        cfg: &DaemonConfig,
        mode: TaskMode,
    ) -> Result<(), SupervisorError> {
        fs::create_dir_all(&cfg.log_dir)?;

        let runner = paths::bundled_runner_path();
        if !runner.exists() {
            return Err(SupervisorError::Command(format!(
                "psycheros-daemon-runner.exe missing at {}. First-run setup didn't stage it — \
                 quit Psycheros and reopen to re-run setup.",
                runner.display()
            )));
        }

        let user = current_user()?;
        // Install paths (`install_autostart` / `install_manual`) always
        // create the task in the enabled state — the user just clicked
        // Install, so the daemon should be on. `set_mode_only` takes a
        // different path that preserves the current state.
        let xml = Self::render_task_xml(cfg, mode, &user, true);
        let xml_path =
            std::env::temp_dir().join(format!("psycheros-task-{}.xml", std::process::id()));
        write_utf16_le_with_bom(&xml_path, &xml)?;

        let out = hidden_command("schtasks.exe")
            .args(["/Create", "/XML"])
            .arg(&xml_path)
            .args(["/TN", &self.label, "/F"])
            .output()?;
        // Best-effort cleanup whether or not register succeeded —
        // the tempfile isn't useful past this point.
        let _ = fs::remove_file(&xml_path);
        if !out.status.success() {
            return Err(SupervisorError::Command(format!(
                "schtasks /Create failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }

        // Kick the daemon. Autostart mode users just clicked Install
        // and probably want the daemon on right now without waiting
        // for next login; manual mode users equivalently expect the
        // daemon up after Install (matches the macOS posture in
        // `LaunchdSupervisor::install_manual`).
        let run = hidden_command("schtasks.exe")
            .args(["/Run", "/TN", &self.label])
            .output()?;
        if !run.status.success() {
            return Err(SupervisorError::Command(format!(
                "schtasks /Run (post-install) failed: {}",
                String::from_utf8_lossy(&run.stderr)
            )));
        }
        Ok(())
    }

    /// Map config-layer mode to the local renderer's task mode.
    fn task_mode(mode: DaemonMode) -> TaskMode {
        match mode {
            DaemonMode::Autostart => TaskMode::Autostart,
            DaemonMode::Manual => TaskMode::Manual,
        }
    }
}

impl Default for TaskSchedulerSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl ServiceSupervisor for TaskSchedulerSupervisor {
    fn install_autostart(&self, cfg: &DaemonConfig) -> Result<(), SupervisorError> {
        self.write_and_register(cfg, TaskMode::Autostart)
    }

    fn install_manual(&self, cfg: &DaemonConfig) -> Result<(), SupervisorError> {
        self.write_and_register(cfg, TaskMode::Manual)
    }

    fn uninstall(&self) -> Result<(), SupervisorError> {
        if !self.is_installed() {
            return Ok(()); // Idempotent — already absent.
        }
        // /End is a no-op if the task isn't running; suppress its
        // status because we want to delete regardless.
        let _ = hidden_command("schtasks.exe")
            .args(["/End", "/TN", &self.label])
            .output();
        let out = hidden_command("schtasks.exe")
            .args(["/Delete", "/TN", &self.label, "/F"])
            .output()?;
        if !out.status.success() {
            return Err(SupervisorError::Command(format!(
                "schtasks /Delete failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        Ok(())
    }

    fn set_mode_only(&self, cfg: &DaemonConfig, mode: DaemonMode) -> Result<(), SupervisorError> {
        // Like the macOS launchd impl: rewrite the on-disk service
        // definition without disturbing the currently-running daemon.
        // For Windows the analogous operation is a re-register via
        // `schtasks /Create /XML ... /F`. Task Scheduler does NOT
        // restart a running task on re-register; the new XML takes
        // effect at next trigger fire (next login) which is exactly
        // when LogonTrigger matters.
        //
        // The task must already exist (the user installed earlier);
        // if it doesn't, surface that rather than silently creating
        // a half-state.
        if !self.is_installed() {
            return Err(SupervisorError::Command(
                "service isn't installed — nothing to update".into(),
            ));
        }

        // Preserve the current enabled/disabled flag across the rewrite.
        // Without this, toggling the autostart-at-login preference (which
        // routes here via `set_daemon_mode`) would silently re-enable a
        // task the user had explicitly stopped — the new XML's
        // <Enabled> would override `/Change /DISABLE`. is_loaded()
        // returns true iff the task is currently enabled, which is
        // exactly the bit we need to preserve.
        let preserved_enabled = self.is_loaded();

        let user = current_user()?;
        let xml = Self::render_task_xml(cfg, Self::task_mode(mode), &user, preserved_enabled);
        let xml_path =
            std::env::temp_dir().join(format!("psycheros-task-mode-{}.xml", std::process::id()));
        write_utf16_le_with_bom(&xml_path, &xml)?;
        let out = hidden_command("schtasks.exe")
            .args(["/Create", "/XML"])
            .arg(&xml_path)
            .args(["/TN", &self.label, "/F"])
            .output()?;
        let _ = fs::remove_file(&xml_path);
        if !out.status.success() {
            return Err(SupervisorError::Command(format!(
                "schtasks /Create (set_mode_only) failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        Ok(())
    }

    fn is_installed(&self) -> bool {
        // "Installed" = task is registered with Task Scheduler at all.
        // Doesn't care whether the task is enabled or disabled — the
        // user's Stop click leaves it registered-but-disabled, which
        // the state machine wants to surface as `Stopped` (not
        // `NotInstalled`).
        hidden_command("schtasks.exe")
            .args(["/Query", "/TN", &self.label])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }

    fn is_loaded(&self) -> bool {
        // "Loaded" = task is registered AND enabled. The Enabled flag
        // is what `stop_daemon` flips to false; the state machine
        // matrix in `daemon::status::probe` then derives `Stopped`
        // from (installed=true, loaded=false, port=down). Without
        // this enabled-aware signal, a manually-stopped daemon would
        // show as `Installed` (the "booting / crashlooping" surface)
        // instead of `Stopped` ("the user picked stop").
        let Ok(out) = hidden_command("schtasks.exe")
            .args(["/Query", "/TN", &self.label, "/FO", "LIST", "/V"])
            .output()
        else {
            return false;
        };
        if !out.status.success() {
            return false;
        }
        parse_enabled_state(&String::from_utf8_lossy(&out.stdout))
    }

    fn start_daemon(&self) -> Result<(), SupervisorError> {
        if !self.is_installed() {
            return Err(SupervisorError::Command(
                "Cannot start — service isn't installed. Install it first.".into(),
            ));
        }
        // Re-enable the task in case the user previously hit Stop
        // (which flipped Enabled=false). Idempotent: enabling an
        // already-enabled task succeeds with no-op stderr.
        let enable = hidden_command("schtasks.exe")
            .args(["/Change", "/TN", &self.label, "/ENABLE"])
            .output()?;
        if !enable.status.success() {
            return Err(SupervisorError::Command(format!(
                "schtasks /Change /ENABLE failed: {}",
                String::from_utf8_lossy(&enable.stderr)
            )));
        }
        // schtasks /Run is idempotent in the sense that a running
        // task gets a second instance queued — but our XML sets
        // <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
        // so the second invocation no-ops. Net behavior: safe to
        // call when the daemon is already up.
        let out = hidden_command("schtasks.exe")
            .args(["/Run", "/TN", &self.label])
            .output()?;
        if !out.status.success() {
            return Err(SupervisorError::Command(format!(
                "schtasks /Run failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        Ok(())
    }

    fn stop_daemon(&self) -> Result<(), SupervisorError> {
        if !self.is_installed() {
            return Ok(()); // Idempotent — already absent.
        }
        // /End terminates the running instance. /End legitimately
        // returns non-zero when no instance is running (e.g. the
        // task is registered but the daemon has already exited).
        // Swallow that case — the goal here is end-state, not
        // exit-status fidelity.
        let _ = hidden_command("schtasks.exe")
            .args(["/End", "/TN", &self.label])
            .output();
        // Disable so the task doesn't fire again at next logon
        // (autostart mode) and doesn't get respawned by
        // RestartOnFailure. Mirrors the macOS session-scoped
        // `launchctl unload` semantic: registration stays on disk,
        // but the service won't run again until the user explicitly
        // re-enables it via Start.
        let disable = hidden_command("schtasks.exe")
            .args(["/Change", "/TN", &self.label, "/DISABLE"])
            .output()?;
        if !disable.status.success() {
            return Err(SupervisorError::Command(format!(
                "schtasks /Change /DISABLE failed: {}",
                String::from_utf8_lossy(&disable.stderr)
            )));
        }
        Ok(())
    }

    fn restart(&self) -> Result<(), SupervisorError> {
        if !self.is_installed() {
            // Nothing registered to restart — silently succeed so
            // callers don't have to gate on is_installed.
            return Ok(());
        }
        if !self.is_loaded() {
            // Task registered but user-disabled. Restart is "cycle
            // the running daemon while preserving its registration
            // intent" — a disabled task has no daemon to cycle, so
            // we leave the world as-is.
            return Ok(());
        }
        // End-then-Run cycles the task without touching the
        // registration or the Enabled flag. /End may legitimately
        // fail when no instance is running (e.g. the daemon already
        // crashed); swallow that and proceed to /Run.
        let _ = hidden_command("schtasks.exe")
            .args(["/End", "/TN", &self.label])
            .output();
        let out = hidden_command("schtasks.exe")
            .args(["/Run", "/TN", &self.label])
            .output()?;
        if !out.status.success() {
            return Err(SupervisorError::Command(format!(
                "schtasks /Run (during restart) failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        Ok(())
    }

    fn log_paths(&self) -> Vec<PathBuf> {
        let log_dir = paths::log_dir();
        let (stdout, stderr) = Self::log_files(&log_dir);
        vec![stdout, stderr]
    }

    fn label(&self) -> &str {
        &self.label
    }

    fn query_runtime_info(&self) -> RuntimeInfo {
        // schtasks /Query /FO LIST /V dumps a "key: value" block. We
        // pluck `Last Result:` (the daemon's last exit code) — the
        // only field schtasks reliably exposes. PID isn't surfaced
        // at this layer; the manager's diagnostics card renders "—"
        // for it on Windows.
        let Ok(out) = hidden_command("schtasks.exe")
            .args(["/Query", "/TN", &self.label, "/FO", "LIST", "/V"])
            .output()
        else {
            return RuntimeInfo::default();
        };
        if !out.status.success() {
            return RuntimeInfo::default();
        }
        parse_schtasks_query(&String::from_utf8_lossy(&out.stdout))
    }
}

/// Parse `Scheduled Task State:` out of `schtasks /Query /FO LIST /V`.
/// `true` means the task is enabled, `false` means it's been disabled
/// (the user's Stop flow). Tolerant: any parse failure returns
/// `false`, which biases the state machine toward the "user wants
/// this off" reading — safer than falsely reporting the daemon as
/// loaded.
fn parse_enabled_state(text: &str) -> bool {
    for line in text.lines() {
        if let Some(rest) = line.trim_start().strip_prefix("Scheduled Task State:") {
            return rest.trim().eq_ignore_ascii_case("Enabled");
        }
    }
    false
}

/// Parse `schtasks /Query /FO LIST /V` output into [`RuntimeInfo`].
///
/// The format is `Key: spaces Value` lines. `Last Result:` is the
/// post-mortem exit code from the most recent run (`0` for a clean
/// run, `2147750687` (0x800710DF, "process terminated") for a /End,
/// negative-ish hex codes for crashes). We surface it as-is so the
/// diagnostics card can render the raw status — same posture as
/// macOS's `LastExitStatus`.
///
/// Tolerant by design: a parse failure returns the default
/// `RuntimeInfo` rather than erroring, so the diagnostics surface
/// can always render "—" for fields the parser couldn't extract.
fn parse_schtasks_query(text: &str) -> RuntimeInfo {
    let mut info = RuntimeInfo::default();
    for line in text.lines() {
        // schtasks pads the key out to ~34 characters with spaces, so
        // we match the prefix and trim the value.
        if let Some(rest) = line.trim_start().strip_prefix("Last Result:") {
            // schtasks emits this as a signed decimal integer when it
            // fits; otherwise the value is the raw hex like 0x800710DF.
            // We try i32 first, fall back to interpreting an unsigned
            // hex/decimal as a sign-extended i32.
            let value = rest.trim();
            if let Ok(n) = value.parse::<i32>() {
                info.last_exit_status = Some(n);
            } else if let Some(hex) = value
                .strip_prefix("0x")
                .or_else(|| value.strip_prefix("0X"))
            {
                if let Ok(n) = u32::from_str_radix(hex, 16) {
                    info.last_exit_status = Some(n as i32);
                }
            } else if let Ok(n) = value.parse::<u32>() {
                info.last_exit_status = Some(n as i32);
            }
        }
    }
    info
}

/// Resolve the current user as a `DOMAIN\Username` string suitable
/// for the XML's `<UserId>` and `<Principal>` blocks. Falls back to
/// `%USERDOMAIN%\%USERNAME%` env-var composition if `whoami` shells
/// out non-zero — every supported Windows release has whoami.exe but
/// we'd rather degrade gracefully than refuse to install.
///
/// `pub(super)` because the launcher-agent sibling module needs the
/// same lookup; the function has no per-supervisor state so it lives
/// as a free function rather than a method on either supervisor.
pub(super) fn current_user() -> Result<String, SupervisorError> {
    if let Ok(out) = hidden_command("whoami.exe").output() {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let trimmed = stdout.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }
    let domain = std::env::var("USERDOMAIN").unwrap_or_default();
    let user = std::env::var("USERNAME").unwrap_or_default();
    if user.is_empty() {
        return Err(SupervisorError::Command(
            "couldn't resolve current Windows user (whoami failed, USERNAME unset)".into(),
        ));
    }
    if domain.is_empty() {
        Ok(user)
    } else {
        Ok(format!("{domain}\\{user}"))
    }
}

/// Minimal XML element-text/attribute escaping. None of our generated
/// paths or usernames should contain these characters in practice,
/// but a path like `C:\Users\A&B\AppData\...` would otherwise produce
/// malformed XML that schtasks would reject with a generic error.
///
/// `pub(super)` so the launcher-agent sibling module can share it —
/// both modules produce Task Scheduler XML and escape paths the same
/// way.
pub(super) fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Quote an argv token for Task Scheduler's `<Arguments>` element.
/// Windows reconstructs an argv from the Arguments string via
/// `CommandLineToArgvW`: tokens with spaces need to be enclosed in
/// double quotes. We wrap unconditionally — `"foo"` and `foo` parse
/// to the same single-arg result, so over-quoting is harmless.
///
/// Embedded double quotes are stripped. None of our generated paths
/// produce them, and properly escaping them with `\"` opens a quoting
/// rabbit hole the runner side would also need to participate in.
fn quote_argv(s: &str) -> String {
    format!("\"{}\"", s.replace('"', ""))
}

/// Write `text` as UTF-16 LE with BOM. `schtasks /Create /XML`
/// requires this exact encoding — UTF-8 input is rejected with a
/// "malformed XML" error that costs an hour to debug if you've
/// never seen it before.
///
/// `pub(super)` so the launcher-agent module can reuse the encoder
/// for its own task XML.
pub(super) fn write_utf16_le_with_bom(path: &Path, text: &str) -> std::io::Result<()> {
    let mut file = fs::File::create(path)?;
    // BOM. Two bytes, little-endian.
    file.write_all(&[0xFF, 0xFE])?;
    for unit in text.encode_utf16() {
        file.write_all(&unit.to_le_bytes())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_cfg() -> DaemonConfig {
        DaemonConfig {
            label: "Psycheros".to_string(),
            deno_path: PathBuf::from("C:\\Users\\me\\AppData\\Roaming\\Psycheros\\bin\\deno.exe"),
            source_dir: PathBuf::from(
                "C:\\Users\\me\\AppData\\Roaming\\Psycheros\\source\\packages\\psycheros",
            ),
            data_dir: PathBuf::from("C:\\Users\\me\\AppData\\Roaming\\Psycheros\\data"),
            log_dir: PathBuf::from("C:\\Users\\me\\AppData\\Roaming\\Psycheros\\logs"),
            port: 3000,
            entity_core_dir: None,
            entity_core_data_dir: Some(PathBuf::from(
                "C:\\Users\\me\\AppData\\Roaming\\Psycheros\\data\\entity-core",
            )),
        }
    }

    // ─── render_task_xml mode-specific elements ─────────────────────────

    #[test]
    fn autostart_xml_has_logon_trigger_and_restart_on_failure() {
        let xml = TaskSchedulerSupervisor::render_task_xml(
            &fixture_cfg(),
            TaskMode::Autostart,
            "PC\\me",
            true,
        );
        assert!(
            xml.contains("<LogonTrigger>"),
            "autostart XML missing LogonTrigger"
        );
        assert!(
            xml.contains("<RestartOnFailure>"),
            "autostart XML missing RestartOnFailure — daemon wouldn't \
             restart on crash"
        );
        assert!(
            xml.contains("<Count>3</Count>"),
            "RestartOnFailure missing Count=3"
        );
        assert!(
            xml.contains("<Interval>PT1M</Interval>"),
            "RestartOnFailure missing Interval=PT1M (the Task Scheduler \
             schema minimum — PT5S would be rejected at /Create time)"
        );
    }

    #[test]
    fn manual_xml_has_no_logon_trigger_and_no_restart_on_failure() {
        let xml = TaskSchedulerSupervisor::render_task_xml(
            &fixture_cfg(),
            TaskMode::Manual,
            "PC\\me",
            true,
        );
        assert!(
            !xml.contains("<LogonTrigger>"),
            "manual XML should not have LogonTrigger — would auto-start at login"
        );
        assert!(
            !xml.contains("<RestartOnFailure>"),
            "manual XML should not have RestartOnFailure — manual stays \
             stopped after a crash"
        );
        assert!(
            xml.contains("<Triggers>") && xml.contains("</Triggers>"),
            "Triggers block must still be present (just empty) — task \
             schema requires the element"
        );
    }

    // ─── render_task_xml content surface ─────────────────────────────────

    #[test]
    fn xml_points_action_at_runner_binary() {
        let xml = TaskSchedulerSupervisor::render_task_xml(
            &fixture_cfg(),
            TaskMode::Autostart,
            "PC\\me",
            true,
        );
        let runner = paths::bundled_runner_path();
        let runner_str = runner.display().to_string();
        assert!(
            xml.contains(&format!("<Command>{}</Command>", escape_xml(&runner_str))),
            "Command element should point at psycheros-daemon-runner.exe — \
             not at a .cmd wrapper. Got XML: {xml}"
        );
    }

    #[test]
    fn xml_arguments_carry_runner_positional_argv() {
        let cfg = fixture_cfg();
        let xml =
            TaskSchedulerSupervisor::render_task_xml(&cfg, TaskMode::Autostart, "PC\\me", true);
        // The runner's positional argv: deno_path, source_dir,
        // stdout_log, stderr_log, KEY=VALUE pairs. Each token is
        // double-quoted so paths with spaces survive
        // CommandLineToArgvW on the runner side.
        let (stdout, stderr) = TaskSchedulerSupervisor::log_files(&cfg.log_dir);
        let args = TaskSchedulerSupervisor::render_runner_arguments(&cfg);
        // Order matters: runner parses argv positionally.
        let expected_prefix = format!(
            "\"{}\" \"{}\" \"{}\" \"{}\"",
            cfg.deno_path.display(),
            cfg.source_dir.display(),
            stdout.display(),
            stderr.display(),
        );
        assert!(
            args.starts_with(&expected_prefix),
            "runner Arguments should start with deno+source+stdout+stderr positional; got: {args}"
        );
        // Env pairs trail the positional args.
        assert!(args.contains(&format!(
            "\"PSYCHEROS_DATA_DIR={}\"",
            cfg.data_dir.display()
        )));
        assert!(args.contains(&format!("\"PSYCHEROS_PORT={}\"", cfg.port)));
        // The args also need to be embedded in the XML.
        assert!(
            xml.contains(&format!("<Arguments>{}</Arguments>", escape_xml(&args))),
            "<Arguments> block missing or doesn't match render_runner_arguments output"
        );
    }

    #[test]
    fn xml_sets_working_directory_to_source_dir() {
        let cfg = fixture_cfg();
        let xml =
            TaskSchedulerSupervisor::render_task_xml(&cfg, TaskMode::Autostart, "PC\\me", true);
        assert!(
            xml.contains(&format!(
                "<WorkingDirectory>{}</WorkingDirectory>",
                escape_xml(&cfg.source_dir.display().to_string())
            )),
            "WorkingDirectory block missing or malformed"
        );
    }

    #[test]
    fn xml_uses_interactive_user_principal() {
        let xml = TaskSchedulerSupervisor::render_task_xml(
            &fixture_cfg(),
            TaskMode::Autostart,
            "PC\\me",
            true,
        );
        // Interactive user, no admin elevation. The whole point of the
        // user-task posture.
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(xml.contains("<UserId>PC\\me</UserId>"));
    }

    #[test]
    fn xml_label_matches_supervisor_label() {
        let xml = TaskSchedulerSupervisor::render_task_xml(
            &fixture_cfg(),
            TaskMode::Autostart,
            "PC\\me",
            true,
        );
        // URI is what the Task Scheduler UI uses as the canonical
        // identifier; mismatching it would orphan the registration.
        assert!(xml.contains("<URI>\\Psycheros</URI>"));
    }

    #[test]
    fn xml_enabled_flag_round_trips() {
        // The Enabled element controls whether triggers fire / restarts
        // queue. set_mode_only must be able to write Enabled=false to
        // preserve a user's Stop choice across a mode rewrite. A naive
        // hardcoded `<Enabled>true</Enabled>` would silently un-stop the
        // daemon every time the user toggled the autostart-at-login
        // preference.
        let xml_enabled = TaskSchedulerSupervisor::render_task_xml(
            &fixture_cfg(),
            TaskMode::Autostart,
            "PC\\me",
            true,
        );
        assert!(
            xml_enabled.contains("<Enabled>true</Enabled>"),
            "enabled=true should produce <Enabled>true</Enabled>"
        );
        assert!(
            !xml_enabled.contains("<Enabled>false</Enabled>"),
            "enabled=true should not produce <Enabled>false</Enabled> anywhere"
        );

        let xml_disabled = TaskSchedulerSupervisor::render_task_xml(
            &fixture_cfg(),
            TaskMode::Autostart,
            "PC\\me",
            false,
        );
        assert!(
            xml_disabled.contains("<Enabled>false</Enabled>"),
            "enabled=false should produce <Enabled>false</Enabled>"
        );
    }

    #[test]
    fn xml_escapes_special_chars_in_user_id() {
        // Hypothetical username with `&` — the kind of edge case that
        // breaks naive XML generation in the wild.
        let xml = TaskSchedulerSupervisor::render_task_xml(
            &fixture_cfg(),
            TaskMode::Autostart,
            "PC\\A&B",
            true,
        );
        assert!(xml.contains("<UserId>PC\\A&amp;B</UserId>"));
        assert!(
            !xml.contains("<UserId>PC\\A&B</UserId>"),
            "raw ampersand leaked into XML — schtasks would reject the file"
        );
    }

    // ─── render_runner_arguments ─────────────────────────────────────────

    #[test]
    fn runner_arguments_include_log_paths_in_positional_slots() {
        let cfg = fixture_cfg();
        let args = TaskSchedulerSupervisor::render_runner_arguments(&cfg);
        let (stdout, stderr) = TaskSchedulerSupervisor::log_files(&cfg.log_dir);
        // Positions 3 and 4 (0-indexed) carry the log file paths.
        // Both quoted, both pointing at the daemon.*.log filenames the
        // log_tailer expects.
        assert!(args.contains(&format!("\"{}\"", stdout.display())));
        assert!(args.contains(&format!("\"{}\"", stderr.display())));
    }

    #[test]
    fn runner_arguments_carry_env_pairs() {
        let cfg = fixture_cfg();
        let args = TaskSchedulerSupervisor::render_runner_arguments(&cfg);
        // KEY=VALUE pairs trail the positional args. The runner splits
        // each on the first `=` to populate deno's environment.
        assert!(args.contains(&format!(
            "\"PSYCHEROS_DATA_DIR={}\"",
            cfg.data_dir.display()
        )));
        assert!(args.contains(&format!("\"PSYCHEROS_PORT={}\"", cfg.port)));
        assert!(args.contains("PSYCHEROS_ENTITY_CORE_DATA_DIR"));
    }

    #[test]
    fn quote_argv_double_quotes_tokens() {
        // CommandLineToArgvW splits on whitespace; double-quotes
        // preserve the enclosed run as a single argv element. Spaces in
        // paths are the typical case we need this for.
        assert_eq!(
            quote_argv("C:\\Users\\Jane Doe\\AppData\\foo.exe"),
            "\"C:\\Users\\Jane Doe\\AppData\\foo.exe\""
        );
    }

    #[test]
    fn quote_argv_strips_embedded_quotes() {
        // No path of ours produces an embedded `"`; if one slips in via
        // hostile input, strip rather than try to escape (which would
        // require the runner to participate in the same quoting
        // convention).
        assert_eq!(quote_argv("a\"b"), "\"ab\"");
    }

    // ─── escape_xml ──────────────────────────────────────────────────────

    #[test]
    fn escape_xml_handles_all_five_xml_chars() {
        assert_eq!(escape_xml("a&b"), "a&amp;b");
        assert_eq!(escape_xml("a<b"), "a&lt;b");
        assert_eq!(escape_xml("a>b"), "a&gt;b");
        assert_eq!(escape_xml("a\"b"), "a&quot;b");
        assert_eq!(escape_xml("a'b"), "a&apos;b");
        // Ampersand must be escaped FIRST — otherwise re-escape would
        // double-encode (& → &amp; → &amp;amp;). Verify order via a
        // string that would tickle a bad implementation.
        assert_eq!(escape_xml("&lt;"), "&amp;lt;");
    }

    // ─── write_utf16_le_with_bom ────────────────────────────────────────

    #[test]
    fn writes_utf16_le_with_bom() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.xml");
        write_utf16_le_with_bom(&path, "AB").unwrap();
        let bytes = fs::read(&path).unwrap();
        // BOM (0xFF 0xFE) + "A" (0x41 0x00) + "B" (0x42 0x00).
        assert_eq!(bytes, vec![0xFF, 0xFE, 0x41, 0x00, 0x42, 0x00]);
    }

    #[test]
    fn writes_utf16_le_with_bom_handles_non_ascii() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.xml");
        // U+00E9 (é) is a single UTF-16 unit; U+1F600 (😀) is a
        // surrogate pair. Both should encode correctly.
        write_utf16_le_with_bom(&path, "é").unwrap();
        let bytes = fs::read(&path).unwrap();
        // BOM + é (U+00E9 → 0xE9 0x00 LE)
        assert_eq!(bytes, vec![0xFF, 0xFE, 0xE9, 0x00]);
    }

    // ─── parse_schtasks_query ───────────────────────────────────────────

    // ─── parse_enabled_state ────────────────────────────────────────────

    #[test]
    fn parse_enabled_state_recognizes_enabled() {
        let canned = "HostName:                             PC\r\n\
                      TaskName:                             \\Psycheros\r\n\
                      Scheduled Task State:                 Enabled\r\n\
                      Status:                               Ready\r\n";
        assert!(parse_enabled_state(canned));
    }

    #[test]
    fn parse_enabled_state_recognizes_disabled() {
        let canned = "Scheduled Task State:                 Disabled\r\n";
        assert!(!parse_enabled_state(canned));
    }

    #[test]
    fn parse_enabled_state_is_case_insensitive() {
        // Localized Windows might render "enabled" or "ENABLED" — be
        // tolerant of casing. (The field name itself is English in
        // both /FO LIST output and the schema, so we don't worry
        // about localizing the key.)
        let canned = "Scheduled Task State:                 enabled\r\n";
        assert!(parse_enabled_state(canned));
    }

    #[test]
    fn parse_enabled_state_returns_false_on_empty_input() {
        // Failure mode bias: "no info" → "treat as disabled" so the
        // state machine surfaces Stopped rather than falsely showing
        // Running.
        assert!(!parse_enabled_state(""));
    }

    #[test]
    fn parse_enabled_state_ignores_unrelated_lines() {
        let canned = "HostName:                             PC\r\n\
                      Status:                               Disabled\r\n\
                      Author:                               Psycheros\r\n";
        // Status field happens to match the value we look for, but
        // the key is different — must not be picked up.
        assert!(!parse_enabled_state(canned));
    }

    #[test]
    fn parse_schtasks_query_extracts_last_result_decimal() {
        let canned = "HostName:                             PC\r\n\
                      TaskName:                             \\Psycheros\r\n\
                      Status:                               Ready\r\n\
                      Last Result:                          0\r\n\
                      Author:                               Psycheros\r\n";
        let info = parse_schtasks_query(canned);
        assert_eq!(info.last_exit_status, Some(0));
        assert!(
            info.pid.is_none(),
            "schtasks /Query doesn't expose PID — must stay None"
        );
    }

    #[test]
    fn parse_schtasks_query_extracts_last_result_hex() {
        // schtasks sometimes emits the exit code as hex when the value
        // doesn't fit i32 cleanly (e.g. 0x800710DF for /End-induced
        // termination).
        let canned = "Last Result:                          0x800710DF\r\n";
        let info = parse_schtasks_query(canned);
        // 0x800710DF as i32 is -2147225377 (sign-extended). The exact
        // value matters less than "this didn't silently drop to None."
        assert!(info.last_exit_status.is_some());
        assert_eq!(info.last_exit_status, Some(0x800710DFu32 as i32));
    }

    #[test]
    fn parse_schtasks_query_returns_default_on_empty_input() {
        let info = parse_schtasks_query("");
        assert!(info.last_exit_status.is_none());
    }

    #[test]
    fn parse_schtasks_query_ignores_unknown_fields() {
        // Real schtasks output has dozens of fields. We only care about
        // Last Result; everything else must be silently skipped.
        let canned = "HostName:                             PC\r\n\
                      Folder:                               \\\r\n\
                      TaskName:                             \\Psycheros\r\n\
                      Next Run Time:                        N/A\r\n\
                      Logon Mode:                           Interactive only\r\n\
                      Last Result:                          5\r\n\
                      Author:                               Psycheros\r\n\
                      Task To Run:                          C:\\Users\\me\\...\r\n";
        let info = parse_schtasks_query(canned);
        assert_eq!(info.last_exit_status, Some(5));
    }
}
