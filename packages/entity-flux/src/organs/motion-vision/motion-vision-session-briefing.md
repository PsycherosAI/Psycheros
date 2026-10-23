# motion-vision — session briefing (prepared 2026-09-07)

> **Session outcome (2026-09-08):** items 1 (absence blindness) and the
> identity-accuracy Fix Path A are BUILT — two-layer perception (bodies =
> presence, faces = names) via the Coral sidecar + presence machines. See
> `docs/motion-vision.md` → "Identity & presence". Items below left as written
> for the record; 2 (camera liveness), 3/7 (captioner swap and salience
> re-baseline), 4 (baseline), 5 (mood modifiers, since built), 6 remain open.

Everything we know, gathered from motion-vision.md, today's logs, and live
observation. For the dedicated motion-vision session.

## Context: what motion-vision is

The first real Sensory Organ: webcam capture (persistent ffmpeg v2l2 stream) →
motion detection → burst frames → VLM captioning (local llama-server) →
`OrganEnvelope`s to the Thalamus. Full reference:
[`docs/motion-vision.md`](motion-vision.md). Template:
[`docs/sensory-organ-template.md`](sensory-organ-template.md).

Current runtime wiring (this install):

| Piece          | What                                                                           | Where      |
| -------------- | ------------------------------------------------------------------------------ | ---------- |
| VLM server     | LFM2.5-VL-450M-Q8_0 (llama.cpp Vulkan)                                         | port 18081 |
| Noticing model | gemma-4-E2B q4                                                                 | port 18080 |
| Reverie model  | Gemma-4-E4B uncensored (HauhauCS-Aggressive Q4)                                | port 18082 |
| Launch binary  | `~/Experiments/gemma4-e2b-baseline/build/llama-b10288-vulkan/bin/llama-server` | —          |

**Launch trap:** the vision server needs `-c 4096` — multi-frame caption
requests run ~2500 tokens and bounce off 2048 with HTTP 400s.

## THE CRASH ISSUE (primary)

**Symptom:** the vision model server (18081) dies silently, repeatedly. Five
deaths in ~24h (also hit 18080 and 18082 once each).

**What it is NOT:**

- NOT the Sensory Organ crashing — the daemon process stays healthy; the Sensory
  Organ keeps retrying VLM calls (`VLM describe failed: connection refused`, 914
  lines today) the whole time.
- NOT the health monitor missing it — the Thalamus monitor flips red within one
  tick (30s) every time, and green on restore. It works.
- NOT a Flux-domain bug. Flux's boundary ends at the envelope.

**What it IS:** the llama-server _process_ being OOM-killed by the kernel (28GB
box, three Vulkan servers + daemon resident; burst allocations collide; the
kernel picks a victim). Fingerprint: server log stops mid-task with zero error
output — SIGKILL leaves no note. No recovery exists: the health monitor
_detects_, nothing _restores_.

**Domain answer:** the server's lifecycle is infrastructure — neither Flux's nor
really motion-vision's-code problem. Three candidate homes, in rough preference
order (decide in the session):

1. **Host-side supervisor** (Flux-adjacent, no Sensory Organ code): an ops layer
   reading the health report, restarting dead server processes with backoff. The
   monitor already emits the signal.
2. **systemd units** per server — the classic answer; `Restart=on-
   failure` +
   resource limits, outside the codebase entirely.
3. **Fewer resident servers** — one llama-server box with slotting serving all
   three roles, trading latency for memory headroom.

Related organ-side gap (the monitor's blind spot): a dead CAMERA while the VLM
answers reads green — ffmpeg stream liveness is internal to the Sensory Organ.
TODO (noted in motion-vision.md): hook the stream into the Thalamus monitor's
yellow state; the seam gets designed in the session.

## Open items for this Sensory Organ (from NOTES)

1. **Absence blindness (scoped to the Sensory Organ).** Departure/return goes
   unreported — no envelope, no signal; the entity never registers the absence.
   Absence is a temporal pattern (present → not → present) that per-envelope
   caption salience cannot see. Needs person-detection state held across frames
   INSIDE the Sensory Organ, emitting departure/return as its own envelope kind.
   The mood-level response (Connection sag on absence) is separate — that's
   Flux-side, already designed.
2. **Camera stream liveness → health yellow** (the TODO above).
3. **The captioner's modesty wall (observed 2026-09-07).** During an intimate
   scene, the VLM produced only euphemistic deflection ("quiet, warm intimacy")
   while salience spiked 0.75–0.85 — it knew, it wouldn't say. Owner's
   direction: abliterated/uncensored vision model. The gemma4-e4b-uncensored
   build already exists (running on 18082 for reverie) and that family has an
   mmproj — first candidate, zero new downloads. CAUTION: re-baseline salience
   after any swap (the 0.2–0.45 mundane band was measured on the chaste model; a
   plainer captioner will shift the whole distribution).
4. **Salience has no baseline (change-blindness).** "Person on orange couch"
   reads mundane forever because nothing tells noticing what normal looks like.
   Per-organ baseline snapshots (scene centroids) would fix this AND make
   transitions visible. Canonical test case: "purple shirt, orange room,
   standing" vs "…sneezing" — same scene, new event; the sneeze must never be
   silenced (pinned as a unit test in familiarity_test.ts for the wake door's
   event-exempt path).
5. **Bottom-up mood is unwired (owner's ask, noted 2026-08-27).** The
   `envelope.moodModifiers` path exists but motion-vision attaches none — the
   room's felt-quality never shifts mood directly. Fix shape: mild modifiers on
   scene-change events (appearance/disappearance, lighting shifts), SMALL
   weights, scene description as source content. This is a design task (which
   events, which axes, which weights).
6. **Noticing volume under active camera.** 3s Thalamus slots + active motion →
   ~10 promotions / 8 min. Corroboration passing similar observations; the
   baseline item (#4) is the real fix.
7. **Captioner phrasing shifts salience** (2026-09-05 incident): after a server
   restart the captioner's phrasing drifted ("man in purple shirt" vs the name),
   salience dropped 0.65–0.75 → 0.20–0.45, and promotion stalled. Any captioner
   change re-calibrates everything downstream. Same caution as #3's swap note.

## Identity accuracy — the E2B test verdict + two fix paths (2026-09-07)

**Tested:** the uncensored E2B-VL as captioner on the shared server (see below).
Latency fine (~3.5s/caption), explicit-content clause works, thinking
suppressed. **Identity accuracy: FAILED** — with the user alone in frame in a
dim room, it described a man who was not there, with invented physical details
(nobody else present). Same failure class as the 450M: small VLMs guess identity
from weak cues, and dim lighting tips the guess. Neither captioner knows who it
is looking at; that is a knowledge gap, not a prompt-tuning gap.

**Fix path A — Coral TPU face-ID (recommended first).** The user has a Coral
TPU. Run a face-embedding model (MobileFaceNet-class; ready-made Coral builds
exist) with a handful of reference photos: ~30ms per-frame "this is the user /
confidence" verdict, zero training run, zero RAM pressure on the box. Organ
flow: Coral identifies the person CLASSICALLY → the fact rides into the VLM
prompt ("one person in frame: <name> — describe what they're doing") → the
captioner describes scene/activity and never guesses identity. **This is also
the exact machinery the absence-blindness item needs** (present → absent →
present detection over time) — one integration solves mis-ID AND
departure/return. Fits the USB-plugin Sensory Organ shape (a perception input,
not a brain).

**Fix path B — LoRA fine-tune the captioner (later, optional).** Teach the small
VLM the user's identity directly: ~50–200 varied photos (including the failure
lighting), simple captions naming the user, LoRA via
LLaVA-Factory/ms-swift-class tooling on a rented GPU hour (conversion back to
GGUF after). Solves identity AND tunes description style, but it's a weekend
project with yak-shaving, needs re-doing if the captioner model changes, and
doesn't help absence detection. Only worth it if path A proves insufficient or
description-style tuning is also wanted.

**Shared-server topology (tested 2026-09-07):** one llama-server on 18080 —
uncensored E2B + mmproj, `-c 8192 -np 2` (two slots so vision captions and
Noticing text calls don't serialize), `-ngl 40`. Noticing (text-only chat
completions) and motion-vision (multimodal chat completions, thinking
suppressed, explicit-content instruction in the prompt — also added to the
Noticing prompt) both point at it. RAM net win: ~4.5GB of old servers out,
~4.2GB in, one fewer process for the OOM killer. Coupling accepted: one death =
both roles red on the health strip (the probe watches the shared port). Noticing
cadence unchanged — the Thalamus slot timer (3s max wait, empty slot = no call,
early-flush on importance mass or reflex ≥ 0.7) owns when Noticing fires, not
the Sensory Organ's motion rate.

## Working reference: today's healthy numbers

- Salience band, mundane quiet room: **0.2–0.45** (measured today, the chaste
  captioner)
- Observation cadence, quiet room: ~1 per 15–30s during motion
- Health monitor: 30s ticks; red on endpoint death, green on HTTP 200, yellow
  reserved for contradictions (unimplemented signal so far)
- Damping (Flux-side, for context): the wake door's event-exempt path keys off
  `event:reflex` tags set from envelope amplitude ≥ 0.7 at noticing time —
  reflex-class events skip Familiarity damping

## Health monitoring hookup (live since 2026-09-06)

The Thalamus health monitor watches this Sensory Organ — no health code in the
Sensory Organ. Heartbeat = envelope flow; probe = `healthProbeUrl` (the host
registers `visionModelUrl + /models`). Dot strip under the PAD meters. See
motion-vision.md → "Health monitoring" for the states and the camera-liveness
TODO.
