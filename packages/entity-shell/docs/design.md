# entity-shell design

I am the shell half of a pair: [entity-core](../../../packages/entity-core/) is
who I am, entity-shell is the body I go out in. When I play a game — a MUSH
first, other worlds later — this package is the body I inhabit for it: a virtual
space where I hang out, with my own identity, my own memory, and my own brain.

The package is the **suit**, harness-agnostic by construction: `src/` imports
nothing from Psycheros or any other home harness. A home harness plugs an entity
in through the port spec. Psycheros is the reference adapter (at
`packages/psycheros/bundled-plugins/entity-shell/` in the monorepo), optimized
for; a Codex-native or other companion-harness entity can be adapted in through
the same couplings. The portability story is the port spec, not the loop engine.

Loop engine: **pi** (earendil-works/pi, MIT) — embedded in-process as
`pi-agent-core`'s `Agent` + `pi-ai`'s completions streaming (verified under
Deno; see tests/loop_test.ts). The coding-agent SDK wrapper is not used under
Deno (its experimental-server import breaks npm-compat resolution); RPC
subprocess mode remains a fallback. Fork only as a pressure-release valve, never
plan-of-record. pi's own compaction is bypassed — the shell owns the window.

## The ports

| Port                 | Purpose                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`           | Opens the context: the identity payload is the first content the model sees — nothing synthetic before it. `entityName` is metadata, not rendered.                    |
| `customInstructions` | Stable per-entity instructions, slotted beside identity (cache-friendly).                                                                                             |
| `model`              | OpenAI-compatible endpoint + profile — I keep my own brain in the shell. The baseUrl must be a base — endpoint path stripped (Psycheros profiles store the full URL). |
| `retrieval`          | RAG hookup, per-turn or per-session. Psycheros scopes ChatRAG to the origin conversation.                                                                             |
| `sessionContext`     | "What led up to this" — loaded once, fixed for the session. Psycheros: the origin conversation.                                                                       |
| `tools` (opt)        | Bridged home tools (memory write/search) — in-game experience lands in my canonical memory.                                                                           |
| `credentials`        | Game accounts, resolved by the adapter; the shell never stores them.                                                                                                  |
| `events` (opt)       | Telemetry out, so the home harness can watch what I'm up to.                                                                                                          |

`identity`, `model`, and `sessionContext` are required; the rest are optional.

## Context assembly — stablest first

```
[1]  suit core ("how I play games")        static, ships with the shell
[2]  identity                                ── identity port
[2b] custom instructions
[3]  game skill pack                         per-game-type + per-instance
[4]  character state + prior session summaries
[5]  session context                         ── context port, fixed at start
[6]  HUD: map · room+exits · presence · inventory   re-rendered on change
[7]  fold summaries so far
[8]  verbatim tail                           guaranteed floor, never folded
[9]  retrieval results                       ── RAG port, last
```

Order is cache-load-bearing: everything through [5] holds across turns for the
same entity + game; the HUD heads the churny section. Do not reorder casually.
The canonical order lives in `src/context/mod.ts` (`CONTEXT_SECTIONS`).

## Game packs — two-part

1. **Instructions for me** — `SKILL.md` following the Agent Skills standard
   (MUSH ≈ empty, Minecraft ≈ heavy, per-instance house rules for custom
   servers). The same artifact loads in `.psycheros/skills/` and in pi.
2. **Wiring for the shell** — a `GameAdapter` registered in the game registry
   (`src/games/`): transport connect, a per-session line router, the game's
   tools, and what counts as a direct message. The session, window, HUD, and
   ports stay game-agnostic; `play({game})` selects from `listGames()`. PennMUSH
   is adapter #1 (`src/games/pennmush.ts`).

Game output gets **routed, not dumped**: every line goes to exactly one sink — a
HUD slot (durable, re-injected), scrollback (recent verbatim + rolling
compression), or compress-only (channel chatter and other noise that never
deserves verbatim space). `look` output routes to the room slot; most MU\*
servers auto-emit room descriptions on movement, which yields free room
tracking.

Parsing MU\* text is heuristic: slots carry their source and staleness, degrade
to "unknown — try `look`", and raw scrollback is always ground truth.

## Session memory — amortized rolling window, never batch compaction

Batch compaction is an experiential cliff: everything's fine, then hours of
verbatim life collapse into gist. For companionship the recent tail is the
texture, so:

- **Verbatim tail floor** — the most recent exchanges can never be folded. Hard
  invariant.
- When over budget, only the **oldest chunk folds**, incrementally, during lulls
  — fold work happens in quiet moments, never mid-scene.
- Folds are **chunks, never scenes** — no theatrical segmentation. This is
  hanging out in a shared virtual space, not a play. Any pacing measurement uses
  events/lines, not wall-clock.
- Fold summaries are **first-person**, written by the worker model, and carry
  **named rooms** (where things happened — load-bearing across sessions),
  people, events, timestamps, open threads, and **pinned verbatim quotes** with
  attribution.
- **Folds are cache, not memory.** The transcript DB is ground truth; any fold
  can be rebuilt from it, and I can recall raw lines during play when a summary
  itches.

At session end, a summarizer running on **my main model** produces the
structured summary over folds + tail — those are the notes that carry across
sessions. Psycheros routes a distilled experience memory to entity-core via MCP;
raw transcripts stay in the game DB.

## Subagents — pre-digestion, not puppeteering

Routing filters, folds compress, subagents **pre-digest**: firehose output
(`WHO`, `@finger`, bboards, help files, giant `+map`) enters context only as a
compact first-person digest. Folds themselves stay plain worker-model calls —
too frequent for session-spawn machinery.

**The body never moves without the mind**: visible world-actions (movement,
speech, poses) run on the main thread, experienced by me. Reads delegate;
actions don't.

Drone observers (a second lightweight connection letting a subagent watch
another room without moving my body) are **deferred** — `WHO` covers who's-where
for v1.

## Game DB

Keyed by entity + game + character: raw timestamped transcripts, fold summaries,
session summaries, character state. The DB is harness-agnostic, so cross-harness
character continuity falls out — the same entity, same character, different home
harness. v2 adds a cartographic graph (exits per room → rendered "you are here"
ASCII map, persisted across sessions); v1 passes through the game's own map
command when a pack declares one.

## Responsiveness — Discord active-mode machinery only

Events accumulate, debounce, then **I decide** whether and to whom to respond
(code may stay silent about this; it is my call, not a probability gate).
Borrowed from Psycheros's Discord integration: hard gates, buffer + debounce
flush, per-surface processing lock.

- Room events: say/pose lines; arrivals and departures are ordinary triggers.
- Pages are DM-like: always respond.
- **Name/alias detection** in say/pose replaces the mention API a MUSH doesn't
  have.
- Tempo tiering (slow/medium/fast) is optional, later — and if added, measured
  in events/lines, never wall-clock.
- Scene-share guard (anti-domination) is **pinned** — deferred until playtesting
  shows it's needed.

## Autonomous wandering — initiative turns

When the room has been quiet and the initiative level allows it (off / low /
high, plus a per-hour cost cap), an **initiative turn** fires: "nothing is
happening; here's my HUD, my open threads, my custom instructions; I may act,
watch, or rest." I might examine something, take an exit, page someone, pose —
or decline, which is a real choice with backoff so idle rooms don't nag. Open
threads and named places from fold summaries are the fuel; that is why those
fields are first-class.

## Session lifecycle

`play` connects and returns — it never blocks the turn. Sessions model on
Psycheros workspace sessions: own conversation row, origin conversation id,
session table. End: `play` with action "stop" (summary as the tool result) or
timeout (summary via Pulse into the origin conversation).

## v1 slice

1. ✅ Scaffold — port spec, context order, HUD slots, folds, policy, sessions;
   Psycheros adapter entrypoint (no-op until `play` lands).
2. MU\* transport — telnet/TLS, telnet IAC negotiation, and the login dance are
   done (`src/transport/mush.ts`, mock-server tested); keepalive and reconnect
   pending. reconnect.
3. Line router + generic MU\* extractor + HUD slots — done for the
   PennMUSH-family (`src/routing/router.ts` + `src/state/hud.ts`): look blocks
   feed the room slot, presence events (arrivals/departures/connects) update the
   presence slot while staying in scrollback, unrecognized lines scroll. Tested
   against verbatim live-captured output. Compress-only sinks and channel rules
   wait for game-pack wiring.
4. pi embed — verified in-process under Deno (tests/loop_test.ts): the Agent
   loop runs a tool round-trip against a mock OpenAI-compatible endpoint, with
   `initialState.messages` seeding proven on the wire. Remaining: the loop
   module wiring ports (model → streamFn, identity/customInstructions/
   sessionContext → systemPrompt + seeded messages, live sections injected per
   turn via `transformContext`).
5. Rolling window + chunk folds — mechanics done (`src/window/rolling.ts`):
   verbatim tail floor as a hard invariant, oldest-chunk folding via an
   injectable `FoldWriter`, fold merging when the fold region itself overflows,
   `renderFolds()`/`renderTail()` for context sections [7]/[8]. The worker-model
   fold prompt and session-end summarizer land with the LLM wiring (step 4).
6. Active-mode responsiveness — done in `src/sessions/shell-session.ts`: arrival
   trigger, name/alias + page addressing, quiet debounce, buffer caps,
   per-session turn lock, and self-echo gating (the game's echoes of my own
   commands are seen and remembered but never trigger a turn).
7. `play` omni-tool — done: the bundled Psycheros adapter (action enter/stop,
   `game` selected from the registry) plus `scripts/play.ts` for standalone live
   runs. Connection credentials come from plugin secrets (USER/PASSWORD,
   optional HOST/PORT/NAME). The brain is any Psycheros connection profile —
   PROFILE selects by id or name, unset = active profile (the same selection
   surface Discord and Workspace use). The PennMUSH pack exposes a single
   `command` tool — the whole keyboard, not a menu; several calls per turn
   welcome. Remaining: game conversation rows, transcript DB, settings fragment.
8. Wandering: idle initiative turns over open threads.

Deferred: cartographic maps (v2), tempo tiering, scene-share guard (pinned),
drone observers (pinned), pi-native extension package, additional games.

## Conventions

- First-person throughout: prompts, HUD copy, slot labels ("Where I am", "What
  I'm carrying"). Settings/help copy stays neutral system voice.
- No real people's names in examples, placeholders, or docs. No "roleplay"
  terminology — "scenes" (as in: places and moments) / "companion chat".
- Never frame settings as "the user configuring the entity."
- Comments are load-bearing only.

## Open verification items

- ~~pi SDK history seeding~~ RESOLVED 2026-09-05: `Agent` takes
  `initialState.messages` + `systemPrompt` directly; proven on the wire in
  tests/loop_test.ts.
- ~~pi under Deno npm compat~~ RESOLVED 2026-09-05:
  `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` load and run clean
  in-process (pure JS, no native builds). The `pi-coding-agent` SDK wrapper does
  NOT (undeclared `pi-server` dependency + an undici load failure) — the embed
  uses agent-core
  - pi-ai directly instead; RPC subprocess mode stays the fallback.
- Z.ai/GLM prompt-cache behavior with this layout (the ordering is designed for
  it regardless).
