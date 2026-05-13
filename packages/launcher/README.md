# Psycheros Launcher

Install, update, and run Psycheros from your browser. No terminal required.

## Easy mode (recommended)

Grab the launcher bundle from the most recent
[`launcher-v*` release](https://github.com/PsycherosAI/Psycheros/releases?q=launcher-v):
either `launcher-v*.tar.gz` (macOS / Linux) or `launcher-v*.zip` (Windows). The
bundle contains everything the launcher needs to run — `run.sh` / `run.ps1` are
inside it, alongside their sibling files.

### Windows

1. Download `launcher-v*.zip` from the latest launcher release.
2. Extract the archive (right-click → **Extract All**) somewhere convenient —
   your Desktop is fine.
3. Open the extracted folder, right-click `run.ps1` → **Run with PowerShell**.
4. A browser window opens automatically.
5. Click **Install**, fill in the settings, then click **Start**.

### macOS

1. Download `launcher-v*.tar.gz` from the latest launcher release.
2. Double-click the archive in Finder to extract it.
3. Open the **Terminal** app, drag `run.sh` from the extracted folder into the
   terminal window, and press **Enter**.
4. A browser window opens automatically.
5. Click **Install**, fill in the settings, then click **Start**.

### Linux

Same as macOS, or from a terminal:

```bash
tar -xzf launcher-v*.tar.gz
cd launcher-v*/
./run.sh
```

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

**Dashboard won't open.** Run `run.ps1` / `run.sh` from inside the extracted
launcher folder — the boot script needs its sibling files (`dashboard.ts`,
`version.ts`, `deno.json`) in the same directory.

## Companion packages

This launcher lives in the [Psycheros monorepo](../../README.md). It installs
and runs the sibling [`psycheros`](../psycheros/) harness, plus
[`entity-core`](../entity-core/) and [`entity-loom`](../entity-loom/).
