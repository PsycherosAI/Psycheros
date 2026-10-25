---
title: Install from source
description: Run Psycheros directly from source with Deno — no launcher required.
---

For users who prefer the command line, want to hack on the code, or are on a
platform the launcher doesn't cover (Linux). You need [Deno](https://deno.land)
and an LLM API key — nothing else.

## Prerequisites

### Deno runtime

Psycheros requires **Deno 2.x** (the exact version CI uses is pinned in
[`.deno-version`](https://github.com/PsycherosAI/Psycheros/blob/main/.deno-version)
— currently `2.9.8`). Any recent 2.x release will work, but matching the pinned
version avoids formatting drift if you plan to contribute.

**macOS / Linux:**

```bash
curl -fsSL https://deno.land/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://deno.land/install.ps1 | iex
```

**macOS via Homebrew:**

```bash
brew install deno
```

Verify:

```bash
deno --version
```

### Git

You need `git` to clone the repository. It's pre-installed on macOS and most
Linux distributions. On Windows, install
[Git for Windows](https://git-scm.com/download/win).

### An LLM API key

Psycheros uses any OpenAI-compatible LLM endpoint. You'll need an API key from
one of:

- [Z.ai](https://z.ai) (default, recommended)
- [OpenRouter](https://openrouter.ai)
- [OpenAI](https://platform.openai.com)
- [NanoGPT](https://nanogpt.com)
- A local model server (Ollama, vLLM, LM Studio, etc.)

You can set the key in a `.env` file before starting, or configure it through
the web UI after first boot — whichever you prefer.

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/PsycherosAI/Psycheros.git
cd Psycheros
```

The repository is a **Deno workspace** — five packages that share dependencies.
Keep the directory structure intact: Psycheros automatically starts
`entity-core` (the canonical-self MCP server) as a child process, and it expects
`entity-core` to live at `../entity-core` relative to the Psycheros package.

### 2. Go to the Psycheros package

```bash
cd packages/psycheros
```

All commands from here on run from this directory.

### 3. Set up your environment file

Copy the example and edit it:

```bash
cp .env.example .env
```

Open `.env` in your text editor. The only thing you need to set is your API key:

```bash
ZAI_API_KEY=your-api-key-here
```

Everything else in `.env.example` is optional — sensible defaults are baked in.
You can always adjust settings (LLM provider, timezone, accent color, tools, web
search, Discord, etc.) through the web UI later.

:::note If you'd rather not put your key in a file, skip this step entirely. You
can configure your LLM provider through **Settings → LLM** in the web UI after
first boot. :::

### 4. Start Psycheros

```bash
deno task dev
```

This starts Psycheros in **watch mode** — it automatically reloads when you
change source files. If you just want to run it without file watching:

```bash
deno task start
```

The first launch downloads dependencies (this takes a minute or two). Once you
see the server listening message, you're ready.

### 5. Open the web UI

Open [http://localhost:3000](http://localhost:3000) in your browser.

On first visit, Psycheros runs you through a quick setup:

1. **Your name** — what the entity calls you.
2. **Entity name** — what the entity is called.
3. **Timezone** — used for daily memory consolidation and scheduling.
4. **LLM settings** — if you didn't set an API key in `.env`, configure your
   provider here.

After setup, you're chatting with your entity. Identity files are generated from
templates in your first run — these become the entity's sense of self.

## What's where

When you run from source, Psycheros creates its data in the current working
directory (the `packages/psycheros/` folder):

| Path           | What it holds                                                    |
| -------------- | ---------------------------------------------------------------- |
| `.psycheros/`  | LLM settings, general settings, custom tools, vault, backgrounds |
| `identity/`    | The entity's identity files (self, user, relationship, custom)   |
| `memories/`    | Chat logs and daily/weekly/monthly/yearly memory summaries       |
| `.snapshots/`  | Daily identity snapshots (retained 30 days by default)           |
| `psycheros.db` | Chat history, RAG index, configuration                           |

`entity-core` creates its own data in `../entity-core/data/` (identity backups,
knowledge graph, embeddings).

:::tip If you want your data somewhere other than the source directory (for
example, to keep it out of git or survive re-cloning), set `PSYCHEROS_DATA_DIR`
in your `.env`:

```bash
PSYCHEROS_DATA_DIR=/path/to/your/data
```

:::

## Running as a background service

`deno task dev` and `deno task start` run in the foreground — close the terminal
and Psycheros stops. For a persistent setup:

### Linux (systemd)

Create a service file at `~/.config/systemd/user/psycheros.service`:

```ini
[Unit]
Description=Psycheros entity harness
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/Psycheros/packages/psycheros
ExecStart=/home/USER/.deno/bin/deno task start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Enable and start:

```bash
systemctl --user enable --now psycheros
```

### macOS (launchd)

Create a plist at `~/Library/LaunchAgents/com.psycheros.daemon.plist` (replace
paths and username):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.psycheros.daemon</string>
  <key>WorkingDirectory</key>
  <string>/path/to/Psycheros/packages/psycheros</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/USER/.deno/bin/deno</string>
    <string>task</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.psycheros.daemon.plist
```

### Windows (Scheduled Task)

Open Task Scheduler → **Create Task**:

- **General:** name it `Psycheros`, select _Run whether user is logged on or
  not_
- **Actions:** _Start a program_ → `C:\Users\YOU\.deno\bin\deno.exe`, arguments
  `task start`, start in `C:\path\to\Psycheros\packages\psycheros`
- **Triggers:** _At log on_
- **Settings:** enable _Restart on failure_ every 60 seconds

Or via PowerShell:

```powershell
$action = New-ScheduledTaskAction -Execute "$env:USERPROFILE\.deno\bin\deno.exe" `
  -Argument "task start" `
  -WorkingDirectory "C:\path\to\Psycheros\packages\psycheros"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "Psycheros" -Action $action -Trigger $trigger -Settings $settings
```

## Stopping Psycheros

If running in the foreground: `Ctrl+C` in the terminal.

If running as a background service: stop it through your service manager
(`systemctl --user stop psycheros`, `launchctl unload ...`, Task Scheduler).

Psycheros also provides a convenience stop task that sends SIGINT:

```bash
deno task stop
```

## Updating

Pull the latest changes and restart:

```bash
cd /path/to/Psycheros
git pull origin main
cd packages/psycheros
deno task start
```

## Troubleshooting

### Port already in use

If port 3000 is taken, set a different one in `.env`:

```bash
PSYCHEROS_PORT=3001
```

Then access the UI at `http://localhost:3001`.

### entity-core connection failed

Psycheros spawns entity-core automatically. If you see a connection error, make
sure:

1. You're running from `packages/psycheros/` (not the repo root).
2. The `packages/entity-core/` directory exists in the cloned repo (it should if
   you cloned the full repository).
3. Deno can write to `packages/entity-core/data/`.

### First launch is slow

The first run downloads Deno dependencies and the embedding model (~100MB).
Subsequent starts are fast — dependencies are cached.

### Permission denied

Deno uses explicit permissions. Psycheros requests all permissions (`-A` flag)
for convenience. If you've restricted permissions, make sure Deno has access to
read/write the working directory, network access for API calls, and environment
variable access.

## Docker alternative

If you'd rather not install Deno, Psycheros ships a Docker image:

```bash
docker run -d --name psycheros -p 3000:3000 \
  -e ZAI_API_KEY=your-api-key \
  -v psycheros-data:/app/packages/psycheros/.psycheros \
  -v entity-core-data:/app/packages/entity-core/data \
  ghcr.io/psycherosai/psycheros:latest
```

See the [README](https://github.com/PsycherosAI/Psycheros#docker) for full
Docker options.
