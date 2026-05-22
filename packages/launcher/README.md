# Psycheros Launcher (v1 — deprecated)

> **Deprecated.** This is the legacy v1 launcher — a browser-tab dashboard that
> ran Psycheros as a child process. It has been replaced by
> [launcher-v2](../launcher-v2/), a desktop app that installs Psycheros as an
> OS-supervised background service (macOS + Windows). New users should start
> with launcher-v2. The v1 installer scripts remain available on
> [releases](https://github.com/PsycherosAI/Psycheros/releases?q=launcher-v) for
> existing users.

Install, update, and run Psycheros from your browser. No terminal required.

## Easy mode (recommended)

The launcher ships an installer script for each platform. Filenames are
version-less and the download URLs always resolve to the most recent launcher
release.

### macOS / Linux

```bash
curl -L -o install.sh https://github.com/PsycherosAI/Psycheros/releases/latest/download/install.sh
bash install.sh
```

### Windows

Download
[`install.ps1`](https://github.com/PsycherosAI/Psycheros/releases/latest/download/install.ps1)
and right-click → **Run with PowerShell**.

If PowerShell refuses to run unsigned scripts, allow them once:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

### Opening the launcher dashboard

The installer clones Psycheros and writes settings, but doesn't auto-open the
dashboard. Once it finishes:

```bash
# macOS / Linux
cd ~/psycheros/packages/launcher && ./run.sh
```

```powershell
# Windows
cd ~/psycheros/packages/launcher; .\run.ps1
```

A browser opens to the dashboard at `http://localhost:3001`. From there click
**Start** and you're running.

### Offline / no-clone alternative

If your machine can't clone from GitHub during install, the launcher also ships
as a self-contained bundle on each release. From the most recent
[`launcher-v*` release](https://github.com/PsycherosAI/Psycheros/releases?q=launcher-v):

- **macOS / Linux** — download `launcher-v*.tar.gz`, extract, run `./run.sh`
  from inside.
- **Windows** — download `launcher-v*.zip`, extract, right-click `run.ps1` →
  **Run with PowerShell**.

Clicking **Install** in the dashboard then handles cloning the rest of Psycheros
for you (still needs network access to reach GitHub).

## What the dashboard does

The dashboard opens at http://localhost:3001:

| Button             | What it does                                                                         |
| ------------------ | ------------------------------------------------------------------------------------ |
| **Install**        | Clones the Psycheros monorepo and saves your settings.                               |
| **Update**         | Pulls the latest code (`git pull --ff-only` on the monorepo).                        |
| **Start**          | Launches the Psycheros server.                                                       |
| **Stop**           | Shuts down the Psycheros server.                                                     |
| **Open Psycheros** | Opens the Psycheros web interface in a new tab — enabled once Psycheros is running.  |
| **Wipe All Data**  | Deletes the install directory for a fresh start. Confirmation dialog before it runs. |

The **Tools** section starts and stops Entity Loom — a companion app for
importing chat histories from other AI platforms into Psycheros. Available once
the monorepo is installed.

**Settings** lets you configure the install path, your name, your entity's name,
and your timezone. Settings persist between sessions.

## What gets installed

A single monorepo clone at your chosen install path (default `~/psycheros`):

```
~/psycheros/
├── packages/
│   ├── psycheros/       ← main app
│   ├── entity-core/     ← entity memory & identity
│   ├── entity-loom/     ← memory import tool
│   └── launcher/        ← this launcher
├── start.sh / start.ps1
├── stop.sh / stop.ps1
└── update.sh / update.ps1
```

You can change the install path in Settings if you already have the monorepo
cloned somewhere else.

## Prerequisites

None. The launcher installs Deno automatically if you don't have it. Git is
optional — with git, updates use `git pull` (fast); without git, the launcher
downloads the latest source directly (works fine, just slower).

## After installing

1. Click **Start** in the dashboard.
2. Click **Open Psycheros** to open the web interface.
3. Go to **Settings** and enter your API key.
4. Start chatting with your entity.

## Command line (advanced)

If you prefer the terminal, the install scripts work too:

```bash
# macOS / Linux
./install.sh
./start.sh
./stop.sh
./update.sh
```

```powershell
# Windows
.\install.ps1
.\start.ps1
.\stop.ps1
.\update.ps1
```

## Troubleshooting

**"Deno not found" after restart.** Some systems need a terminal restart to pick
up the new PATH. Close and reopen your terminal.

**"Could not clone" error.** Check your internet connection and try again.

**First run is slow.** Deno downloads dependencies on the first launch. This
only happens once.

**Port 3000 already in use.** Stop the other program using that port, or make
sure you don't have another instance of Psycheros running.

**Dashboard won't open.** Run `run.ps1` / `run.sh` from inside the launcher
folder itself — either `~/psycheros/packages/launcher/` after `install.sh` /
`install.ps1`, or the extracted `launcher-v*/` folder if you used the offline
bundle. The boot script needs its sibling files (`dashboard.ts`, `version.ts`,
`deno.json`) in the same directory.

## Companion packages

This launcher lives in the [Psycheros monorepo](../../README.md). It installs
and runs the sibling [`psycheros`](../psycheros/) harness, plus
[`entity-core`](../entity-core/) and [`entity-loom`](../entity-loom/).
