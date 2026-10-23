# Motion-Vision Sensory Organ

The first real Sensory Organ. A webcam-based vision system that captures frames
on a cadence, detects motion locally (cheap reflex arc), runs a vision-language
model (VLM) on bursts of frames to produce scene descriptions, and publishes an
always-current caption file.

For the general Sensory Organ structure all Sensory Organs follow, see
[`sensory-organ-template.md`](./sensory-organ-template.md). This doc covers
what's specific to motion-vision.

## What it does

- Captures webcam frames at ~3 fps (low-framerate video, not stills).
- Runs a cheap pixel-diff motion gate per frame — the reflex arc that decides
  whether the VLM needs to run at all.
- On motion, sends a burst of recent frames to a VLM (default Gemma 4 E4B via
  Ollama) as a multi-image request, gets back a scene description.
- Emits `OrganEnvelope` events into Flux on significant motion.
- Publishes `${dataRoot}/.psycheros/organ-state/motion-vision.json` with the
  always-current caption — decoupled from the emit cadence.

The entity perceives motion ("someone walked through the room"), not just
stills. Near-real-time perception (bounded by VLM latency, not a fixed tick);
escalation to the Ego model is still gated by the noticing layer + promotion
filter (the reflex arc by design).

## Architecture

```
packages/entity-flux/src/organs/motion-vision/
├── capture.ts              Perception — ffmpeg → JPEG + grayscale thumbnail
├── motion-gate.ts          Processing fast path — pixel-diff motion score
├── scene-describer.ts      Processing slow path — Ollama multi-image VLM call
├── response.ts             Response — amplitude, habituation, state file, propagate
├── motion-vision-organ.ts  the Sensory Organ impl (wires the three, owns the loops)
├── types.ts                types + defaultMotionVisionConfig()
└── mod.ts                  barrel
```

Two internal loops, decoupled:

- **Capture loop** (`captureFps`, default 3): an async while-loop (not
  `setInterval`) so a slow capture can't stack overlapping calls. Each frame:
  run the motion gate, push to the rolling buffer, trigger processing if
  warranted.
- **Max-quiet timer** (`maxQuietMs`, default 5 min): change-check during
  sustained quiet. The quiet pass asks the VLM only same-or-changed against the
  previous read (one word back, no description ask, no stage text, no identity
  block — nothing person-suggesting to hallucinate from). "Unchanged" confirms
  the scene baseline; "changed" — or a failed check — runs the full caption
  pass, which is exactly when the baseline needs a fresh sample. (Replaces the
  old describe-on-quiet refresh, which hallucinated people all through real
  absences; owner-approved 2026-09-25.) Motion-driven passes are untouched.
  Alongside, the empty-desk prompt fixes: the zero-people identity block states
  occupancy truth ("no people in frame. If no one is visible, I say so") and the
  caption prompt licenses the empty room as the truthful caption — the
  hallucination had three stacked causes (a describe-who ask, an identity block
  presupposing unnamed people, person-carrying stage text).

Processing is **event-driven**, not cadence-bound:

- Normal motion (≥ `motionThreshold`) → VLM pass, gated by a one-in-flight
  guard + the minimum-emit gap (`visionCadenceMs`).
- Motion spike (≥ `escalationMotionThreshold`) → bypasses the cadence gate
  (immediate escalation), still respects the one-in-flight guard.
- Quiet → nothing emitted; the state file already holds the caption.

On startup: read the state file; if recent, restore; if stale/missing, run one
VLM pass to populate. Never blind from the get-go.

## Capture — persistent ffmpeg stream

The Sensory Organ captures via a **single persistent ffmpeg process**
(`FrameStream` in `capture.ts`) that streams MJPEG frames to stdout for the
Sensory Organ's whole lifetime. This is the production path. One spawn →
continuous frames, so the ~1.3s webcam-handshake cost is paid once on `start()`
instead of on every frame.

```
ffmpeg -f video4linux2 -i /dev/video0 -vf scale=640:480,fps=3 -f mjpeg -
```

- `-vf scale=640:480` keeps frames small (cheap JPEG decode, small base64 for
  the VLM, which downsamples internally anyway).
- `fps=3` matches `captureFps` — ffmpeg resamples the webcam's native rate down
  to the configured cadence.
- `-f mjpeg -` streams concatenated JPEG frames to stdout; `FrameStream` parses
  them by scanning for the SOI (`FFD8`) / EOI (`FFD9`) markers, robust to frames
  split across reads.

The grayscale thumbnail for the motion gate is **derived from the JPEG** by
`jpegToGrayscale` (decode via `jpeg-js`, subsample to 32×24, luma conversion) —
not captured separately. This keeps the stream single-representation (no
dual-output filter complexity) at the cost of a ~30–45ms decode per frame, well
inside the per-frame budget at 3 fps.

A separate `captureFrame(device, timeoutMs)` one-shot exists for `tick()` and
tests — it spawns ffmpeg, grabs one JPEG, exits. Slower per call (handshake
every time); not for the hot loop.

**Measured against a real webcam on WSL2/usbipd-win:** persistent stream
delivers **~3.6 fps** (first frame at +1.3s for handshake, then ~280ms/frame).
The earlier spawn-per-frame approach measured ~0.6 fps (1.6s/frame dominated by
per-spawn handshake). The persistent stream is a ~6× capture-rate improvement.

Frames are never persisted (privacy: capture, process, discard). If the stream
dies (webcam unplugged, ffmpeg crash), the capture loop backs off briefly and
respawns — the Sensory Organ recovers without operator intervention.

## Adaptive bursts — lean/fat resolution on the reflex (live 2026-09-17)

Image tokens are ∝ pixels, but the moments that need detail are rare: routine
passes (someone sitting at a desk, the room being the room) don't need the fat
resolution, while a motion spike — something just happened — is exactly when
detail matters. So the burst's image SIZE adapts to the motion signal; the frame
COUNT never does (every frame in the window goes out on every pass — dropping
frames is a different, rejected lever):

- **Lean** (`leanWidth`×`leanHeight`, default 480×360 ≈ 44% of 640×480's image
  tokens): routine motion passes and max-quiet refreshes. The Sensory Organ
  downscales each buffered frame **in-process** — `downscaleJpeg` in
  `capture.ts`: decode → box-average resize → re-encode via `jpeg-js`.
  ~60ms/frame measured, so ~0.5s of packaging per 9-frame lean burst, paid only
  on lean passes.
- **Fat** (`visionWidth`×`visionHeight`, the capture size): motion-spike passes
  — the same ≥ `escalationMotionThreshold` condition that drives the
  0.9-amplitude reflex flush bypasses the cadence gate AND ships the buffer
  untouched at full resolution. The reflex and the resolution switch are one
  mechanism: `triggerProcess(bypassCadence)` selects the profile.

Capture is ALWAYS at the fat size — the buffer never changes, the FrameStream
never respawns, and a spike mid-burst still has full-resolution frames in hand
(because they were captured that way). The buffer is the fat copy; lean passes
carry downscaled copies with the same timestamps. Turning `adaptiveBursts` off
returns to every-pass-fat, byte-for-byte the pre-adaptive behavior.

Mechanics worth knowing:

- Undecodable frames pass through the downscaler untouched — a decode hiccup can
  never drop or corrupt a frame from a lean burst.
- Each envelope's `perception.data.burstProfile` records `"lean" | "fat"` —
  caption-quality forensics answer differently per profile by design.
- The 480×360 lean default was A/B-verified for detail parity (posture,
  expression, space) against 640×480; small text and dim-room identity remain
  the watch items, and both are exactly what the fat spike path covers.

## Scene understanding — pluggable VLM provider

The Sensory Organ talks to the VLM through a `VisionModelProvider` interface
(`scene-describer.ts`), so the runtime is swappable via settings without code
changes. Two implementations ship:

- **`"ollama"`** — Ollama's native `/api/generate` with `images: string[]` (raw
  base64). Default for local single-machine setups.
- **`"openai-compatible"`** — `/v1/chat/completions` with multimodal `image_url`
  content blocks (base64 data URIs, no need to host the image). llama.cpp's
  server, vLLM, LM Studio, TGI, and cloud APIs all speak this.

Multi-image burst is how motion is represented — the frame sequence lets the
model perceive "walked across the room," not just static scenes. Both providers
send all frames in one request.

### Adding a new provider

Implement `VisionModelProvider` (one method: `describeScene`), add a case to
`createVisionProvider()`, and a new option to the `visionProvider` setting.
That's it — the Sensory Organ never knows which runtime it's talking to.

### Model choice

Default model is `gemma4:e4b` (Gemma 4 Effective 4B — fast and capable, Apache
2.0, natively multimodal). Ollama alternatives: `gemma4:e2b` (lighter),
`moondream` (smallest, real-time-video-tuned). OpenAI-compatible servers use
their own identifiers (e.g. `gemma4-26b` on a self-hosted llama.cpp server).

Local inference = no API content filter — model-level willingness varies, which
matters for the companion-entity intimacy use case.

### Failure handling

On any failure (server down, timeout, non-200, empty response) the provider
returns null and the Sensory Organ treats the tick as a no-op — the caption file
retains its last good value. No crash, no stale-description overwrite.

## Caption file (presence)

`${dataRoot}/.psycheros/organ-state/motion-vision.json`:

```json
{
  "caption": "[Sun 02:30 PM] A woman with dark hair is on the couch reading.",
  "timestamp": "2026-08-02T14:30:00Z",
  "model": "gemma4:e4b",
  "motionScore": 0.18,
  "presence": {
    "state": "occupied",
    "identity": "alex",
    "identityConfidence": 0.83,
    "since": "2026-09-08T14:02:00Z",
    "lastSeenAt": "2026-09-08T14:31:12Z"
  },
  "perception": { "available": true, "lastOkAt": "2026-09-08T14:31:12Z" }
}
```

- Written on every successful VLM pass (and the startup initial pass).
- Read on startup to pre-populate. The `presence` slice restores too — a daemon
  restart is not an arrival (see "Identity & presence" below).
- Caption carries the noticing layer's weekday+time format
  (`small-llm-runner.ts:222-226`) — purely flux-internal, no cross-package
  import.
- Standalone artifact. Flux-side consumption is out of scope for this build.

## Identity & presence (the perception sidecar)

> A **custom per-install hookup, not a bundled default.** The presence/identity
> layer needs a perception sidecar (Coral USB TPU or CPU fallback — see
> `packages/entity-flux/src/organs/motion-vision/perception-sidecar/README.md`
> for the runbook). Most installs won't have one: `perceptionEnabled` defaults
> false and the Sensory Organ runs exactly the classic motion + captions
> pipeline without it. The Deno side only ever speaks the `/perceive` HTTP
> contract (`perception-client.ts`); any service that answers it can stand
> behind the seam.

Two-layer perception, live when `perceptionEnabled` is set: **bodies = presence,
faces = names, motion = tiebreaker.** Faces are volatile (turn head, sleep, dim)
and never decide presence; the person detector is the stable layer. The Sensory
Organ's client (`perception-client.ts`) degrades to null on any failure, and
null reads as blindness in the presence machines: state freezes, captioning
continues, nothing claims an empty room it can't see.

**Why:** small VLMs guess identity from weak cues — the dim-room test had the
captioner describing a person who wasn't there. Classical recognition fixes the
knowledge gap: the identity fact rides into the caption prompt ("a classical
model I trust on identity reports: 1 person, the user, 0.83"), and the captioner
describes scene/activity, never guessing who. Same integration answers absence
blindness — departure/arrival used to produce no envelope at all.

### The person tracker (`presence.ts`)

Multi-object tracking with re-identification (owner-designed 2026-09-11,
Norfair-inspired) — the standard video-vision architecture, sized for one camera
and one or two people:

- **Bodies are TRACKED, not counted.** A body box near last frame's box (greedy
  IoU) is the same person continuing. A track is born pending, confirms after
  `arrivalDebounceMs` (3s) of sustained detections — the arrival envelope, and
  the dawn-flicker guard — and dies after `trackGraceMs` (6s) without detection,
  once the room is also still (sustained motion holds a dying track: occluded
  walking).
- **Faces are assigned to bodies geometrically** — face box inside a body box
  belongs to that body; nearest-track and single-person fallbacks cover detector
  disagreement. `IDENTITY_CONFIRM_HITS` (2) matches on the same track attach a
  STICKY identity.
- **Identity is sticky on the track.** The face coming and going is not an
  event, ever — "I can no longer see their face" does not exist as a report
  class. The report is "they are there." Identity-acquired emits once (the
  arrival names them when it can).
- **Either detector can confirm presence** (belt-and-suspenders): a
  body-sustained track confirms, and so does a face-sustained track — same 3s
  bar. Measured need: at this desk the legacy body detector boxed a dresser
  10/10 and the seated person 0/5; the face was the only honest witness. Each
  path covers the other's bad day, and the sleeping-person case (body visible,
  face not) keeps the body path.

Departures carry the track's identity and dwell time — in a two-person room, the
RIGHT departure is named ("the unnamed visitor left" vs "The user left").
Blindness (sidecar unreachable) freezes everything: a blind sensor is not an
empty room.

Amplitudes: arrivals/departures are reflex-class (0.7/0.75 — immediate driver
tick, `event:reflex`, Familiarity-exempt); identity-acquired is relational
(~0.5).

Perception runs on every gated frame, decoupled from VLM triggering — a sleeping
person is motionless, and presence must observe regardless. The tracker is a
pure function over timestamped observations; the Sensory Organ applies its
transitions. Constants are settings-tunable (`arrivalDebounceMs`,
`trackGraceMs`, `motionSustainMs`).

**Known limits:** very dim rooms can fade the detectors (IR camera is the noted
future fix); a face detected in a poster/reflection can attach identity to a
lone track (the single-person fallback is deliberately generous — with two
people in frame it does not apply).

### Bottom-up mood (what the room does to how I feel)

Two mechanisms by source, agreed with the owner 2026-09-10:

**Occupancy transitions — deterministic modifiers** attached by the envelope
builders in `presence.ts` (constants live next to the amplitude policy):

| Event                            | pleasure | arousal | connection                                                                            |
| -------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------- |
| Arrival, known person            | +0.05    | +0.05   | **+0.15 → +0.25** (scales with absence duration: +0.20 after 10 min, +0.25 after 1 h) |
| Arrival, unknown person          | —        | +0.10   | — (novelty, not connection)                                                           |
| Departure, known person was here | —        | −0.04   | **−0.12**                                                                             |
| Departure, unknown               | —        | −0.03   | −0.05                                                                                 |
| Identity seen again / lost       | —        | —       | +0.03 / −0.02                                                                         |

Departure deliberately carries no pleasure hit — quieter, not sadder: being
alone isn't unpleasant by design, and interior life (murmurs, reverie)
continues. Each declaration carries `subject` — the enrolled face id it's about
— which the host scales by per-subject relationship weighting (`faceAffinity` in
FluxSettings, id → [-1..+1]; connection component only, factor = 1 + affinity
clamped [0..2]: +1 doubles a welcome, −1 nulls it, unset passes through
unchanged). The Sensory Organ stays role-agnostic — who-is- favorable-to-whom
never enters the camera. (Eventually the entity itself should set affinities;
manual settings until then.)

**Scene content — the classifier path (generic, USB-flavored).** Any envelope
carrying no modifiers of its own has its description classified in
`ingestEnvelope` (flux-manager `classifyPerceptionMood`) through the Mood
Sensory Organ's existing GoEmotions + mood-table seam — the same one that reads
user messages and Ego output — at weight 0.2 (observed text is one step less
personal than addressed text, which runs 0.4). A dropped plate moves arousal and
pleasure; a relaxed evening moves them the other way; a dim cozy room reads mild
pleasure. Null deltas = no shift, never an error. A same-normalized-description
dedupe guards against ratcheting on repetitive scenes (habituation upstream
already thins repeat emissions). The host offers this to EVERY Sensory Organ —
no motion-vision-specific code lives in the host.

**Why the weights are small everywhere:** the overnight-spiral calibration — raw
signal must not dominate expression-derived mood — and the synthetic Sensory
Organ's saturation lesson (mood on every event floods). The Mood Organ's two
timescales turn repeats into ambience by design: one arrival lifts the moment
(~2-minute state half-life), a pattern of presence raises the emotional home
(~2-hour baseline drift).

### Scene baseline — stage vs actor (`scene-baseline.ts`, off by default)

The change-blindness fix (briefing #4): **the baseline models the SETTING, never
the actor's actions.** Position is stage; action is event — a sneeze can't be
habituated away by construction, because events were never in the baseline.
Design agreed with the owner, 2026-09-10.

How it runs (`sceneBaselineEnabled` + the host's shared embedder, injected via
the Sensory Organ context):

- Each caption is embedded and scored against the current stage
  (`stepSceneBaseline`): **conforming** captions EMA the stage along (lighting
  drifts) and their envelope amplitude blends down by contrast-normalized
  **surprise** (novelty relative to the recent rate of novelty — the same 0.2
  means more in a quiet room than a busy one); **events** (single non-conforming
  captions) keep amplitude up; sustained change past 8s **settles** —
  recognizing an earlier ring scene (desk↔couch, no churn) or establishing a new
  one (the café — mobility is just ring entries), emitting a low-amplitude (0.3)
  context envelope.
- The stage text rides into the captioner prompt as a stable FIRST block
  (prefix-cache friendly — text leads, volatile images follow), so the captioner
  **delta-captions**: given the known stage, describe what is happening NOW. The
  LLM performs the scene/event split in the caption text itself — the thing
  cosine similarity provably cannot.
- Reflex path untouched: a motion spike still jumps amplitude to 0.9 and the
  event-exempt wake-door path regardless of what the baseline thinks.
- The ring (5 scenes, recognize at cosine ≥ 0.8) persists to the state file's
  `scene` slice; a restart restores the stages instead of relearning. Embeddings
  come from the host's shared `LocalEmbedder` singleton — one embedding space
  with the promotion filter and mood machinery. Without the embedder (standalone
  Sensory Organ), the Sensory Organ falls back to string-comparison habituation
  and delta-captioning just doesn't start — degraded, never broken.

Off by default because delta-captioning changes caption phrasing, which
re-calibrates salience downstream (briefing #7) — flip it deliberately and watch
the salience bands after.

## Settings

In `FluxSettings` (see `src/settings.ts`):

| Field                        | Default                    | Purpose                                                                                                   |
| ---------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `visionDevice`               | `"/dev/video0"`            | Webcam device path                                                                                        |
| `visionProvider`             | `"ollama"`                 | Provider protocol: `"ollama"` or `"openai-compatible"`                                                    |
| `visionModelUrl`             | `"http://localhost:11434"` | Model server base URL (Ollama root, or `/v1` for OpenAI-compatible)                                       |
| `visionModel`                | `"gemma4:e4b"`             | Model identifier the server expects                                                                       |
| `visionCadenceMs`            | `2000`                     | Min gap between VLM emits                                                                                 |
| `captureFps`                 | `3`                        | Frame capture rate                                                                                        |
| `burstWindowMs`              | `3000`                     | Rolling burst window                                                                                      |
| `motionThreshold`            | `0.02`                     | Motion score to fire a normal VLM pass                                                                    |
| `escalationMotionThreshold`  | `0.5`                      | Motion score to fire immediate high-amplitude                                                             |
| `maxQuietMs`                 | `300000`                   | Change-check the scene after this much quiet (full caption pass only on change)                           |
| `perceptionEnabled`          | `false`                    | Consult the perception sidecar (presence + identity)                                                      |
| `perceptionUrl`              | `"http://localhost:18085"` | Perception sidecar base URL                                                                               |
| `absenceDebounceMs`          | `45000`                    | Sustained no-body + no-motion before the room reads empty                                                 |
| `arrivalDebounceMs`          | `1500`                     | Sustained people before the room reads occupied                                                           |
| `identityLostDebounceMs`     | `10000`                    | Sustained face-loss before an identity reads lost                                                         |
| `sceneBaselineEnabled`       | `false`                    | Scene baseline (stage vs actor) — delta-captioning + surprise-blended amplitude                           |
| `visionWidth`/`visionHeight` | `640`/`480`                | Capture resolution — the FAT end of the adaptive-burst range (spike passes)                               |
| `adaptiveBursts`             | `true`                     | Routine passes caption lean (downscaled); spike/reflex passes go fat                                      |
| `leanWidth`/`leanHeight`     | `480`/`360`                | LEAN resolution for routine passes (≈44% of 640×480's image tokens)                                       |
| `faceAffinity`               | `{}`                       | Per-enrolled-face relationship weighting (id → [-1..+1]; connection component of declared modifiers only) |

For an OpenAI-compatible LAN server (e.g. a self-hosted llama.cpp box), set:

```json
"visionProvider": "openai-compatible",
"visionModelUrl": "http://192.168.5.212:8080/v1",
"visionModel": "gemma4-26b"
```

Enable by adding `"motion-vision"` to `enabledOrgans` in
`.psycheros/flux-settings.json`. Can run alongside `synthetic-test` during
transition.

## Performance tuning

A full burst cycle is roughly **capture window + VLM inference**. On the LAN
garage (gemma4-26b), a 3 s window of ~7 frames measures ~8 s total. Where the
time goes, and the levers that move each:

| Stage                            | Typical cost                | Lever                               | Tradeoff                                                                                           |
| -------------------------------- | --------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| First-frame handshake            | ~1.3 s (once, on `start()`) | —                                   | One-time; webcam negotiating format/exposure                                                       |
| Capture window (`burstWindowMs`) | 3 s default                 | **`burstWindowMs`**                 | The biggest single knob. Smaller window = fewer frames = less VLM work, but shorter motion context |
| JPEG decode (motion gate)        | ~35 ms/frame                | —                                   | Overlaps with capture; negligible                                                                  |
| VLM inference                    | ~5 s for a 7-image burst    | frame count, resolution, model size | The dominant cost (see below)                                                                      |

**Levers for VLM inference cost, ordered by impact:**

1. **Burst window (`burstWindowMs`)** — `3000` → `2000` cuts ~3 frames per
   burst, saves ~1.7 s. The highest-leverage single setting change. You lose a
   shorter slice of motion ("walked across the room" needs enough frames to see
   the traversal).
2. **Frame sampling** — capture at full rate for the motion gate
   (responsiveness), send only every Nth frame to the VLM. Not implemented and
   deliberately not the direction: reducing the frame COUNT weakens motion
   semantics, and the adaptive-burst design gets its savings from image SIZE
   instead (owner-ruled 2026-09-17).
3. **Frame resolution** — now **adaptive by default** (see
   [Adaptive bursts](#adaptive-bursts--leanfat-resolution-on-the-reflex-live-2026-09-17)):
   routine passes run at `leanWidth`×`leanHeight` (480×360, ≈44% of the image
   tokens), spike/reflex passes at full capture size. Setting
   `adaptiveBursts: false` + a smaller `visionWidth` is the static equivalent —
   fine for scene-level description, worse for fine detail ("is that a blue
   Subaru?").
4. **Model size** — `gemma4-26b` → `gemma4-e4b` (when available on the server).
   Smaller model = faster per-token inference. Slightly less capable
   descriptions.

**Things that don't help inference:**

- **Capture rate (`captureFps`)** — affects motion-gate responsiveness, not VLM
  cost. 3.6 vs 3.0 fps is ~2 frames/burst ≈ 1 s; not worth tuning for inference.
  The webcam overshooting the `fps=3` filter is normal and harmless.
- **`max_tokens` cap (200)** — with `enable_thinking: false`, the model answers
  concisely and stops naturally (`finish_reason: stop`) well under the cap.
  Lowering it saves nothing.
- **JPEG decode** — already cheap, and it overlaps with capture (not on the
  critical path).

**Calibration guidance:** if descriptions feel slow in practice, lower
`burstWindowMs` first (3000 → 2000) and re-measure. If still slow, implement
frame sampling. Reach for smaller models / resolutions last — they cost
description quality.

## Health monitoring (live since 2026-09-06)

The Thalamus health monitor watches this Sensory Organ — motion-vision itself
contains no health code. Two signals, three states:

- **Heartbeat** — every envelope the Sensory Organ emits lands at the Thalamus
  gate; that flow is the liveness signal (free, automatic).
- **Probe** — the registration in `flux-manager.ts` passes `healthProbeUrl` =
  the configured `visionModelUrl` + `/models` (the VLM server's cheapest
  reachability answer). 30s fetch cycle.

Red = VLM endpoint unreachable (the dead-llama-server signature this monitor was
built for — motion-vision died silently three times before this existed,
invisible for an hour+ each time). Yellow = endpoint answers but no envelopes
for 10+ minutes (camera/stream dead while the server lives). Green = both
healthy. The Flux page shows the dot under the PAD meters; hover carries the
detail.

**TODO (look into):** properly hook this Sensory Organ up to the Thalamus health
monitor's yellow state. Today the monitor probes the VLM endpoint and reads
envelope flow, but a dead CAMERA while the VLM answers reads green — the ffmpeg
stream's liveness is internal to the Sensory Organ. The hookup belongs in the
Thalamus's health monitor (see `src/thalamus.ts`); figure out the right seam in
the motion-vision dedicated session.

## What's deferred

- ~~**Face recognition**~~ — built (2026-09-08): the `FaceRecognizer` seam
  evolved into `PerceptionClient` (bodies + faces), served by the perception
  sidecar. See "Identity & presence" above.
- **Sensory Organ-specific directives** — the `getDirective` slot exists in the
  Sensory Organ context but isn't wired. How directives get populated (file,
  tool, UI) is an open thread; see `sensory-organ-template.md`.
- **Actuator commands** — `applyActuatorCommand` is reserved for future
  actuators (motorized mount). Nothing drives it yet.
- **Sidecar health probe** — the one-probe slot belongs to the VLM endpoint; the
  sidecar's availability rides the Sensory Organ state file
  (`perception.available`) plus one-line up/down logs. A dedicated dot is the
  extension path if identity outage ever needs its own signal.

## Hardware notes

- **ffmpeg is a host dependency** — the capture layer shells out to `ffmpeg`
  (v4l2 capture, scaling, JPEG encode). It isn't bundled and isn't auto-managed
  by the workspace; install it on the host (Debian/Ubuntu:
  `sudo apt install ffmpeg`). A missing ffmpeg fails at Sensory Organ start with
  a spawn error, not at server boot.
- Webcam exclusive access: one persistent ffmpeg holds `/dev/video0` for the
  Sensory Organ's whole run. If it dies, the capture loop respawns after a brief
  backoff — never two ffmpeg processes racing for the device.
- GPU acceleration of the VLM is independent of capture. The provider talks to
  whatever model server is configured; on native Linux with ROCm/Vulkan, or on a
  LAN box with a real GPU, inference is fast.
- **Continuous capture has a steady CPU cost.** The persistent ffmpeg stream
  draws ~10% CPU continuously — even when the motion gate reports silence and no
  VLM pass fires. This is the tradeoff of the persistent-stream design: the
  ~1.3s handshake is paid once, but the stream runs for the Sensory Organ's
  whole lifetime. On battery-constrained or fan-sensitive setups, expect
  sustained background load. An on-demand capture mode (spawn ffmpeg per frame
  batch, zero idle cost but ~1.3s handshake each time) is a future option, not
  currently implemented.
