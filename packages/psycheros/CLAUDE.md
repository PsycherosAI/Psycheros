# psycheros — agent card

The harness daemon. Web UI on port 3000, streaming LLM, tool execution, RAG,
lorebook, data vault. Psycheros is an **embodiment** of the entity — the
entity's canonical identity and memory live in the sibling
[`entity-core`](../entity-core/) MCP server, and Psycheros syncs with it when
`PSYCHEROS_MCP_ENABLED=true`.

First-person convention applies — see [root CLAUDE.md](../../CLAUDE.md).

## Commands

```bash
deno task dev          # development with hot reload
deno task start        # production
deno task stop         # graceful shutdown
deno check src/main.ts
deno lint
```

LLM connections are configured through the web UI (Settings > LLM Settings), not
via env vars beyond a first-run default. The `ZAI_*` vars seed a default profile
on first run if present.

## Module structure

Each `src/*/` directory has a `mod.ts` barrel. Import from `mod.ts`, not from
internal files. Add new modules following the same pattern.

The agentic loop is in `src/entity/loop.ts` — LLM call, tool execution, context
capture, image and tool-arg fading. The chat HTTP route in
`src/server/routes.ts` calls into it and streams SSE back to the browser.

## Embedding model configuration

`src/embeddings/` is the configuration surface for the user-selectable embedding
model. Settings persist to `.psycheros/embedding-settings.json` and propagate to
entity-core via `ENTITY_CORE_EMBEDDING_*` env vars at MCP spawn (same pattern as
LLM settings). Deep reference — presets, re-embed orchestrator, dynamic vec0
dimension, rebuild notification flow, settings UI:
[`docs/embeddings.md`](docs/embeddings.md).

- **Xenova cache gotcha (load-bearing):** `@huggingface/transformers` defaults
  to `env.useBrowserCache = true`. In Deno the Web Cache API is available, so
  Xenova writes there and skips the filesystem entirely — leaving models in
  Deno's opaque `~/.cache/deno/...` and breaking any on-disk check. Both
  embedders (`src/rag/embedder.ts` for psycheros, entity-core's
  `src/embeddings/mod.ts`) force `env.useBrowserCache = false` so models persist
  at `${dataRoot}/.psycheros/model-cache/`. Don't remove this.
- **MCP ping pause invariant:** any long-running maintenance task that spikes
  CPU (the re-embed orchestrator, rebuilds) must call `mcpClient.pausePings()` /
  `resumePings()` — loading a model falsely trips the ping watchdog and storms
  reconnect attempts that race the explicit restart. `MCPClient` sets a
  `fallbackNotificationHandler` **before** `client.connect()` and auto-pauses
  pings on `notifications/embedding-rebuild` `started`/`progress`, resuming on
  `done`/`failed`, so a boot-time rebuild in entity-core can no longer starve
  pings into the watchdog-kill loop.
- **Settings/index drift detection:** the save endpoint persists a new model to
  the settings file _before_ the user confirms the re-embed, so a switch that
  was never re-indexed (missed confirmation, failed run) leaves settings and
  vec0 tables at different dimensions — every retrieval path then fails per-call
  while chat keeps working. `Server.init()` logs the mismatch at boot and
  `checkEmbeddingSync()` (`web/js/psycheros.js`, on page load) shows the
  re-index banner. Keep at least one durable surfacing: the
  `model_change_detected` SSE event is one-shot (entity-core boot) and stops
  firing entirely once entity-core's fingerprint happens to match the settings
  again even if its tables don't.

## Voice chat subsystem

`src/voice/` manages voice chat using a **walkie-talkie model**: one user
utterance → one STT call → one LLM call → one TTS response. The entire pipeline
runs in-process in the Deno daemon — no Python sidecar, no real-time turn
aggregator. An earlier Pipecat-based real-time pipeline is shelved; see
`pipecat-shelved/SHELVED.md` for what was preserved and revival conditions. Full
reference — architecture, design decisions, module layout, protocol, browser
quirks: [`docs/VOICE_CHAT_UX.md`](docs/VOICE_CHAT_UX.md). API endpoints:
[`docs/api-reference.md`](docs/api-reference.md) ("Voice Chat").

Traps:

- **The voice call FAB lives in the app shell, not the chat fragment.** The
  trigger button (`#voice-call-btn`) is a sibling of `#chat` inside `.main` so
  it survives HTMX swaps of `#chat`. Visibility is JS-driven
  (`updateVoiceCallButtonVisibility` in `web/js/psycheros.js`), re-evaluated on
  every `htmx:afterSwap` into `#chat`. Don't move the FAB into
  `renderChatView()` — the swap survival is load-bearing. Renaming the
  `#messages` id silently breaks the gate.
- **Mid-response audio gate** (`pipeline.ts` `pushAudio` + `session-manager.ts`
  `user_speech_start` handler) — TTS audio leaking back into the mic triggers
  the browser VAD during speaking. `pushAudio` drops frames while
  `processing`/`speaking`; the `user_speech_start` handler still sets
  `userSpeaking` (Pulse draining needs it) but must NOT call
  `setState("recording")`. Otherwise the next `user_silence` runs
  `processAudioTurn` on top of the in-flight turn — firing the "sent" tone
  mid-speaking and letting the entity respond to its own echo.
- **Server-side audio gate must literal-compare `session.pttMode`** — the field
  is typed `"ptt" | "vanilla"`, both strings are truthy, so a bare
  `if (session.pttMode)` silently drops all audio in vanilla mode. Same trap
  applies to any union-of-string-literals field used as a flag.
- **`is_voice` column is authoritative for voice attribution** — the
  `[Voice Chat]` prefix in message content is derived (regenerated from the
  column at read time), not stored; the LLM can't mark itself as voice. Persist
  paths strip parroted prefixes (and `<t>` tags) from LLM _output_ only. **Never
  strip the prefix from the LLM's input** — that breaks the entity's voice
  attribution awareness (same pattern as `<t>` tags).
- **Chrome Android browser-STT quirks** — skip `getUserMedia` entirely in
  browser STT mode (an active stream silently blocks `SpeechRecognition` from
  the mic). Before touching `web/js/voice.js` STT or PTT handling, read
  `docs/VOICE_CHAT_UX.md` "Browser STT on Chrome Android" and "Subtle PTT
  behaviors" — four load-bearing PTT subtleties (silence-detector re-check,
  `onend` restart while holding, phrase-buffer mid-hold guard, `endPTT` defers
  to `onend`) live there.
- Voice turns are real `EntityTurn`s with the same context as text chat and hold
  the per-conversation write lock from user-message persist through final
  response. Tools are enabled during voice calls; pass `disableTools: true` to
  suppress them for a specific turn.

## Workspace subsystem

`src/workspace/` is the entity's "faculty for careful, detailed work" — OpenCode
sessions the entity spawns via the `workspace` omni-tool. The entity is the
_user_ of the workspace; the workspace is framed as part of the entity, like
arms lifting something — never a separate agent. **Off-by-default:** `workspace`
and `ask_user` are in `DEFAULT_DISABLED_TOOLS`; enable via Settings > Tools once
OpenCode is installed. Deep reference — modes, permissions, backups, module
layout, UI, retention: [`docs/workspace.md`](docs/workspace.md). API endpoints:
[`docs/api-reference.md`](docs/api-reference.md) ("Workspace").

Modes: **sync** (blocks the turn, summary inline), **async** (fire-and-forget;
completion fires a transient Pulse carrying the summary back to the origin
conversation), **engaged** (turn-based entity↔OpenCode loop in
`engaged-runner.ts`; OpenCode never talks to the user directly —
`ask_origin_conversation` / `ask_user` suspend the session behind a toast, and
the answer resumes it).

**Ephemeral principle (load-bearing):** the workspace conversation is a
scratchpad. The full transcript exists only in the live SSE stream — it is never
persisted, embedded, or summarized directly:

- Only engaged-mode entity turns persist (loop continuity + terminal view).
  ChatRAG indexing and cross-conversation retrieval exclude workspace
  conversations (both index sites in `loop.ts`, both search paths in
  `rag/conversation.ts`); daily memory summarization excludes
  `sourceType: "workspace"` (`summarizer.ts`); Context Inspector snapshots are
  skipped for workspace turns.
- The completion summary → Pulse → the entity's own reflection in the origin
  conversation is the ONLY channel workspace content reaches entity memory.
  Don't add another.

Lifecycle invariants and wirings:

- `getWorkspaceSupervisor()` returns null before `Server.init()` finishes and
  after `Server.stop()`. The `workspace` tool checks for null and returns a
  graceful "not available" message — don't add new callsites that assume it's
  always set. The omni-tool uses the supervisor directly, not ToolContext — it's
  a process-wide singleton; don't add it to EntityConfig / PulseEngineConfig.
- `WorkspaceSupervisor.config_` is exposed read-only for the server's MCP route
  handler. Don't mutate.
- The MCP endpoint at `/api/workspace/mcp/:sessionId` takes the workspace
  **conversation ID** — the handler looks up by either ID form. OpenCode's
  sandbox config points at this URL.
- Engaged-runner's entity turns are real `EntityTurn`s — full identity/RAG/
  memories context, but the heartbeat map has no entry between iterations, so
  entity thinking time never trips a false stall. Keep it that way. OpenCode's
  session ID is captured from the first JSON event with a `sessionID` field; if
  OpenCode changes its event schema, `invokeOpenCode`'s parse loop +
  `streamEventToTerminalLine` are the places to update.
- Sandbox dirs share ONE OpenCode runtime (`opencode-runtime.ts`): a single
  node_modules at `<workspaceRoot>/.opencode-runtime/` symlinked into every
  sandbox, outside session dirs so retention never follows the symlink.
- The `>_` FAB (`#workspace-btn`) stacks BELOW `#voice-call-btn` in the app
  shell — same HTMX swap-survival rule as the voice FAB; do NOT move into
  `renderChatView()`.
- Sandbox retention and the workspace-scoped backup system only ever delete
  inside the workspace root / back up before writes — a corrupted `sandbox_path`
  can never become an arbitrary delete.

**Per-turn tool visibility:** workspace-only tools are gated by `visibleIn`
predicates on the `Tool` interface (tools/types.ts): `ask_user` appears only in
engaged workspace conversations, `manage_message` only in workspace
conversations (any mode). The `workspace` omni-tool has no predicate — always
visible. `ToolRegistry.getDefinitions(ctx)` applies the filter; `EntityTurn`
passes the conversation context.

## Entity skills

`src/skills/` + the `skill` tool: markdown procedure files at
`dataRoot/.psycheros/skills/<name>/SKILL.md` (frontmatter `name` +
`description`, optional `references/*.md`) that the entity loads on demand
instead of carrying in every context.

**Load holds (no fade for skills):** `skill({name})` holds the skill active —
there is no plain-load-then-fade path for skill bodies; the entity decides
duration, not a turn count. The tool result is a one-line confirmation; the body
lives only in the system message. **Holds are live mid-turn**: the loop watches
for `affectedRegions: ["held-skills"]` on tool results (`heldSkillsDirty` in
`EntityTurn.process()`), and on a hold/release immediately rebuilds the block
(`buildHeldSkillsContent()`), splices the new system message into `messages[0]`
via the `composeSystemMessage` closure, and re-persists the context snapshot
(`persistSnapshot`). The entity has the skill in the SAME turn it reached for
it. Cost: one intra-turn prefix invalidation per hold/release event (rare;
cross-turn caching is already defeated by the SA block). **References stay
transient**: `skill({name, reference})` returns the reference content with
`metadata.fade` so the generic fade sidecar (`buildFadeMap` in
`src/entity/loop.ts`) collapses it after 5 turns, like `look_closer`.

**Release:** `release: true` drops the hold when the entity decides the skill's
work is done. Holds are per-conversation, stored in the `held_skills` table **as
names only**: bodies re-resolve from disk inside the `EntityTurn.process()`
skill gate each turn (so edits apply next turn), and a hold whose skill file is
gone is lazily released there. The held bodies render in a `<held_skills>` block
built by `buildHeldSkillsBlock` (`src/skills/index-block.ts`), passed as the
LAST `buildSystemMessage` param and rendered after the SA section (dynamic
region — keeps the static prefix intact). Load/release tool results return
`affectedRegions: ["held-skills"]`, which drives the chip strip UI
(`#held-skills-strip`, a sibling of `#chat` — see
`docs/design/held-skills-chips.md`). Release works off the DB row even if the
skill file was deleted; `release` can't combine with `body` or `reference`.

**Authoring:** the same tool writes — `skill({name, description, body})`
saves/updates a skill; `skill({name, reference, body})` writes a reference doc
(body required before references). No approval gate (matches Hermes' default);
the soft norm "mention new or changed skills to the user when practical" lives
in the tool description. Writes to `generated: true` skills are refused —
regeneration would clobber them. `name` accepts a single string **or a list** —
batches load/release several skills in one call (partial success reports held
vs. missing; all-missing is an error; batches refuse `body`/`reference`).

**Starter templates:** `templates/skills/` seeds `repair-malformed-timestamps`
(self-maintenance exemplar) and `my-skills` (a deliberately loose primer on the
craft — mechanics that are true today + soft guidance + an explicit "this file
is mine to rewrite" clause; do not tighten it into a rulebook).

**Context index:** "My skills" (name + description per line) rides with the
tools — `EntityTurn.process()` appends `buildSkillsIndexBlock()` output (a bare
`My skills:` list, no preamble — the description carries the semantics) to the
`skill` tool's **description** in the per-request tool definitions. The
definition is CLONED before appending — mutating the registry's canonical
definition would pollute the Settings UI and accumulate across turns. Gated on
the `skill` tool actually being enabled and re-scanned per request, so Settings
edits apply next turn with no restart. In the Context Inspector it's visible
inside the `skill` tool's definition in the Tools tab (`tool_definitions_json`)
— there is no separate Skills Index section or snapshot field.
`buildSystemMessage`'s param list is fully positional — inserting a param
mid-list type-checks while silently swapping sections; verify via Context
Inspector, not just `deno check`.

**psycheros-handbook:** a generated knowledge-base skill (lean SKILL.md index +
curated `docs/*.md` as `references/`), regenerated at every daemon start
(`generateHandbookSkill` in `src/skills/handbook.ts`, called from `main.ts`).
Frontmatter `generated: true` drives the "auto-generated" badge in Settings and
the authoring block. Overwrites itself by design — user edits don't survive
restart. The starter template skill seeds from `templates/skills/` via
`copyTemplateSkillDirs` (`src/init/mod.ts`), which never overwrites an installed
skill.

**Workspace bundling:** the `workspace` tool's `skills: ["name"]` param on
`open` copies entity skills into the sandbox alongside the built-ins
(`bundleSkills(skillsDir, extraSkills)` in `src/workspace/skills.ts`).
Validation happens in `handleOpen` BEFORE spawn — unknown names and
built-in-name collisions return errors with no orphaned session row.
`WorkspaceBriefing.bundledSkills` persists on the session row; the briefing
mentions bundled skills at BOTH the supervisor's inline briefing composition
(`supervisor.ts`, the real spawn path) and `composeBriefing` (kept in sync but
not on the spawn path).

**Settings:** third "Skills" tab in Settings > Tools. `/api/skills/list` and
`/api/skills/held` must be route-matched before `/api/skills/:name` (prefix
pattern ordering — both are also excluded from the `:name` slice guards). Skill
names are validated against `SKILL_NAME_RE` (`src/skills/loader.ts`) at every
name→path boundary — that regex is the path-traversal defense.
`GET /api/skills/held?conversationId=` feeds the chip strip's 5-second
reconciliation poll (`updateHeldSkillsStrip` in psycheros.js — same pattern as
the BLE status badges; push paths make updates instant, the poll guarantees the
strip can't go stale).

## Wearable data pipeline

`src/wearable/` handles sensor data from entity-plexus (an Android app connected
to Bangle.js watches via BLE) — separate from the DeviceBridge (which serves web
BLE gateway clients with a different protocol). Two singletons:
`WearableConnectionManager` (WebSocket connections, command push, stream
discovery into BLE device profiles) and `WearableDataCache` (latest reading per
type per device, synchronous SA reads). The `ble_device` tool and
`/api/device/command` try DeviceBridge first, then fall back to the wearable
manager. Event rules turn sensor conditions into Pulses. Full reference:
[`docs/wearables.md`](docs/wearables.md); endpoints:
[`docs/api-reference.md`](docs/api-reference.md) ("Wearable Data Streaming").

## LLM client and model capabilities

`src/llm/client.ts` is the OpenAI-compatible LLM client (streaming and
non-streaming chat completion, provider-specific headers, model parameter
filtering). `src/llm/model-capabilities.ts` detects which sampling parameters a
model supports from its name string (ordered rules, first match wins; unknown
models get a permissive default) and gates vision via `supportsVision()` —
extend those tables for new model families; don't add ad-hoc model-name checks
elsewhere. Deep reference — capability rules, reasoning parameters and scopes,
token-budget two-pass trim, provider headers:
[`docs/llm-client.md`](docs/llm-client.md).

Traps:

- **Provider misroute recovery** in `EntityTurn.process()` (loop.ts, after the
  retry loop) catches responses routed entirely through the reasoning field with
  `content` empty (seen with GLM on OpenRouter; Z.ai direct does not exhibit
  it). Without recovery the reply hides inside the thinking section and the edit
  fallback reads the rendered thinking section's text. The recovery splits at
  the last boundary marker
  (`</thinking>`/`</thought>`/`</reasoning>`/`</antml:thinking>`) or promotes
  the reasoning to content on `finish_reason=stop`; a `thinking_corrected` SSE
  event tells the live UI to reset thinking and render the recovered reply.
- **Reasoning response parsing** checks four SSE delta fields in priority order
  (`reasoning_content` Z.ai, `reasoning` OpenRouter/DeepSeek, `thinking` Claude
  via OpenRouter, `reasoning_details` OpenRouter structured) — a new provider
  returning reasoning in a different field means extending the chain in
  `processChunk()`.
- **OpenRouter requires `HTTP-Referer` + `X-Title` headers**, or requests fail
  with "Missing Authentication header".
- **Intra-turn persistent reasoning is required on tool-call turns for
  DeepSeek** — without threading `reasoning_content` back between agent-loop
  iterations, the next call 400s. `"auto"` resolves via preset support; voice
  and worker clients force it off.

## HTMX inline scripts

HTMX 2.x does not reliably re-execute `<script>` tags inside swapped fragments.
Functions called from `onclick` handlers in HTMX-swapped fragments must live in
`web/js/psycheros.js` (loaded once, persists across swaps). That file is loaded
as `type="module"`, so top-level function declarations are module-scoped — any
function referenced from inline `onclick` must be explicitly exported via
`globalThis.functionName = functionName`.

Server data that fragment JS needs (e.g., provider presets) should be embedded
using `<script type="application/json" id="...">` tags or
`<input type="hidden">` fields in the HTML fragment, not inline `<script>`
assignments.

## Adding a built-in tool

A tool isn't fully wired until **all seven** of these are in place. The Pulse
path is the silent failure — a tool that works in chat but errors when an
autonomous Pulse calls it almost always means step 7 is missing.

1. Create `src/tools/my-tool.ts` implementing the `Tool` interface.
2. Register it in `AVAILABLE_TOOLS` in `src/tools/registry.ts`.
3. Add the tool name to the appropriate category in `TOOL_CATEGORIES` in
   `src/tools/tools-settings.ts`.
4. For off-by-default tools: add to `DEFAULT_DISABLED_TOOLS` in the same file.
5. For auto-enablement when its settings are configured: add to the
   `autoEnabled` array in `src/server/server.ts`.
6. If the tool changes UI state: use a state-change function and return
   `affectedRegions` (see below).
7. **If the tool needs persistent settings** (API keys, config): add a settings
   type in `src/llm/`, a getter on `PsycherosServer`, and wire it into **both**
   `EntityConfig` (`src/entity/loop.ts`) and `PulseEngineConfig`
   (`src/pulse/engine.ts`). The Pulse engine must pass the settings through or
   the tool will fail when called autonomously.

## Adding a custom tool (no core changes)

Custom tools don't need any of the registry wiring above.

1. Create `.psycheros/custom-tools/my-tool.js` exporting a default `Tool`
   object.
2. Or use the **Import Tool** button on Settings > Tools > Custom.
3. Toggle it on.

The custom-tool loader is in `src/tools/custom-loader.ts`.

## Trusted local plugins

`src/plugins/` is the trusted-plugin harness — a multi-capability extension
surface (tools, prompt hooks, HTTP routes, browser assets, entity-core MCP
decorators) for code that's more than a single tool. Plugin authors write a
manifest + entrypoints; the manager loads them at daemon startup. The canonical
authoring guide is [`docs/plugins.md`](docs/plugins.md); the operator-facing
vetting guide lives in the User Guide at
`site/src/content/docs/psycheros/user-guide.md`.

**Module layout:**

- `plugin-manager.ts` — `PluginManager` singleton: discover → resolve → load
  lifecycle, prompt-hook execution with per-hook + aggregate budget caps, route
  dispatch, asset serving, status reporting. Holds the event log registry.
- `installer.ts` — `PluginInstaller`: zip + git inspection, draft staging,
  atomic install-with-backup, removal. The auto-updater chains `inspectGit` →
  `installDraft` rather than duplicating the replace path.
- `event-log.ts` — `PluginEventLog` (per-plugin in-memory ring buffer +
  plain-text file at `.psycheros/plugin-logs/<id>.log` with 5 MB rotation) +
  `PluginEventLogRegistry` (per-plugin lookup, global enable/disable). One-line
  text format optimized for support-chat paste.
- `dependency-resolver.ts` — pure function: topological sort with `@std/semver`
  range checks, cycle detection, alphabetical tie-breaking.
- `updater.ts` — GitHub tag-API checker + apply-via-installer.
- `mod.ts` — barrel.

**Three load-bearing invariants:**

1. **Aggregate prompt-hook budget.** `buildPromptContent()` accepts
   `{ maxTotalChars }` from the host. The entity loop computes it as
   `(contextLength - maxTokens) * 0.15` clamped to `[4_000, 60_000]`. Hooks run
   in priority order (lower number = preserved under pressure); over- budget
   hooks are truncated (with marker) or skipped, both setting `degraded`.
   Without this, N plugins × 12k chars each could blow the context window — the
   system message is never trimmed.
2. **Env-var denylist.** `isDeniedPluginEnvVar()` in
   `packages/plugin-api/src/mod.ts` blocks ~26 process-global names (proxy, TLS,
   native injection, identity, runtime) plus `PSYCHEROS_*` and `ENTITY_CORE_*`
   prefix blocks. `applyPluginEnv` enforces it; the manager surfaces refused
   vars in `PluginStatus.warnings`. Note: this only covers the env-file path. A
   plugin calling `Deno.env.set(...)` from its own code bypasses the denylist —
   closing that needs Workers isolation (v1.1+).
3. **Load order = dependency order.** `load()` is split into discover → resolve
   → load phases specifically so resolution can topologically sort before any
   `start()` runs. A plugin whose dep failed resolution never imports — its
   `start()` cannot run before the dep it needs.

Plugin-owned credentials live under
`dataRoot/.psycheros/plugin-secrets/<id>.env`, outside portable exports. Use
`PSYCHEROS_PLUGIN_<ID>_*` names because trusted plugins share the process
environment.

**Surfacing:** Plugins Settings page at `/fragments/settings/plugins` (safety
banner, health card with last-turn budget meter via `getLastBudgetReport()`,
install form + install-review modal, per-plugin Recent Activity + log download +
update checks); Context Inspector Metrics tab (`pluginBudgetUsed` /
`pluginBudgetMax` on `LLMContextSnapshot.metrics`) and Plugins tab (per-hook
detail from `LLMContextSnapshot.pluginHooks`, persisted in the
`plugin_hooks_json` column); API endpoints under `/api/plugin-manager/*`
(health, events, log download, check-update, apply-update, inspect/install /
remove).

**Discord media hooks (API v2):** `PLUGIN_API_VERSION` is 2, but validation
accepts 1 or 2 — v1 manifests (google-suite) load unchanged, and
`capabilities.discordMedia` on a v1 manifest fails validation. All three hosts
(psycheros manager, installer, entity-core manager) share
`validatePluginManifest`, so the acceptance list is the single switch. Inbound:
`planTurnAttachments` records native-declined attachments as `pluginCandidates`;
the router flush offers them to `deps.enrichAttachmentMarkers` (bound to
`PluginManager.enrichAttachmentMarkers`) which replaces fallback markers with
plugin text. Plugins never intercept the native vision path, and plugin markers
never take `[image N]` numbers — the marker-N == `turnImages[N-1]` invariant
only ever covered vision attachments. Enriched marker text persists in the
transcript and is char-capped (4k per attachment, 16k per flush) and collapsed
to one line — markers are single-line by construction. Outbound:
`services.discord.sendAttachments` (`discord-send.ts`) posts multipart with the
host's bot token, read lazily via the manager's 5th ctor arg — plugins capture
services once in `start()`, before Discord settings load, so the token must not
be gated at injection time. The token never reaches plugin code;
`act_in_discord`'s raw-token pattern is host-only.

## Reactive UI: state-changes

UI updates flow through state-change functions in `src/server/state-changes.ts`.
A state-change function returns `{ success, data, affectedRegions }`, and
`affectedRegions` tells the frontend which DOM regions to re-render.

- **Synchronous** (during a chat turn): return the state-change result from the
  tool — it flows through the chat stream.
- **Background** (Pulse, gateway, scheduler handler): call
  `getBroadcaster().broadcastUpdates()` on the persistent SSE channel
  (`GET /api/events`).

Two SSE channels exist. `POST /api/chat` is the per-request stream (message_id,
context, thinking, thinking_corrected, content, tool_call, metrics, done) and
its retry sibling `POST /api/chat/retry`. `GET /api/events` is the persistent
channel for background updates and Pulse streaming.

Background toasts render above the chat bar (mobile-first, bottom-sheet
pattern), never top-right.

## Design system (frontend styling)

- Never hardcode hex colors in `web/css/**`, `templates.ts` inline styles, or JS
  DOM styling — use the `--c-*` tokens from `web/css/tokens.css`. No
  `var(--c-x, #fallback)` fallbacks either (drift seeds). Full token table,
  derivation rules, and the short exemption whitelist:
  [`docs/design/design-system.md`](docs/design/design-system.md) — consult it
  before any frontend change that touches color.
- Themes are 7 picked slots (bg/fg/accent/highlight/success/warning/error);
  every other color derives at apply time in `web/js/color.js`. `--c-*` token
  names are load-bearing: `packages/launcher-v2/frontend/styles/tokens.css`
  mirrors them — add tokens additively and sync its static defaults; never
  rename.
- Semantic colors are success/warning/error; never reuse accent for error
  states. The stop button's double-tap confirm stays warning-linked (safety
  color).
- New frontend features get a design doc from
  [`docs/design/TEMPLATE.md`](docs/design/TEMPLATE.md) before implementation.

## Concurrency: three locks to know about

- **Tool execution mutex** — `ToolRegistry.executeAll()` serializes tool
  execution across concurrent turns. Without this, two turns racing on the
  knowledge graph or identity files would corrupt state.
- **Per-conversation write lock** — `src/utils/conversation-lock.ts` is a
  promise-chain mutex keyed by conversation ID. Entity turns hold it from
  user-message persist through final response. **`send_discord_dm` also acquires
  it** before writing synthetic role-alternation messages to the DM
  conversation. Any new code that writes to chat persistence for a specific
  conversation must take this lock — otherwise role alternation corrupts when a
  Pulse and a chat turn touch the same DM thread.
- **MCP restart mutex** — `MCPClient.restart()` is promise-guarded. The
  scheduled-reconnect timer (set by `scheduleReconnect` when a health ping
  fails) and any direct caller (e.g. `entity-data.ts` export retry) share a
  single in-flight restart. Without this, two `StdioClientTransport` children
  spawn concurrently and race for entity-core's `graph.db` — the root cause of
  the Windows "database is locked" crash. Any new "restart MCP because X" path
  must call `mcp.restart()`, not spawn its own transport.

## Discord Gateway reconnect invariants

Three load-bearing wirings in `src/discord/gateway.ts`. Break any of them and
the entity silently goes dark a few hours after startup with no log lines and no
recovery path short of a daemon restart.

- **`skipNextClose` only inside `if (this.ws)` blocks** — the flag suppresses
  the outgoing WS's asynchronous close event so it doesn't double-schedule a
  reconnect. Setting it unconditionally at the top of `connectWs()` (the prior
  bug) leaks a stale flag: on initial connect there's no old WS to fire a close
  event, the flag never gets consumed, and the next real disconnect gets
  silently swallowed. Always pair the set with the actual `ws.close()` call.
- **`scheduleReconnect()` must never refuse** — no hard attempt cap. The 60s
  watchdog (next bullet) relies on this. A permanent give-up leaves no recovery
  path for transient outages, token fixes, or DNS hiccups. Backoff is already
  bounded at 30s, so infinite retries are affordable. If a cap is ever
  reintroduced, the watchdog must be updated to reset the counter on a cooldown
  or it becomes a dead safety net.
- **`reconnectTimer` is tracked, not anonymous** — the watchdog checks it to
  detect "reconnect already pending" before scheduling another. `disconnect()`
  clears it. Don't go back to an untracked `setTimeout` — the watchdog will
  stack reconnects.

The watchdog also runs `try/catch` around its check body, matching the router's
prune-timer pattern — an uncaught throw inside `setInterval` kills the Deno
process.

## Discord image attachments

Image attachments from Discord messages flow through `src/discord/images.ts`:
the router plans markers + selected images at flush (`planTurnAttachments`), and
the server resolves them in `handleDiscordTurn` — vision pixels (transient) →
captions (Settings > Vision captioning) → markers only. Three load-bearing
wirings:

- **Marker number N == index N-1 of the turn's vision/caption array.** The
  numbered `[image N attached: ...]` markers in the persisted transcript
  correlate with the images attached to that turn. Both walks in
  `planTurnAttachments` must traverse messages/attachments in the same order —
  reordering either breaks the correlation.
- **Pixels are transient, captions persist.** Never persist image data or the
  signed CDN URLs (they expire ~24h); the markers + caption text are the
  transcript's permanent record of what was shared.
- **The vision gate is `supportsVision()` in `src/llm/model-capabilities.ts`.**
  Extend that table for new model families — don't add ad-hoc model-name checks
  elsewhere. Unknown models default to vision-capable (permissive, same
  philosophy as sampling params).

**Outbound image sends (act_in_discord `image_path`, send_discord_dm
`image_path`, describe_image `path`):** every entity-supplied media path
resolves through `resolveDiscordImagePath` (`src/tools/discord-image-path.ts`) —
the ONLY sanctioned gate. It contains the path strictly under
`<dataRoot>/.psycheros/` and validates the extension set directly. Never
reintroduce `getMediaType()` for path validation: it defaults unknown extensions
to `image/png`, so "notes.txt" would pass a media-type allowlist (the bug this
helper closed — LLM-controlled paths could exfiltrate arbitrary files to Discord
or into the conversation). Sends carry AbortSignal timeouts (a hung fetch stalls
the global tool mutex) and `enforce_nonce` idempotency keyed on
`toolCallId:actionIndex` via `sendDiscordAttachments`' `idempotencyKey` —
retried tool calls must not double-post.

## User data and runtime state

All user-mutable state resolves under **`dataRoot`** — defaulting to
`Deno.cwd()` so today's `deno task start` behaviour is unchanged, overridable
via `PSYCHEROS_DATA_DIR` for launcher-managed deployments that put source and
data in separate directories. Source-relative reads (templates, web assets, vec0
extension) still resolve under **`projectRoot`**. Configs that need both fields
are `ServerConfig`, `EntityConfig`, `PulseEngineConfig`, and `RouteContext`.

The data tree (rooted at `dataRoot`):

- `identity/` and `.snapshots/` — **runtime-only**, gitignored, never committed.
  User-specific entity data. Never `git add` files from them.
- `.psycheros/` — DB (`psycheros.db`), settings JSON files, vault documents
  (`.psycheros/vault/documents/`), generated images, chat attachments,
  background images, anchor images, custom tool JS files
  (`.psycheros/custom-tools/`).
- `memories/` — daily/weekly/monthly/yearly memory summaries.

Docker users currently bind-mount `.psycheros/` only; setting
`PSYCHEROS_DATA_DIR=/data` and bind-mounting `/data` is the cleaner way to
persist the entire data tree uniformly.

To change identity _defaults_, edit `templates/identity/` (committed,
source-root). `src/init/mod.ts` seeds `dataRoot/identity/` from
`projectRoot/templates/identity/` on first run when empty. `templates/vault/` is
seeded into the global Data Vault on first startup.

**Memories are stored exclusively in `entity-core` via MCP.** There is no
Psycheros-local memory store. Daily summarization in `src/memory/mod.ts` writes
through the MCP client.

## Token budget

`contextLength` from the active LLM profile controls FIFO truncation of oldest
conversation history. The system message (identity, RAG, lorebook, vault, graph,
situational awareness, image-gen anchors) is **never** truncated. The current
user message is always preserved. Budget =
`contextLength - maxTokens - 5% safety margin`. Trimming and sanitization in
`src/entity/token-budget.ts`, applied in `EntityTurn.buildMessages()`.

## Scheduled work

Every scheduled or event-triggered task — daily memory summarization, identity
snapshots, MCP identity-change pushes, every flavour of Pulse trigger — routes
through the durable scheduler at [`src/scheduler/`](src/scheduler/). One
process-local instance lives on `PsycherosServer.scheduler`. Schedules and run
history live in `schedules` and `job_runs` in the main SQLite database. See
[`docs/scheduler.md`](docs/scheduler.md) for catch-up policies, registered
handlers, and operational details.

## Deep references

| Topic                             | Doc                                                          |
| --------------------------------- | ------------------------------------------------------------ |
| First-person philosophy           | [../../PHILOSOPHY.md](../../PHILOSOPHY.md)                   |
| Env vars, config, migrations      | [docs/configuration.md](docs/configuration.md)               |
| Tool system, identity tiers       | [docs/tools-reference.md](docs/tools-reference.md)           |
| Memory + RAG (chat, vault, graph) | [docs/memory-and-rag.md](docs/memory-and-rag.md)             |
| Embedding model configuration     | [docs/embeddings.md](docs/embeddings.md)                     |
| Voice chat                        | [docs/VOICE_CHAT_UX.md](docs/VOICE_CHAT_UX.md)               |
| Workspace subsystem               | [docs/workspace.md](docs/workspace.md)                       |
| Wearable data pipeline            | [docs/wearables.md](docs/wearables.md)                       |
| LLM client, model capabilities    | [docs/llm-client.md](docs/llm-client.md)                     |
| UI features                       | [docs/ui-features.md](docs/ui-features.md)                   |
| API endpoints, SSE architecture   | [docs/api-reference.md](docs/api-reference.md)               |
| Durable scheduler                 | [docs/scheduler.md](docs/scheduler.md)                       |
| Design system, theming            | [docs/design/design-system.md](docs/design/design-system.md) |
| Security audit                    | [docs/security-audit.md](docs/security-audit.md)             |
| Trusted plugins (authoring)       | [docs/plugins.md](docs/plugins.md)                           |

External Connections (Discord, web search, home, intimacy), Vision (image gen,
captioning, gallery), Situational Awareness, and Pulse all have their feature
surfaces documented in the relevant `docs/` files — as do the subsystem sections
above. Don't reproduce feature surfaces here; CLAUDE.md carries the map and the
traps.

## Companion packages

This package lives in the [Psycheros monorepo](../../README.md). The canonical
identity and memory store is the sibling [`entity-core`](../entity-core/); the
chat-history importer is the sibling [`entity-loom`](../entity-loom/).
