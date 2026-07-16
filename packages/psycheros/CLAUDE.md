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

## Voice chat subsystem

`src/voice/` manages voice chat using a **walkie-talkie model**: one user
utterance → one STT call → one LLM call → one TTS response. The entire pipeline
runs in-process in the Deno daemon — no Python sidecar, no real-time turn
aggregator. This replaced an earlier Pipecat-based real-time pipeline that
fought the high-latency stack; see `pipecat-shelved/SHELVED.md` for what was
preserved and when to revive it.

```
Browser (Web Speech API or PCM capture)
  ──WebSocket──→ Psycheros (:3000)
                   STT (server-side) → LLM (streaming) → TTS (streaming)
                   audio frames back to browser as Int16 PCM 16kHz
```

**Key design decisions:**

- **Opt-in and isolated** — master feature flag (`VoiceSettings.enabled`)
  defaults to `false`. When off, the voice routes return 403 and no audio state
  exists.
- **Walkie-talkie turn model** — explicit
  `IDLE → RECORDING → PROCESSING →
  SPEAKING → IDLE` state machine. No
  aggregator, no cascading responses. Latency doesn't drop, but the user expects
  to wait in this model.
- **Two STT paths**:
  - `"browser"` — Web Speech API (`SpeechRecognition`). Browser transcribes;
    daemon receives text. Zero server-side STT cost, works on phones.
  - `"deepgram"` / `"openai"` / `"custom"` — server-side STT. Browser streams
    PCM; daemon calls the provider. For local Whisper servers, point `"custom"`
    at the server's `baseUrl`.
- **Two input modes** (global, toggled mid-call from the overlay):
  - Default: end-of-speech detection (browser-side energy VAD with a
    configurable silence threshold for server-side STT; phrase-debounce for
    browser STT).
  - Opt-in push-to-talk: hold a button (or configured key binding) to record,
    release to send. Useful for users who stutter, think before speaking, or are
    in noisy environments. Configurable key bindings (keyboard codes, mouse
    buttons, MediaSession actions for Bluetooth headsets).
- **Saveable voice profiles** — follows the `ImageGenSettings` pattern. Each
  `VoiceProfile` has TTS/STT provider config, TTS pronunciation, STT
  corrections, custom instructions, audio effects, context window size, VAD
  threshold (`vadThreshold`), end-of-turn silence (`endOfTurnSilence`),
  browser-STT phrase debounce (`phraseDebounceMs`), STT debug toggle
  (`sttDebug`), idle timeout, reasoning-disable toggle, voice effect preset
  (`voiceEffect`). Storage: `.psycheros/voice-settings.json`.
- **Phone-call UI** — dedicated overlay, not embedded in the chat. After a call
  ends, the transcript is persisted as regular messages prefixed `[Voice Chat]`
  via `db.addMessage` under the per-conversation write lock — so the text
  conversation can continue naturally with the voice exchange as context.
- **Voice call FAB lives in the app shell, not the chat fragment.** The trigger
  button (`#voice-call-btn`) is a sibling of `#chat` inside `.main` so it
  survives HTMX swaps of `#chat`. Visibility is JS-driven
  (`updateVoiceCallButtonVisibility` in `web/js/psycheros.js`): shown only when
  `/api/voice/status` reports enabled AND `#messages` exists in the DOM (i.e., a
  conversation is actually open). Re-evaluated on every `htmx:afterSwap` into
  `#chat`. Don't move the FAB into `renderChatView()` — the swap survival is
  load-bearing. Renaming the `#messages` id silently breaks the gate.
- **Multi-device lock** — one voice session per conversation. If a second client
  tries to start voice on the same conversation, it's rejected.
- **Independent context window** — voice mode uses its own rolling context
  window (default 64k tokens) from the voice profile, not the text LLM profile's
  setting.
- **Reuses EntityTurn infrastructure** — voice mode constructs an `EntityTurn`
  with the same `EntityConfig` as text chat (`handleChat` in `routes.ts`) and
  drives `entityTurn.process()` from the voice pipeline. The entity gets
  identical context for voice as for text: full situational awareness (current
  time, devices, last interaction, conversation metadata, wearable data),
  lorebook triggers, RAG-retrieved memories, chat history RAG, vault documents,
  knowledge graph context, image-gen descriptions, context snapshots, metrics.
  No bespoke system message — single source of truth.
- **Voice-specific `ProcessOptions`** — `voiceMode: true`, `systemPromptSuffix`
  (VOICE CHAT MODE note + per-profile custom instructions),
  `messagePrefix: "[Voice Chat] "` (prepended to persisted messages so voice
  attribution is visible in history; parrot-emitted copies stripped before
  persist, same pattern as `<t>` tag handling). Tools are enabled for voice
  turns (since `caf23a8`, June 2026) — the entity can call any tool during a
  voice call. Pass `disableTools: true` explicitly to suppress tools for a
  specific voice turn.
- **Pulse queuing during voice** — Pulses that fire during a voice call are
  queued and batched at the next conversational break.
- **TTS pronunciation + STT corrections** — both are per-profile string
  substitution maps applied at different pipeline stages. Pronunciation rewrites
  LLM output before TTS (e.g. "Psycheros" → "sy-KEH-ros"). Corrections rewrite
  STT output before the LLM sees it (e.g. "sih keh ros" → "Psycheros"). Same
  matching rules (word-boundary, case-insensitive, preserves leading
  capitalization).
- **Reasoning disable** — profiles can opt out of LLM thinking tokens
  (`disableReasoning: true`, the default for latency). Passed to the LLM client
  as `thinkingEnabled: false`.
- **Streaming TTS playback** — LLM tokens accumulate into a sentence buffer. At
  sentence boundaries (`.`, `!`, `?`, newline) or 200 chars, the buffer is
  flushed: `<t>` tags stripped, TTS pronunciation applied, then streamed to the
  provider. Audio frames are sent to the browser as soon as they arrive so the
  user hears speech while the rest of the response is still generating.
- **`[Voice Chat]` parrot prevention** — three layers, all preserve the entity's
  view of voice attribution (only LLM _output_ is cleaned, never its _input_):
  1. **Persist-side strip** (`loop.ts`): strips ALL `[Voice Chat]` from LLM
     output before persisting. Only re-adds the prefix in voice mode
     (`options.messagePrefix` set).
  2. **Streaming-side strip** (`loop.ts` chunk yield path): buffers the first 13
     chars of each attempt, strips leading prefix before yielding chunks so
     users never see it flash during the live response.
  3. **TTS-side strip** (`pronunciation.ts`): defensive layer in the sentence
     flush. History retains the prefix on legitimate voice messages — the entity
     always knows which turns were voice. Same pattern as `<t>` timestamp tags.
     **Don't strip all prefixes from LLM context** — that breaks the entity's
     voice attribution awareness (see
     `feedback_voice_attribution_decisions.md`).
- **Browser STT on Chrome Android** — special handling required:
  - Skip `getUserMedia` entirely in browser STT mode; an active stream silently
    blocks `SpeechRecognition` from accessing the mic on Chrome Android.
    Trade-off: waveform canvas stays blank. Server-side STT modes still acquire
    the mic (needed for PCM streaming).
  - 300ms delay before `onend` auto-restart on mobile to prevent overlapping
    system tones. Desktop restarts immediately (in PTT mode) so words right
    after a pause aren't lost in the gap.
  - `interimResults: true` (still only send finals) — Chrome Android ends
    recognition aggressively when `interimResults: false`.
  - Phrase accumulator + `phraseDebounceMs` debounce (default 1200ms) — Chrome
    fires finals at every phrase pause; batch into one utterance.
  - Cumulative-result detection — Chrome Android also fires finals that contain
    cumulative session text. If new transcript starts with the joined buffer,
    REPLACE instead of append (otherwise snowballs).
  - `sttDebug` profile flag (default off) gates diagnostic toasts.
- **PTT settings** — `VoiceSettings.pttKeys` (string array of
  `KeyboardEvent.code` or `MediaSession:action` or `Mouse3`/`Mouse4`) is the
  only global PTT config. PTT enable/disable is per-call — toggled from the
  voice overlay, initialized from `VoiceProfile.pushToTalk`, tracked in voice.js
  module-local `pttEnabled` and server-side `session.pttMode`
  (`"ptt" | "vanilla"` literal — see below). MediaSession bindings toggle
  (single-press); keyboard/mouse bindings hold (keydown/keyup). Four
  load-bearing PTT subtleties — silence-detector must re-check `pttEnabled`
  every iteration (toggle-on mid-call), browser-STT `onend` must restart
  recognition if still holding, phrase buffer must not flush mid-hold, and
  `endPTT` flush must defer to `onend` (Chrome emits a trailing final between
  `stop()` and `onend`). See `docs/VOICE_CHAT_UX.md` "Subtle PTT behaviors" for
  the full rationale.
- **Server-side audio gate** (`session-manager.ts` binary-frame handler) — gates
  on `session.pttMode === "ptt" && !session.pttHolding`. Must be a literal
  compare: `pttMode` is typed `"ptt" | "vanilla"`, both strings are truthy, so a
  bare `if (session.pttMode)` silently drops all audio in vanilla mode. Same
  trap applies to any union-of-string-literals field used as a flag.
- **Mid-response audio gate** (`pipeline.ts` `pushAudio` + `session-manager.ts`
  `user_speech_start` handler) — TTS audio leaking back into the mic triggers
  the browser VAD during speaking. Both call sites must check pipeline state
  before acting: `pushAudio` drops frames while `processing`/`speaking`;
  `user_speech_start` still sets `userSpeaking` (Pulse draining needs it) but
  must NOT call `setState("recording")`. Otherwise state jumps `speaking` →
  `recording`, `isEntityMidResponse()` then returns false, and the next
  `user_silence` runs `processAudioTurn` on top of the in-flight turn — firing
  the "sent" tone mid-speaking and letting the entity respond to its own echo.
- **Yin Yang mode** — toggle button (☯) in the voice overlay switches from voice
  input to text input mid-call. Typed text uses the same
  `{type:
  "transcript"}` message path as browser STT, so all infrastructure
  works unchanged. Stops `MediaStreamTrack`s on entry so the browser releases
  the hardware mic; re-acquires on exit (server-side STT only).
- **Voice effects** — `VoiceProfile.voiceEffect` field applies a Web Audio
  filter chain between `playbackGain` and destination. Six presets: `none`,
  `comms` (sci-fi intercom), `robot` (ring mod), `telephone` (bandpass), `deep`
  (lowpass + bass), `cavern` (feedback delay). All cheap (1–3 nodes each).
  Per-profile "Test Effect" button in Audio settings.
- **Screen wake lock** — `navigator.wakeLock.request('screen')` on call start,
  released on call end. Prevents Android from killing the WebSocket when the
  screen auto-times-out. Non-fatal if unsupported.
- **Silent audio loop (mobile only)** — claims the OS media session so Bluetooth
  headset buttons (Shokz etc.) route to the page. Mobile-only (UA sniff): on
  desktop the empty WAV data URL we used previously spun Chrome's audio thread
  (zero bytes per loop = infinite loop frequency = browser-wide freeze). Mobile
  generates a real 1-second silent WAV via Web Audio + Blob URL so each loop has
  real work.
- **Voice attribution via `is_voice` column** — the `[Voice Chat]` prefix in
  message content is now **derived** (regenerated from the `is_voice` column at
  read time), not stored. Column is authoritative — the LLM can't mark itself as
  voice. Same architectural pattern as timestamps (stored in `created_at`,
  regenerated as `<t>` tags). Persist path strips both `[Voice Chat]` AND `<t>`
  tags from LLM output before DB. Read paths (ChatRAG, history, browser
  rendering) prepend the prefix when `isVoice=true`, strip stray prefixes as
  defense-in-depth. See `docs/VOICE_CHAT_UX.md` for the full migration story.

**Module layout:**

- `src/voice/session-manager.ts` — `VoiceSessionManager` singleton: session
  lifecycle, browser message handling, multi-device lock, idle timeout. No
  longer persists transcripts — EntityTurn persists per-message during the call
  (with `[Voice Chat]` prefix via `messagePrefix`).
- `src/voice/pipeline.ts` — `WalkieTalkieSession` class: the per-session state
  machine. Drives `EntityTurn.process()` and routes content chunks to TTS. Emits
  state/transcript/audio events the session manager forwards to the browser.
- `src/voice/stt.ts` — server-side STT providers (Deepgram, OpenAI, custom).
  Wraps PCM in a WAV header before upload. Browser-native STT never reaches this
  module — text arrives pre-transcribed.
- `src/voice/tts.ts` — streaming TTS providers (MiniMax, ElevenLabs, OpenAI,
  custom). All output is normalized to Int16 PCM 16kHz mono so the browser's
  playback queue can consume frames directly. MiniMax ported from the shelved
  `FixedMiniMaxTTSService` (buffer_remaining flush).
- `src/voice/pronunciation.ts` — `applyTTSPronunciation`, `applySTTCorrections`,
  `stripTimestamps`, `stripTTag`. Ported from the shelved Pipecat `TTagStripper`
  / `_strip_timestamps` / `PronunciationProcessor`.
- `src/voice/mod.ts` — barrel.
- `src/llm/voice-settings.ts` — types, persistence, masking, profile
  normalization. Includes `ttsKeepAliveDays` and `lastKeepAlive` on
  `VoiceProfile` for keep-alive scheduling.
- `web/js/voice.js` — client-side voice logic: mic capture via `getUserMedia`,
  PCM resampling (48kHz→16kHz), browser SpeechRecognition integration,
  browser-side energy VAD for end-of-speech detection, PTT button handling,
  audio playback queue, waveform canvas visualization, mute/deafen/end controls,
  keyboard shortcuts. Exported via `globalThis` for HTMX onclick handlers.
  Detects Tauri at runtime (`window.__TAURI__?.core?.invoke`) and calls the
  launcher's `request_mic_permission` command before `getUserMedia` — works
  around a macOS WKWebView bug where the system mic prompt never fires inside
  the desktop app. Falls through cleanly in browser mode and on older launchers
  without the command (try/catch logs a warning). See
  [`launcher-v2/CLAUDE.md`](../launcher-v2/CLAUDE.md) "Traps that bite" for the
  full bug + workaround context.
- `web/css/voice.css` — phone-call overlay styles, waveform canvas, control
  buttons, toast notifications, voice banner. Loaded via `@import "voice.css"`
  in `main.css`.
- `pipecat-shelved/` — the previous Pipecat-based pipeline, preserved for a
  future real-time mode. See `pipecat-shelved/SHELVED.md` for revival conditions
  and what was ported.

**Daemon ↔ Browser protocol** (JSON control messages + binary audio over
WebSocket):

```
Browser → Daemon:   { type: "ptt_start" } | { type: "ptt_end" }
                   { type: "user_silence" }   (browser VAD ended speech)
                   { type: "transcript", text }  (browser-native STT result)
                   { type: "mute" } | { type: "unmute" }
                   { type: "end_call" } | { type: "ping" }
                   Binary: Int16 PCM 16kHz mono frames (server-side STT only)

Daemon → Browser:   { type: "state", state: "idle" | "recording" | "processing" | "speaking" }
                   { type: "transcript", role, text }
                   { type: "session_ended" }
                   { type: "error", message } | { type: "pong" }
                   Binary: Int16 PCM 16kHz mono TTS frames
```

**Server wiring:** voice settings load in `Server.init()`, voice routes
registered in `handleAPIRoute()`, cleanup in `Server.stop()`.
`updateVoiceSettings()` closes in-flight sessions when voice is disabled — no
subprocess lifecycle to manage anymore.

**TTS keep-alive:** profiles with `ttsKeepAliveDays > 0` get a daily scheduler
check (`voice.tts-keep-alive` at 4 AM) that calls TTS directly if the interval
has elapsed, preventing voice deletion on providers like Minimax. The
`lastKeepAlive` timestamp is persisted in `voice-settings.json`.

**TTS test endpoint:** `POST /api/voice/test-tts` calls the active profile's TTS
provider directly (no walkie-talkie pipeline) and returns raw MP3 bytes. Used by
the "Test TTS" button and the keep-alive scheduler (via `callTTS()` in
`routes.ts`).

**API endpoints:**

| Endpoint                                   | Method   | Purpose                                   |
| ------------------------------------------ | -------- | ----------------------------------------- |
| `/api/voice/status`                        | GET      | Subsystem status (enabled, session count) |
| `/api/voice/settings`                      | GET      | Voice settings (API keys masked)          |
| `/api/voice/settings`                      | POST     | Save voice settings                       |
| `/api/voice/test-tts`                      | POST     | Test TTS provider (returns audio bytes)   |
| `/api/voice/ws?conversationId=&profileId=` | GET (WS) | Voice session WebSocket                   |

## Wearable data pipeline

`src/wearable/` handles sensor data from entity-plexus (Android app connected to
Bangle.js watches via BLE). Separate from the existing DeviceBridge (which
serves web BLE gateway clients with a different protocol). Two singleton
services:

- **WearableConnectionManager** (`connection-manager.ts`) — WebSocket
  connections from entity-plexus, fire-and-forget command push, implicit device
  registration from first inbound message. Discovers data streams from incoming
  readings and an optional capabilities message, persists them to BLE device
  profiles in `.psycheros/ble-settings.json`.
- **WearableDataCache** (`cache.ts`) — latest sensor reading per type per
  device, synchronous `getSnapshot()` for zero-latency SA reads.

The `ble_device` tool and `/api/device/command` endpoint try DeviceBridge first,
then fall back to WearableConnectionManager. The wearable cache is included in
`DeviceCacheSnapshot.wearableDevices` for SA reads.

**Stream discovery and SA injection:** Data streams (sleep, hr, accel, etc.) are
discovered dynamically when readings arrive — either from an explicit
capabilities message or auto-detected from incoming data. Each stream gets a
`BLEStreamConfig` entry (label, xmlTag, enabled) on the device's BLE profile.
The user configures XML tag names and per-stream on/off toggles in two UIs: BLE
settings (per-device stream config) and SA settings (global toggle view). The
entity loop's `formatWearableData()` renders a `<wearable_data>` block in the SA
XML using each stream's configured xmlTag, only including enabled streams with
fresh readings (< 5 min). Known stream types (sleep, hr, accel, battery, gps,
screen) get human-readable renderers; unknown types serialize as JSON.

**Connection status** is tracked by
`WearableConnectionManager.connectedDeviceIds` and surfaced in both BLE and SA
settings UIs with Connected/Disconnected badges.

**Event Rules (Webhooks):** The SA settings page has a Webhooks tab that lets
the user define rules that trigger Pulses when sensor readings match conditions.
Each rule has a single condition (stream ID + operator: `changes_to`,
`goes_above`, `goes_below` + value) and a single action (`Run Pulse`). The
`EventRulesEngine` (`event-rules-engine.ts`) evaluates incoming readings from
`WearableConnectionManager.handleMessage()` (after `cache.ingest()`), calling
`PulseEngine.triggerPulse(rule.action.pulseId, "data_event")` on match.
Sustained tracking (`condition.sustainedMinutes`) requires the condition to hold
continuously before firing; cooldown prevents re-triggering within
`cooldownMinutes`. Types and persistence live in `event-rules.ts`. Config
persists across device disconnects — all registered devices are always visible
and editable regardless of connection state.

**Production vs localhost routes:** The wearable endpoints are registered under
two path sets. `/api/device/stream` and `/api/device/data` are for localhost/dev
(no Authelia). `/api/ingest/stream` and `/api/ingest` are for production behind
Authelia's `client_credentials` bearer auth — the access-control rule only
allows authenticated requests on `/api/ingest`. Both path sets delegate to the
same handlers. Route registration is in `server.ts` `handleAPIRoute()`.

## LLM client and model capabilities

`src/llm/client.ts` is the OpenAI-compatible LLM client. It handles chat
completion (streaming and non-streaming), provider-specific headers, and model
parameter filtering.

**Model capabilities** (`src/llm/model-capabilities.ts`) — an ordered array of
model-family rules that detects which sampling parameters a model supports from
its name string. First match wins. `filterSamplingParams()` strips unsupported
parameters before the API call and logs what was removed. Zero-value no-op
params (`topK=0`, `frequencyPenalty=0`, `presencePenalty=0`) are silently
skipped rather than stripped — they're defaults, not intentional user choices.
Non-zero values on unsupported models still warn. Unknown models get a
permissive default (send everything). The rules cover OpenAI o-series, GPT-5.x
(including 5.5), GPT-4.x/3.5, Claude, DeepSeek, Gemini, Qwen, GLM, Llama,
Mistral, Kimi, and Gemma — including OpenRouter-prefixed names like
`anthropic/claude-sonnet-4-20250514`. GPT-5.x only supports `maxTokens`
(sampling params rejected like o-series).

**Reasoning parameters** are gated on provider in `buildRequest()`:

- **Z.ai / NanoGPT**: sends `thinking: { type: "enabled" }` — enables Z.ai's
  chain-of-thought return.
- **OpenRouter**: sends `reasoning: {}` — tells OpenRouter to return reasoning
  tokens (ignored without it).
- **Other providers**: no parameter sent; reasoning tokens returned
  automatically if the model supports them.

**Reasoning response parsing** in `processChunk()` checks four SSE delta fields
in priority order: `reasoning_content` (Z.ai), `reasoning`
(OpenRouter/DeepSeek), `thinking` (Claude via OpenRouter), `reasoning_details`
(OpenRouter structured array — extracts `text` from entries with
`type: "reasoning.text"`). Adding a new provider that returns reasoning in a
different field means extending this chain.

**Provider misroute recovery** in `EntityTurn.process()` (loop.ts, after the
retry loop) catches the case where the entire response — thinking and reply both
— was routed through the reasoning field with `content` empty. Most commonly
seen with GLM on OpenRouter; Z.ai direct does not exhibit this. Without recovery
the reply hides inside the thinking section and the edit fallback reads the
rendered thinking section's text (literal "▼ Thinking" UI labels in the
textarea). The recovery splits at the last boundary marker
(`</thinking>`/`</thought>`/`</reasoning>`/`</antml:thinking>`) if present, or
promotes the reasoning to content when `finish_reason=stop`. A
`thinking_corrected` SSE event tells the live UI to reset thinking and render
the recovered reply as assistant-text.

`buildProviderHeaders()` adds provider-specific HTTP headers:

- **OpenRouter**: `HTTP-Referer` + `X-Title` (required, or requests fail with
  "Missing Authentication header")
- **Anthropic**: `anthropic-beta: prompt-caching-2024-07-31`

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

Broader extensions live under `dataRoot/.psycheros/plugins/<id>/`. The Psycheros
manager is `src/plugins/`; it loads only at startup, merges plugin tools into
the normal registry, runs prompt hooks after built-in retrieval, and mounts
plugin routes/assets under namespaced paths. See `docs/plugins.md`. My
plugin-owned credentials live under
`dataRoot/.psycheros/plugin-secrets/<id>.env`, outside portable exports. I
should use `PSYCHEROS_PLUGIN_<ID>_*` names because my trusted plugins share
process environment.

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

| Topic                             | Doc                                                |
| --------------------------------- | -------------------------------------------------- |
| First-person philosophy           | [../../PHILOSOPHY.md](../../PHILOSOPHY.md)         |
| Env vars, config, migrations      | [docs/configuration.md](docs/configuration.md)     |
| Tool system, identity tiers       | [docs/tools-reference.md](docs/tools-reference.md) |
| Memory + RAG (chat, vault, graph) | [docs/memory-and-rag.md](docs/memory-and-rag.md)   |
| UI features                       | [docs/ui-features.md](docs/ui-features.md)         |
| API endpoints, SSE architecture   | [docs/api-reference.md](docs/api-reference.md)     |
| Durable scheduler                 | [docs/scheduler.md](docs/scheduler.md)             |
| Security audit                    | [docs/security-audit.md](docs/security-audit.md)   |

External Connections (Discord, web search, home, intimacy), Vision (image gen,
captioning, gallery), Situational Awareness, and Pulse all have their feature
surfaces documented in the relevant `docs/` files. Don't reproduce them here.

## Companion packages

This package lives in the [Psycheros monorepo](../../README.md). The canonical
identity and memory store is the sibling [`entity-core`](../entity-core/); the
chat-history importer is the sibling [`entity-loom`](../entity-loom/).
