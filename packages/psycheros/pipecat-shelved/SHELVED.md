# Pipecat Voice Pipeline — Shelved

**Shelved:** 2026-06-14 **Reason:** Real-time turn management mismatched with
high-latency stack.

## What this is

A Python [Pipecat](https://github.com/pipecat-ai/pipecat) 1.3.0 sidecar that ran
as a subprocess of the Deno daemon. It handled the full STT → LLM → TTS audio
pipeline with real-time turn management: `VADProcessor` → STT →
`LLMUserAggregator` (with `UserTurnStrategies`) → LLM → TTS → output.

## Why it was shelved

Pipecat's turn management assumes sub-3s end-to-end latency. The actual stack
runs 10–15s:

- Local Whisper STT: 1–3s
- Overseas LLM first token: 3–5s
- Cloud TTS: 2–4s

By the time the entity finished responding, the user had already said more
things, the aggregator queued them as separate turns, and the LLM generated
cascading responses. Band-aids (`BotSpeakingTurnGate`, `BotSpeakingTurnLock`,
speech-duration filters) didn't fix the underlying mismatch.

## What replaced it

A Deno-native walkie-talkie pipeline in `packages/psycheros/src/voice/`. One
user utterance → one STT call → one LLM call → one TTS response. No aggregator,
no turn strategies, no Python sidecar. Latency doesn't drop, but in a
walkie-talkie model the user expects to wait.

See `packages/psycheros/docs/VOICE_CHAT_UX.md` for the current architecture.

## What's worth porting back if this is revived

These components are useful regardless of turn model and are already ported to
the Deno pipeline:

- `TTagStripper` (lines 361–400 of `bot.py`) — strips Psycheros `<t>` tags from
  LLM output before TTS. Ported as `stripTTag` in `src/voice/pronunciation.ts`.
- `_strip_timestamps` (lines 356–358) — strips timestamp prefixes from
  conversation history. Ported as `stripTimestamps` in
  `src/voice/pronunciation.ts`.
- `FixedMiniMaxTTSService` (lines 81–212) — handles MiniMax `buffer_remaining`
  bug in Pipecat 1.3.0. The buffer-flush logic is ported into `streamMinimax` in
  `src/voice/tts.ts`.
- Reasoning token filtering in `ZaiLLMService._process_context` (lines 558–593)
  — handled natively by `LLMClient` in `src/llm/client.ts`, which classifies
  reasoning into `StreamChunk.type === "thinking"` and skips it for TTS.
- `PronunciationProcessor` (lines 302–320) — phonetic substitution before TTS.
  Ported as `applyTTSPronunciation` in `src/voice/pronunciation.ts`.

## What's not worth porting back

These exist only to paper over the real-time model's mismatch with high-latency
stacks. If this code is revived, they should stay deleted unless latency
actually drops below 3s:

- `BotSpeakingTurnGate` (lines 427–482) — silence-based turn-end filter
- `BotSpeakingTurnLock` (lines 406–424) — blocks user turns while bot speaks
- `BotSpeakingTracker` (lines 488–514) — module-level speaking flag
- `SpeechTimeoutUserTurnStopStrategy` usage
- `LLMUserAggregator` / `LLMContextAggregatorPair`
- `UserTurnStrategies`
- `PipelineProbe` (debug frame logger)

## Conditions that would warrant reviving

The real-time model becomes viable when **all** of these hold:

- Cloud STT with <500ms latency (Deepgram streaming, AssemblyAI, etc.)
- Cloud LLM with <1s first-token latency (or local model with GPU)
- Cloud TTS with <500ms start latency
- Total pipeline latency under 3–4s end-to-end

At that point the real-time experience (live interruption, low-latency
back-and-forth) becomes worth the complexity of turn management again.

## How to revive

The Pipecat sidecar would need to be re-wired to the Deno daemon via the
WebSocket protocol documented in `packages/psycheros/CLAUDE.md` (historical
version, pre-2026-06-14). The `src/voice/sidecar.ts` file (deleted in the same
commit that created this directory) handled the subprocess lifecycle — it's in
git history at the commit just before this directory was renamed.

The Pipecat code itself targets Pipecat 1.3.0. The `⚠️ Pipecat API stability`
warning in the historical CLAUDE.md still applies: `pipecat-ai` evolves
frequently, import paths and frame types may have changed.
