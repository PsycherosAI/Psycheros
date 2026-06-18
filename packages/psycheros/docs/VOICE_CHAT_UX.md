# Voice Chat

Deep reference for the voice chat subsystem. For day-to-day operating notes
(load-bearing wirings, module map), see the "Voice chat subsystem" section of
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
  or Chrome's "listening" / "no longer listening" tones overlap.
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

Global setting (`VoiceSettings.pttEnabled` + `pttKeys[]`), toggled mid-call from
the overlay. Keyboard/mouse bindings use hold semantics (keydown/keyup);
MediaSession bindings (Bluetooth headset buttons) use toggle semantics.

Keybind capture flow plays silent audio to claim the OS media session so the
headset button event routes to the page. Mobile-only — desktop gets media key
events on focused tabs without claiming the session, and the silent audio
approach previously froze Chrome browser-wide on desktop (empty WAV data URL
looped infinitely fast).

Toggle buttons (PTT, Yin Yang) call `.blur()` after click so the PTT keybind
doesn't fall through to browser-default "activate focused button" behavior.

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
- **`recognition.onend` auto-restart** must check `pttEnabled` and `yinYangMode`
  before restarting, otherwise stopping recognition has no effect (immediate
  restart).

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

## History

This doc used to be a chronological log of every resolved issue. That format
grew to 600+ lines and wasn't useful as a reference. For the history of specific
fixes, use `git log --grep` against the voice subsystem files. Key milestones:

- 2026-06-14: walkie-talkie pivot (Pipecat shelved)
- 2026-06-15: EntityTurn refactor (voice reuses text chat infrastructure)
- 2026-06-17: `is_voice` column migration (authoritative voice attribution)
- 2026-06-17: mobile-only silent audio (Chrome desktop freeze fix)
