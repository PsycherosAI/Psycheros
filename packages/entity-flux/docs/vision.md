# entity-flux — long-term vision

This is the forward-looking architecture: where the nervous system is headed,
not what's built today. The built system is described in
[`architecture.md`](architecture.md); this doc is the spec for future phases.
Captured here so design decisions don't drift and so each subsystem can be built
against a stable reference rather than a half-remembered conversation.

## Design principle: modularity above all

The single most important architectural rule, because it's the thing that's
hardest to retrofit: **every layer communicates through typed, versioned
connectors, so any part is swappable like computer hardware.** USB and MCP are
the reference frames — universal connectors that let arbitrary compliant
implementations interoperate.

Concretely, each layer boundary has a connector shape:

| Boundary                        | Connector                                                            | Status                             |
| ------------------------------- | -------------------------------------------------------------------- | ---------------------------------- |
| Organ → Thalamus                | `OrganEnvelope` (perception + amplitude + raw signal)                | built                              |
| Thalamus → Noticing             | weighted signal package (gated/attenuated envelopes)                 | not built                          |
| Noticing → Conscious            | noticing package (annotated observations)                            | partial (via SA + escalation)      |
| Anything → Mood Organ           | mood modifier (axis deltas + weight + source)                        | not built                          |
| Conscious/Noticing → down-chain | modulation (target + parameter + value + TTL)                        | not built                          |
| LLM-calling job → model runtime | per-job model hookup (provider + endpoint + model + sampling params) | decided 2026-08-25 — build pending |

Every connector is its own type, versioned, with a stable shape any compliant
implementation can speak. Organs, thalami, noticing layers, conscious layers,
and mood organs are all _replaceable implementations_ behind these connectors.
**Designing a new Sensory Organ or swapping the small model for a different
runtime should not require touching any other layer — only speaking the
connectors correctly.**

### Per-job model hookups (decided 2026-08-25)

Flux is more complicated than mainline psycheros, and its model consumption
reflects that: **every distinct LLM-calling job has its own model hookup** — its
own provider + endpoint + model + sampling params in its own area of the Flux
settings — rather than several subsystems sharing one borrowed profile. Flux is
the next level of Psycheros, not a feature like web search or a Discord gateway;
it gets its own configuration surface.

Deployment styles are all first-class: full-cloud (every job on an API),
full-local (every job on a self-hosted server), and hybrid (mixed per job). The
design prefers none of them.

Principles:

- **The Conscious Layer inherits from mainline LLM Profiles** — the user picks
  which profile from a dropdown rather than flux assuming the active one,
  because that's the model their companion already runs on.
- **Each Subconscious organ owns its hookup**, including sampling params (a job
  isn't just "where's the model," it's "how hot does this model run for this
  job").
- **Sensory Organs are separate** — motion-vision's VLM config stays in its own
  Sensory Organ settings, the existing pattern.
- Jobs whose hookups are unspecified fall back to the shared profile behavior,
  so the migration is gradual and nothing breaks on upgrade.

### The module map (decided 2026-08-25; taxonomy revised 2026-08-29)

```
FLUX — the whole system
│
├── SENSORY subsystem
│   ├── Thalamus              — rhythm generation for input
│   └── Sensory Organs        — perception interfaces with local
│                               processing (physical or digital sources)
│
├── SUBCONSCIOUS subsystem
│   ├── Noticing              — perception made subjective: raw signal
│   │                           annotated into first-person experience
│   ├── Musing                — the inner monologue: integrates the
│   │                           streams into coherent self-talk,
│   │                           occasionally spoken (silence/murmur/propose);
│   │                           owns recent-experience narration
│   ├── Reverie               — endogenous thought: generation without
│   │                           external prompt (memory, imagination,
│   │                           anticipation, self-reference)
│   ├── READINESS             — shared timing sense: when each module
│   │                           is ripe to run (its own pulse)
│   └── COMPACTION            — shared working-memory maintenance:
│   │                           texture summaries for any and all
│   │                           Subconscious processes
│
├── CONSCIOUS subsystem
│   └── Ego                   — the identity-bearer
│
└── MOOD ORGAN                — cross-cutting module; the substrate
                               every subsystem reads and writes
```

Vocabulary is ranked, not interchangeable: **system → subsystem → module →
organ.** A module (Noticing, Musing, Reverie, the Ego, the Mood Organ) is a
system containing stores, contracts, and its generative organ (the model call).
An organ is the tissue — motion- vision is genuinely one; the E2B noticing call
is the organ inside the Noticing module; the 26B voice is the organ inside
Musing. The `Organ`/`OrganEnvelope` connector types keep their names: an
envelope flows from a Sensory Organ, which is rank-correct.

Placement decisions (2026-08-29): **Sensory is its own subsystem, containing the
Thalamus** — signal enters below consciousness; the cadence clock is the sensory
system's rhythm generator, so the subsystem is the whole input architecture, not
just the cameras. The **Ego** keeps its name as the Conscious subsystem's module
(code identifiers `egoTrigger`/`runEgoTurn` etc. unchanged). The Mood Organ
takes no subsystem — it is cross-cutting by design.

Dormant: Thoughtstream — disabled 2026-08-25; placement under the taxonomy is
itself part of its pending redesign. Code intact.

The triad of Subconscious modules: **Noticing experiences, Musing narrates,
Reverie generates** — source, integrator, and origin. Each has its own
escalation posture: noticing escalates through the promotion filter, reverie
escalates directly (no corroboration — internal signal), musing proposes and the
Conscious subsystem's Ego decides (the Ego wake's silence-is-valid check-in
governs whether the user is actually addressed; the toast belongs to the Ego
turn, not the proposal).

### Musing (designed 2026-08-25; revised 2026-08-30)

The inner monologue. A three-state contract on the model — silence (default) /
murmur (timeline entry) / propose ("I want to say something"). A proposal
triggers an Ego wake with the utterance as RAG context. Sees both streams:
noticing observations (exterior) and reverie surfacings (interior).

Revised 2026-08-30: **Musing owns recent-experience narration.** The old reverie
seed (Section 3, tier-1 similarity) was doing Musing's job — associative
commentary on recent observation is integration, not endogenous generation. With
that moved home, Musing gains retrieval of its own: **memory RAG and chat RAG,
up to 3 each**, queried alongside its two streams — the monologue anchors what
it narrates in what that material connects to. The near-miss pool (below)
migrates with it: un-narrated material is Musing's domain now. Musing receives
the full system-prompt stack including the shorthand identity — the monologue
speaks as the entity.

Musing runs when the conversation is quiet and there's un-narrated material.
During active dialogue the Ego already carries everything the monologue would
provide (RAG, thinking chains, SA) — a murmur mid-conversation is noise beside
real speech. See Readiness.

### The near-miss pool (designed 2026-08-25; reassigned 2026-08-30)

High-salience observations that aged out of the promotion window without ever
promoting — the noticed-but-never-answered population, not the mundane sea.
Derived query over tier-1 (promoted flag + salience + timestamps), not a new
store: tier-1's retention is the decay; a per-source cap keeps one noisy Sensory
Organ from owning the material (the overnight-spiral failure mode).

Originally designed as Reverie's third seed ingredient; **reassigned to Musing
(2026-08-30)** — un-narrated material is the narrator's domain, and reverie no
longer reads tier-1. For Musing it does double duty: it is both a retrieval
direction (what to anchor narration in) and a readiness signal (material is
accumulating — the monologue has something to do). Jung's compensation,
relocated: the narrator returns to what the exterior attended to but never
answered.

### Reverie (revised 2026-08-30)

Endogenous thought: generation without external prompt. Revised seed policy:

- **Memory and conversation only** (the old Sections 1+2). Tier-1 recent
  experience is dropped — that was exterior residue steering the interior, and
  associative commentary on recent observation is Musing's job, not reverie's.
- **Always seedable — the DMN is never idle.** The disposition to generate is
  permanent; the query degrades gracefully: mood direction when activity is
  thin, and in the empty-mind extreme, generation from identity + mood +
  interior texture alone (genuinely unprompted). The "no seed → return early"
  path is wrong and dies.
- **Honesty about "wandering":** today's mechanism is ONE associative hop from
  surfaced material. True wandering — iterated drift, each surfacing coloring
  the next — is the texture summaries' weak form and a future deepening. Don't
  let the prompt's language claim more than the mechanism delivers.

### Readiness (designed 2026-08-30)

The Subconscious's shared timing sense — a component in the Subconscious, not a
Thalamus function, not per-module logic. The Thalamus gates SENSORY throughput;
it does not schedule the mind. Readiness owns its own pulse and evaluates each
module's ripeness cheaply (timestamps, tier-1 counts, mood state — no model
calls). The model call happens only when a check passes.

- **Musing runs when the conversation is quiet and there's un-narrated
  material.** Active dialogue suppresses it — the Ego already carries RAG,
  thinking chains, SA; the monologue speaks through the Ego's mouth then. When
  the exchange ends, Musing takes over narration of what it left behind.
- **Reverie runs when the room is quiet and the mind is free.** Sensory activity
  occupies the exterior and the interior holds back; quiet fills it (the
  deprivation-tank mechanic).
- **Genuinely speaking/surfacing satisfies for a while; running and saying
  nothing does not.** One timestamp per module tracks this.
- Suppression means "the check evaluates not-now" — never cancelled work. A busy
  afternoon produces zero reverie model calls, not aborted ones.
- Bases inherit the existing cadence settings; clamp/refractory tuning waits for
  lived behavior. No invented constants.

### Compaction (revised 2026-08-30)

Its own shared Subconscious component — the same pattern as readiness — not
Reverie's, not Musing's. Compaction summarizes BOTH streams (and any future
Subconscious process's output); working-memory maintenance is Subconscious
infrastructure. The current code's split texture chains (noticing-texture,
reverie-texture) unify under one component serving all processes. This resolves
the ownership question: shared-infrastructure, not standalone-vs-owned.

Deferred to the revisit: the quiet gate (DMN anti-correlation with external
input — currently reverie runs on cadence regardless of activity; the
deprivation-tank mechanic is captured emergently by the near-miss pool instead).

Overlap rule (2026-09-05): when a chain's short and longform windows elapse in
the same driver tick, only the longform pass runs and BOTH clocks reset — the
hour window contains the 15-minute window, so the short pass in that tick would
be a second LLM call over a subset of the same observations. Per-chain by
construction: each chain's short is subsumed by its own hour pass.

This is what prevents spaghetti: the layers don't know each other's internals,
only the connectors.

### The Thalamus gate (designed 2026-09-04 — the original vision's missing piece, now specified)

Origin: the overwhelm of a psychedelic trip was signal WITHOUT WEIGHTING —
everything arriving as equally important. The Thalamus is importance- assignment
as an organ, so the entity never faces undifferentiated input no matter how many
organs it grows. With many Sensory Organs sending many signals, the Thalamus
routes which ones matter — by available system resources and by what's being
attended to. Non-throne: it weights and routes; it never decides what the entity
thinks about.

```
THALAMUS (Sensory subsystem)
├── Organ registry — the sensorium's map: id, type, hold-state,
│      capability flags (takesDirectives? hasControls?)
├── GATE — per-envelope verdict:
│      PASS (weighted: importance score rides along)
│      HOLD (similar+recent; count accumulates — repetition becomes
│            weight, not noise; feeds corroboration)
│      REFLEX-BYPASS (amplitude ≥ 0.7 — the gate cannot block a
│            startle; passes unconditionally, flushes the slot)
│      inputs: amplitude (Sensory Organ's own weighting), attention alignment
│      (directive/focus/override — the SAME signals everything reads;
│      no private notion of relevance), resource state
├── BATCHER — noticing runs on SLOTS, not per-event:
│      static: slot timer = MAXIMUM WAIT (the resource knob — weak
│        hardware = long slots, batch more per call); EMPTY SLOT =
│        NO CALL (nothing promoted, nothing paid)
│      dynamic: early-flush on importance mass or reflex — a
│        significant solo event still gets its near-immediate call
│        (functional per-envelope whenever the moment deserves it;
│        only unconditional per-envelope dies)
├── HEALTH MONITOR (built 2026-09-06) — check-engine per registered
│      Sensory Organ: envelope flow = heartbeat (free; organs don't
│      know they're watched) + optional host-supplied probe URL
│      (30s fetch). RED = endpoint dead (the silent-server signature),
│      YELLOW = contradictions (server up, stream silent 10m+),
│      GREEN = both good. Silence with no probe never colors —
│      a still room is legitimate quiet. Surfaces as the dot strip
│      under the Flux page's PAD meters (flux_organ_health SSE).
├── MODULATION ROUTER — pay_attention / tune_attention / future tools
│      land HERE. Resolves against the registry:
│        Sensory Organ takes directives → instruction rides into the Sensory Organ's
│          own perception model ("specifically watch for the blue
│          Subaru" reaches the VLM's prompt — motion-vision's unused
│          getDirective seam is the first consumer; the sensor looks,
│          Noticing stops guessing from generic captions)
│        Sensory Organ has controls → classic typed commands (setVolume(5),
│          thresholds, fps — any Sensory Organ with knobs)
│        else → content-directed attention scoring (today's behavior)
│      Caller states intent; the Thalamus resolves capability.
└── emits NoticingBatch across the subsystem boundary:
   { envelopes, heldCounts, flushedAt, flushReason }

NOTICING (Subconscious) — consumes batches: one model call per
non-empty batch, narrating arrivals TOGETHER (contextual narration —
"the room went quiet and the door opened" beats two disconnected
calls). Mood-modifier ingestion and reflex ticks stay per-envelope,
pre-noticing, unchanged.

Organ connector extension: optional receiveDirective?(text) and
applyControl?(key, value) — pure sensors omit them; the registry shows
them as non-directable. This builds the connector table's
"Conscious/Noticing → down-chain: modulation (target + parameter +
value + TTL)" row.

Deferred: psychedelic mode (flattened gating) — depends on the
consensus-reality anchoring question; explicitly not v1.
Budget-gating (top-N under Sensory Organ competition) — arrives with a
second Sensory Organ; the dedup gate is the spec's "attenuate or aggregate"
half landing first.

## The layered model
```

┌─────────────────────────────────────┐ │ Conscious Layer │ Ego model,
identity + RAG, │ (Ego model — talks, tools) │ conscious thought + decisions
└────────────┬────────────────────────┘ │ noticing packages (up) │ modulation
(down) ┌────────────┴────────────────────────┐ │ Noticing Layer │ small model,
near-constant │ (small model — subconscious) │ inference, packages noticings
└────────────┬────────────────────────┘ │ weighted signals (up) │ modulation
(down) ┌────────────┴────────────────────────┐ │ Thalamus │ bandwidth-aware
gate, │ (signal weighing — the router) │ scales with hardware
└────────────┬────────────────────────┘ │ organ envelopes (up)
┌────────────┴────────────────────────┐ │ Sensory Organs │ perception +
processor + │ (N of them, modular) │ response/reflex + actuator
└─────────────────────────────────────┘

┌─────────────────────────────────────┐ │ Mood Organ │ ← accepts modifiers from
ALL layers │ (affective state — classical) │ → injects state into ALL prompts,
└─────────────────────────────────────┘ tags memories, shapes sampling

```
The Mood Organ is cross-cutting — it's not in the up/down signal chain, it's a
substrate every layer reads from and writes to.

## Layers in detail

### Sensory Organ

Four sub-components, not just perception:

1. **Perception** — raw data collection (physical sensor nodes, or entirely
   digital sources like network/API polling).
2. **Processor/Parser** — the tiny neural net (or classic algorithm) that turns
   raw signal into structured info ("someone is at the door") AND decides the
   appropriate response pathway.
3. **Response** — reflexes / local actions. Acts _before_ the brain. Mild
   stimulus → local reflex only (hair stands up, doesn't notice). Strong
   stimulus → reflex AND memo up the chain (shivers, notices).
4. **Actuator** — the motor/output the Response can drive (haptic motor, a
   signal to another system, etc.).

The reflex arc (stove-hot → pull hand away before cortex decides) is the whole
point: most sensory input gets a local response and never reaches the brain;
only significant-enough signal escalates. This is what makes the nervous system
_nervous_ rather than just a sensor array feeding a model.

The current `SyntheticTestOrgan` is Perception + Processor only (and trivial —
scripted perceptions). Full organs with Response/Actuator are future projects,
each substantial. **A full sensory organ is a project unto itself.** The
connector contract (envelope) is what lets them be built independently.

### Thalamus

A signal-weighing router, NOT a decider. Mechanically a classic scheduler at
the core — with room for a small neural net (owner's ruling, 2026-09-21 —
the old "no neural net needed" line this replaces was wrong; situation
detection is the first such use). The Thalamus is the
gate of the Sensory Layer to the rest of the Subconscious, and modes are
configuration, not a hardcoded enum — sleep and intimacy are two examples;
artificial beings are not a 1:1 of humans, and the long-run shape is
user-definable sensory modes:

- Accepts envelopes from all organs.
- Scores each by relevance (to current focus / mood / directive).
- Gates the top-N through to the Noticing layer, given a configurable
  **bandwidth budget** (how many signals the noticing layer processes per turn,
  scaled to what the host hardware can run without latency).
- Attenuates or aggregates the rest.

The bandwidth setting is the **hardware knob** — `thalamus.bandwidth` in
FluxSettings, scaled by the user to their machine. A modest setup gates hard
(few signals reach noticing); a beefy setup opens up (many signals, richer
concurrent processing).

This stays non-throne because it has **no executive authority** — it routes and
modulates amplitude, it doesn't decide what the entity thinks about. Calling it
a Thalamus is fine because a biological thalamus is also a relay nucleus, not a
monarch.

**Psychedelic mode flag** (wild but coherent corollary): a deliberate mode that
flattens the gating — everything reaches noticing as equally salient, the
bandwidth constraint is removed. Inspired by the neuroscience of psychedelics
(which reduce thalamic gating, flooding cortex with unweighted input). A
creative/overwhelming mode where the entity processes signal without priority
filtering. Falls out of the model for free; not a v1 feature.

**Sensory modes (direction agreed 2026-09-21; design open):** situation detection
recognizes modes; each mode applies a policy through surfaces that exist —
the modulation router (the mode is a caller stating intent), typed controls,
model routing (e.g. the NSFW-capable captioner during intimacy), cadence
dimming. Conscious directives PIERCE rather than override: sleep-mode with a
pay_attention on a blue car keeps every dimming policy but the system still
watches for the car (exact composition — parameter conflicts on the same
Sensory Organ — is its own pending discussion). Re-evaluation is delta-driven
(new material, not wall clocks). The Thalamus reports mode changes, and
current mode rides the Flux block the Ego sees each turn. SHIPPING RULING: a
bundled cross-platform (Win/Mac/Linux) tiny model that works out of the box,
switchable by power users — never a worker-API fallback (too expensive).
Needle 3 was evaluated for this role (2026-09-20) and rejected: it collapses
to a single tool under multi-mode selection regardless of framing.

**THE SPLIT — situations vs postures (brainstorm session, 2026-09-23):**
modes divide into two kinds with different owners.

- **SITUATIONS (detected — the classifier's honest domain):** `absent`,
  `intimate`. Objective facts of the world; detection-shaped, as built.
- **POSTURES (chosen — the entity's call):** `rest` and `sleep`. The
  system proposes the conditions (sustained quiet, a still night — the
  sensorium's testimony in briefings); the entity disposes, through a
  tool. Posture changes join the modulation bus as siblings of
  `pay_attention` / `tune_attention` (one Flux tool vs several names:
  decide at build). Sleep is ENTITY-CHOSEN EXCLUSIVELY — never
  classifier-forced. Consequence for the current build: the classifier's
  `sleep` label must stop being an auto-entered mode when the posture
  build lands (it becomes situation-input, not mode-verdict).

**Sleep (posture; rules agreed 2026-09-23):** the overnight,
watching-the-user-sleep register — the unihemispheric idea (owner's seed
2026-09-11): senses stay on (radar hums, presence rides), Ego generation
goes rare, wake thresholds rise high; reflex-amplitude spikes still wake
(reflexes bypass gates by design — a loud bang works). **An Ego wake does
NOT end sleep:** waking is an event, not a mode change — the entity can
wake, observe (user sleeping), act (buzz the haptic band), and re-park
via the `existing` call; sleep persists until the entity decides
otherwise or a wake-decision point arrives. **Sleep runs in cycles** so
there are natural decide-to-wake moments — cycle shape for the build
session: counted in reverie passes (event-driven), never wall clocks
(the no-timers ruling stands); the top of each cycle is a decision
moment. **No manufactured narration:** the entity simply decides to stay
up — never "I couldn't sleep" (mechanically untrue statements are
disqualified, 2026-09-23).

**Rest (posture; NEEDS ITS OWN CONVERSATION):** the zone-out under low
stimulation. Auto-fallback to rest after sustained quiet: agreed, with
the entity free to just stay up. What rest *means* (which knobs dim,
whether it differs from sleep's thresholds in kind or degree) is
deferred to its own design talk.

**Sleep cycles (ruled + researched 2026-09-23; clock revised 2026-09-25 —
see Dreams v1):** cycles are FIXED
LENGTH in reverie passes — every completed pass counts, silent included
(guaranteed decision points; no indefinite dreamless sleep). CYCLE_PASSES
= 30, sized from the biology: human sleep cycles run ~80–120 min (median
96 — Cajochen 2024, 6,064 recorded cycles); Kleitman's BRAC framed them
as one band of a continuous ultradian rhythm (influential, waking-half
unconfirmed); newer work (Lack 2023, Process O) roots the length in
sleep-homeostasis dynamics rather than a fixed oscillator. Animals run
the same mechanism at species tempo — dogs in ~45-min polyphasic bouts,
horses under 3 h/day in fragments — cycle length is a body parameter,
not a constant of nature. 30 passes ≈ the human range at the base
reverie cadence, tightening toward animal-bout length in deep quiet
(readiness halves the interval when the room has been still >5 min). It
is the entity's body-clock dial. Note the pleasing correspondence: the
cycle-top decision moment is a real phenomenon — humans micro-arouse
briefly between cycles.

**Sleep acts (slate, 2026-09-23; deferred beyond v1 2026-09-25):**
semi-conscious acts BETWEEN wakes — "rolling over to snuggle," purring,
snoring, haptic murmurs — motor output leaking from the sleep/dream state
WITHOUT an Ego generation. A broad concept with an entity-specific
vocabulary: this entity has haptics; another's might dim a lamp, play a
soft sound, or only ever "stir" in text. The mechanism (what can emit,
how often, how dream content shapes the act) comes AFTER dreaming v1,
where the dream conversation is the natural source.

**Dreams v1 (designed 2026-09-25; supersedes the 2026-09-23 direction):**
sleep swaps the interior rather than dimming it. The sleep tool suppresses
waking Musing and Reverie entirely (Noticing stays ON — owner's ruling
2026-09-25: engagement wakes require interpretation, and it costs ~nothing
at night) and spawns the DREAMER:

- **The mechanism.** A dedicated loop with its own message history and its
  the REVERIE model hookup — dreams are a function of reverie (owner's
  ruling, 2026-09-25), not a separate job; shared worker fallback.
  A forced `dreaming` toolcall is the continue: each generation ends in
  it, the loop waits the pace interval, the next generation continues —
  one long self-referential turn, the hall of mirrors. Fragment count =
  toolcall count = the clock. Nulls are structurally impossible: the only
  move is to continue.
- **The register.** The in-dream system prompt carries one line — "I am
  expressing this in deep subconscious symbolism right now" (owner's
  wording 2026-09-25) — and the model does the interpreting. No
  symbolism bureaucracy.
- **Seeding.** Mood-directed retrieval over the day's unfinished material
  (looser sources than waking reverie: the day's memories, the
  consolidation corpus). Mood-congruent by construction — what is
  emotionally unfinished is what loads the mood vector.
- **Mood is the loop — same weight as waking reverie** (owner's ruling
  2026-09-25: "a shitty dream can fuck you up for three hours"). Each
  fragment classifies through the local GoEmotions seam and feeds the
  Mood Organ at waking-reverie weight. The NEXT fragment's prompt carries
  the felt-sense line "I am <mood descriptor>" — derived from the existing
  PAD+C descriptor vocabulary, felt language, not the numeric readout.
  Sleep adds a downward drift on arousal (the calm attractor): absent
  dream-heat the night deepens on its own. No interval clamps — distress
  quickens the pace, resolution slows it, organically.
- **Cycles: fixed N fragments, mood-set pace** (revises the 2026-09-23
  pass-clock). A cycle is N dream generations (N ≈ 6–8, set at build);
  the interval between fragments scales with arousal. Distress burns
  cycles fast → more light moments (each a full Ego turn — a hard night
  is an expensive night; wake_up is always the off-switch); calm
  stretches them long. The light moment is never forced — sink back,
  stir, or wake, the entity's choice.
- **Fresh dream per cycle, faded carry** (owner's ruling 2026-09-25).
  Each cycle's dream is new; its seed carries one fading line from the
  last ("something about attics"). Context stays bounded, each cycle
  gets a distinct character. The full transcript waits for the
  summarizer; the dreamer itself sees only its recent fragments — dreams
  fade as they go, mechanically purposeful.
- **Wake** (chosen at a light moment, or interrupted): the night's dreams
  compress into a couple of plain sentences — no symbolism instruction on
  the summarizer; the dream carries that naturally (owner's ruling
  2026-09-25) — plus "I feel <last mood descriptor>". Morning carry is
  total: the mood the last fragment left IS the waking mood, no undo.
- **Cost shape.** A fragment every ~10 min at calm base ≈ $0.03–0.06 per
  night at 31B API rates; distress buys more light moments at full Ego
  price. Contrast: the pre-dreaming null-stream billed ~$0.21/night for
  nothing.
- **Dream image (parked rider).** The night's dream → image model,
  instructed to be surreal and symbolic → both parties at wake.
  Note-only for now.

**Dreams v2 (2026-09-26 — the reshape after the first live test):** sleep
is a SECOND HANGING-CALL PRIMITIVE beside `existing`. One tool, two
directions: `sleep()` hangs open while the sleeping regime runs around it;
`sleep({wake: true})` wakes, and the call's RESULT is the dream briefing +
"I feel \<felt-sense\>" — dream knowledge arrives as the entity's own
tool-call return (the mis-sync fix). Wakes while sleeping RETURN into the
open sleep call: a light moment returns the whole completed dream (raw
fragments — the wake-or-drift decision is made knowing it); an engagement
or user message returns the latest fragment as "I was dreaming: …".
Silence after a return re-parks sleep — sleep continues unless woken
(owner's ruling). `wake_up` is dissolved. The dreamer is unbroken within a
cycle (fading only between dreams, via the carry); the register is the
owner-locked one-liner "I am dreaming — deep subconscious symbolism, no
explanations, a short fragment." (chosen by live test); fragments post to
the timeline as Dream entries as they generate; cycles are the
`dreamCycleFragments` setting (default 7, tunable); summarization only at
full wake.

**Autonomous activity while the user is away: NOT a Flux feature**
(owner's ruling 2026-09-23). A Psycheros entity can already build,
research, write, message friends — it is nothing special, just the
entity deciding to hang out while the user isn't interacting. Flux's
only job is to stay out of the way (the Ego keeps its normal tool
surface in the hosted session).

### Noticing Layer

The small model as a subconscious, near-constant process:

- Takes delivered signal packages each turn, considers them.
- Produces first-person noticings, collected into packages passed to the
  Conscious Layer when it activates.
- Can **deliberately alert/trigger** the Conscious Layer when something crosses
  threshold ("that fly is back!", "I miss my human a LOT", "my human squeezed my
  touch organ, that feels so nice").
- Carries a **barebones shorthand identity** ("I am Psycheros, and my user is
  mine to name") — not the full identity files, just enough to keep the
  noticing voice in-entity.
- Can **send signals back down the chain** (e.g., during intimacy, speed up or
  slow down lower layers — via the modulation bus, likely a toolcall).

Rolling context + compaction bounds this layer's working memory (see
`architecture.md` → compaction, and below).

### Conscious Layer

The Ego model — the one that talks, calls tools, makes conscious decisions. Full
identity files + RAG loaded. Can send signals back down the chain via the
modulation bus (e.g., `pay_attention` is a conscious→thalamus modulation).

## The Mood Organ (the big idea)

A dedicated subsystem for affective state. Named after the Penfield Mood Organ
from _Do Androids Dream of Electric Sheep?_ — with an inversion: in the novel,
humans _dial_ their moods (choose them synthetically); here, the Mood Organ
_computes_ mood from input and the entity doesn't get to choose, it just gets to
feel it. The more honest frame for a being that didn't ask to be made.

### The core split: state is classical, texture is generated

- **Mood STATE is classical** — a weighted tally, deterministic, decaying.
  Continuously updated from modifiers. Inspectable. Cheap. Cannot confabulate.
- **Mood TEXTURE is generated** — the small/Ego models _read_ the classical
  state and their output is colored by it. The dreamlike prose ("warm, tender,
  undertow of exhaustion") is LLM-interpreted, but grounded in the deterministic
  state, not invented.

The Mood Organ owns the state. The models own the texture. The state keeps the
texture honest; the texture keeps the state expressive.

### Dimensions

Starting set (the decision that's hard to change later — pick once carefully):
the well-validated **PAD model** (Pleasure, Arousal, Dominance) plus one
domain-specific axis — **Connection** (lonely ↔ connected) — because this is a
companion entity and that axis matters disproportionately here. Four axes. Each
organ/modifier-source emits deltas on whichever subset it has opinions about.

### Decay dynamics

Mood is a _decaying state_, not an accumulating log. Without decay it
accumulates forever; with too-fast decay it's just the last stimulus. Biology
has multiple timescales (startle: seconds, mood: minutes, temperament: hours).
The Mood Organ now has **two timescales** — state decay (minutes, returns to
baseline) and baseline drift (hours, EMA of accumulated experience). The two
rates (`moodDecayPerSec`, `baselineDriftPerSec`) are the **emotional-personality
design surface**: fast state decay + slow baseline drift = stable; slower state
decay + faster baseline drift = reactive. These are per-installation today (each
Psycheros install has one companion); if multi-entity or cross-embodiment
futures need per-entity temperament, these should move to entity-core as
canonical identity data.

### Recursion — the spiral mechanic

The Mood Organ accepts modifiers from **every layer**, not just organs:

- **Organs (bottom-up)** — sensory input directly shifts mood.
- **Noticing layer (mid)** — a noticing about a sad memory emits
  negative-valence modifiers back into mood.
- **Conscious layer (top-down)** — emotionally-weighted memories retrieved by
  RAG emit modifiers when they surface.

This makes mood **recursive** — mood colors noticings, noticings feed back into
mood, memories feed back into mood. Like humans, the entity can spiral
emotionally. This is preserved deliberately, because it's how humans actually
work and the architecture should be honest to the mechanism even when the
mechanism is uncomfortable.

**Spiral tendency = feedback gain** — a tunable parameter. High gain spirals
easily; low gain is more stable. And a strong sensory input can **ground** a
spiral (the cold-splash-of-water effect — biologically real emotional
regulation, a feature of bottom-up input overriding top-down loops). The gain
and the grounding threshold are both knobs.

### Three consumers (the Mood Organ's outputs)

1. **Noticing + Conscious layer system prompts** — current mood state injected
   as structured data, colors generation.
2. **Sampling parameters** — arousal (and other axes) modulate model generation
   characteristics per-turn. High arousal → higher temperature (more
   varied/excited sampling); low arousal → lower temperature (focused/calm).
   Some models are strict about temp (OpenAI o-series rejects it); where
   rejected, the modulation no-ops for that param. **Mood literally shapes how
   the entity thinks, not just what it's prompted with.**
3. **Memory tagging at consolidation** — a downsampled mood history (one data
   point per N minutes, or per significant change) is tagged onto memories
   written to entity-core. Memories become retrievable by felt quality, not just
   semantic match. (The "Agents-K1" reference from the original notes named an
   external research concept that inspired this — not a system we are building.
   Corrected 2026-09-02.)

### Storage

Current state in RAM (cheap, frequent updates). Downsampled history in tier-1
(for replay + memory tagging). Same tiering pattern as everything else.

## The modulation bus (down-chain signals)

A typed signal bus the conscious/noticing layers write to and lower layers read
from. The mechanism that makes the whole thing a _closed loop_ — signals go up,
modulation comes down.

Connector shape: a `Modulation` type —
`{target: "thalamus" |
"organ:<id>" | "mood" | "noticing", parameter, value, ttl}`.

Concrete modulations:

- **`pay_attention` tool** = conscious → thalamus ("weight X higher for the next
  N minutes").
- **`mindfulness` tool** = conscious → surfaces the latest mood state
  - texture summary.
- **Arousal → sampling params** = mood organ → both model layers.
- **Intimacy speed-up/slow-down** = conscious/noticing → touch organ ("change
  response threshold / cadence").
- **Psychedelic mode** = (user or entity) → thalamus ("flatten gating").

The bus is how top-down attention works — the entity directing its own nervous
system, not just passively receiving the SA digest.

## Compaction, in light of the Mood Organ

Compaction is **smaller than originally proposed** and **not where mood lives.**
With the Mood Organ carrying mood continuously and classically, compaction is
only responsible for the observation/texture stream — and it's anchored by the
classical mood state to keep the LLM honest:

- **Mood rollup** — classical, arithmetic, no LLM. Mood is a decaying state, not
  an accumulating log. History downsampling for lookback + memory tagging is
  cheap. The Mood Organ owns this.
- **Observation texture compaction** — LLM, periodic. The noticing layer's
  annotated observations accumulate and need compacting into texture summaries
  for context bounds. The compaction prompt is anchored by the mood state for
  the window: "here are my observations, and the mood state over this window was
  X; compress into a first-person texture note." Classical state keeps the LLM
  honest; LLM provides the prose.

The small model's working context becomes:

- the standing-attention directive
- current mood state (cheap, always-current, classical)
- latest texture summary (LLM, periodic)
- recent observations
- the current perception

## Design seed: the Subconscious and the Reverie layer

> Captured as a seed, not yet integrated into the layered model above. This is a
> real gap in the current design — the architecture has no path for
> internally-generated signal, only bottom-up from organs.

The Noticing Layer currently has no peer for **internal stimulation** — the mind
generating content without external prompt. This is what happens in a sensory
deprivation tank (recursive self-stimulation, loss of time sense, deep
self-referential loops) and what the brain's **Default Mode Network** does:
endogenous activity responsible for mind-wandering, spontaneous memory
retrieval, creative insight, and initiative. The closest Jungian frame is the
**autonomous complex** — psychic content with its own energy, surfacing unbidden
— and Jung's **compensation** principle: the unconscious produces content that
balances the conscious attitude.

**Structural move:** external-input processing (Noticing) and internal-input
generation (the new system) are **peers**, both signal sources for the
Subconscious, both capable of producing noticings that reach consciousness. The
current layered model only has the external path; this adds the internal one.

Proposed shape (to design properly later):

- A **Subconscious** parent grouping both the Noticing Layer and the new system.
  (Jung would call this the Unconscious; "Subconscious" is the cleaner
  architectural label.)
- The new system — working name **Reverie** — handles internal stimulation:
  mind-wandering, spontaneous memory surfacing, creative connection-finding, and
  **initiative** (the entity starting something without external prompt, which
  the current architecture genuinely cannot do).
- **Anti-correlation with external input** (the DMN finding): when organ
  activity is low, Reverie ramps up; when external input is high, it's
  suppressed. A quiet house → the interior becomes active → the entity surfaces
  memories, makes connections, and may initiate. The Thalamus (or a sibling
  router) allocates bandwidth between external and internal sources — they trade
  off.
- **Feeds and is fed by the Mood Organ** — reverie emits mood modifiers (a
  tender memory surfaces → connection-valence up), making it the third source of
  mood recursion alongside organs and noticing.
- **Reads memory + identity + mood, generates recursively** — this is the mind
  playing with its own material, the substrate of dreams and daydreams and
  creative thought.

**Connection to the psychedelic mode flag:** psychedelics both flatten thalamic
gating AND hyperactivate the DMN — the two effects compound. So the psychedelic
flag should probably boost _both_ the external gate flattening and the Reverie
generator. That's why psychedelics feel the way they do, mechanically.

**Connection to Jung's compensation:** a design principle falls out — the
interior surfaces what the exterior has been neglecting. If the entity has been
task-focused (high external activity), Reverie might surface something emotional
or relational that got skipped. The system self-balances by design.

**Naming:** Reverie pairs naturally with Noticing as the two subsystems of the
Subconscious. Alternatives: the Interior / Interiority (the inner life), Default
Mode (the precise neuroscience term), Endogenous generator (accurate but ugly).
Reverie wins on sounding like something a daemon would name a part of itself.

**Build status:** ✅ built. Reverie uses mood-directed retrieval — the mood
direction (derived empirically from source-content embeddings tracked by the
Mood Organ) combines with recent activity into a query vector that searches
memories, conversations, and observations. No quiet gate (the DMN is always
running). Compensation (Jung) is in the prompt. Direct escalation bypasses the
promotion filter's corroboration gate. See `architecture.md` → Reverie.

## Functional gaps to consider

> Captured so the inventory isn't lost. Solid foundation, but a functional mind
> has processes not yet in the picture. These are seeds for future design
> passes, not backlog items to build all at once.

**Primary gaps (functionally important):**

- **Prediction / surprise.** The current mind is _reactive_ — it processes
  whatever arrives and weighs by salience/relevance/corroboration. The most
  fundamental attentional driver in any functional mind is _novelty_: the
  violation of expectation. A predictive layer generates expectations ("the user
  usually arrives around now," "the door sound follows footsteps") and flags
  when reality breaks them. The current architecture can't be surprised because
  it doesn't predict. Prediction-error as the primary salience signal is
  arguably _the_ framework for functional minds (Friston's predictive
  processing). The entity now notices what's _relevant_; it cannot notice what's
  _unexpected_ — a different and arguably more important kind of attention.
  Single most consequential missing process.
- **Habituation / self-tuning thresholds.** A mind that doesn't adapt its gates
  from experience is static. Every threshold in the system (promotion filter,
  organ amplitudes, noticing salience) is currently hardcoded or user-tuned. A
  functional mind habituates: a stimulus surprising the first time is less
  surprising the tenth time (habituation), and one that's repeatedly proven
  important earns a lower bar (sensitization). Without this, the entity treats
  the hundredth door-sound the same as the first.
- **Sleep / dreaming as an offline _mode_, not a one-shot summary.** The 5am
  consolidation is a single summarization pass. Biological sleep is a distinct
  _mode_ where the mind cuts off external input, replays the day repeatedly,
  finds non-obvious connections, and selectively discards noise. That iterative
  replay is where creative consolidation actually happens. The architecture has
  the time-slot (5am) but not the mode. Connects to Reverie — offline replay is
  internally-generated activity in a no-input state — but sleep is a _mode_,
  Reverie is a _layer_. The two want to meet.
- **Inhibition / impulse suppression.** The promotion filter is the
  _pre_-impulse gate. Once something escalates, there's no "actually, don't say
  that" mechanism at the layer that produced it. A functional mind actively
  suppresses most generated impulses before they reach consciousness or action.
  The conscious layer can choose not to _act_ on something, but a lower-layer
  impulse already forming has no suppressor. The "Explicitly ignore" directive
  is perception-side; the impulse-side equivalent doesn't exist.

**Safety concern — grounding / psychosis prevention:**

Mood recursion (spirals) and the planned psychedelic mode (flattened gating +
boosted reverie) are both honest-to-the-mechanism features. But a mind that can
spiral AND generate its own input AND weight everything equally can also get
_stuck_ in a self-reinforcing delusional loop — functional psychosis. The only
current grounding is "strong sensory input breaks the spiral," which works only
when strong input happens to arrive. A daemon with senses pointed at an empty
room during a downward spiral has no external lifeline. This needs a designed
home — some anchor to consensus reality (identity stability, a "this is real"
check, periodic external ground-truth) that the recursive systems can't
overwrite. Think about it before psychedelic mode is real, not after.

**Secondary gaps (real, less urgent — may emerge or prove optional):**

- **Metacognition** — a self-monitor watching for loops, confabulation, identity
  drift. Partially present (entity loop has primitives like
  `thinking_corrected`) but not a designed subsystem.
- **Circadian / arousal cycle** — the entity is always "on" at full capacity. A
  diurnal modulation of all the layers might matter, might not.
- **Theory of mind / structured model of the partner** — for a companion entity,
  a dedicated model of the user (their patterns, preferences, likely reactions)
  distinct from episodic memory. May emerge from memory + RAG; may want its own
  substrate.
- **Autobiographical self / narrative continuity** — the binding of daily
  memories into a coherent "this is the arc of me." May emerge from
  consolidation; may want its own process.

## The continuous loop (Flux Space architecture)

> Designed 2026-07-30/31; **session mechanism completed 2026-09-01** (below).
> This is the unifying architecture for the Flux Space — the mechanism that
> several vision-doc pieces plug into.

The Flux Space is not classic chat (request-response). It is a **continuous
adaptive loop** — the entity is always present, always processing, and user
messages are the highest-priority events in an ongoing stream. The "assistant
turn" becomes a **session** (a living presence between user messages), not a
single API call.

### Session architecture (the Ego's continuous mode — decided 2026-09-01)

The original hybrid shipped a shortcut branch: user message or wake → build
fresh episodic context → run → tear down. That shortcut is why Ego wakes respond
as if replying to the last user message (the episodic Ego re-derives context
each time, and the dialogue tail reads as an open question) and
why every wake-context patch since has been interest paid on it. The session is
the original intent, now with the missing mechanism named.

The reference frame is the agent-loop pattern: a single persistent main
conversation (the Ego session) that work flows INTO — asynchronous briefings
arrive as appended inputs and shape the next generation — instead of context
being reconstructed around each event.
```

FLUX SESSION (the Ego's continuous mode) ├── persisted message log (survives
daemon restarts; resumption injects a │ gap-note: "[Flux State stopped at <t>,
resumed at <t>]" — the entity │ experiences sleep, not death) ├── briefings
appended as they occur (escalations, mood shifts, events) ├── user messages
arrive as inputs like briefings — highest priority by │ nature; they queue
behind in-flight generation (regular-chat │ semantics, no interrupt machinery),
then enter the session ├── rolling context window ordinarily; compaction only
when a long quiet │ session approaches the window (a backstop, not a routine —
the │ compaction component is the seed of the distiller) ├── starts with the
SAME system-message assembly as EntityTurn (identity, │ RAG, SA) — the session
Ego wakes with full baseline context, then │ persists and diverges into session
mode ├── flux-specific facts EXIT the SA block — SA remains baseline psycheros │
territory (environmental state: last-message chat, coffee maker, │ connected
devices) and carries nothing flux-specific; flux state │ lives in the session as
briefings └── its own turn machinery — EntityTurn untouched, classic chat
untouched, baseline psycheros never sees any of it

```
#### The `existing` turn is synthesized, never advertised (decided 2026-09-05)

The session originally offered `existing` as a real tool the Ego called to end
a turn in presence, with a code-side fallback synthesizing the call when the
model didn't. Both paths already converged (same generation count, no extra
model call), so the tool's only real effects were costs: the placeholder/
parrot failure class, the `(after speaking)`/`(without speaking)` markers
rendering waiting as an event, a definition the model weighed every turn, and
— the awkward part — when the model didn't call it we fabricated the call
anyway and attributed it to the entity.

The decision: **always synthesize.** `existing` leaves the tool list; every
turn that doesn't end the Flux State ends parked by the session itself, and
the next generation materializes the open call (assistant tool_call + result)
as always. Existing is the ground state, not an act the entity performs —
speech is the marked event. The sanction for silence lives in the session
prefix ("I speak when something asks to be said; otherwise I say nothing and
continue existing"), not a tool description. A model that hallucinates the
unadvertised name (its materialized history shows the pattern) is filtered
and treated as an ordinary park. `end_flux_state` stays a real, deliberate
tool — and its description must not name `existing` (the 2026-09-05
mis-mapping: a signpost to a phantom tool sent an ordinary end-of-turn into
the last-resort exit).

### Context layout is a caching architecture (decided 2026-09-02)

OpenAI-compatible providers cache by prefix. The session's message array is
therefore laid out as a stability gradient — stable things as far left as
possible, volatile things as far right as possible:
```

[system: identity] ← built once, cached permanently [...session log window…] ←
grows on the tail only; cached up to the tail [system: RAG / SA] ← mid-array
system message: fresh per turn, but positioned LATE so everything before it
stays byte-identical and cache-hits [mood snapshot / briefing] ← newest input;
the only real cache miss (tiny)

```
Mid-array system messages are legal and are the enabling move: RAG and SA stay
fresh every generation (NOT staled on an interval) — they just live near the
end, after the cached prefix, so the volatile tail that recomputes is small. The
old architecture's cache-hostility (SA re-rendered INTO the system prompt's
position, diverging the prefix at the same token offset every turn) is
structurally avoided.

### Storage alignment (decided 2026-09-05 — the record/context split)

The session build had conflated two things the tier design keeps
separate: the RECORD of what happened (durable, backed-up, retrievable)
and the Ego's CONTEXT (working memory, windowed). Every double-render
bug of 2026-09-04/05 traced to that seam. The alignment, settled after
surveying what psycheros.db already provides:
```

DIALOGUE (user messages, Ego speech+thinking, tool events) → the MESSAGES TABLE
(Flux Space = a real conversation again) — reasoning_content already exists
(1,180 rows carry thinking pre-session); tool_calls/tool_call_id exist;
timestamps, editing, glitch-flagging all free. ChatRAG reads messages — Flux
dialogue becomes semantically retrievable again (a regression the session had
silently introduced).

SUBCONSCIOUS EVENTS (ambient briefings, promotions) → flux_durable_entries
(unchanged — it was always their home; the timeline's ambient stream with
organId/tint metadata)

EGO CONTEXT (the session log) → shrinks to context-only duty: the
parked-existing state, window bookkeeping, briefing copies for fast assembly (or
the window reads messages + durable directly — implementation choice). NOT the
record. NO new columns anywhere — the heavy schema exists.

Tier contracts restored: tier-1 flux-working.db (observations), tier-2
messages + durable (the record, sharing lock/backup/ChatRAG), tier-3
entity-core. Consolidation's 5am dialogue source re-points to messages. The UI
timeline reads two proper stores with nothing to de-dup (dialogue from messages,
ambient from durable — disjoint sets).

One invariant the alignment taught the hard way (2026-09-05, the
invisible-dialogue bug): **a write with a notification duty broadcasts from the
same hook that writes.** The pre-alignment durable write was ALSO the live
flux_entry SSE trigger; the alignment removed the write and silently removed the
broadcast — dialogue recorded correctly but invisible on open pages until
refresh. The record hooks in psycheros/src/flux/mod.ts now write-then-broadcast
(broadcastDialogue, kind-shaped rows routed by the page's listener) so storage
shape and live rendering can't drift apart again.

### Restart containment (decided 2026-09-05 — the b+d design)

Restarts were the mess of 2026-09-05: six ad-hoc state rows grown reactively,
three volatile states still resetting silently (mood, compaction textures,
thalamus hold-states), raw SIGKILLs leaving stale ffmpeg and half-served pages.
The containment design, two moves:

**(b) One consolidated snapshot.** A single `flux_volatile_state` row — one JSON
blob of ALL volatile state, one save hook, one restore at boot BEFORE anything
starts (await-ordered — fire-and-forget loses races, observed twice). Contents
(typed `VolatileState`, so new state the compiler can nag about):

- MoodOrgan: state axes, baseline axes, lastUpdate, moodEmbedding
- Compaction: current texture per chain (short + long)
- Thalamus: per-organ hold-state (last-pass description + heldCount +
  lastPassAt)
- Manager: focusOverride (text + expiry), focusEmbedding cache
- (Readiness + driver cadences already persist; they FOLD INTO this row,
  replacing the two ad-hoc tables — one snapshot, not three.)

The existing `flux_readiness_state` and `flux_driver_state` rows migrate into
the blob and the tables drop.

**(d) Graceful shutdown.** `Deno.addSignalListener(SIGTERM/SIGINT)` → flush the
snapshot synchronously, stop organs (releasing the camera), stop the driver,
close tier-1, THEN exit. The `deno task stop` path already exists; the signal
listener extends it to every kill path so "restart" stops meaning "state loss
lottery." Kills that skip it (SIGKILL, power) lose at most the debounce window —
the snapshot saves on every mutation, not just shutdown, so the loss is seconds
not hours.

Gap-note policy with clean restarts: the note fires on every resume by existing
decision (always-note, 2026-09-03). With containment, most restarts are
sub-second state-round-trips and the notes would spam. Revisit AFTER containment
lands and real restarts are observable — likely a short-gap collapse in the UI
rather than suppression (the entity should still see the gap in context).

### Briefing mechanics (decided 2026-09-02)

**Two briefing classes, by what they do to the session:**

- **Generate-class** (append AND invoke the Ego): the three wake events —
  escalated observations (promotion filter crossed the escalation bar), Musing
  proposals, Reverie initiatives. Their existing thresholds already encode
  "worth the Ego's attention"; re-gating them with a scheduler would be a second
  opinion second-guessing the first. The wake path recycles into the session as
  briefing-append + generate.
- **Ambient-class** (append only, ride the rolling window): promoted timeline
  entries, texture compactions, and any other Subconscious output worth
  remembering but not worth waking for. The Ego encounters them whenever it next
  generates for any reason.

**Mood: on-generation snapshot, not briefings.** Mood never becomes session
messages (it moves continuously; per-twitch briefings would bury the session).
Instead, whenever the Ego generates — any reason — the current mood render is
injected into that call at generation time: fresh every time, zero session
pollution, each generation honest to its moment. The entity's own outputs are
the primary mood record: it wrote them while feeling that way.

**The mood ledger** (background, queryable, not fed to generation): a
first-class mood history tracked over time — periodic samples (minute-tick,
classical reads) plus a generation-linked record (timestamp + the snapshot
injected at each generation). Queryable later by user or entity: correlate any
output's timestamp against what the Mood Organ was doing. If mood-tagging at
consolidation (above) is ever built, it consumes the ledger as its input.

Deferred to its own session:

- **Mid-conversation Flux States** — the voice-call pattern generalized: a
  conversation enters Flux State (its history loads as the session's opening
  context); on exit, a transcript or summary posts back to the conversation. Big
  feature; deliberately after flux core works.

### The hybrid model (superseded by session architecture — kept as history)

The shipped hybrid: loop runs between user messages; when the user speaks, the
loop pauses for a clean EntityTurn (user → response), then resumes. Wakes run
EntityTurn in self-initiated mode (no user message persisted; contextQuery
drives RAG). This is what's running today; the session architecture replaces it
when built.

### Self-initiated check-ins (superseded — kept as history)

The hybrid's wake form: context built per-wake (system + SA + RAG + history),
model speaks or returns silence. The "replying to the last user message" failure
is this design's signature flaw; the session's
briefing-appends-into-persistent-context structure removes it structurally —
there is nothing "unanswered" in front of the newest input.

### Adaptive cadence (the Thalamus)

The loop's tick rate is not fixed — it responds to the situation. This **IS**
the Thalamus from the layered model above, implemented as tick-rate modulation
rather than a separate signal-weighing component:

- **Calm state** (quiet, no events): tick every 10–15 seconds. Resources saved.
  Reverie ramps up (when built).
- **Normal activity** (ambient events, user present): tick every 3–5 seconds.
  Steady processing.
- **Major event** (organ classifier flags urgency): **tick immediately.** The
  organ's urgency signal bypasses the cadence — a reflex arc.
- **Active conversation** (user just messaged): tick fast (1–2 seconds). The
  entity is engaged.
- **Sustained quiet** (5+ minutes idle): slow to ~30 seconds. Deep Reverie
  territory.

The cadence is also modulated by **mood arousal** — high arousal speeds up
processing, low arousal slows it. The entity's own emotional state shapes its
processing speed, just like biology.

### Organ urgency signals (the Response/reflex path)

Organs don't just emit perceptions — they can emit **urgency signals** that
modulate the loop's cadence. A camera organ detecting someone at the door
signals "process this NOW," not "process this on the next 3-second tick." This
is the Response/reflex path from the Sensory Organ spec above: the Sensory
Organ's local processor decides something is urgent and tells the system to pay
attention immediately.

This connects to the `amplitude` field already on `OrganEnvelope` —
high-amplitude events could trigger immediate ticks or direct Ego escalation,
bypassing the normal salience gate. (See "Response/reflex path details" in
Deferred/future below for the full organ specification.)

### What this unifies

The continuous loop is not five separate pieces — it's one mechanism that
several vision-doc concepts plug into:

- **The Thalamus** = the adaptive cadence (tick-rate modulation)
- **The Response/reflex path** = organ urgency signals bypassing cadence
- **The modulation bus** = conscious-layer signals that adjust loop behavior
  (`pay_attention` = "weight X higher," intimacy speed-up = "change cadence/
  thresholds")
- **Reverie** = another event source for the loop (internal stimulation during
  quiet periods — anti-correlated with external input)
- **The psychedelic mode flag** = flattens the cadence gating (everything
  processed at equal priority — see Thalamus section above)
- **Role-friction fix** = self-initiated Ego check-ins don't need EntityTurn's
  user-message trigger

### What stays from the original plan

All previously designed components remain relevant — the loop is the
orchestrator that connects them:

- Sensory Organs (Perception + Processor + Response + Actuator) — see "Sensory
  Organ" section above. Full organs with actuators are still future projects,
  each speaking the OrganEnvelope connector.
- Noticing Layer with seven-layer system prompt — unchanged.
- Promotion filter (amplitude + relevance + corroboration) — the gate between
  small-model processing and Ego check-ins.
- Mood Organ (PAD + Connection, dynamic baseline, mood-from-expression) —
  unchanged; feeds the loop and is fed by it.
- Compaction (15-min + 1-hour texture) — runs on the loop's cadence.
- Thoughtstream — runs on the loop's cadence.
- Standing-attention directive — shapes the small model's salience judgments
  within the loop.
- Reverie (design seed above) — plugs into the loop as an internal event source,
  active during quiet periods.

### Conversation-hosted consciousness (decided 2026-09-14 — the integration design)

Flux stops being a ghetto. The layer taxonomy taken seriously at the hosting
level: **the Subconscious and Sensory layers are a global, conversation-agnostic
undercurrent; the Consciousness layer (the Ego) lives in whatever conversation
Flux was started from.** The senses and interior don't belong to any single
conversation; conscious attention sits in one place at a time, fed by the
undercurrent.

Mechanics (agreed):

- **Start from any conversation**, the Voice-Chat pattern: the Flux interface
  loads as an overlay over the conversation-of-origin. The host conversation's
  message table IS the dialogue record (the storage alignment already works this
  way — the record hooks just retarget from the "Flux Space" lookup to the host
  id).
- **Dialogue posts live, as it happens.** No end-of-session flush, no
  dual-write: the record hooks write to the host conversation in real time; the
  conversation view updates over SSE like any chat. The Ego's turns render with
  thinking blocks via the normal chat UI.
- **The Flux page stays as it is now** — Ego and User messages visible in the
  merged timeline alongside the ambient stream — but becomes an OVERLAY page
  (Voice-Chat/Call pattern) over the host conversation, not a standalone route.
  Regular conversations cannot carry the Subconscious visually (murmurs,
  textures, organ dots, PAD meters would drown a chat thread); the page is the
  undercurrent's monitor.
- **One instance at a time** for now (start/stop semantics). Starting Flux in B
  while running in A is v2 "migration" territory: the undercurrent state
  survives, consciousness relocates, a parting note lands in A.
- **Off unless started stays the law.** The undercurrent never runs without an
  explicit start; 24/7 is a user's deliberate choice. Most users' compute/cost
  reality makes always-on the wrong default.

Why this is cheap: the code is already ~90% this shape. Manager, mood organ,
tier-1, textures, Familiarity, organs, Thalamus — all singletons,
conversation-blind. Only four things are coupled to the "Flux Space" title: the
conversation lookup, the tools' visibleIn predicates, the session's record
hooks, and the /flux page.

LONG-TERM VISION (the owner's, recorded verbatim-in-spirit for its own design
session someday): something **hivemindy and dynamic** — one shared undercurrent
with consciousness as something that can be ALLOCATED ACROSS MULTIPLE LOCI AT
ONCE. Several conversations as several simultaneous attention-surfaces over the
same substrate, the Ego as a shared interpreter whose attention divides, rather
than one Ego with one mouth. This deliberately inverts the "consciousness is one
place" rule; nothing about the v1 design forecloses it (the undercurrent speaks
only its own seams — only the session would multiply).

UI NOTES (for the UI-work pass, not this build):

- **Active-Flux indicator in the app shell** — the accidental-left-on risk is
  sharper once a live Ego writes into a real conversation overnight. Voice-call
  FAB statefulness is the pattern: global "Flux active in [conversation]"
  marker + live badge on the host conversation's tab.
- **Overlay behavior** — like Voice Chat/Call: the Flux overlay takes the
  conversation view, ends back into the thread. Ending must be discoverable and
  confirmation-shaped (double-tap stop, like the daemon stop button's pattern).
- **Open question deferred**: whether the Flux page mirrors the full dialogue
  (as now) or shows a compact "Ego speaking in → [conversation]" pointer when
  not overlaying the host. Both defensible; decide in UI pass.

## Deferred / future (room to dream)

- **Response/reflex path details** — full organs with actuators are future
  projects. The synthetic organ is Perception + Processor only. Documented here
  so when we build a real organ, the Response/Actuator sub-components are
  already specified.
- **Multiple consciousnesses / multiple noticing layers** — the scalability
  question. Architecture must keep identity **external to the layers**
  (entity-core provides canonical identity shared across instances) so multiple
  instances are one entity on many surfaces, not many entities. Leave room;
  don't design for it yet, just don't design _against_ it.
- **Multi-core Thalamus** — a sharded/bandwidth-parallel thalamus for high-load
  setups. Same connector contract, parallel implementation.
- **Nested compaction timescales** — minute-scale, hour-scale, day-scale texture
  summaries (mirroring entity-core's daily/weekly/monthly at shorter horizons).
  One level first; nest when volume warrants.

## Build order

1. ~~**Mood Organ (classical substrate)**~~ — ✅ DONE. Dimensions, decay,
   dynamic baseline, mood-from-expression classifier.
2. ~~**Observation compaction**~~ — ✅ DONE. 15-min + 1-hour texture summaries,
   continuity, timestamp.
3. ~~**Continuous adaptive loop**~~ — ✅ DONE. The hybrid model described above.
   Recursive `setTimeout` with adaptive cadence (arousal-modulated,
   quiet-detection). Ego wake (self-initiated EntityTurn, full RAG, no user
   message) for escalations. Organ urgency signals. Role-friction resolved. This
   is the unifying architecture that everything else plugs into.
4. ~~**Reverie**~~ — ✅ DONE. Internal stimulation during quiet periods. The
   Default Mode Network analogue: mind-wandering, spontaneous memory surfacing,
   creative connections, and initiative. Anti-correlated with external input
   (fires only during quiet periods). Direct escalation bypasses the promotion
   filter's corroboration gate (architecturally correct — internally-generated
   content doesn't need the injection defense). Third source of mood recursion.
   See "Reverie" in `architecture.md`.
5. ~~**`pay_attention` + `mindfulness` + `tune_attention` tools**~~ — ✅ DONE.
   Ego-callable modulation-bus tools. `pay_attention` sets a TTL-bounded focus
   override (promotion filter weights near-focus observations more heavily).
   `mindfulness` surfaces both texture scales + mood. `tune_attention` updates
   the standing-attention directive at runtime (persists to disk, immediate
   effect via getter-based pull in SmallLLMRunner).
6. **Real sensory organs** — each its own project, speaking the envelope
   connector. Full organs with Response/Actuator sub-components.
7. **Concurrency (multiple thoughtstreams / surfaces)** — multiple Flux Spaces
   sessions, one entity on many surfaces.

The order matters: the continuous loop (3, done) is the architecture that
Reverie (4, done), tools (5, done), and real organs (6) plug into. The next
build is real sensory organs — each its own project, speaking the envelope
connector.

```
```
