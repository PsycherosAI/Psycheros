//! Subprocess helpers — `CREATE_NO_WINDOW` insulation.
//!
//! In release builds the launcher is `windows_subsystem = "windows"`,
//! which means the process starts with **no console attached**. Any
//! subprocess spawned via `std::process::Command` that needs a console
//! (which on Windows is most CLI tools — `schtasks`, `git`, `netstat`,
//! `tasklist`, `whoami`, `deno`, etc.) **allocates a new console
//! window** because there's no parent console to inherit. The window
//! flashes for a few hundred milliseconds while the child runs, then
//! vanishes when it exits.
//!
//! The daemon-status watcher polls `schtasks /Query` every two seconds
//! → two console flashes every two seconds, indefinitely. The first
//! production install we tried turned this into a non-stop flicker of
//! ghost cmd windows.
//!
//! The fix is to spawn with the `CREATE_NO_WINDOW` creation flag
//! (`0x08000000`), which tells `CreateProcess` to not allocate a
//! console for the child. The child still gets stdout/stderr handles
//! (we read them when capturing output); it just doesn't get a
//! window.
//!
//! On non-Windows platforms the helper is a thin pass-through —
//! console flicker isn't a thing on macOS/Linux, but routing every
//! spawn through one helper keeps the call sites uniform across
//! platforms and makes it trivially obvious in code review that a
//! subprocess won't pop a window.
//!
//! ## When NOT to use this
//!
//! `open_path` (the "Reveal in Finder / Explorer" affordance) spawns
//! `explorer.exe <path>` and the user **wants** that window. Don't
//! route it through this helper.
//!
//! ## What about the daemon runner?
//!
//! `src/bin/psycheros-daemon-runner.rs` applies `CREATE_NO_WINDOW`
//! itself when spawning deno — that path doesn't go through this
//! helper because the runner is a separate binary that doesn't
//! import the launcher's modules. The flag value is the same in
//! both places; the constant is duplicated there rather than shared
//! to keep the runner self-contained.

use std::ffi::OsStr;
use std::process::Command;

/// `CREATE_NO_WINDOW` from `WinBase.h`. Duplicated here rather than
/// pulled from `windows-sys` so the helper has no extra deps and
/// compiles identically on non-Windows targets (the constant is
/// unused there).
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Return a `std::process::Command` for `program` with the Windows
/// `CREATE_NO_WINDOW` flag applied. On non-Windows this is identical
/// to `Command::new(program)` — the helper exists so call sites are
/// platform-uniform.
///
/// Use this for every subprocess the launcher spawns, with the
/// explicit exception of "open this path in the user's file
/// manager" (the user *wants* that window).
pub fn hidden_command<S: AsRef<OsStr>>(program: S) -> Command {
    #[cfg(target_os = "windows")]
    let mut cmd = Command::new(program);
    #[cfg(not(target_os = "windows"))]
    let cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
