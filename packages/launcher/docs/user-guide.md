# Launcher — User Guide

The launcher is the easiest way to install, update, and run Psycheros. It opens
a small dashboard in your browser at `http://localhost:3001` with buttons for
**Install / Update / Start / Stop / Wipe**. No terminal usage required.

If you've never run Psycheros before, start here.

## Installing

The launcher ships an installer script for each platform. Filenames are
version-less and the download URLs always resolve to the most recent launcher
release — safe to link to, hardcode, or share.

### macOS / Linux

```bash
curl -L -o install.sh https://github.com/PsycherosAI/Psycheros/releases/latest/download/install.sh
bash install.sh
```

### Windows

Download
[`install.ps1`](https://github.com/PsycherosAI/Psycheros/releases/latest/download/install.ps1)
and right-click → **Run with PowerShell**.

If PowerShell refuses to run unsigned scripts, allow them once: open PowerShell
as your user and run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

### What the installer does

- Checks for Git and Deno (installs Deno if missing).
- Asks where you want Psycheros to live (default `~/psycheros`).
- Clones the Psycheros monorepo there.
- Asks for your name, your entity's name, and your timezone.
- Generates `start.sh` / `stop.sh` / `update.sh` helpers next to the clone.

### Opening the launcher dashboard

The installer doesn't auto-open the dashboard — once it finishes, run the
launcher yourself:

```bash
# macOS / Linux
cd ~/psycheros/packages/launcher
./run.sh
```

```powershell
# Windows
cd ~/psycheros/packages/launcher
.\run.ps1
```

A browser window opens to the dashboard at `http://localhost:3001` — control
panel with Install / Update / Start / Stop / Wipe buttons (see
[The dashboard](#the-dashboard) below).

If you'd rather skip the dashboard entirely, `cd ~/psycheros && ./start.sh` runs
Psycheros directly.

### Offline / no-clone alternative

If your machine can't clone from GitHub during install, the launcher also ships
as a self-contained bundle. From the most recent
[`launcher-v*` release](https://github.com/PsycherosAI/Psycheros/releases?q=launcher-v),
download `launcher-v*.tar.gz` (macOS / Linux) or `launcher-v*.zip` (Windows),
extract it, and run `./run.sh` (or right-click `run.ps1`) from inside the
extracted folder. The dashboard opens with the full UI; clicking **Install**
there will still need network access to reach GitHub for the rest of Psycheros.

## The dashboard

Once the launcher is running, the dashboard at `http://localhost:3001` is your
control panel. Each button is one action:

| Button             | What it does                                                                         |
| ------------------ | ------------------------------------------------------------------------------------ |
| **Install**        | Clones the Psycheros monorepo into your install directory and saves your settings.   |
| **Update**         | Pulls the latest code (`git pull --ff-only` if git is available, else re-downloads). |
| **Start**          | Launches the Psycheros server.                                                       |
| **Stop**           | Shuts down the Psycheros server.                                                     |
| **Open Psycheros** | Opens the Psycheros web interface in a new tab. Enabled once Psycheros is running.   |
| **Wipe All Data**  | Deletes the install directory for a fresh start. Asks for confirmation first.        |

The **Tools** section starts and stops Entity Loom — a companion app for
importing chat histories from other AI platforms (ChatGPT, Claude, SillyTavern,
Kindroid, Letta). Available once the monorepo is installed. See the
[entity-loom user guide](/Psycheros/entity-loom/user-guide/) for what it does.

## Settings

Click the **Settings** gear to configure:

- **Install path** — where the Psycheros monorepo is cloned. Default
  `~/psycheros`. Change this if you've already cloned the monorepo elsewhere and
  want the launcher to use that copy.
- **Your name** — what the entity calls you in conversations.
- **Entity name** — what the entity is called.
- **Timezone** — used by the entity's daily-memory consolidation and Pulse
  scheduling.

Settings persist between sessions in a JSON file next to `dashboard.ts`. They're
just defaults for the install step; once Psycheros is installed, all per-entity
configuration lives in the Psycheros web UI itself.

## What gets installed

A single monorepo clone at your install path:

```
~/psycheros/
├── packages/
│   ├── psycheros/       ← main app (web UI, chat loop, tools)
│   ├── entity-core/     ← entity memory + identity (MCP server)
│   ├── entity-loom/     ← memory import wizard
│   └── launcher/        ← this launcher
├── start.sh / start.ps1
├── stop.sh / stop.ps1
└── update.sh / update.ps1
```

## Prerequisites

None. The launcher installs [Deno](https://deno.land) automatically if you don't
have it. Git is optional — with git, updates use `git pull` (fast); without git,
the launcher downloads the latest source directly (works fine, just slower).

## After installing

1. Click **Start** in the dashboard.
2. Click **Open Psycheros** to open the web interface (`http://localhost:3000`
   by default).
3. Go to **Settings → LLM Connections** in Psycheros and enter your API key for
   an OpenAI-compatible LLM provider.
4. Start chatting with your entity.

If you have chat history from another platform you want to import, use the
**Start Entity Loom** button under Tools on the launcher dashboard and follow
the [Entity Loom user guide](/Psycheros/entity-loom/user-guide/).

## Updating

Click **Update** in the dashboard. The launcher runs `git pull --ff-only` on the
install directory (or re-downloads the latest source if git isn't available).
Restart Psycheros via **Stop** then **Start** to pick up the new version.

## Command line (advanced)

If you prefer the terminal, the install scripts work without the launcher UI:

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

The dashboard is the same operations as these scripts behind the scenes — pick
whichever interface you prefer.

## Troubleshooting

**"Deno not found" after restart.** Some systems need a terminal restart to pick
up the new PATH. Close and reopen your terminal.

**"Could not clone" error.** Check your internet connection and try again. If
git isn't installed, the launcher will fall back to a direct download.

**First run is slow.** Deno downloads its dependencies on the first launch. This
only happens once.

**Port 3000 already in use.** Stop the other program using that port, or make
sure you don't have another instance of Psycheros running. Port 3000 is
Psycheros's web UI; the launcher itself uses port 3001.

**Dashboard won't open.** Run `run.ps1` / `run.sh` from inside the launcher
directory itself — either `~/psycheros/packages/launcher/` after `install.sh` /
`install.ps1`, or the extracted `launcher-v*/` folder if you used the offline
bundle. The boot script needs `dashboard.ts`, `version.ts`, and `deno.json` as
siblings in the same directory — running it in isolation won't work.

**Launcher port 3001 already in use.** Another launcher session is probably
already running. Close it before starting a new one.

## When not to use the launcher

The launcher is the recommended path for non-technical operators. If you're
deploying Psycheros to a server, embedding it in your own infrastructure, or
running it as a container under an orchestrator, the
[Docker image](https://github.com/PsycherosAI/Psycheros/pkgs/container/psycheros)
or building from source is a better fit. See the repo
[README](https://github.com/PsycherosAI/Psycheros#docker) for those paths.
