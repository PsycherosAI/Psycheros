# Service supervisors

Per-OS implementations of
[`ServiceSupervisor`](../src-tauri/src/supervisor/mod.rs). All three platforms
implement the same trait surface; the launcher's UI and command handlers never
branch on OS.

## The trait

```rust
trait ServiceSupervisor: Send + Sync {
    // Registration — dual-mode (autostart vs manual). Both immediately
    // start the daemon as a side effect.
    fn install_autostart(&self, cfg: &DaemonConfig) -> Result<(), SupervisorError>;
    fn install_manual(&self, cfg: &DaemonConfig) -> Result<(), SupervisorError>;
    fn uninstall(&self) -> Result<(), SupervisorError>;

    // State queries.
    fn is_installed(&self) -> bool;   // service definition on disk
    fn is_loaded(&self) -> bool;      // record active in the OS supervisor

    // Lifecycle.
    fn start_daemon(&self) -> Result<(), SupervisorError>;
    fn stop_daemon(&self) -> Result<(), SupervisorError>;
    fn restart(&self) -> Result<(), SupervisorError>;

    // Reporting surface.
    fn log_paths(&self) -> Vec<PathBuf>;
    fn label(&self) -> &str;
    fn query_runtime_info(&self) -> RuntimeInfo { RuntimeInfo::default() }
}
```

Every method is **idempotent**: calling `install_*` when already installed must
succeed (overwriting the plist/unit); `uninstall` when not installed must
succeed; `start_daemon`/`stop_daemon` are no-ops in the already-target state.
This makes the manager UI robust against inconsistent on-disk state (e.g. plist
exists but isn't loaded after a crashloop unload).

The autostart-vs-manual split affects only what gets written to the service
definition. After install, both modes accept the same `start_daemon` /
`stop_daemon` / `restart` calls — the manager's Start and Stop buttons work
identically in either mode. The semantic difference shows up at **login time**
(autostart re-launches; manual stays off) and after a crash (autostart restarts
via `KeepAlive`; manual does not).

`query_runtime_info` is the only method with a default impl — it returns the
supervisor's best-effort PID + last-exit-status, and the trait defaults to "no
info" so platforms whose supervisors can't expose those cheaply don't have to
implement it.

## macOS — launchd (full impl)

[`supervisor/launchd.rs`](../src-tauri/src/supervisor/launchd.rs)

- **Where:** `~/Library/LaunchAgents/ai.psycheros.daemon.plist`
- **Domain:** user agent (loads at user login, not boot)
- **Privilege:** none required, ever (no sudo, no auth prompt)
- **Autostart mode:** `RunAtLoad=true` + `KeepAlive=true` — launches at login
  and revives on crash.
- **Manual mode:** `RunAtLoad=false`, `KeepAlive` omitted — only runs when the
  user explicitly hits Start; stays off across login/logout cycles until they
  hit Start again.
- **Logs:** flat files at `StandardOutPath` / `StandardErrorPath` —
  `<data_dir>/logs/daemon.stdout.log` and `daemon.stderr.log`
- **Status check:** `launchctl list <label>` exit code (0 = loaded, 113 = not
  loaded). The stdout text format varies across macOS versions; the exit code is
  stable.

### Plist contract

The launcher hand-rolls the plist XML (no plist crate dep) because the surface
is small and the format is stable. EnvironmentVariables block sets
`PSYCHEROS_DATA_DIR`, `PSYCHEROS_PORT`, `PSYCHEROS_ENTITY_CORE_PATH`,
`PSYCHEROS_ENTITY_CORE_DATA_DIR`, `PSYCHEROS_MCP_COMMAND`, plus `HOME` and
`PATH`. `PSYCHEROS_MCP_COMMAND` is set to the resolved Deno binary path so that
entity-core (spawned by the daemon via MCP stdio transport) uses the same Deno
as the daemon itself rather than relying on PATH resolution.

### Stop semantics

`launchctl stop <label>` is a no-op against `KeepAlive=true` (autostart-mode)
daemons — launchd revives the process within ~2 seconds. The supervisor's
`stop_daemon` therefore uses session-scoped `launchctl unload` (no `-w`), which
detaches the service for the current login session without flipping the
persistent enable state. The autostart-mode daemon comes back at next login; the
manual-mode daemon stays off because nothing tells launchd to re-load it. From
the user's perspective both surfaces share one Stop button with mode-aware copy
explaining what "Stop" means right now.

`uninstall` uses `launchctl unload -w` to flip the persistent enable state off
and remove the plist file in one go.

## Linux — systemd user unit (stub)

[`supervisor/systemd.rs`](../src-tauri/src/supervisor/systemd.rs)

- **Where:** `~/.config/systemd/user/psycheros.service`
- **Privilege:** user-level; one-time `sudo loginctl enable-linger $USER` for
  the daemon to survive logout (see below)
- **Restart on crash:** `Restart=on-failure` with `RestartSec=2`
- **Start at login:** `WantedBy=default.target` + `systemctl --user enable`
- **Logs:** systemd journal — `journalctl --user -u psycheros.service`
- **Status check:** `systemctl --user is-enabled psycheros.service` exit 0 =
  enabled

### Implementation notes for the next implementer

1. Write the unit file to `~/.config/systemd/user/`.
2. Run `systemctl --user daemon-reload` after each write so systemd picks up the
   new file.
3. `systemctl --user enable --now psycheros.service` to register and start in
   one step.
4. `is_loaded()`: shell out to
   `systemctl --user is-enabled
   psycheros.service`; parse exit code.
5. `uninstall()`: `systemctl --user disable --now psycheros.service` then `rm`
   the unit file + another `daemon-reload`.

### Logs aren't files

Unlike launchd, systemd captures stdout/stderr into the journal, not flat files.
The manager's "View logs" affordance on Linux must shell out to
`journalctl --user -u psycheros.service --since "1 hour ago"` rather than
tailing files. `log_paths()` returns an empty vec on Linux; the manager checks
for that and renders a journalctl-based view instead.

### The lingering caveat

By default, systemd user services stop when the user's last login session ends —
i.e., the daemon dies when the user logs out. That violates the "persistent
entity" model.

The fix is `loginctl enable-linger $USER`, which keeps user services alive
across sessions. This is the **only** sudo step in the entire Linux launcher
flow. Two design choices:

- **Document it (current plan).** First-run wizard tells the user to paste a
  one-liner into a terminal. Single command, clear purpose, no app-managed
  escalation. The downside is users have to do it manually.
- **Fall back to `~/.config/autostart/<file>.desktop`** when linger isn't
  available — gives "starts at login" but loses crash-restart (XDG autostart
  fires once and doesn't supervise).

We default to documenting linger. The autostart-desktop fallback is worth
considering for users who refuse the sudo prompt, but it's secondary.

## Windows — Task Scheduler (full impl)

[`supervisor/task_scheduler.rs`](../src-tauri/src/supervisor/task_scheduler.rs)

- **Where:** Task Scheduler library root — task name `Psycheros`
- **Domain:** user task (interactive logon token, no admin needed)
- **Privilege:** none required, ever (no UAC, no auth prompt)
- **Autostart mode:** `<LogonTrigger>` for the current user +
  `<RestartOnFailure Count=3 Interval=PT1M/>` — fires at every logon and retries
  the action up to three times on non-zero exit. `PT1M` is the Task Scheduler
  schema's minimum interval; shorter values are rejected at `/Create` time.
- **Manual mode:** empty `<Triggers/>` block and no `<RestartOnFailure>` — only
  runs when the user explicitly hits Start; stays off across login / logout
  cycles until they hit Start again.
- **Logs:** flat files at `<data_dir>/logs/daemon.stdout.log` and
  `daemon.stderr.log` — opened by the `psycheros-daemon-runner` sidecar (see
  "Runner sidecar" below) and inherited by the deno child as its stdout/stderr
  handles.
- **Status check:** `schtasks /Query /TN Psycheros` exit 0 = registered.
  `schtasks /Query /TN Psycheros /FO LIST /V` exposes
  `Scheduled Task
  State: Enabled|Disabled`, which the supervisor uses to
  distinguish the user's Stop click (Disabled) from a transient mid-boot state
  (Enabled but port not yet bound).

### Task XML contract

The launcher hand-rolls the task XML (no `windows-rs` Task Scheduler COM dep)
because the surface is small and the schema is stable across Windows 8.1+. The
XML is written as **UTF-16 LE with BOM** to a tempfile, then
`schtasks /Create /XML <tmp> /TN Psycheros /F` registers it. UTF-8 is rejected
by `schtasks /XML` with a generic "malformed XML" error that's easy to lose an
hour to.

The XML sets `<MultipleInstancesPolicy>IgnoreNew</...>` so a second `/Run` while
the daemon is already up is a safe no-op, `<ExecutionTimeLimit>PT0S</...>` so
the daemon runs indefinitely (default Task Scheduler limit is 72 hours), and
`<LogonType>InteractiveToken</...>` + `<RunLevel>LeastPrivilege</...>` so the
task runs as the current desktop user with no elevation.

### Stop semantics

Task Scheduler doesn't have a launchd-style "loaded vs unloaded" axis — a task
is either registered or not. To get the same Stopped-vs-Installed state machine
the macOS impl exposes, `stop_daemon` does `schtasks /End` (terminate the
running instance) followed by `schtasks /Change /DISABLE` (flip the persistent
enabled flag off). `is_loaded` parses `Scheduled Task State:` from the LIST
query so a disabled task surfaces as `Stopped`, not `Installed`. `start_daemon`
re-enables and runs. The Stop flow is therefore **persistent across logins** —
manually stopping the daemon keeps it off until the user hits Start. (Mode
semantics still differ: autostart's `<LogonTrigger>` re-enables the implicit
run-at-logon flow once Start is clicked.)

`uninstall` does `schtasks /End` + `schtasks /Delete /F` — task gone, no orphan
instances.

### Runner sidecar (job-object cascade kill + stream redirection)

Task Scheduler's `<Exec>` action has two limitations we have to work around:

1. **No native stdio redirection** — the executable is invoked with no shell, so
   `1>> file` syntax doesn't apply.
2. **No process-tree cascade on terminate** — when `schtasks /End` kills the
   action's root process, child processes survive as orphans, including the deno
   process actually holding the port. An early `.cmd` wrapper implementation
   exhibited this: Stop would appear to succeed (cmd.exe died) but the deno
   child kept running, so the port stayed bound and the manager's state machine
   couldn't reach `Stopped`.

Both problems are solved by a small Windows-only Rust sidecar binary,
`psycheros-daemon-runner` (`src-tauri/src/bin/psycheros-daemon-runner.rs`):

- `#![windows_subsystem = "windows"]` — no console window flashes up when the
  task fires.
- Creates a Win32 Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then
  `AssignProcessToJobObject(self)`. Children spawned after this inherit job
  membership.
- Spawns deno via `std::process::Command` with `CREATE_NO_WINDOW`, passes
  opened-in-append `daemon.stdout.log` / `daemon.stderr.log` file handles as the
  child's stdout/stderr.
- Waits for deno. If `schtasks /End` calls `TerminateProcess(runner)` during the
  wait, the runner's handle on the job closes (it was the only holder); the
  kernel then walks the job and terminates deno. Stop is reliable, the port
  frees, and the manager's state machine transitions cleanly.

The runner takes its inputs positionally on argv so the supervisor can build the
command-line at install time without a quoting layer beyond the standard
`CommandLineToArgvW` rules. Argv layout:

```text
psycheros-daemon-runner.exe <deno_path> <source_dir> <stdout_log> <stderr_log> [KEY=VALUE ...]
```

The supervisor's `render_task_xml` emits this as the task's `<Arguments>`
element, with each token double-quoted.

The runner ships as a Tauri `externalBin` sidecar on Windows
(`tauri.windows.conf.json`); `setup.ps1` builds it via
`cargo build --release --bin psycheros-daemon-runner` and stages it at
`src-tauri/binaries/psycheros-daemon-runner-x86_64-pc-windows-msvc.exe`.
First-run setup copies it into
`<launcher_data_dir>/bin/psycheros-daemon-runner.exe` so the task XML references
a path that survives launcher auto-update — same staging pattern as the bundled
Deno.

The launcher's log_tailer module + manager's live log panel tail
`daemon.stderr.log` exactly the same way as on macOS — the filenames are
deliberately identical across platforms.

### Launcher autostart agent

Mirrors the macOS
[`launcher_agent`](../src-tauri/src/supervisor/launcher_agent.rs) posture: a
second task `Psycheros-Launcher` is registered alongside the daemon's
`Psycheros` task on install. The launcher task fires at user logon, invokes
`<install_path>\Psycheros.exe --no-window` (under a `cmd.exe /c "..."` wrapper
so stdout/stderr land in `launcher.stdout.log` / `launcher.stderr.log`), and
deliberately omits `<RestartOnFailure>` — Quit Launcher from the tray should
stick.

Dev builds skip the launcher-agent install: the agent's
`resolve_launcher_binary()` recognizes installed paths (`Program Files`,
`AppData\Local\Psycheros`) and refuses anything under `target\debug\` /
`target\release\` so a dev session doesn't pin a stale binary into the user's
Task Scheduler library across rebuilds.

### Weaker supervision than launchd / systemd

Task Scheduler's restart-on-failure is genuinely less robust:

- No equivalent to launchd's crash-loop throttling. After
  `<RestartOnFailure Count=3>` retries Task Scheduler gives up silently; the
  manager card surfaces `Installed` (registered but no port).
- "Failure" is defined narrowly (non-zero exit code). A process that hangs
  without exiting is not considered failed.

The manager surface should poll daemon status more aggressively on Windows (~1s
vs 2s) and surface "daemon stopped" states with manual- restart affordances more
prominently. (Not yet implemented — the 2s shared poll covers both platforms
today.)

### SmartScreen

Unsigned `.exe` and `.msi` files trigger SmartScreen warnings on first run.
Documented workaround: right-click → Properties → Unblock, then "More info → Run
anyway." Same posture as macOS Gatekeeper. See [`release.md`](release.md).

## Cross-platform integration testing

Once Linux and Windows impls land, the integration test surface should exercise
the trait contract for each:

- Install when not installed → loaded, daemon running within timeout
- Install when already installed → idempotent (no error, still loaded)
- Uninstall when installed → unloaded, no orphan processes
- Uninstall when not installed → idempotent (no error)
- `is_loaded` matches install/uninstall state
- `log_paths()` returns sensible values (files on macOS/Windows, empty on Linux
  where journalctl is used)

Per-OS specifics (plist content, unit file format, task settings) are tested via
golden-file comparisons of the rendered output, not via running the real
supervisor.
