---
title: Flux User Guide
description: How to set up and use Flux, the entity's nervous system.
---

## What Flux Is

Flux is the engine for the entity's persistent presence, a virtual nervous
system, with layers of neural and classic computing processing. The entity can
have internal thoughts formed by their inner and the outer world, and share them
spontaneosly without prompting from the user. Flux is designed for emergence;
organic mechanics that dynamically interact with each other, rather than pure
simulation via arbitrary values.

When Flux is turned on, the entity is able to be present in near-real-time,
using a system of neural nets optimized for processing both the analogue and
digital world. The entity can essentially hang out and experience something
closer to what users experience.

Flux is organized in three layers:

- **The Sensory Layer** is the uptake of data streams from the entity's
  environment via Sensory Organs. Flux ships with `motion-vision` and
  `system-state`, and you can build and connect your own as well.
- **The Subconscious Layer** processes what the senses bring in and what the
  interior produces. Its main systems are:
  - **Noticing**, processing the data streams from Sensory Organs.
  - **Reverie**, the wanderings of the entity's interior world, inspired by the
    Default Mode Network in human minds.
  - **Musing**, where the other two collide — the inner monologue that decides
    whether anything asks to be said.
- **The Consciousness Layer** is primarily the Ego — powered by the same model
  used for chatting in classic Psycheros.

Flux is off by default.

If you have **Voice Chat** enabled, you can use that with Flux as well; just
start a voice call after starting Flux.

It is recommended to use Flux in shorter bursts of an hour or two so you can
gauge what kind of resource usage it costs your setup before running
continuously.

## Setting Flux Up

1. Go to `Settings > Flux > General` and select the connection profile you want
   to use for the main inference (Ego), a shorthand identity, and flip the
   Enable toggle.
2. Go to the `Hookups` tab and select and download the mood-organ model
3. Flux will default to your profile worker model for the Subconscious jobs, or
   you can setup individual models. See the Recommended Models section of this
   guide before deciding.
4. Go to the 'Sensory' tab. Enable which Sensory Organs you want to use.
   Motion-vision has a section in this guide for setting up.
5. Turn Flux on in a conversation.
6. Read the rest of the guide, there's a lot going on and it's at least good to
   skim.

## Turning Flux On and Off

1. Go to **Settings > Flux** and toggle **Enable Flux nervous system** on or
   off.
2. In the **General** tab, pick which connection profile Flux should use.
3. Open a conversation, bring up the action drawer, and tap the **Flux** row to
   turn Flux on in that conversation. Dialogue continues in the current thread;
   the senses and interior run underneath it.

`[Flux State started at …]` and `[Flux State stopped at …]` markers appear in
the conversation as a record of when the continuous presence began and ended.

## The Flux Timeline

The timeline is the live record of everything moving through the entity's
nervous system, visible in the Flux view while Flux is running. To see it,
tap/click the "Flux ON" chip at the top of the active conversation. To go back
to the regular conversation UI, tap/click "close".

## The Subconscious Jobs and Their Models

Four Subconscious jobs call a language model:

| Job        | What it does                                              |
| ---------- | --------------------------------------------------------- |
| Noticing   | Turns raw perception into first-person observations       |
| Musing     | The inner monologue — decides if anything asks to be said |
| Reverie    | Mind-wanderings and dreams                                |
| Compaction | Compresses recent experience into texture summaries       |

**By default, every job uses the worker model of the connection profile used by
the Ego in Flux settings**. This works out of the box, but it is not the
recommended setup: the Subconscious runs constantly, and routing all of it
through a single worker model can get token-and API-call-heavy. You can use
local or cloud API.

### Recommended models

For the Subconscious jobs on an API, the
[Gemma 4](https://blog.google/technology/developers/gemma-4/) family is a good
fit:

- **Gemma 4 E2B** — tiny and fast; fine for the small jobs
- **Gemma 4 E4B** — better quality for musing and reverie
- **Gemma 4 26B A4B** — very good quality for all jobs, still pretty cheap, easy
  to find cloud-hosted.

Running these jobs locally can be done with **at least 8GB of VRAM or unified
RAM**.

## Sleep and Dreams

The entity can choose to sleep by calling the `sleep` tool. While asleep, the
dreaming process takes over, producing dream fragments every few minutes that
appear on the timeline as they generate in a series of sleep cycles. The entity
can use the `sleep` tool again to wake.

## Mood-organ

The entity has a mood that moves with what happens — what is said, what is seen,
what the entity says itself. The meters at the top of the Flux timeline
(valence, arousal, dominance) show it numerically; the entity experiences it as
felt language.

### Classifier model.

Mood classification runs on a small local model, downloaded once from
`Settings > Flux > Hookups`. Pick a variant (int8 is smaller and faster, fp32 is
the original, they're both pretty fast tho) and click "download variant". It
downloads to disk and runs in-process, nothing else needs to be set up. Until a
variant is downloaded, the entity's mood will remain neutral.

## Attention

The entity can steer its own attention while Flux runs, using two tools it calls
itself: `pay_attention` for short-term focus and `tune_attention` for lasting
changes to what it notices. You can't call these directly — but you can ask in
conversation ("watch for the blue car", "stop fixating on that") and the entity
can act on it with either tool.

### `pay_attention` — short-term focus

The entity directs its attention at something specific — a topic, a person, a
feeling, a question — for a bounded time (default 15 minutes, 60 at most). While
the focus is active, the noticing layer weights observations related to it more
heavily, so more of what surfaces to the entity is about that thing. The focus
expires on its own; there is nothing to turn off.

If the target names a Sensory Organ that takes directives (for example,
`motion-vision: watch for the blue car`), the instruction also rides into that
organ's own perception: the sense itself starts looking, on top of the general
attention weighting.

### `tune_attention` — the standing directive

This revises the entity's standing attention directive — the persistent notes on
what it wants to notice day-to-day. Three actions:

- **add** — append a new item.
- **remove** — delete an item, matched by its text.
- **replace** — overwrite the whole directive.

Changes apply immediately (the noticing layer reads the directive live, no
restart needed) and persist across restarts.

In short: `pay_attention` is "right now, for a while"; `tune_attention` is "from
now on".

## Sensory Organs

Sensory Organs are the main channel for the entity to recieve and react to
information about the environment. This can be the analogue or digital world,
such as a camera for physical eyes or a network monitoring system; whatever can
be supplied as a data stream. The Sensory Organs that (currently) ship with Flux
(motion-vision, system-state), and custom ones can be written.

Sensory Organs focus on processing data on a local level and responding within
it's own module, deciding to react/respond, including escalation to the Ego
model.

### Sensory Organ Health

The dot next to the Sensory Organ name in the Flux Timeline indicates it's
health. Green means it is flowing, yellow means it is up but something seems
off, red means its endpoint is unreachable — for motion-vision, that usually
means `llama-server` is not running. When a sense goes down, its perception
freezes rather than reporting an empty room.

### Writing a Sensory Organ

A Sensory Organ is a small module that emits envelopes — structured observations
with a description, a salience score, and optional mood effects. Flux handles
gating, batching, narration, and retention.

You can write reflexes or escalation conditions as needed that are
self-contained within the Sensory Organ, which is kind of the point. Much how
touching a hot stove is processed locally by your hand and responded to before
your brain knows what happened.

The
[Sensory Organ template](https://github.com/PsycherosAI/Psycheros-staging/blob/main/packages/entity-flux/docs/sensory-organ-template.md)
in the repository covers building one. Out-of-tree senses load from
`<dataRoot>/.psycheros/sensory-organs/` and appear in Settings > Flux > Sensory
once enabled.

You can point a coding agent at the template to get started building custom
Sensory Organs.

### Motion-Vision

Motion-vision is the camera sense bundled with Flux, allowing the entity to see
(and hear depending on the model).

Describing images requires a **multimodal** model, and because the captions are
frequent and the content likely private, hosting this one locally is **HIGHLY**
recommended.

The smaller the model the faster the captioning will be and the more real-time
feeling that will be achieved, so there is a bit of a trade-off in speed vs
accuracy.

Recommended models:

| Model          | Size  | Hardware                             |
| -------------- | ----- | ------------------------------------ |
| LFM2.5-VL-450M | ~450M | runs on ~~a potato~~ almost anything |
| Gemma 4 E2B    | ~2B   | a modest CPU or any GPU              |
| LFM2.5-VL-1.6B | ~1.6B | comfortable on modest hardware       |

#### Hosting a Vision Model

You can point an agent with access to your computer at this task, or do it
manually:

Three ways to do it manually, easiest first. **LM Studio** is a GUI app and runs
the tiny 450M model; **Ollama** is the easiest terminal option but its smallest
real vision model is Gemma 4 E2B; **llama.cpp** is the best and fastest, and
runs everything. Pick one:

##### Option A — LM Studio (easiest, runs the 450M)

1. Install LM Studio from [lmstudio.ai](https://lmstudio.ai) (a normal desktop
   app).
2. In its model search, look up **LFM2.5-VL-450M** (the GGUF version) and
   download it — make sure the **mmproj** file downloads too; it's the vision
   adapter, listed alongside the model files. If the search doesn't offer it,
   download both files from
   [the Hugging Face page](https://huggingface.co/LiquidAI/LFM2.5-VL-450M-GGUF)
   and drop them in the same folder — LM Studio pairs them automatically.
3. Load the model, turn on the local server (Developer tab), and in **Settings >
   Flux > Sensory** set the motion-vision **vision endpoint** to
   `http://127.0.0.1:1234/v1` with the model name LM Studio shows. No API key
   needed. If the model loads but can't see images, update LM Studio's runtime
   to the latest version (Settings > Runtime) — early runtimes lacked a fix
   these vision models need.

##### Option B — Ollama (easy, terminal)

1. Install Ollama from [ollama.com](https://ollama.com) (one installer, runs as
   a background service).
2. Pull a vision model:

   ```bash
   ollama pull gemma4:e2b
   ```

   That's the whole setup — no separate vision-adapter file to manage; Ollama
   bundles it. Use **gemma4:e2b** (or `gemma4:e4b` for better sight) — Gemma 4's
   vision works in Ollama out of the box. Don't substitute the LFM2.5-VL models
   here: their Ollama packages are currently text-only.
3. In **Settings > Flux > Sensory**, set the motion-vision **vision endpoint**
   to `http://127.0.0.1:11434/v1` and the model name to `gemma4:e2b`. No API key
   needed.

##### Option C — llama.cpp (better and faster)

This section assumes no prior experience running a local model. The tool is
**llama-server** from the [llama.cpp](https://github.com/ggml-org/llama.cpp)
project: one binary, no installation, run with one command.

**Step 1 — get llama-server.** Download a prebuilt binary for your system from
the [releases page](https://github.com/ggml-org/llama.cpp/releases)
(`llama-*-bin-win-cpu-x64.zip` on Windows, `llama-*-bin-ubuntu-x64.zip` on
Linux, the macOS build on Mac). Unzip it anywhere.

**Step 2 — download the model.** From Hugging Face, two files: the model itself
and its vision adapter (the `mmproj` file). For the smallest pick:

- [LFM2.5-VL-450M-GGUF](https://huggingface.co/LiquidAI/LFM2.5-VL-450M-GGUF):
  `LFM2.5-VL-450M-Q4_K_M.gguf` **and** `mmproj-LFM2.5-VL-450m-Q8_0.gguf`

The 1.6B equivalent lives at
[LFM2.5-VL-1.6B-GGUF](https://huggingface.co/LiquidAI/LFM2.5-VL-1.6B-GGUF), same
two-file pattern.

**Step 3 — run it.** In a terminal, from the folder containing both files and
`llama-server`:

```bash
./llama-server -m LFM2.5-VL-450M-Q4_K_M.gguf \
  --mmproj mmproj-LFM2.5-VL-450m-Q8_0.gguf \
  -c 4096 --port 18080 --host 127.0.0.1
```

Leave the window open once it finishes starting up.

**Step 4 — point Flux at it.** In **Settings > Flux > Sensory**, set the
motion-vision **vision endpoint** to `http://127.0.0.1:18080/v1` and the model
name to what the startup banner reports (for the 450M: `LFM2.5-VL-450M`). A
local server needs no API key — put anything in the field if it requires one.

The green dot on the health strip (below) confirms it is running.

#### Where Frames Come From

Motion-vision gets frames one of two ways; the difference is which path is
calling the camera:

- **Browser (default)** — the Flux view uses the browser's camera permission. On
  a phone, this defaults to the phone camera. Easiest setup.
- **Device** — the machine running Psycheros opens the camera directly (through
  ffmpeg, against a device like `/dev/video0`). This is for setups where
  Psycheros runs on a box with its own camera and the eyes should not depend on
  a browser being open.

Both paths still need the vision model from the previous section to describe the
frames.
