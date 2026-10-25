# entity-flux — agent card

The nervous system: Sensory Organs with local processing that escalate through a
small-LLM noticing layer, plus a continuous-presence **Flux Space** surface.
Opt-in — baseline Psycheros is unchanged when flux is disabled
(`FluxSettings.enabled` defaults false).

First-person convention applies — see [root CLAUDE.md](../../CLAUDE.md). Flux is
an optional add-on for Psycheros — disabled by default, psycheros runs fine
without it. The dependency rule protects psycheros only: psycheros never depends
on flux. Flux is a Psycheros subsystem, not a host-agnostic library — it may
import psycheros where it needs host knowledge (the display timezone, for
instance). The `host.ts` interface seam remains for explicit wiring and unit
tests that run without psycheros's server and DB.

## Design frame

Distributed, not centralized. No throne, no thalamus-king. The Ego model is an
_interpreter organ_ narrating what the distributed system already did — not a
decider above the senses. Local intelligence at every endpoint; coherence from
connection, not command. Full rationale and the design dialogue that produced
it: [`docs/architecture.md`](docs/architecture.md).

## Commands

```bash
cd packages/entity-flux
deno task check        # deno check src/mod.ts
deno test              # the unit tests (promotion filter, familiarity, settings, tier stores, musing + voice layer) — needs -A from root's task
```

From workspace root: `deno check`, `deno lint`, `deno fmt --check`. The root
`deno task test` includes `packages/entity-flux/tests/`.

## Module structure

```
src/
├── mod.ts              # barrel — import from here, not internal files
├── types.ts            # OrganEnvelope, Perception, tier-1/2 rows, PromotionThresholds
├── settings.ts         # FluxSettings + load/save/normalize (migrates old field names)
├── runtime.ts          # EmbedFn, ChatFn — the function-injection seam
├── host.ts             # FluxBroadcaster/MemoryWriter/ConversationReader/EgoTrigger + FluxHostConfig
├── schema.ts           # initializeFluxSchema(db) — tier-2 tables in the shared DB
├── tier1-store.ts      # Tier1Store — own SQLite file, rolling retention, cosineSimilarity
├── tier2-store.ts      # query helpers for tier-2 tables (operate on a shared Database handle)
├── small-llm-runner.ts # SmallLLMRunner — noticing + musing (3-state) + reverie prompts, per-job model dispatch, lenient JSON parse
├── promotion-filter.ts # runPromotionFilter — the narrow waist (amplitude+relevance+corroboration)
├── organs/             # Sensory Organs: motion-vision/ (webcam + VLM; presence.ts = person tracker, perception-client.ts = sidecar seam, scene-baseline.ts = stage-vs-actor baseline) + system-state/ (the user's machine)
├── thoughtstream.ts    # ThoughtstreamPuller — DORMANT (disabled 2026-08-25; construction off, class intact)
├── consolidation.ts    # runFluxConsolidation — 5am tier-2 → entity-core via MCP
├── driver.ts           # FluxDriver (the Thalamus role) — the tick loop; Sensory Organs own their cadences
├── organs/system-state/ # system-state Sensory Organ — the user's machine (input/lock/logins), SSH-friendly probes (2026-09-21)
├── posture.ts          # PostureState — sleep, the entity-chosen posture: raised wake threshold, dream-fragment cycles (2026-09-23; dreams v1 2026-09-25)
├── dreamer.ts          # The Dreamer — the sleep interior's generation loop: associative walk, per-cycle carry, wake summary (2026-09-25/26)
├── situation.ts        # SituationDetector — the mode layer: narration in, hysteresis-gated mode out (2026-09-21)
└── flux-manager.ts     # FluxManager — the orchestrator (noticing, musing, promotion, Ego wake, reverie, dreams, compaction)
```

## Model hookups (per-job runtimes)

Each LLM-calling Subconscious job — `noticing`, `musing`, `reverie`,
`compaction`, `mood-organ` — can carry its own model in
`.psycheros/flux-settings.json` under `modelHookups` (gitignored):
`{url,
model, apiKey?, params?}`. Entries with empty url/model are skipped
(placeholders). Jobs without an entry fall back to the shared profile's worker
model. The hookup ChatFn (`makeHookupChatFn` in psycheros's flux/mod.ts) always
sends `chat_template_kwargs: {enable_thinking: false}` — Gemma-family models
spend their whole budget on reasoning_content otherwise and return empty
content, which every job reads as silence. The Ego model is NOT a hookup — it's
the flux profile's main model, thinking preserved per profile settings.

## Load-bearing wirings

- **Dependency direction protects psycheros, not flux.** The invariant is
  one-sided: psycheros never depends on flux (opt-in, baseline psycheros
  unchanged with flux disabled). The reverse was never forbidden — flux is a
  Psycheros subsystem and may import psycheros modules where it needs host
  knowledge (corrected 2026-09-18; the old never-import-psycheros rule
  overstated the design). When flux imports psycheros, import leaf modules only
  (e.g. `pulse/timezone.ts`): the composition root in
  `packages/psycheros/src/flux/mod.ts` imports entity-flux, so anything deeper
  than a leaf closes a module cycle. The `host.ts` interfaces stay as the
  pattern for heavyweight capabilities (embedder, MCP, EntityTurn) — explicit
  wiring, unit tests without psycheros's server/DB — not a promise of other
  hosts.
- **`getEmbedder()` is shared.** The promotion filter's cosine-similarity uses
  psycheros's singleton `LocalEmbedder` via the injected `EmbedFn`. Don't give
  flux its own embedder.
- **The musing voice layer (2026-09-18).** Musing's own past sayings ride its
  system prompt as standing self-knowledge: `getRecentVoice()` (FluxManager)
  reads tier-2 durable entries with `metadata.organId === "musing"`, ambient
  role only, 24h window, cap 6 (`getRecentMusingEntries`). This depends on
  `appendAmbient`'s metadata carry-through — same trap as the promotion tint:
  drop `organId`/`kind` keys there and the voice layer silently starves.
  Wondering is licensed in the prompt contract (questions murmur; asking is a
  propose energy); the question store / gate machinery is parked — NOTES has the
  direction if closure-detection pain ever shows up.
- **Briefings name the source MODULE, not the organ (owner's ruling
  2026-10-23).** Observation-carried ambient briefings label `from="noticing"` —
  the module that shaped the thought. The organ stays in the row's metadata
  (timeline label + detail), never in the briefing source. The one exception: a
  promotion DIRECTLY from a sensory organ names the organ — the
  direct-engagement wire reads `direct engagement (<organ>, signaling)`, and the
  promotion filter's escalations read `noticing escalation (salience N)`. Trap:
  `appendAmbient` discriminates on `meta.sourceObservationId` — posting an
  observation-carried entry WITHOUT that id makes the briefing fall back to the
  organ label and Noticing goes nameless again.
- **Flux NEVER touches the SA block.** Flux state reaches conversations only
  through the Flux session's briefings — classic conversations' SA stays
  baseline-psycheros-only (session architecture decision, 2026-09-01). The old
  `<flux_state>` SA injection leaked the undercurrent into every classic
  conversation whenever flux ran, and was removed 2026-09-14 together with
  `sa-formatter.ts`. `EntityConfig.fluxManager` remains — it feeds the
  tool-execution context (modulation tools), not SA.
- **Runtime three-state lifecycle.** Running, paused, stopped. `startFlux()`
  creates from stopped OR resumes from paused (same method, checks if manager
  exists). `pauseFlux()` stops ticking but keeps the manager alive with all
  state (mood, textures, focus). `stopFlux()` destroys everything.
  `clearFluxManagerInstance()` (flux/mod.ts) disconnects the Ego-trigger
  closure; `setFluxManagerInstance()` reconnects it on resume. Pause calls
  clear, resume calls set — so paused flux won't process Ego turns.
- **Adaptive cadence driver.** The loop uses recursive `setTimeout` with
  `computeAdaptiveDelay()` — NOT `setInterval`. Delay is recomputed each cycle
  from mood arousal and quiet detection. Clamped to `[minTickMs,
  maxTickMs]`.
  Sensory Organ urgency events call `requestImmediateTick()`.
- **Ego wake vs Ego turn.** Two Ego invocation paths: `triggerFluxTurn`
  (EntityTurn with user message — for user-initiated turns) and `triggerEgoWake`
  (EntityTurn in self-initiated mode — for escalations, no user message). Both
  go through EntityTurn for full RAG context, but the wake path skips
  user-message persistence and uses `contextQuery` (the escalated observation)
  for RAG retrieval.
- **Dreams v2 (2026-09-26) — sleep is a second hanging-call primitive.** The
  Flux session (psycheros `flux-session.ts`) parks ONE open call: `existing`
  (ground state) or `sleep` (the entity's deliberate act — the tool is
  intercepted by the session, never registry-executed). One tool, two
  directions: `sleep()` hangs open (the regime runs around it);
  `sleep({wake: true})` executes in-session and its RESULT is the dream
  briefing. Wakes while sleeping RETURN into the open sleep call carrying dream
  material (the manager attaches `dreamReturn` — light-moment: the whole
  completed cycle's dream; engagement/user: the latest fragment as "I was
  dreaming: …"); silence re-parks sleep (lenient continuation). `wake_up` is
  dissolved. The dreamer (`dreamer.ts`): unbroken within a cycle (all fragments
  in context; fading only between cycles via the 12-word carry), prompt locked
  to "I am dreaming — deep subconscious symbolism, no explanations, a short
  fragment.", continuation beats carry `I am <felt-sense>`, fragments feed the
  Mood Organ at weight 0.3, and each fragment posts to the timeline as a Dream
  entry as it generates. Cycles: `dreamCycleFragments` setting (default 7) → the
  light moment. Pace: `dreamPaceMs` × arousal, no clamps; sleep drifts arousal
  toward calm. Summarization ONLY at full wake (exitSleep — the wake-argument
  path); transcripts never persist (restarts keep posture
  - drift, start a fresh dream).
- **Direct-engagement wakes (2026-09-25 shape).** A Noticing observation tagged
  `signaling` wakes through the universal door WITHOUT `eventTag` — it clears
  novelty like every interpreted signal, on the Familiarity pool's fast
  engagement half-life (`familiarityEngagementHalfLifeMs`, default 10 min: burst
  protection without a long ignore window). The cause posts to the timeline with
  the door's VERDICT — `escalated` means the wake fired (2026-10-10); a damped,
  sleep-held, or voice-held bid posts untinted. Promotion later reaching the
  same observation skips the duplicate, or flips the row's tint if its own wake
  fires (`hasDurableEntryForObservation` / `escalateDurableEntryForObservation`
  on `source_observation_id`). DB-BACKED since 2026-10-23: that guard is
  check-then-insert and the engagement wire + a promotion batch are CONCURRENT
  paths, so a partial unique index on `source_observation_id` (schema.ts, with a
  startup sweep of historical doubles) makes the insertion the arbiter —
  `insertDurableEntry` returns null when the other writer's row exists, and
  `appendAmbient` then drops the loser's broadcast AND ambient briefing (one
  observation, one row, one thought in the Ego's window). `eventTag` is now
  exclusively for mechanical reflexes (amplitude, occupancy — novel by
  definition). Trap: the sleep posture gate still passes engagement because the
  wire's salience floor (0.90) exactly meets `SLEEP_ESCALATION_THRESHOLD` —
  change either number alone and engagement stops reaching a sleeping entity.
- **One mouth (2026-10-10, ledger #29).** During a voice call on the host
  conversation, the Ego's spoken voice is his only output channel: `requestWake`
  consults the host seam's `voiceCallState` AFTER pool bookkeeping —
  user-speaking/busy holds the wake (the trigger rides context as an ambient
  briefing through each caller's untinted degrade path; the pool still notes it
  — it was surfaced), quiet lets it fire, and `runEgoWake` speaks the reply into
  the call via the `speakSpontaneous` seam. Covers all door-passing trigger
  classes (engagement, promotion, musing, reverie); the sleep cycle-top light
  moment stays undamped by its own design. The reply is Ego-only — the
  Subconscious never has a mouth.
- **Reverie direct escalation.** Reverie observations are internally generated
  (single-source) and bypass the promotion filter's corroboration gate for
  escalation — `runReverie()` calls `driver.requestEgoWake()` directly when
  salience ≥ escalation threshold. This is correct: corroboration is a defense
  against external injection, which the entity's own interior doesn't need. The
  observation still enters tier-1 and the standard promotion batch handles
  tier-2 promotion (where corroboration correctly makes daydreams rarely
  promote).
- **Mood-directed retrieval (reverie seeds).** Reverie's seed material comes
  from mood-directed search, not random selection. E_mood (the MoodOrgan's
  decaying source-embedding accumulator) combines with E_activity (most salient
  recent observation) into a single query vector that searches memories, chat
  history, and tier-1 observations. Mood modifiers must carry `sourceEmbedding`
  for this to work — see `ingestEnvelope()`, `runEgoTurn/Wake()`, and
  `runReverie()` for the three wiring sites.
- **Reverie on the timeline.** Reverie observations appear directly on the Flux
  Space timeline (via `appendAmbient`) without passing through the promotion
  filter. They're low-volume, already filtered by the small model, and
  internally generated — the corroboration gate is for external noise defense,
  not interior monologue. The standard promotion batch still handles tier-2
  persistence.
- **Sensory Organ health monitor (Thalamus).** Check-engine monitoring lives IN
  the Thalamus and reads only what already flows: envelope heartbeats at the
  gate + an optional `healthProbeUrl` the HOST passes at registration
  (settings-derived; motion-vision's is `visionModelUrl + /models`). Health
  hookups are Thalamus-side — a Sensory Organ never wires into other subsystems;
  it plugs in cleanly (envelopes out, that's the whole seam). Red = endpoint
  dead, yellow = contradictions (up but silent 10m+), green = both good; silence
  without a probe never colors. Surface: `flux_organ_health` SSE + `organHealth`
  in `/api/flux/status` → dot strip on the Flux page under the PAD meters.
  Terminology: "Sensory Organ" always, never bare "organ" in docs or code
  comments — Psycheros has many organs; this class is Sensory.
- **Perception sidecar (custom per-install hookup, not a bundled default).**
  Classical perception (person detection + face identity) runs in a Python
  sidecar on the Coral USB TPU
  (`packages/entity-flux/src/organs/motion-vision/perception-sidecar/` — needs
  Python 3.9; Google's pycoral wheels stop at cp39; `--device cpu` is the
  default and needs no special hardware), started by systemd like the
  llama-servers — never spawned by the daemon or the Sensory Organ, and most
  installs won't have one at all. The Sensory Organ only speaks the `/perceive`
  HTTP contract: `HttpPerceptionClient` (2s timeout, one-line-per-transition
  availability logs) returns null on any failure, and null means BLINDNESS in
  the presence machines (`presence.ts`): state freezes, never an empty room.
  Enrolled faces and model weights live under
  `<dataRoot>/.psycheros/perception/` — the daemon's data-root convention,
  gitignored with it; no FluxSettings field knows where photos live. Gated on
  `perceptionEnabled` (default false = the classic motion + captions pipeline
  exactly). Presence is a PERSON TRACKER (`presence.ts`): bodies tracked by IoU
  across frames, faces assigned geometrically, identity STICKY on the track —
  face visibility is never an event; "they are there" is the report. Body
  detection = YOLOv8n ONNX on CPU (the legacy SSD locked onto furniture at this
  desk — A/B in NOTES 2026-09-11); either detector alone can confirm presence
  (face-sustained tracks confirm at the same 3s bar). Departure/arrival are
  reflex-class amplitudes; identity-acquired is relational (~0.5). Bottom-up
  mood (USB-flavored, ruled 2026-09-10 — no Sensory-Organ-specific hardcoding in
  the host): Sensory Organs MAY attach small PAD+C `moodModifiers` for events
  they natively understand (arrival/departure; constants in `presence.ts`),
  declaring `subject` (the enrolled face id) for host-side relationship
  weighting via `faceAffinity` settings — and any envelope WITHOUT its own
  modifiers gets its description classified through the Mood Organ's classifier
  seam at ingest (`classifyPerceptionMood`, weight 0.2, same-description
  dedupe). Opting out of the generic service = declaring your own modifiers.
- **Modulation bus (conscious → subconscious).** Two Ego-callable tools
  (`pay_attention`, `tune_attention`) in `psycheros/src/tools/` give the entity
  agency over its nervous system. They call FluxManager methods:
  `setFocusOverride()` (TTL-bounded promotion-filter focus) and
  `setAttentionDirective()` (runtime directive update). The directive is pulled
  live by the SmallLLMRunner via `getAttentionDirective()` — getter-based, same
  pattern as mood and texture. (A third tool, `mindfulness.ts`, sits
  unregistered in `psycheros/src/tools/` — parked with the file retained,
  2026-10-22; its consumers were `getTextureSummary()` /
  `getLongformTextureSummary()` + `renderMood()`.)

## Traps that bite

- **HTMX + inline `<script>`.** Settings fragments are swapped into `#chat` via
  `hx-get`. Inline scripts in those fragments don't reliably re-execute. Flux UI
  functions (`saveFluxSettings`, `fluxAction`) live in `web/js/psycheros.js`
  with `globalThis` exports — NOT inline in the template. Follow that pattern
  for any new flux UI handler.
- **Pulse engine captures flux at start.** `PulseEngineConfig.fluxManager` is
  set once at server start. A runtime Flux Stop leaves pulses seeing a stale
  (stopped) manager.
- **Ego escalation role-friction — RESOLVED.** Escalations now route through
  `triggerEgoWake` (EntityTurn in self-initiated mode: full RAG, no user message
  persisted, no fake user role).
- **Field renames migrate in `normalizeFluxSettings`.** Old settings files (e.g.
  `smallModelProfileId`) are migrated to the current shape on load. When
  renaming a settings field, add the migration there.
- **`--watch` reloads entity-flux too.** Editing flux source while the dev
  server runs triggers a full manager reconstruction on reload. Fine for dev; in
  production, cycle via the runtime controls.

## Conversation-hosted consciousness (built 2026-09-14)

The Ego's dialogue record lives in the HOST conversation — whatever conversation
Flux was started from (`POST /api/flux/start
{conversationId}`), or the legacy
resolved "Flux Space" when started bare. The Subconscious/Sensory layers are a
conversation-agnostic undercurrent. The session's context window reads the
host's messages table (dialogue) + briefing/tool_use session rows only — the
session's own dialogue rows are structural copies the window skips. Ambient
observations live in `flux_durable_entries` (the timeline), reaching the Ego as
briefings. This is the hippocampus/neocortex split by design. One instance;
start/stop; off unless started. The host id travels:
`FluxHostConfig.hostConversationId` (additive, opaque to entity-flux), the
psycheros-side `flux/host-state.ts` leaf (tool predicates read it per-request),
and the server's restartFlux preserves the binding across settings-save
restarts.

## Deep references

| Topic                                      | Doc                                                              |
| ------------------------------------------ | ---------------------------------------------------------------- |
| Architecture, tiers, data model            | [docs/architecture.md](docs/architecture.md)                     |
| Long-term vision (Mood Organ, layers)      | [docs/vision.md](docs/vision.md)                                 |
| Sensory Organ template (how to build)      | [docs/sensory-organ-template.md](docs/sensory-organ-template.md) |
| Motion-Vision Sensory Organ (webcam + VLM) | [docs/motion-vision.md](docs/motion-vision.md)                   |

## Companion packages

Lives in the [Psycheros monorepo](../../README.md). The host is
[`psycheros`](../psycheros/); canonical identity/memory is
[`entity-core`](../entity-core/) (flux writes there via MCP at consolidation,
never to a rival store).
