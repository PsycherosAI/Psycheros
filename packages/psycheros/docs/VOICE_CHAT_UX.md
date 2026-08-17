# Voice Chat

Deep reference for the voice chat subsystem. For the trap list (load-bearing
wirings that bite), see the "Voice chat subsystem" section of
[`../CLAUDE.md`](../CLAUDE.md). For end-user feature list, see the main README.

## What it is

Phone-call-style voice overlay. User speaks, entity responds via TTS. Turn model
is **walkie-talkie**: one utterance → one STT call → one LLM call → one TTS
response. Explicit `idle → recording → processing →
speaking → idle` state
machine. No real-time aggregator, no cascading responses.

The walkie-talkie model is a deliberate trade: latency doesn't drop, but the
user expects to wait. The state indicator ("Listening / Recording / Thinking /
Speaking") makes the wait visible. For low-latency setups (cloud STT < 500ms +
fast LLM + fast TTS), a real-time mode could be revived — see
[`../pipecat-shelved/SHELVED.md`](../pipecat-shelved/SHELVED.md) for revival
conditions.

## Architecture

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
- **Two STT paths** — `"browser"` uses the Web Speech API (browser transcribes;
  daemon receives text; zero server-side STT cost, works on phones).
  `"deepgram"` / `"openai"` / `"custom"` are server-side: the browser streams
  PCM and the daemon calls the provider. For local Whisper servers, point
  `"custom"` at the server's `baseUrl`.
- **Two input modes** (global, toggled mid-call from the overlay): default
  end-of-speech detection (browser-side energy VAD with a configurable silence
  threshold for server-side STT; phrase-debounce for browser STT), and opt-in
  push-to-talk (hold a button or configured key binding to record, release to
  send — useful for users who stutter, think before speaking, or are in noisy
  environments). Key bindings accept keyboard codes, mouse buttons, and
  MediaSession actions for Bluetooth headsets.
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
- **Independent context window** — voice mode uses its own rolling context
  window (default 64k tokens) from the voice profile, not the text LLM profile's
  setting.
- **Reuses EntityTurn infrastructure** — voice mode constructs an `EntityTurn`
  with the same `EntityConfig` as text chat (`handleChat` in `routes.ts`) and
  drives `entityTurn.process()` from the voice pipeline. The entity gets
  identical context for voice as for text: full situational awareness, lorebook
  triggers, RAG-retrieved memories, chat history RAG, vault documents, knowledge
  graph context, image-gen descriptions, context snapshots, metrics. No bespoke
  system message — single source of truth.
- **Voice-specific `ProcessOptions`** — `voiceMode: true`, `systemPromptSuffix`
  (VOICE CHAT MODE note + per-profile custom instructions),
  `messagePrefix:
  "[Voice Chat] "` (prepended to persisted messages so voice
  attribution is visible in history; parrot-emitted copies stripped before
  persist, same pattern as `<t>` tag handling). Tools are enabled for voice
  turns — the entity can call any tool during a voice call; pass
  `disableTools: true` explicitly to suppress tools for a specific voice turn.
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
- **Yin Yang mode** — toggle button (☯) in the voice overlay switches from voice
  input to text input mid-call. Typed text uses the same `{type: "transcript"}`
  message path as browser STT, so all infrastructure works unchanged. Stops
  `MediaStreamTrack`s on entry so the browser releases the hardware mic;
  re-acquires on exit (server-side STT only).
- **Voice effects** — `VoiceProfile.voiceEffect` field applies a Web Audio
  filter chain between `playbackGain` and destination. Six presets: `none`,
  `comms` (sci-fi intercom), `robot` (ring mod), `telephone` (bandpass), `deep`
  (lowpass + bass), `cavern` (feedback delay). All cheap (1–3 nodes each).
  Per-profile "Test Effect" button in Audio settings.

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
  playback queue can consume frames directly.
- `src/voice/pronunciation.ts` — `applyTTSPronunciation`, `applySTTCorrections`,
  `stripTimestamps`, `stripTTag`.
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
  [`../launcher-v2/CLAUDE.md`](../launcher-v2/CLAUDE.md) "Traps that bite" for
  the full bug + workaround context.
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

## STT provider trade-offs

Two paths, configured per voice profile in Audio settings:

| Provider                   | When to use                              | Trade-offs                                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser` (Web Speech API) | Free, no API key, audio stays in browser | Chrome Android has a cluster of quirks (see "Browser STT on Chrome Android" below). No censorship toggle — Google's service censors swear words; built-in profanity restorations in `pronunciation.ts` undo the common ones. |
| `deepgram`                 | Recommended for reliability              | Real-time streaming, no censorship, generous free tier                                                                                                                                                                       |
| `openai` (Whisper)         | When Whisper is preferred                | Slower than Deepgram, accurate                                                                                                                                                                                               |
| `custom`                   | Self-hosted Whisper / Kokoro / etc.      | Point `baseUrl` at any OpenAI-compatible `/audio/transcriptions` endpoint                                                                                                                                                    |

For production deployments, prefer server-side STT. Browser STT is a free
fallback that comes with real reliability costs on mobile.

## Browser STT on Chrome Android

A cluster of quirks that all needed separate fixes. Server-side STT modes are
unaffected.

- **Mic conflict** — `getUserMedia` holding the mic silently blocks
  `SpeechRecognition`. Browser STT mode skips `getUserMedia` entirely; the
  waveform canvas stayed blank (now removed). Server-side modes still acquire
  the stream for PCM streaming.
- **Rapid-cycling system tones** — auto-restart on `onend` needs a 300ms delay
  on mobile or Chrome Android's "listening" / "no longer listening" tones
  overlap. Desktop doesn't have this issue; in PTT mode the restart is immediate
  so words right after a pause aren't lost in the gap.
- **Premature turn-end** — `interimResults: false` makes Chrome Android end
  recognition aggressively. Switched to `interimResults: true` (still only send
  finals via the `isFinal` filter).
- **Phrase fragmentation** — Chrome fires finals at every phrase pause. Phrase
  accumulator + `phraseDebounceMs` (default 1200ms, configurable per profile)
  batches into one utterance.
- **Cumulative-result snowball** — Chrome Android also fires cumulative finals
  ("okay" → "okay I'm" → "okay I'm trying"). Detection in onresult: if the new
  transcript starts with the joined buffer (case-insensitive,
  punctuation-insensitive), replace instead of append.

## PTT (push-to-talk)

PTT keys are the only global PTT config (`VoiceSettings.pttKeys[]`, accepting
keyboard codes, mouse buttons, and MediaSession actions); PTT itself is per-call
— toggled mid-call from the overlay, initialized from the voice profile's
`pushToTalk`. Keyboard/mouse bindings use hold semantics (keydown/keyup);
MediaSession bindings (Bluetooth headset buttons) use toggle semantics.

Keybind capture flow plays silent audio to claim the OS media session so the
headset button event routes to the page. Mobile-only — desktop gets media key
events on focused tabs without claiming the session, and the silent audio
approach previously froze Chrome browser-wide on desktop (empty WAV data URL
looped infinitely fast).

Toggle buttons (PTT, Yin Yang) call `.blur()` after click so the PTT keybind
doesn't fall through to browser-default "activate focused button" behavior.

### Subtle PTT behaviors (load-bearing)

These are easy to break by accident. Each was a real bug.

- **Silence detector must re-check `pttEnabled` every loop iteration.** The
  detector is gated at session start
  (`!pttEnabled && sttProvider !== "browser"`), but if the user toggles PTT on
  mid-call, the loop is already running. Without a `pttEnabled` check inside
  `check()` (plus clearing any pending `silenceTimer`), VAD keeps firing
  `user_silence` mid-hold and ends the turn early.
- **Browser STT `onend` must restart recognition when still holding PTT.**
  Chrome's internal VAD fires `onend` after a silence. In PTT mode, if
  `pttHolding` is still true, restart recognition (immediately on desktop, 300ms
  delay on mobile for system-tone separation). Otherwise speech after a pause is
  silently lost. `pttHolding` flips to false in `endPTT()` _before_
  `recognition.stop()`, so an intentional release does not trigger a restart.
- **Phrase buffer must not flush mid-hold.** `flushSttPhraseBuffer` bails when
  `pttHolding` is true. Without this guard, a pause longer than
  `phraseDebounceMs` mid-hold pushes a partial transcript and the daemon starts
  processing before the user has released.
- **`endPTT` flush must defer to `onend`, not fire on `stop()`.** Chrome emits
  one last `final result` between `recognition.stop()` and `onend` for any
  speech in flight when the user released. If `endPTT` flushes synchronously (or
  via `setTimeout(0)`), that trailing phrase is split into its own transcript —
  and since the daemon is now mid-response to the first transcript, the trailing
  phrase is dropped by the `isEntityMidResponse` guard. Fix: set a
  `pendingEndPTTFlush` flag in `endPTT`, run the actual flush in `onend`, with a
  500ms fallback timeout for the rare case where `onend` never fires.

## Voice attribution

`is_voice` column on the messages table is authoritative — the `[Voice Chat]`
prefix in content is **derived** (regenerated from the column at read time), not
stored. Same pattern as timestamps (stored in `created_at`, regenerated as `<t>`
tags on read).

Persist-side strip catches parroted `[Voice Chat]` prefixes AND `<t>` tags from
LLM output before they enter the DB. Streaming-side strip catches leading prefix
during chunk streaming so users never see it flash live. Read paths (ChatRAG,
history, browser rendering) prepend the prefix when `isVoice=true`, strip stray
prefixes as defense-in-depth.

Strips in 5+ places across the codebase are non-load-bearing (belt and
suspenders for the column). Don't rely on them for correctness — they exist to
handle legacy data and LLM parrots that slip through.

## Mobile vs desktop

| Concern                       | Mobile (Android Chrome)                                                              | Desktop (Chrome/Firefox)             |
| ----------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------ |
| Wake lock                     | `navigator.wakeLock.request('screen')` — primary, may be overridden by battery saver | Works reliably                       |
| Silent audio                  | Mobile-only — claims media session for Bluetooth buttons, screen-off fallback        | Skipped (caused browser-wide freeze) |
| Mic access                    | One consumer at a time — `getUserMedia` blocks `SpeechRecognition`                   | Multiple consumers OK                |
| SpeechRecognition reliability | Quirky (see Chrome Android section)                                                  | Standard                             |

## Known gotchas

- **Voice FAB visibility depends on `#messages`.** The floating call button
  (`#voice-call-btn`) lives in `renderAppShell()` as a sibling of `#chat` (so it
  survives HTMX swaps) and is shown only when
  `document.getElementById('messages')` exists — i.e., inside an open
  conversation. `updateVoiceCallButtonVisibility` in `web/js/psycheros.js`
  re-evaluates on every `htmx:afterSwap` into `#chat`. Renaming or removing the
  `#messages` id silently breaks the gate (FAB would disappear everywhere, or
  appear on settings if switched to a negative check).
- **Masked API keys leak into runtime state.** `saveVoiceSettings` returns
  corrected settings; `updateVoiceSettings` must store those, not the masked
  incoming values. `isMaskedApiKey()` + `ensureRealKey()` guards at every
  TTS/STT fetch site catch future masking bugs with a clear "re-enter your API
  key" message instead of a cryptic ByteString error.
- **Each TTS/STT provider uses a different auth header.** Don't assume
  `Authorization: Bearer` everywhere. MiniMax, OpenAI, and custom
  OpenAI-compatible endpoints use Bearer; **ElevenLabs requires `xi-api-key`**
  and rejects Bearer with `"Provided authorization header was invalid."` Keep
  both call sites in sync when touching TTS auth: `streamElevenLabs` in
  `voice/tts.ts` (live pipeline) and `callTTS` in `server/routes.ts` (Test TTS
  button + keep-alive scheduler).
- **Streamed PCM chunks must be byte-aligned before Int16 playback.** HTTP
  framing can split a 2-byte Int16 sample across two chunks; if the client
  treats each chunk independently, `new Int16Array(oddByteLengthBuffer)` throws
  RangeError and every subsequent sample plays as static ("TV losing signal").
  The OpenAI path had this fixed inline (`leftover` carry in
  `streamOpenAICompatible`); ElevenLabs and MiniMax were missing it and would
  static intermittently on Mac especially. `alignChunks()` in `voice/tts.ts` is
  the shared helper — apply it to any new TTS provider's raw byte stream. The
  browser side (`queueAudioFrame` in `web/js/voice.js`) also carries odd bytes
  across WebSocket frames via `pendingBytes` as defense-in-depth. Reset on
  cleanup AND on idle-when-playback-empty (mid-sentence aborts can leave a stale
  byte).
- **Test TTS plays a different format than live voice.** `callTTS` in
  `server/routes.ts` deliberately requests default-format audio (MP3 for
  ElevenLabs, MiniMax, OpenAI) so the browser can decode a single blob — fine
  for a one-shot button click. Live voice uses raw PCM (16kHz Int16) for
  streaming latency. So "Test TTS works but live voice sounds like static" is
  the signature of a streaming-PCM alignment bug, not a provider-config bug.
- **Mic access requires a secure origin.** Browsers silently refuse
  `getUserMedia` on `http://<lan-ip>:port` — no prompt, no error, just denial.
  Users on Mac hitting Psycheros from another machine over plain HTTP will see
  "mic not asking for permission" because the browser won't even prompt. Three
  valid contexts: `http://localhost:3000`, any `https://` URL, or the Tauri
  desktop app (which uses `http://tauri.localhost` internally). The client
  (`setupAudioCapture` in `web/js/voice.js`) detects `!window.isSecureContext`
  and shows an actionable toast — don't strip that check.
- **Tauri macOS desktop needs `NSMicrophoneUsageDescription`** in
  `packages/launcher-v2/src-tauri/Info.plist` (auto-discovered by Tauri 2).
  Without it, macOS won't even prompt the user for mic access — the app silently
  can't capture audio. Windows/Linux Tauri don't need an analog; WebView2 treats
  `tauri.localhost` as secure and OS mic privacy is user-level.
- **Custom OpenAI-compatible TTS servers may return MP3 or WAV, not PCM.** The
  OpenAI TTS API supports `response_format: "pcm"` (raw 24kHz Int16), but
  third-party servers (PocketTTS, Kokoro, etc.) often ignore the parameter and
  return MP3 by default — played as raw PCM that's the "TV losing signal" static
  again. `streamOpenAICompatible` in `voice/tts.ts` now sniffs the first chunk's
  magic bytes + Content-Type and switches paths: WAV is parsed inline (44-byte
  header walk, no new dep); MP3 is decoded via `mpg123-decoder` (WASM, libmpg123
  reference decoder, ~77 KB). Detection logs to the console as "Custom server
  returned mp3 (requested pcm) — decoding transparently." Raw PCM stays on the
  low-latency streaming path. The user shouldn't need to write a FastAPI
  translation layer between their TTS server and Psycheros — that was the
  original bug.
- **Multi-device lock.** One voice session per conversation. Second client
  trying to start voice on the same conversation is rejected.
- **Pulse queuing.** Pulses that fire during a voice call are queued and drained
  at the next conversational break (entity finishes speaking, user isn't
  mid-utterance). Voice call ending with Pulses queued → each resolved as
  `skipped`, fires again on next schedule.
- **Per-conversation write lock.** All persistence for a specific conversation
  must take the per-conversation lock (`acquireLock` in
  `utils/conversation-lock.ts`). Voice turns and chat turns both hold it from
  user-message-persist through final response. Without it, concurrent writes
  corrupt role alternation.
- **`recognition.onend` auto-restart** has three branches that are easy to
  confuse: (1) `pendingEndPTTFlush` → flush the phrase buffer and return
  (recognition just ended from `endPTT`); (2) `pttEnabled && pttHolding` →
  restart recognition (Chrome VAD fired mid-hold); (3) non-PTT path → restart
  with 300ms delay. Out-of-order checks cause either infinite restart loops or
  lost speech.
- **Mid-response audio + `user_speech_start` must respect pipeline state.** TTS
  audio leaking back into the mic (imperfect echo cancellation) triggers the
  browser VAD during the entity's turn. Two server-side guards prevent the
  walkie-talkie state machine from corrupting: `pipeline.pushAudio()` drops
  frames while `processing`/`speaking` (so echo audio doesn't accumulate and get
  processed after the entity finishes); and the `user_speech_start` handler in
  `session-manager.ts` still sets `userSpeaking` (Pulse draining needs it) but
  skips `setState("recording")` when the entity is mid-response. Without either
  guard, state would jump `speaking` → `recording`, `isEntityMidResponse()`
  would return false on the next `user_silence`, and `processAudioTurn` would
  run `setState("processing")` on top of the in-flight turn — firing the "sent"
  tone mid-speaking and potentially having the entity respond to its own echo.

## Open work

- **Per-conversation voice profiles** — currently global active profile.
  Different conversations might want different voices / languages.
- **Cloud STT latency improvements** — beyond what existing providers offer;
  would need to evaluate new providers as they come online.
- **Local TTS packaging** — Kokoro/Chatterbox bundling so users don't have to
  run a separate TTS server. Currently configured via custom `baseUrl`.

## Out of scope

These were considered and deferred during the pivot from Pipecat:

- **Real-time interruption** — barge-in during entity speech. Walkie- talkie
  model is non-interruptible by design. Reviving needs the shelved Pipecat
  pipeline or an equivalent real-time aggregator.
- **Server-side echo cancellation** — `getUserMedia` enables browser echo
  cancellation; no server processing added.
- **Speaker identification** — filtering out non-user speech would need an ML
  model (Web GPU client-side or server-side). Workaround today: push-to-talk
  mode in noisy environments.
