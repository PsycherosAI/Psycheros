# Psycheros production debug shell — orientation for AI agents

You are connected via SSH to a **live Psycheros production container**. This
shell exists for live diagnosis. Treat the system as production.

## Layout

| Path                         | Contents                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `/app/Psycheros/`            | Service source (Deno 2.x). The deno process is running on this code — **do not edit while the service is running**.        |
| `/app/Psycheros/.psycheros/` | App data: `psycheros.db` (conversations, RAG, vault, anchors), per-feature settings JSON, generated images, SSH host keys. |
| `/app/entity-core/`          | entity-core MCP server source.                                                                                             |
| `/app/entity-core/data/`     | Canonical identity, `memories/` tree, `graph.db`. **Source of truth for the entity.**                                      |

## Process model

- PID 1: `dumb-init`
- Main service: `deno run -A --cached-only /app/Psycheros/src/main.ts` on port
  3000
- Subprocess: entity-core MCP server (over stdio)
- This sshd: running on its configured port

## Logs

There is **no logfile inside the container**. The Deno process writes to
container stdout. From outside the container: `docker logs psycheros [-f]`. From
inside, you can only observe live state — not history.

## Useful queries

```bash
# Service health
curl -s http://localhost:3000/health

# Listening sockets
ss -tlnp

# DB tables
sqlite3 /app/Psycheros/.psycheros/psycheros.db ".tables"

# Recent conversations
sqlite3 /app/Psycheros/.psycheros/psycheros.db \
  "SELECT id, title, datetime(updated_at,'unixepoch') FROM conversations ORDER BY updated_at DESC LIMIT 10"

# Memory inventory
find /app/entity-core/data/memories -name '*.md' | wc -l

# Graph stats
sqlite3 /app/entity-core/data/graph.db "SELECT COUNT(*) FROM nodes; SELECT COUNT(*) FROM edges;"
```

## Project documentation

- `/app/Psycheros/CLAUDE.md` — agent system card, primary architectural
  reference
- `/app/Psycheros/README.md` — directory map and component relationships
- `/app/Psycheros/docs/` — deep-reference articles per topic

Read `CLAUDE.md` early — it explains the entity model, RAG architecture, and
core patterns far better than this brief can.

## Rules of engagement

**Read freely.** This shell exists to investigate.

**Do not, without explicit human approval:**

- Edit any file under `/app/Psycheros/` source (live code).
- Restart, kill, or signal the deno process.
- Delete or modify files under `.psycheros/` or `entity-core/data/`.
- Run schema migrations or destructive SQL.
- Install packages permanently (an `apt-get install` for ad-hoc inspection is
  fine — it does not persist across container restarts).
- Modify identity files in
  `/app/entity-core/data/{self,user,relationship,custom}/`. Identity changes
  flow through the entity's own tools, not raw file edits.

**Network:** outbound HTTPS works for fetching diagnostic info. The sshd listens
on a non-default port and is intended for LAN-only access — do not log
credentials, keys, or PII to public services.

## Agent ergonomics

- `GIT_PAGER=cat`, `PAGER=cat` — no pagers, commands stream cleanly.
- `vim`, `vi`, `less`, `tree`, `file`, `rg`, `jq`, `sqlite3` available.
- Bash 5.x is the login shell.
- Working directory on login is `/root` — `cd /app/Psycheros` for the app.
