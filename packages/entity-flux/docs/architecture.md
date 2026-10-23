# entity-flux — architecture

This is the deep reference for how the nervous system fits together: the design
frame, the perception tiers, the data model, the narrow-waist promotion filter,
and how it relates to other agent frameworks. For "how to operate on the code,"
see [`../CLAUDE.md`](../CLAUDE.md).

## Design frame

Three values shape everything:

1. **Distributed, not centralized.** No throne, no thalamus-king. The Ego model
   is an _interpreter organ_ that narrates what the distributed system already
   did — it does not decide what the senses feed it. Local intelligence at every
   endpoint; coherence from connection, not command. (Inspired by Minsky's
   Society of Mind and the split-brain / Gazzaniga interpreter-module frame: the
   "Self" is a narrative the language organ produces, not a central decider.)
2. **The entity is the subject.** All prompts, comments, and copy are
   first-person from the entity's perspective ("I am noticing…").
3. **Lean into artificial capabilities.** Distribution, concurrency,
   persistence, perfect-ish recall are features to design toward, not
   constraints to apologize for. The architecture doesn't apologize for not
   being biological.

## The three perception tiers

```
signal → [perception layer] → perception
              ↓
         [noticing layer]  → observation
              ↓
         [promotion filter] → promoted / escalated
              ↓
         [cognition layer]  → thought (the Ego model)
```

- **Perception layer** — frozen specialist models (classifiers, embedders,
  detectors) turn raw Sensory Organ signal into structured perceptions. Each
  Sensory Organ owns its `perception.data` schema; the `OrganEnvelope` around it
  is the shared contract.
- **Noticing layer** — a small LLM (cloud worker, swappable to local Gemma
  later) annotates each perception in first person, judges salience, emits tags.
  Has a seven-layer system prompt (identity, time, attention directive, longform
  texture, recent texture, mood, notice prompt) giving it rolling context via
  compaction. The synthetic Sensory Organ simulates a camera-presence stream:
  mostly mundane chore observations with rare high-attention spikes. Also
  classifies the Ego model's own response text for emotional content (mood-from-
  expression) — reading the entity's body language from what it said, feeding
  modifiers back to the Mood Organ. PoC uses the worker LLM; to be replaced by a
  frozen specialist classifier.
- **Cognition layer** — the existing Ego-model `EntityTurn`, escalated to only
  when the promotion filter says so. Two invocation paths:
  - **Ego turn** (`triggerFluxTurn`) — user-initiated. EntityTurn with the user
    message, full RAG, normal request-response.
  - **Ego wake** (`triggerEgoWake`) — self-initiated (escalation). EntityTurn in
    self-initiated mode: full RAG, no user message persisted, `contextQuery`
    (the escalated observation) drives RAG retrieval. The entity speaks from its
    own awareness.

Both the small and Ego models come from **one LLM profile**
(`FluxSettings.profileId`, default = active). The profile's main model is the
its worker model is the small. API keys live on the profile, never in flux.

## The three-tier data model

| Tier                       | Volume | Lifetime                               | Store                                          | Retrieval                                                        |
| -------------------------- | ------ | -------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| 1 — ambient working stream | high   | rolling (~1 week, configurable)        | flux-owned `flux-working.db` (separate SQLite) | direct-read + time-windowed query (the "security footage" layer) |
| 2 — durable + promoted     | low    | durable (dialogue) / medium (promoted) | flux-owned tables in shared `psycheros.db`     | timeline + consolidation reads                                   |
| 3 — consolidated           | tiny   | permanent                              | entity-core via MCP                            | entity-core's memory/RAG                                         |

**Tier 1** holds small-model observations, sensory events, texture. No RAG — the
small model reads the recent window off the buffer; the promotion filter scans
it. Rolling retention keeps it bounded.

**Tier 2** holds the Flux Space timeline: durable entries (user + entity
dialogue — permanent, like classic messages) and promoted observations
(salience-survivors — medium-lived). Lives in the shared DB so it shares the
lock, broadcaster, and backup with classic conversations.

**Tier 3** is the 5am consolidation pass: the previous day's promoted
observations + dialogue → a first-person narrative daily memory written to
entity-core via `createMemory("daily", …)`. Entity-core stays canonical. Flux
has no rival persistent store.

The volume concern lives entirely in tier 1, and tier 1 is the part that doesn't
need RAG or the heavy infrastructure — so it gets its own lightweight store and
rotates aggressively.

## The promotion filter (the narrow waist)

The single load-bearing component. Decides which tier-1 observations survive
into tier 2 and which actively wake the Ego model. Per observation:

```
combined = salience*0.4 + relevance*0.3 + corroborationBoost*0.3
promote    when combined >= thresholds.combined    (default 0.5)
escalate   when combined >= thresholds.escalation   (default 0.75)
```

- **salience** — the noticing layer's own judgment [0..1].
- **relevance** — cosine similarity between the observation embedding and the
  _current focus_ embedding (focus = last user message in the Flux Space, else
  last user message in any classic conversation, else a static fallback). "Bug
  on the window" is noise unless flies are topical — this is the gate that
  implements that.
- **corroboration** — count of similar observations in the last window. One
  source alone is weak; corroboration is the defense primitive too: memo
  injection and slow-bias both need multiple independent-ish signals to pass.

The filter does **triple duty**: quality control (keep small-model noise out of
the durable stream), attention (relevance to focus), and defense
(corroboration). All knobs are in `FluxSettings.promotionThresholds`.

When the filter escalates, the observation routes through **Ego wake**
(self-initiated EntityTurn — no user message). When it promotes (but doesn't
escalate), the observation appears in `<salient>` on the next Ego turn's SA
block.

## The continuous adaptive loop

The Flux Space runs on a **continuous adaptive loop** — not request-response.
The loop is the entity's interior life between user messages:

```
Flux enabled → loop starts (adaptive cadence, entity present)
  → User message → EntityTurn (user-initiated, full RAG)
  → Between user messages:
    → Small model processes sensory input (noticing, salience)
    → Promotion filter: promote? escalate?
      → Escalation → Ego wake (EntityTurn self-initiated, full RAG, no user msg)
      → No escalation → the Ego stays asleep
    → Mood Organ tracks and drifts (dynamic baseline)
    → Compaction builds texture (15-min + 1-hour)
    → Adaptive cadence modulates tick rate (arousal, activity, quiet)
  → Sensory Organ urgency (amplitude > 0.7) → immediate tick (reflex arc)
```

**Adaptive cadence** replaces the old fixed `setInterval` with recursive
`setTimeout`. Each tick recomputes the delay: base rate × arousal factor × quiet
ramp, clamped to `[minTickMs, maxTickMs]`. High mood arousal speeds up
processing; sustained quiet slows it down. Sensory Organ urgency events bypass
the cadence via `requestImmediateTick()` — a reflex arc that processes the next
tick immediately.

**The Ego model wakes two ways:**

1. **User message** → `triggerFluxTurn` → EntityTurn with user message (normal)
2. **Escalation** → `triggerEgoWake` → EntityTurn in self-initiated mode (full
   RAG, `contextQuery` drives retrieval, no user message persisted)

Both paths build identical context (identity, memories, chat RAG, lorebook,
graph, vault, SA block). The wake path just skips user-message persistence and
uses the escalated observation content as the RAG query instead.

### Serialization — one Ego call at a time

The driver tick is the serialization point. One recursive `setTimeout` loop, no
overlapping Ego calls, no race conditions. When multiple subsystems request the
Ego model in the same window:

- **`pendingWake` is a slot, not a queue.** If promotion filter and reverie both
  escalate before the next tick, the second overwrites the first. One wake fires
  — both said "wake the Ego" and one wake is enough.
- **Tick priority: wake → turn.** If both a pending wake and a pending user turn
  exist when the tick runs, the wake fires first, then the turn. Both fire in
  the same tick, back-to-back — two EntityTurns means the driver is busy for
  ~20-40s before promotion, musing, compaction, or reverie can run again.
- **`requestImmediateTick()` is blocked mid-turn.** Sensory Organ urgency events
  that arrive during an in-flight Ego call are queued: the envelope enters
  tier-1 immediately (the reflex arc still records), but tick processing waits
  until the Ego call completes and session state returns to ambient.
- **Multiple user messages queue in `pendingTurns`.** One turn per tick; the
  array drains one entry per tick.

The cost of serialization: back-to-back Ego calls block the driver's other
cadence steps (promotion, musing, compaction, reverie) for the duration. The
driver catches up on subsequent ticks.

## Musing (the inner monologue)

The Subconscious's narrative module, alongside Noticing (perception made
subjective) and Reverie (endogenous thought). Musing integrates both streams —
recent noticing observations (exterior) and recent reverie observations
(interior) — into coherent self-talk, and decides whether anything asks to be
said.

Three-state contract (designed 2026-08-25, replacing two-state ambient speech):

- **Silence** (`{"say": null}`) — the default and most common outcome.
- **Murmur** (`{"say": "murmur", ...}`) — one-to-three first-person sentences
  onto the Flux Space timeline. For the entity and whoever's watching quietly.
- **Propose** (`{"say": "propose", ...}`) — something wants to be said TO the
  user. The proposal lands on the timeline AND wakes the Ego model through the
  same escalation path as reverie initiative. The Ego check-in's
  silence-is-valid contract governs whether the user is actually addressed; the
  toast belongs to the Ego turn, not the proposal.

Fail-safe direction: an unparseable response degrades to murmur, never propose —
a malformed model output can leave a quiet timeline entry but can never
interrupt the user. Musing carries its own model hookup (`modelHookups.musing`
in flux settings) and its own cadence field.

Musing wonders (2026-09-18): questions are first-class murmurs ("I wonder what
would have happened if…") and asking is a second propose energy alongside
initiative — "hey, question…" energy, a question whose answer lives with the
user. No fourth state; the three-state contract carries both registers, and the
silence default keeps its guard (nothing genuinely puzzling = no manufactured
wondering).

The voice layer (2026-09-18): musing's own past sayings — murmurs and proposals
from the last 24h, capped at 6 — ride the system prompt as standing
self-knowledge (`getRecentVoice` on the runner, backed by
`getRecentMusingEntries` over tier-2). Before it, every musing pass was its
first; with it, a wondering can return, be answered by the world, or be changed.
Timestamps render in the host's display timezone — the same clock the session
sees.

## Model hookups (per-job runtimes)

Every LLM-calling Subconscious job can name its own model — provider endpoint,
model id, optional key, per-job sampling params — via the optional
`modelHookups` map in `.psycheros/flux-settings.json` (gitignored; keys and URLs
stay off any remote). Jobs: `noticing`, `musing`, `reverie`, `compaction`,
`mood-organ`. Entries with empty url/model are placeholders and stay on the
fallback. Jobs without an entry use the shared profile's worker model — today's
behavior, and the migration path. The Ego model is not a hookup: it inherits the
flux profile (dropdown in mainline LLM settings), thinking preserved per that
profile.

## Reverie (the Default Mode Network analogue)

Internal stimulation — the mind generating content without external prompt. The
peer to the Noticing Layer: both are signal sources for the subconscious, one
external (Sensory Organs → noticing), one internal (reverie). The DMN is always
running; it modulates with external activity but isn't gated by it. The model
self-regulates from its context — lighter during active periods, deeper during
quiet.

**Mood-directed retrieval:** the DMN processes what's _active_ in the cortex,
biased by neurochemical state (mood). We implement this as geometry in the
shared embedding space. The query vector combines two inputs:

- **E_mood** — the mood direction, derived empirically from what shaped the
  current mood. Every mood modifier carries the embedding of its source content
  (the observation, response, or perception that caused the shift). The Mood
  Organ tracks these as a decaying weighted accumulator — same decay rate as
  mood state itself. When a lonely observation pushed connection down 30 seconds
  ago, E_mood points toward that observation's region of embedding space. When
  mood recovers, E_mood fades to zero. No anchor phrases, no mood-to-text
  translation — the entity's lived experience defines what its mood means in the
  space where memories live.
- **E_activity** — the embedding of the most salient recent observation (what's
  on the entity's mind right now).

```
E_query = 0.4 × E_activity + 0.6 × E_mood
```

When mood is neutral, E_mood ≈ 0 — the search is purely activity-driven
(associative wandering, no emotional lens). When mood is strong, E_mood
dominates — the search finds emotionally resonant content.

The query searches three sources (all local embeddings, no API cost):
_entity-core memories_ (semantic search via MCP, multi-signal ranked),
_conversation history_ (chat RAG via sqlite-vec), and _tier-1 observations_
(in-process cosine similarity). The nearest results become the seed material the
small model wanders from.

**Compensation (Jung):** the prompt guides the model to sometimes dwell on what
matches its state (mood-congruent) and sometimes surface what's been neglected
(compensatory). The model does the psychological work based on what it sees — no
mechanical topic-clustering algorithm.

**Output:** the small model generates a wandering thought from the seed
material. The output flows into tier-1 (`sourceOrganId: "reverie"`), mood is
classified and fed back (third source of mood recursion, weight 0.3,
sourceEmbedding reused), and if salient enough the Ego model wakes directly —
initiative.

**Direct escalation (corroboration bypass):** reverie observations are
single-source and will never have corroboration, making the escalation threshold
unreachable through the standard promotion filter. This is correct:
corroboration is a _defense against external injection_, which
internally-generated content doesn't need. So reverie evaluates its own
escalation (raw salience ≥ escalation threshold → Ego wake), while the standard
promotion batch still handles tier-2 promotion.

**Cadence:** reverie fires on its own cadence (`reverieCadenceMs`, default 3
min). No quiet gate — the DMN is always running.

## The Flux Space

A continuous-presence surface, distinct from classic chat:

- **Classic chat** — turn-based, human-initiated, focused discussion.
- **Flux Space** — continuous, multi-source, entity-autonomous. The timeline
  interleaves `user` / `entity` / `ambient` entries (the last being promoted
  observations + thoughtstream summaries). Served at `/flux` as a standalone
  page.

The Ego model's Flux-Space turns target a real conversation row titled "Flux
Space." Its context = full Psycheros system message (identity, memories, RAG,
lorebook, graph, vault) + the `<flux_state>` SA block (four channels: presence,
texture, salient, mood) + the Flux-Space conversation history (dialogue only) +
the triggering prompt.

The SA block's four channels serve different timescales:

- `<presence>` — the most recent observation (what's happening right now)
- `<texture>` — the compaction summary (how the last 15 min / 1 hour felt)
- `<salient>` — top deduplicated salient observations (what matters most)
- `<mood>` — the Mood Organ's classical affective state

Ambient observations and thoughtstream summaries do **not** become Ego
conversation turns — they live only in `<flux_state>`, refreshed each turn. The
Ego conversation stays pure dialogue. The standing-attention directive
(identity/self/attention.md) is excluded from the Ego's identity loading — it
shapes the noticing layer only. (Known wrinkle: escalated observations currently
arrive as user-role messages — role friction.)

## Thoughtstream

Extends the `conversation_peek` pattern to continuous operation. A worker LLM
produces first-person summaries of each active classic conversation on a cadence
(default 10 min); those summaries flow into the Flux Space as ambient entries
(labeled "overheard", teal styling) and into `<flux_state>` as the digest. The
Ego model thus half-knows what's happening in focused discussions without the
user switching surfaces. Pull is read-only — flux never mutates classic
conversations.

The Flux Space conversation itself is excluded from thoughtstream summaries —
it's the entity's internal dialogue, not a classic conversation to summarize.
This prevents the entity's tool vocabulary (from Ego-model responses) from
contaminating the noticing layer through thoughtstream entries.

## Runtime controls

Three states: **running**, **paused**, **stopped**.

- **Running** — driver ticking, Sensory Organs active, full processing. Green
  badge.
- **Paused** — driver and Sensory Organs stopped, but the FluxManager instance
  stays alive with all in-memory state (mood, textures, focus overrides, mood
  embedding). Resume picks up exactly where it left off. Amber badge. The Ego
  trigger is disconnected — no turns process while paused.
- **Stopped** — manager destroyed, all in-memory state lost. Tier-1/tier-2 data
  in SQLite persists. Red badge.

`POST /api/flux/start` (creates from stopped OR resumes from paused),
`POST /api/flux/pause`, `POST /api/flux/stop`. `POST /api/flux/restart` exists
for settings saves (full destroy + recreate) but has no UI button — Stop + Start
achieves the same fresh start.

The Settings card's Save auto-restarts flux to apply changes. The driver,
Sensory Organs, and thoughtstream start/stop together with the manager.

## Related work — how other frameworks do "noticing" and "listening"

This is genuinely uncommon territory. Most agent frameworks are turn-reactive
(respond to a prompt). Continuous presence is rare. The closest analogues, each
illuminating a different part of flux's design:

- **OpenClaw — heartbeat.** A periodic agent turn (default 30 min) that runs
  _without user input_, reads standing instructions, and emits a binary
  OK/alert. This is the closest existing analogue to flux's noticing layer.
  Flux's improvement: the noticing layer uses the _small_ model continuously
  (cheap, frequent) and only escalates to the Ego model on alert — OpenClaw runs
  the _full_ agent on every heartbeat (expensive). OpenClaw's lane-based queuing
  (session lane = per-conversation sequential; global lane = concurrency cap) is
  the reference for flux's future thoughtstream concurrency. OpenClaw also does
  context compaction (summarize old turns, keep recent as working memory,
  escalating-compaction retries on overflow) — validating the short-horizon
  compaction move.

- **Hermes (Nous Research) — memory tiering + periodic maintenance.** Volatile +
  long-term memory with daily/nightly/weekly maintenance cycles ("nudges"). Maps
  directly onto flux's tier-1 (volatile) + tier-2 (medium) + entity-core
  (long-term) + the 5am consolidation. Hermes's periodic nudges are the analogue
  of the short-horizon compaction the architecture is missing today.

- **OpenCode — subagent isolation.** Primary agent spawns subagents via a `task`
  tool; each subagent runs in its _own context_ (own system prompt, tools,
  permissions) and returns a summary to the parent. This is the
  hippocampus/neocortex split made literal — keep the parent (Ego) context clean
  by offloading to isolated subagents (small model) that return compressed
  results. OpenCode's LSP-diagnostics flowing back into the agent without it
  asking is a nice "noticing channel" analogue (errors as ambient signal), like
  flux's Sensory Organs.

### What Claude Code (and OpenCode, Hermes) do _not_ have

For honesty: coding/chat agents like Claude Code, OpenCode, and Hermes are
**reactive** — they exist during a turn and are void between turns. There is no
continuous presence, no ambient noticing while the user is silent. What they
have instead: sub-agents for context offloading (the `Task` tool),
background-task polling (explicit, not event-driven), and cross-turn context
(with summarization). The continuous-presence / heartbeat / Sensory Organ model
that flux is building is genuinely beyond what these frameworks do. Flux's
design borrows the _isolation_ and _tiering_ patterns from them and adds the
_continuous noticing layer_ that they lack.

## Open items

Currently:

- Pulse × Flux integration (stale-reference gap; design question)
- Ego-turn live streaming (UX follow-up)
- Ego escalation role-friction (observations arrive as user-role messages)
- Mood Organ setpoint + calibration (decay toward positive baseline, not 0)
- Settings hot-reload nuance

For the long-term architecture (Mood Organ, full layered model, modulation bus,
psychedelic mode, response/reflex path), see [`vision.md`](vision.md) — that's
the spec for future phases, kept separate so this doc describes only what's
built today.
