# Workspace Subsystem

Deep reference for `src/workspace/` — the entity's "faculty for careful,
detailed work": OpenCode sessions the entity spawns via the `workspace`
omni-tool. The entity is the _user_ of the workspace; the workspace is framed as
part of the entity, like arms lifting something — never a separate agent.

For lifecycle invariants and load-bearing wirings, see "Workspace subsystem" in
[`../CLAUDE.md`](../CLAUDE.md). API endpoints:
[`api-reference.md`](api-reference.md) ("Workspace").

## Modes

- **sync** — blocks the entity's turn, returns a summary inline.
- **async** — fire-and-forget; completion fires a transient Pulse carrying the
  summary back to the origin conversation.
- **engaged** — turn-based loop in `engaged-runner.ts`: OpenCode responds →
  entity turn with full context → repeat until the entity calls `end_session` or
  the iteration cap hits. OpenCode never talks to the user directly —
  `ask_origin_conversation` / `ask_user` suspend the session and surface a
  toast; the answer resumes it.

## Permissions

5-tier path classifier in `permissions.ts`. Tier 5 (daemon files, raw DB, graph
DB) is always blocked, regardless of mode — symlink-resolved (realpath) BEFORE
classification. Sandboxed mode wraps OpenCode in bwrap (Linux) / sandbox-exec
(macOS) with `--die-with-parent`; Feral mode skips the OS sandbox entirely (user
opt-in for host access). **Windows has no OS sandbox** — soft enforcement only
(classifyPath + OpenCode permission config + agent-file prose), equivalent to
Feral. Partyhard is disabled (code commented out, not deleted — OpenCode's
`--auto` doesn't reliably gate headless; see supervisor.ts for the one-line
rationale).

## Workdir sessions

`workdir` param on open binds an existing host folder rw into the sandbox
namespace (bwrap `--bind` after the projectRoot ro-bind; matching Seatbelt allow
on macOS) so the session works on real files in place — kernel-scoped, unlike
Feral. Tier 5 paths refused; every bind passes an approval toast; `/tmp`
workdirs refused on Linux (bwrap's tmpfs shadows binds there). Persisted on the
session row (`workdir` column) so resume rebuilds the same bind. The scratch
sandbox stays the OpenCode project dir — config, skills, and OpenCode's ~63MB
node_modules never land in the user's folder.

## Backup system

Filesystem JSONL at `<dataRoot>/.psycheros/backups/<surface>/<target_id>.jsonl`,
OUTSIDE psycheros.db. Every write to message content, pulse, lorebook entry,
vault document, or custom tool archives the pre-edit state first (24h window +
cap 5 + collapse-to-1 after 24h quiet). `write_entity_data` batch mode shares
one justification/approval/batch_id across items.

## Stall detection

The supervisor tracks `lastEventAt` per in-flight `invokeOpenCode` call; a
watchdog ticks every 15s and marks a session stalled after 90s of no events —
skipping sessions that are suspended or waiting on a query/approval
(blocked-on-user is not stalled). `workspace_stalled` / `workspace_resumed` SSE
events drive the amber FAB state. Purely informational; the 5-min hard timeout
(SIGTERM → 5s → SIGKILL) still does the killing.

## Module layout

- `supervisor.ts` — `WorkspaceSupervisor` singleton + `invokeOpenCode`
  (subprocess spawn, event stream parse, timeout escalation), stall watchdog,
  resume dispatch. Reached via `getWorkspaceSupervisor()`, not ToolContext.
- `engaged-runner.ts` — the turn-based entity↔OpenCode loop, suspend/resume.
- `coordination-layer.ts` — daemon-side JSON-RPC dispatcher exposing the 4 tools
  to OpenCode (`read_entity_data`, `write_entity_data` w/ approval flow,
  `read_codebase`, `ask_origin_conversation`). Hand-rolled, no MCP SDK
  transport.
- `sandbox.ts` — per-session sandbox dir at
  `<dataRoot>/.psycheros/workspace/<conversationId>/`, writes `opencode.json`
  (permission matrix: reads allowed everywhere, outside writes/bash = ask) and
  `AGENTS.md`; bwrap/sandbox-exec argv builders.
- `agent-template.ts` — the agent file (OpenCode's system prompt), neutral
  system voice (first-person is reserved for the entity).
- `skills.ts` — 4 bundled Skills + `references/` docs, written into each sandbox
  at spawn.
- `permissions.ts` — classifyPath / approvePath, always-ask paths, Tier 5.
- `approval-queue.ts` / `query-queue.ts` — pending writes / pending questions,
  SSE toast broadcast; queries persist to disk across restarts.
- `reflection.ts` — LLM sanity pass on Tier 2 write proposals.
- `briefing.ts` / `summary.ts` — first user message composition; ≤500-token
  summary distillation via the worker LLM.
- `transcript.ts` — SSE broadcast formatting (ephemeral; see the ephemeral
  principle in CLAUDE.md).
- `session.ts` — runtime types.

## Workspace conversations

`sourceType: "workspace"`, excluded from the sidebar. Session metadata lives in
`workspace_sessions` (briefing, summary, status incl. `suspended`, mode,
isolation). Rendered as a **terminal pane** (`renderWorkspaceTerminal` in
templates.ts — routed from `handleChatFragment`), NOT the chat view: header with
goal + status badge, live SSE events as terminal lines (tool calls dim, entity
turns accent-colored via `data-entity-name`), ended sessions show briefing +
persisted turns + summary. No input area — the user never types into a workspace
conversation.

## OpenCode runtime requirements

- `opencode` binary on PATH (fallback `~/.opencode/bin/opencode`; override via
  the `opencodeBinaryPath` setting).
- LLM profile forwarding defaults ON — Psycheros writes the selected profile
  into each sandbox's `opencode.json` and passes the API key via env var. Turn
  OFF in Settings > Workspace to use OpenCode's own auth instead.
- Entity name comes from `general-settings.json` (single source of truth, same
  name as everywhere else) via `readWorkspaceEntityName()`. The standing context
  block lives in `workspace-settings.json`.

## UI

- `>_` FAB at `#workspace-btn`, stacked BELOW `#voice-call-btn` in the app shell
  (HTMX swap-survival — do NOT move into `renderChatView()`). State-driven
  visibility: hidden when idle, shown while any session is active/suspended,
  brief green flash on completion. Amber + slow pulse when stalled; amber `!`
  overlay for pending questions. Pinned projects do NOT keep the FAB visible —
  pin management lives in Settings > Workspace.
- Settings > Workspace has two tabs (General / Sessions; switcher in
  workspace.js per the HTMX-survival rule). Sessions tab manages retention pins:
  pinned sessions (Unpin/Open) + recent finished sessions (Pin). The entity pins
  via the `pin`/`unpin` workspace actions; the `pinned` flag exempts a session's
  sandbox from retention.
- `export_project` copies finished artifacts out of sandboxes to the projects
  folder (`projectsPath` setting, default `~/Projects` per-OS). Approval-toast
  gated, copy-not-move, refuses to overwrite existing names,
  traversal-contained. Shares `findArtifactSource` with propose_install.
- Toasts render above the chat bar (mobile-first), never top-right.

## Shared OpenCode runtime

Sandbox dirs share ONE OpenCode runtime: `opencode-runtime.ts` keeps a single
node_modules at `<workspaceRoot>/.opencode-runtime/` (promoted from the newest
terminal sandbox at daemon start) and symlinks it into every sandbox — without
it, each sandbox bootstraps its own ~63MB copy. The runtime dir is rw-bound into
bwrap/seatbelt so OpenCode can still install plugin updates; it lives outside
session dirs so retention never follows the symlink. Running/suspended/pinned
sessions keep their real copies.

## Retention

Nightly retention (`workspace.sandbox-retention`, 04:17 via the durable
scheduler) deletes dirs for terminal sessions older than `sandboxRetentionDays`
(default 7, 0 disables; Settings > Workspace). Retention also deletes the
session's conversation (cascading the workspace_sessions row and the
engaged-turn messages — the scratchpad is ephemeral by design) and sweeps orphan
workspace conversations whose session row is already gone. The handler only
deletes inside the workspace root — a corrupted `sandbox_path` can never become
an arbitrary delete.
