---
title: "Launcher — User Guide"
---

The Psycheros launcher is a desktop app that installs your entity as a
persistent background service and gives you a single window to chat with it.
Your entity runs continuously — closing the launcher doesn't stop it.

If you've never run Psycheros before, start here.

## Installing

### macOS

1. Download
   [`Psycheros-macOS-latest.dmg`](https://github.com/PsycherosAI/Psycheros/releases/latest/download/Psycheros-macOS-latest.dmg).
2. Drag `Psycheros.app` to `/Applications/`.
3. **Right-click** (or `Control`-click) the app and choose **Open** from the
   context menu. This is required on the first launch only — Psycheros is not
   code-signed and macOS Gatekeeper blocks a normal double-click.
4. macOS shows a dialog: _"Psycheros" can't be opened because Apple cannot check
   it for malicious software._ Click **Open** anyway.
5. The app launches. Every subsequent launch is a normal double-click.

If you only see **Move to Trash** and no Open option, your Mac is on the
strictest Gatekeeper setting. Lower it under **System Settings → Privacy &
Security → Security**, or run this in Terminal once:

```bash
xattr -dr com.apple.quarantine /Applications/Psycheros.app
```

**Why this is expected:** Psycheros hasn't paid Apple's Developer ID signing
fee. The extra step is only needed once. After that, macOS remembers your
approval.

### Windows

1. Download
   [`Psycheros-Windows-latest.msi`](https://github.com/PsycherosAI/Psycheros/releases/latest/download/Psycheros-Windows-latest.msi).
2. Run it. Windows SmartScreen may show "Windows protected your PC" — click
   **More info** → **Run anyway**. This is expected for unsigned installers.
3. The launcher installs and opens.

## First run

The launcher walks you through setup:

1. **Your name** — what the entity calls you.
2. **Entity name** — what the entity is called.
3. **Timezone** — used for daily memory consolidation and scheduling.
4. **LLM API key** — any OpenAI-compatible key (Z.ai, OpenRouter, OpenAI, etc.).

Once configured, click **Install autostart**. The launcher writes an OS service
definition (launchd on macOS, Scheduled Task on Windows) and starts the daemon.
From then on, your entity runs at every login and is auto-restarted by the OS if
it crashes.

## The launcher window

The launcher has two surfaces:

- **Chat** — the main view. The entity's web UI rendered inside the launcher
  window. Same interface you'd see at `http://localhost:3000` in a browser.
- **Manager** — press <kbd>⌘,</kbd> (macOS) or <kbd>Ctrl+,</kbd> (Windows) to
  toggle. Shows daemon status, install/uninstall autostart, logs, version info,
  and recovery tools.

You don't need to keep the launcher open. The entity runs as a background
service regardless. The launcher is just a window onto it.

## Coming from the v1 launcher

If you were running the v1 launcher (a browser dashboard at `localhost:3001`)
and want to bring your existing entity over:

1. **Export from v1 first.** In v1's chat UI, go to **Settings → Admin → Entity
   Data → Export** and save the `.zip`.
2. Install the v2 launcher (steps above).
3. Complete v2's welcome wizard and click **Install autostart** — a fresh empty
   entity comes up.
4. In v2's chat UI, go to **Settings → Admin → Entity Data → Import** and select
   the `.zip` from step 1. The daemon restarts and your migrated entity takes
   over.

## Updating

The launcher checks GitHub Releases every 3 hours for newer versions. When an
update is available, a toast notification appears inside the launcher window.

To check manually, open the manager (<kbd>⌘,</kbd>) and look at the version info
card. Click any version chip to open that package's release page on GitHub.

## Troubleshooting

**The launcher won't open on macOS.** Make sure you right-clicked → Open on the
first launch. If Gatekeeper still blocks it, open Terminal and run:
`xattr -dr com.apple.quarantine /Applications/Psycheros.app`

**"Port 3000 already in use."** Another instance of Psycheros is running. The
launcher detects this and connects to the existing daemon — just use the chat
window.

**The entity isn't responding.** Open the manager (<kbd>⌘,</kbd>) and check the
status card. If the daemon shows as Stopped, click **Start daemon**. If it shows
as Running but chat isn't loading, check the log tail at the bottom of the
manager for errors.

**First run is slow.** Deno downloads its dependencies on first launch. This
only happens once.

**Entity Loom (import wizard).** To import chat histories from other platforms,
open the Psycheros chat UI and go to **Settings → Admin → Entity Loom**. See the
[Entity Loom user guide](/Psycheros/entity-loom/user-guide/) for details.

## When not to use the launcher

The launcher is the recommended path for desktop users. If you're deploying
Psycheros to a server, running it in Docker, or embedding it in your own
infrastructure, the
[Docker image](https://github.com/PsycherosAI/Psycheros/pkgs/container/psycheros)
or building from source is a better fit. See the repo
[README](https://github.com/PsycherosAI/Psycheros#docker) for those paths.

## The legacy v1 launcher

The v1 launcher was a browser-tab dashboard at `http://localhost:3001` with
Install / Update / Start / Stop buttons. It ran Psycheros as a child process,
meaning closing the dashboard killed the entity. The v2 launcher replaces it
with an OS-supervised service model.

The v1 installer scripts (`install.sh` / `install.ps1`) are still available on
the
[`launcher-v*` releases](https://github.com/PsycherosAI/Psycheros/releases?q=launcher-v)
for anyone who prefers that path, but new users should start with v2.
