# Psycheros launcher

Desktop app that installs and supervises Psycheros as a persistent background
service on macOS and Windows — then gives you a single window onto the chat UI
when you want to talk to your entity.

> **macOS and Windows ship.** The launcher publishes stable evergreen downloads
> that always point to the latest release:
>
> - **macOS:**
>   [`Psycheros-macOS-latest.dmg`](https://github.com/PsycherosAI/Psycheros/releases/latest/download/Psycheros-macOS-latest.dmg)
> - **Windows:**
>   [`Psycheros-Windows-latest.msi`](https://github.com/PsycherosAI/Psycheros/releases/latest/download/Psycheros-Windows-latest.msi)
>
> Linux (systemd-user) remains deferred. See
> [`docs/architecture.md`](docs/architecture.md) for the current platform
> matrix.

## What it does

- **Installs Psycheros as an OS service.** Click "Install autostart" → the app
  writes a launchd plist / systemd unit / scheduled task, registers it, and
  starts the daemon. From then on Psycheros runs at every login and is
  auto-restarted by the OS if it crashes.
- **Embeds the chat UI.** Once the daemon is up, the launcher's window navigates
  to the live Psycheros chat at `localhost:3000`. No browser tab; no separate
  window. Closing the launcher doesn't stop the daemon.
- **Acts as the admin panel.** Press <kbd>⌘,</kbd> any time to toggle to the
  manager surface: status, install/uninstall autostart, view logs, run pending
  migrations, force-sync identity, etc.
- **Auto-fallback when the daemon dies.** Daemon crashes mid-chat? The launcher
  window flips back to the manager with diagnostics. The OS supervisor restarts
  the daemon a moment later; the launcher flips back to chat automatically when
  the port comes up again.

## Why a launcher at all?

Psycheros is a **persistent entity** — it should run continuously in the
background regardless of whether you're actively chatting. The v1 launcher was a
browser-tab dashboard that started a daemon as a child process, meaning closing
the dashboard killed the entity. The v2 launcher flips that model: the OS
supervises the daemon, and the launcher is just a window onto the running
service.

You can still run Psycheros via Docker or `deno task start` directly — the
launcher is one convenience surface, not the only one. The launcher detects a
daemon already running on `:3000` and connects to it instead of trying to
install over the top.

## Installing (end users)

Download the latest release for your platform:

- **macOS:** download
  [`Psycheros-macOS-latest.dmg`](https://github.com/PsycherosAI/Psycheros/releases/latest/download/Psycheros-macOS-latest.dmg),
  drag to `/Applications/`. **See "First launch on macOS" below before opening
  it** — Psycheros is not code-signed and Gatekeeper will block a normal
  double-click.
- **Windows:** download
  [`Psycheros-Windows-latest.msi`](https://github.com/PsycherosAI/Psycheros/releases/latest/download/Psycheros-Windows-latest.msi),
  run, click through SmartScreen's "More info → Run anyway." Psycheros is not
  signed for Authenticode; the warning is expected.

### First launch on macOS

Psycheros ships **unsigned**. macOS Gatekeeper blocks downloaded apps unless
they've been signed and notarized by Apple, which costs $99/year — a cost I'm
not passing on to users. The workaround is one extra step on the very first
launch, and only the first launch.

**Easy path (right-click):**

1. After dragging `Psycheros.app` into `/Applications/`, **right-click** (or
   `Control`-click) the app icon.
2. Choose **Open** from the context menu.
3. macOS shows a dialog: _"Psycheros" can't be opened because Apple cannot check
   it for malicious software._ Click **Open** anyway.
4. The app launches. macOS remembers your approval — every subsequent launch is
   a normal double-click.

> If you only see **Move to Trash** and no Open option in step 3, your Mac is on
> the strictest Gatekeeper setting. Either lower it under **System Settings →
> Privacy & Security → Security**, or use the terminal path below.

**Terminal path (one command):**

```bash
xattr -dr com.apple.quarantine /Applications/Psycheros.app
```

This strips the `com.apple.quarantine` attribute macOS attaches to downloaded
files. After running it, Psycheros opens with a normal double-click and the
Gatekeeper dialog never appears. Equivalent to the right-click path; pick
whichever you prefer.

**Why this is expected, not broken:** I haven't paid Apple's Developer ID fee
for v1. The first launch — and only the first — needs the manual confirmation
above. If you'd rather trust an automated installer pipeline more than a single
right-click, this app isn't for you yet; revisit when a signed v2 ships (if it
ever does — see [`docs/release.md`](docs/release.md) for the signing posture).

### Coming from launcher-v1?

If you've been running the v1 launcher (a `~/psycheros` clone with state in
`packages/psycheros/.psycheros/`, `identity/`, etc.) and you want to bring your
existing entity over, **export from v1 BEFORE installing v2**:

1. In v1's chat UI, **Settings → Admin → Entity Data → Export** — save the
   `.zip`.
2. Install v2 per the steps above (including the Gatekeeper right-click).
3. Complete v2's welcome wizard and click "Install autostart" — a fresh empty
   entity comes up.
4. In v2's chat UI, **Settings → Admin → Entity Data → Import** — select the
   `.zip` from step 1. The daemon restarts and your migrated entity takes over.

Full procedure + caveats in [`docs/migration.md`](docs/migration.md).

## Troubleshooting

The launcher carries its own support surface inside the app:

- **Manager footer → Diagnostics** — versions, paths, daemon state, log tail.
  Most issues are diagnosable from this card alone. Use the `Reveal` buttons
  next to paths to open them in Finder when you need to inspect files directly.
- **Manager footer → Data** — back up, restore, wipe, re-init. Routine recovery
  operations live here.
- **`docs/runbook.md`** — symptom → recovery mapping. Covers the common failure
  modes (port held by another process, MCP down, bootstrap fails with "git not
  found", etc.) with the exact buttons to click.

If the launcher itself won't start, check the Console.app system log for
`ai.psycheros.launcher` entries.

## Contributing

Dev setup, build commands, and agent context live in
[`CONTRIBUTING.md`](CONTRIBUTING.md). The load-bearing wirings + traps that bite
are in [`CLAUDE.md`](CLAUDE.md).

## Documentation

User-facing:

- [docs/runbook.md](docs/runbook.md) — symptom → recovery

Architecture + internals:

- [docs/architecture.md](docs/architecture.md)
- [docs/supervisors.md](docs/supervisors.md)
- [docs/source-provisioning.md](docs/source-provisioning.md)
- [docs/frontend.md](docs/frontend.md)
- [docs/release.md](docs/release.md)
- [docs/migration.md](docs/migration.md)
- [docs/v1-roadmap.md](docs/v1-roadmap.md) — historical context for the body of
  work that brought the launcher to its current state.
