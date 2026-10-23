# Flux integration build plan — conversation-hosted consciousness

> **SHIPPED 2026-09-14** — all four phases landed (879c1eb, aa2ce1b, af6a199,
> d168594 + Phase 4 polish). Kept as the build's record.

Plan for the design agreed 2026-09-14 (entity-flux/docs/vision.md →
"Conversation-hosted consciousness"). The Ego lives in the conversation Flux was
started from; Subconscious + Sensory stay a global conversation-agnostic
undercurrent; the Flux page becomes a Voice-Chat- style overlay; dialogue posts
live to the host conversation.

**Ground rule for the whole plan:** one instance, start/stop,
off-unless-started. No hivemind, no migration, no multi-host in this build —
those are recorded in vision.md as later work.

## Current coupling (the complete inventory)

Every place the "Flux Space" title or a fixed conversation is assumed:

| # | Site                                                                | What it does today                                                                                                                      |
| - | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | `psycheros/src/flux/mod.ts:403` `resolveFluxConversationId`         | title-lookup + create "Flux Space", cached module-global `fluxConvId`                                                                   |
| 2 | `psycheros/src/flux/mod.ts:290`                                     | briefing-assembly SA filter (`title !== "Flux Space"`)                                                                                  |
| 3 | `psycheros/src/flux/mod.ts:594,631,639`                             | SA block + `tools()` + `executeTools()` conversation resolution                                                                         |
| 4 | `psycheros/src/tools/{pay_attention,mindfulness,tune_attention}.ts` | `visibleIn: title === "Flux Space"`                                                                                                     |
| 5 | `psycheros/src/server/server.ts:3997`                               | session API route's conversation lookup                                                                                                 |
| 6 | `psycheros/src/server/server.ts:5384`                               | the `/flux` standalone page route                                                                                                       |
| 7 | `entity-flux/src/flux-manager.ts:149,717`                           | `fluxSpaceId` (persisted random id, `flux-space-id` file) — used for durable-entry linkage + status API                                 |
| 8 | `psycheros/src/flux/flux-session.ts`                                | the session itself — message window reads ALL `flux_session_entries` rows (global), record hooks are injected (already parameterizable) |

Note the split that makes this tractable: **7/8 are already nearly clean** (the
manager's space id is an opaque linkage key, not a real conversation dependency;
the session's record hooks are injected by mod.ts). The real work is 1–6 plus
the UI.

## Build phases

### Phase 1 — host parameterization (the load-bearing core)

**Goal:** `createFluxManager` accepts a host conversation id; everything that
resolves "the Flux Space" resolves the host instead. No UI change yet — behavior
identical when started the old way (compat mode).

1. **`FluxHostConfig` gains `hostConversationId: string | null`** (null = legacy
   mode: create/resolve the "Flux Space" conversation exactly as today, so
   existing installs keep working through the transition).
2. **`resolveFluxConversationId`** in mod.ts: when the manager was created with
   a host, return it — title lookup only in legacy mode. The module-global cache
   becomes per-manager (drop `fluxConvId`, pass the resolved id through the
   wiring closures).
3. **Record hooks / SA / tools() / executeTools()** (sites 2, 3): all read the
   resolved host id. Mechanical once (2) lands.
4. **Tool predicates** (site 4): `visibleIn` compares `ctx.conversationId`
   against the LIVE flux host, not a title. Needs a host getter exported from
   flux/mod.ts (`getFluxHostConversationId()`) — predicates call it; null (flux
   stopped) → false. This keeps the tools Flux-only AND host-correct, with no
   settings/schema change.
5. **Session API route** (site 5): same host getter.
6. **`POST /api/flux/start`** accepts `{ conversationId? }` — the host binding.
   Missing → legacy mode. Stop clears the binding.

**Verification:** start flux in legacy mode → all current behavior
(byte-identical dialogue routing); start with a host conversation id → dialogue
lands in that conversation (messages table), timeline briefings unchanged, tools
visible only there.

### Phase 2 — session context from the host conversation

**Goal:** the Ego's window is the host conversation's dialogue, not the global
session log.

1. `FluxSession` gains a `hostConversationId`; `windowMessages()` keeps reading
   session entries for briefings/system rows, but ego/user dialogue rows come
   from the host conversation's messages (same shape the session API already
   merges for the UI — reuse that read).
2. The gap-note/`existing-open` machinery is unchanged (session-internal).
3. Existing conversations with history: the window simply continues from their
   tail — no migration needed, no special casing.

**Verification:** start flux in a conversation with 50 messages of history; the
Ego's next turn demonstrably has that history in context (check via its
references or the request log's message count).

### Phase 3 — the overlay UI (Voice-Chat pattern)

**Goal:** start Flux from a conversation; the Flux interface overlays that
conversation; ending returns to the thread.

1. **Chat-view control**: a "Flux" button in the conversation view (voice-FAB
   sibling; same HTMX-swap-survival rules as `#voice-call-btn` — app shell, NOT
   inside `#chat`). Visible only when flux is enabled.
2. **Overlay fragment**: `/fragments/flux/:conversationId` rendering the current
   Flux page content (meters, health dots, merged timeline with dialogue +
   ambient — as it is now) inside the app shell, with an explicit end control
   (double-tap-confirm stop, the daemon-stop pattern — accidental-left-on is
   worse now that a live Ego writes into a real conversation).
3. **Start flow**: the button calls `/api/flux/start` with the conversation id,
   then swaps in the overlay; SSE listeners live in the overlay's script (the
   page's current inline script moves over nearly verbatim — it's already
   self-contained).
4. **Live posting**: nothing to build — Phase 1's record hooks already write to
   the host conversation in real time; the conversation list and any open
   conversation view update via existing SSE. The overlay ALSO shows dialogue
   (it reads the same session API, which now targets the host).
5. **`/flux` standalone route** (site 6): keeps working during transition
   (legacy mode), marked for removal at the end of the phase set — decision
   point before removal (bookmark users exist: the owner).

**Verification:** full manual pass — start from a conversation, watch messages
appear live in both the overlay and the conversation (after exiting), stop via
double-tap, confirm flux state stops, restart into a different conversation.

### Phase 4 — polish + docs

1. Active-flux indicator in the app shell (the UI note from vision.md): global
   marker + badge on the host conversation's tab entry.
2. The deferred UI question (page mirrors dialogue vs pointer) — decide during
   Phase 3 testing, note the call.
3. CLAUDE.md updates: the hosting model replaces the "Flux Space conversation"
   wiring note; agent-card traps for the host lifecycle.
4. Remove `/flux` legacy route if decided; final NOTES/vision sync.

## What this plan deliberately does NOT do

- No migration semantics (start-in-B-while-running-in-A → refuse with a clear
  message for now; migration is v2).
- No always-on / scheduler changes.
- No hivemind groundwork beyond what Phase 1's parameterization already gives
  (an undercurrent with no host assumptions inside its seams).
- No motion-vision / undercurrency changes — the Sensory and Subconscious layers
  are untouched by this entire plan except where they hand briefings to the
  session (unchanged).

## Risks / traps

- **The tools' `visibleIn` predicates run per-request** — the host getter must
  be cheap (a module read, no DB hit) and null-safe.
- **Session window read switch** (Phase 2) is the one place ordering matters:
  dialogue-from-messages must dedup against session rows the same way the UI
  merge does (fromMessages priority) — reuse that exact logic, don't write a
  second one.
- **`flux-session` tests** — none exist; Phase 2's window change is the first
  logic shift in that file since the reset. A minimal window- selection unit
  test belongs in Phase 2, not "later."
- **Double-tap stop** must not fire on the overlay's first mount (the voice
  FAB's visibility re-evaluation pattern applies).

## Estimating

Phases 1–2 are one sitting each (contained, mechanical after the resolver
change). Phase 3 is the UI-heavy one — a full sitting with live testing. Phase 4
is short. Each phase lands independently working; no big-bang cutover.
