# How to build a Sensory Organ

This is the canonical reference for the structure every Sensory Organ in Flux
should follow. The first real Sensory Organ — **motion-vision** (webcam-based
vision) — is the reference implementation; read its doc (`motion-vision.md`)
alongside this for a concrete example.

The Sensory Organ contract lives in `src/types.ts` (`Organ`, `OrganConfig`,
`OrganEnvelope`, `Perception`). Sensory Organs are registered by the host
(Psycheros) in `packages/psycheros/src/flux/mod.ts` and self-drive via the sink
— FluxManager calls `start()`/`stop()` and does **not** poll `tick()`.

## The plug — the USB-inspired hookup

A Sensory Organ is a peripheral; Flux is the mainboard. Like USB, the whole
contract is the connector: the sense declares what it provides and draws, the
host provides standard ports, and neither knows the other's internals.

**The sense declares (its plug spec):**

- **The envelope** — its only output. One shape (`OrganEnvelope`), emitted
  through the sink or returned from `tick()`. Everything downstream (noticing,
  promotion, escalation, mood) reads only this.
- **Mood modifiers, optionally** — events the sense natively understands
  affectively carry small PAD+C deltas, like a USB device stating its power draw
  (see "Mood" below).
- **Nothing else.** No registration calls, no configuration of the nervous
  system, no knowledge of what consumes the envelope.

**The host provides (its ports):**

- **The sink** — the envelope inlet, handed to the factory; call it on every
  event.
- **`context.dataRoot`** — where state files live (`.psycheros/organ-state/`).
- **`context.embed`** (in-tree senses) — the one shared embedding space.
- **Health display** — free, envelope-driven; the sense does nothing.

**Neither side crosses the line:** the sense never imports FluxManager,
noticing, the promotion filter, the Ego, or the tier stores (the import-surface
rule below); Flux never requires the sense to know anything about the nervous
system. A sense that speaks the connector works anywhere the connector works —
compiled in-tree, or as a plugin from `.psycheros/sensory-organs/`.

## The three-part structure

```
Perception    raw sensory data collection (capture / ingest + buffer)
Processing    fast path (cheap detector, early-exit) → slow path (specialist)
Response      amplitude + propagate() + escalation + habituation + state presence
```

Organize the Sensory Organ's code into modules that mirror these parts. From
`src/organs/motion-vision/`:

- `capture.ts` — Perception
- `motion-gate.ts` + `scene-describer.ts` — Processing (fast / slow)
- `response.ts` — Response helpers
- `<organ>-organ.ts` — the `Organ` impl that wires the three together
- `types.ts` + `mod.ts` — types and the barrel

### Perception

Owns raw data collection — frame capture, audio capture, sensor reads, whatever
the modality. Pushes raw samples into a rolling buffer sized to the processing
window. Cheap, no inference.

### Processing: fast path then slow path

- **Fast path** — a cheap local detector that runs on every sample and decides
  whether the expensive specialist is needed. The reflex arc. Most samples get a
  local reaction here and never reach the specialist. For vision: a pixel-diff
  motion gate. For audio: voice-activity detection. For a system-state Sensory
  Organ: a change hash.
- **Slow path** — the heavy specialist (a VLM, a transcriber, an embedder) that
  turns the buffered samples into structured meaning. Runs only when the fast
  path says it's worth it, gated by a one-in-flight guard + a minimum-emit gap.

The fast path can short-circuit straight to a low-amplitude Response without
ever invoking the slow path. That's where the resource savings live.

### Response

Owns the significance decision and the outputs. Three jobs:

1. **Amplitude** — derive from the fast-path signal (motion magnitude, VAD
   energy, etc.), scaled into `[0, 1]`. See `amplitudeForMotion` for the shape.
2. **Propagate** — package the perception into an `OrganEnvelope` and forward it
   to the sink. The noticing layer takes it from there.
3. **Presence** — publish always-current state to a state file (see below),
   independent of whether an envelope is emitted.

## Two output channels — keep them separate

- **Events push** (envelopes via the sink) — motion-triggered or
  escalation-triggered. Go to the noticing layer, may wake the Ego model.
- **Presence is read** (the state file) — always-current snapshot, available to
  whatever wants it, decoupled from the Sensory Organ's emit cadence.

The split matters: presence must not be tied to the emit cadence (which is
adaptive and hardware-dependent). Write the caption/state to a file; let
consumers read it on their own schedule.

## Response emit paths

A Sensory Organ typically has two emit paths:

1. **Fresh caption** — normal-significance detection → run the specialist → emit
   an envelope at signal-derived amplitude.
2. **Immediate escalation** — a high-significance spike → bypass the
   minimum-emit gap, emit a high-amplitude envelope now. The promotion filter
   handles Ego-wake from there. No direct Sensory Organ→noticing channel (no
   spaghetti) — high amplitude is the escalation signal.

There is intentionally **no presence heartbeat envelope**. Emitting a cached
caption on a timer would couple presence to the tick rate. Use the state file
instead.

## State file convention

`${dataRoot}/.psycheros/organ-state/<organId>.json` — a standalone artifact the
Sensory Organ writes on every specialist result and reads on startup to
pre-populate. Consumers read it whenever they want.

```json
{
  "caption": "[Sun 02:30 PM] what the Sensory Organ currently perceives",
  "timestamp": "2026-08-02T14:30:00Z",
  "model": "which-specialist",
  "<organ-specific>": "..."
}
```

- Always written on a successful specialist pass (independent of habituation).
- Read on startup; if recent, restored (entity has presence immediately, not
  blind during restart). If stale/missing, run one specialist pass to populate.
- A max-quiet timer (e.g., 5 min) forces a refresh during sustained quiet so the
  file stays reasonably current.
- Caption text uses the noticing layer's time format (`weekday + time`, en-US
  locale — see `small-llm-runner.ts` and `response.ts:formatCaptionTime`).

## Habituation — events only, never presence

Recurring/unchanging **event** descriptions decay in amplitude so the noticing
layer isn't flooded with repetition. See `habituationFactor`.

- Applies to event amplitudes only.
- Does **not** affect whether the state file is updated (presence never
  habituates away — that would re-blind the entity).
- v1 uses crude normalized-string comparison; a future refinement should use
  embedding-based similarity (the VLM varies wording even for identical scenes).

## The envelope is the only event-seam to Flux

A Sensory Organ never imports `FluxManager`, the noticing layer, the promotion
filter, or the Ego model. It emits envelopes through the injected sink and
writes its state file. Everything downstream is Flux's job. This is the
load-bearing modularity rule — keep it.

**The full import surface of a Sensory Organ is exactly two things above its own
directory:** the shared contract (`../../types.ts` — envelope, perception,
modifier shapes, injected-fn types) and layer-neutral helpers
(`../../vector-math.ts` — pure math, no imports). NOTHING else — not the tier
stores, not runtime modules, not any Subconscious machinery. (Caught live
2026-09-11: the scene baseline had imported `cosineSimilarity` from
`tier1-store.ts` — a Sensory Organ transitively depending on the Subconscious's
SQLite storage for a dot product. Extracted to vector-math.)

## Mood: declare, don't wire (built 2026-09-10)

Two USB-flavored ways a Sensory Organ's signal reaches the Mood Organ — neither
involves the Sensory Organ knowing mood exists:

- **Declare what you natively understand.** Events your Sensory Organ
  understands affectively (motion-vision's arrival/departure is the exemplar)
  attach small PAD+C `moodModifiers` directly to the envelope — a declaration in
  the plug spec, like a USB device stating its power draw. If the modifier is
  ABOUT a specific recognized person, set `subject` (the enrolled id) — the host
  MAY apply per-subject relationship weighting (`faceAffinity` settings); the
  Sensory Organ never knows whether it does, and never holds relationship
  knowledge itself.
- **For everything else, say it in words.** Any envelope WITHOUT its own
  modifiers gets its `perception.description` run through the host's affect
  classifier (GoEmotions + mood table) at observation weight. Opting out of the
  generic service = declaring your own modifiers. A future Sensory Organ gets
  felt-quality classification for free, zero wiring.

Weights stay small (raw signal must not dominate expression-derived mood — the
overnight-spiral calibration; also the synthetic Sensory Organ's saturation
lesson: mood on every event floods).

## Health monitoring — automatic, Sensory Organ does nothing

The Thalamus runs a check-engine health monitor for every registered Sensory
Sensory Organ (built 2026-09-06). A new Sensory Organ gets health display for
free, with ONE wiring step on the host side and NOTHING inside the Sensory Organ
itself:

- **Heartbeat: free.** Every envelope your Sensory Organ emits lands at the
  Thalamus gate, and the monitor reads that flow as the liveness heartbeat. Emit
  envelopes and you are monitored.
- **Probe: one line at registration.** If the Sensory Organ depends on an
  external server (a VLM, an STT endpoint), the HOST wiring passes its URL when
  registering the Sensory Organ: `healthProbeUrl` on the `OrganRegistration`.
  The monitor fetches it every 30s — green (reachable + envelopes flowing), red
  (endpoint refuses; the dead-server signature), yellow (contradictions: server
  answers but the stream is silent 10+ min, or degraded). No probe URL: silence
  alone never colors anything — a quiet room is legitimate.

The health hookup lives entirely in the Thalamus — see `healthProbeUrl` on
`OrganRegistration` in `src/thalamus.ts`. Point the registration at your Sensory
Organ's endpoint and the monitor handles the rest.

## Reserved slots (interface only, wire later)

Two extension points are designed into the Sensory Organ context but
intentionally unwired in v1:

### `getDirective?: () => string | null` — Sensory Organ-specific perceptual directive

A concrete perceptual target ("flag blue Subarus," "alert on the door opening").
The slow-path specialist appends it to its prompt so it knows what to flag.

**This is NOT the noticing layer's `getAttentionDirective`.** That one is
abstract, relationship-level prose for the small model ("notice the flow of life
in my user's day"). A Sensory Organ directive is concrete and perceptual.
Different animals — keep them separate.

How Sensory Organ directives get populated is an **open thread**: a per-Sensory
Organ file, a new tool, a UI page. Designed in, not decided.

### `applyActuatorCommand()` — discrete actuator command

A one-shot action on the Sensory Organ's hardware ("pan camera to X," "adjust
exposure"). Folded into Response rather than a separate component: an actuator
is just a Response that acts on the Sensory Organ's own hardware.

Two initiation paths (both reserved for future phases):

- **Local reflex** — the Sensory Organ drives its own actuator from a fast-path
  signal (e.g., center the camera on motion). Never reaches consciousness.
- **Conscious command** — the Ego model calls a tool that routes a command down
  to the Sensory Organ ("pan to X"). Same actuator, conscious initiator.

Nothing drives actuators in v1; the interface slot is here so the shape is
ready.

## Open threads

- **Sensory Organ-directive source** — how does a Sensory Organ-specific
  directive get set? File, tool, UI? TBD. The `getDirective` slot exists; what
  backs it is unset.
- **`pay_attention` reaching Sensory Organs** — the `pay_attention` tool
  currently affects only the promotion filter (up-chain relevance weighting).
  Extending its focus-override to also reach Sensory Organs — same injection
  shape as other Flux-injected capabilities — is a small follow-up that would
  make temporary attentional sets ("watch for my friend's car for the next half
  hour") bias Sensory Organ processing, not just promotion.
- **Multi-Sensory Organ coordination** — Flux has no sideways Sensory
  Organ-to-Sensory Organ channel today. If two Sensory Organs ever need to
  coordinate (e.g., two vision systems handing off a tracked target), route the
  signal up and back down through a coordinator/router rather than adding
  sideways coupling. Keep directive and actuator interfaces uniform across
  Sensory Organs so this door stays open.

## When you build a new Sensory Organ

1. Create `src/organs/<your-organ>/` mirroring the file layout above.
2. Implement Perception (capture/ing), Processing (fast gate + slow specialist),
   Response (amplitude, propagate, state file).
3. Define a `<YourOrgan>OrganConfig extends OrganConfig` with
   `default<YourOrgan>Config()`.
4. Export from `src/organs/mod.ts` via `export * from "./<your-organ>/mod.ts"`.
5. Add settings to `FluxSettings` (prefixed, e.g. `audioDevice`), with defaults
   mirroring `default<YourOrgan>Config()`.
6. Register in `packages/psycheros/src/flux/mod.ts`'s Sensory Organ loop,
   passing `dataRoot` via the context. If the Sensory Organ talks to an external
   server, pass its URL as `healthProbeUrl` in the Thalamus registration (see
   "Health monitoring" above) — that is the entire health hookup.
7. Write unit tests for the fast gate, the slow specialist (mocked), and the
   state-file helpers.
8. Update or add a Sensory Organ-specific doc alongside this one.

## Shipping out-of-tree — the Sensory Organ plugin surface

Built 2026-09-19: a Sensory Organ does not have to live in this tree. Bespoke,
experimental, or shared senses load from the install's data directory — one
module per sense under `<dataRoot>/.psycheros/sensory-organs/` (`.ts` or `.js`),
exporting a single factory:

```ts
// <dataRoot>/.psycheros/sensory-organs/my-sense.ts
export function createSensoryOrgan(sink, context) {
  return {
    config: { id: "my-sense", tickIntervalMs: 2000, enabled: true },
    async tick() {
      // Either return an envelope here, or emit through the sink when the
      // sense has its own cadence — same as an in-tree Sensory Organ.
      return null;
    },
    start() {},
    stop() {},
  };
}
```

The `sink` is the manager's envelope ingest — envelopes out is the whole seam,
exactly as in-tree. `context.dataRoot` is the daemon's data root; persistent
state belongs under `.psycheros/organ-state/<id>.json` like the built-ins. The
three-part structure, output-channel discipline, habituation, and health
conventions in this doc all apply unchanged.

### Optional settings — the descriptor

A plugin may declare settings that the Settings UI renders (Settings > Flux,
under its id) by exporting `sensoryOrganSettings` alongside the factory:

```ts
export const sensoryOrganSettings = [
  {
    key: "sidecarUrl",
    label: "Sidecar URL",
    type: "text",
    default: "http://localhost:18086",
  },
  { key: "pollMs", label: "Poll interval (ms)", type: "number", default: 1000 },
  {
    key: "sensitivity",
    label: "Sensitivity",
    type: "select",
    default: "medium",
    options: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
  },
  { key: "verbose", label: "Verbose logging", type: "toggle", default: false },
];
```

- **One source of truth:** values persist in `flux-settings.json` under
  `sensoryOrganSettings.<id>.<key>`. Hand-editing the config file and the
  Settings UI write the same place — the UI is sugar, never a second store.
- **The factory receives merged values** (each field's default, overridden by
  whatever was saved) as `context.settings`. Read knobs from there, never from
  env.
- **Restart-to-apply:** saving Flux settings restarts Flux, and restart re-runs
  factories with fresh values — the same semantics as every other Flux setting.
  No hot-apply in v1.
- **Saved values are keyed by the id** — name the plugin file after the id (the
  loader warns when file and id disagree).
- **Fields are validated at load:** malformed entries are dropped, not fatal.
  Descriptors appear in Settings after the first Flux start of a boot (discovery
  runs at composition).
- **Plugin edits are picked up on the next Flux start:** discovery cache-busts
  its imports, so a changed plugin file reloads with the next composition — no
  daemon restart needed.

Rules of the surface:

- **Local files only.** No remote/URL modules (owner's ruling, 2026-09-19) —
  sharing a Sensory Organ means sharing the file.
- **Enablement is explicit:** the discovered Sensory Organ goes live when its id
  appears in Flux settings' `enabledOrgans`; remove the id to disable.
- **Load-time validation:** the connector shape (config.id / tickIntervalMs /
  enabled + tick / start / stop) is checked at load; malformed modules are
  skipped with a loud per-file error, never a crash.
- **Built-ins can't be shadowed:** plugin ids `synthetic-test` and
  `motion-vision` are refused.
- **The connector is structural, not compiler-checked:** plugin modules are
  dynamic imports, invisible to `deno check`. If the `SensoryOrgan` /
  `OrganEnvelope` contracts change, out-of-tree copies drift silently until load
  or runtime — keep type copies in sync when the seam changes.
- **Same treatment as built-ins:** Thalamus heartbeat and health dot, promotion
  filter, Familiarity damping, mood via envelope modifiers — nothing about being
  a plugin changes the nervous system's side.
- Files in this directory are part of the data tree — local to an install, never
  committed, never shipped.
