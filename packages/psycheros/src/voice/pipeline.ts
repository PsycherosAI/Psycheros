/**
 * Walkie-talkie voice pipeline.
 *
 * One user utterance → one EntityTurn.process() call → streamed content
 * chunks routed to TTS. No turn aggregation, no VAD-driven turn-end timers,
 * no cascading responses.
 *
 * State machine:
 *
 *   IDLE ──(audio starts arriving OR ptt_start)──→ RECORDING
 *   RECORDING ──(user_silence OR ptt_end)──→ PROCESSING
 *   PROCESSING ──(first TTS frame)──→ SPEAKING
 *   SPEAKING ──(TTS done)──→ IDLE
 *
 * For browser-native STT the browser sends a finalized transcript directly,
 * so we skip RECORDING and go IDLE → PROCESSING.
 *
 * The pipeline emits events that the session manager translates into
 * WebSocket messages forwarded to the browser:
 *
 *   { type: "state", state: "idle" | "recording" | "processing" | "speaking" }
 *   { type: "transcript", role: "user" | "assistant", text: string }
 *   binary audio frames (Int16 PCM 16kHz mono)
 *
 * All context-building (identity, SA, lorebook, RAG, vault, graph,
 * image-gen, history loading) is handled by EntityTurn — voice mode gets
 * the same context text chat gets. The pipeline only owns the audio side:
 * mic → STT → EntityTurn.process() → sentence-buffer → TTS → audio frames.
 */

import type { EntityTurn } from "../entity/loop.ts";
import type { VoiceProfile } from "../llm/voice-settings.ts";
import {
  applySTTCorrections,
  applyTTSPronunciation,
  normalizePunctuationForSpeech,
  stripTTag,
} from "./pronunciation.ts";
import { streamTTS } from "./tts.ts";
import { transcribe } from "./stt.ts";

export type WalkieTalkieState =
  | "idle"
  | "recording"
  | "processing"
  | "speaking";

export type WalkieTalkieEvent =
  | { type: "state"; state: WalkieTalkieState }
  | { type: "transcript"; role: "user" | "assistant"; text: string }
  | { type: "audio"; data: Uint8Array }
  | { type: "pulse_start"; name: string }
  | { type: "tool_start"; toolName: string; toolCallId: string }
  | { type: "tool_end"; toolCallId: string }
  | { type: "error"; message: string };

/** Maximum chars to accumulate before flushing a sentence to TTS. */
const MAX_SENTENCE_CHARS = 200;
/** Sentence boundary characters trigger an immediate flush. */
const SENTENCE_BOUNDARY = /[.!?。\n]/;

export interface WalkieTalkieSessionOptions {
  profile: VoiceProfile;
  entityTurn: EntityTurn;
  conversationId: string;
  /** Appended to EntityTurn's system message (VOICE CHAT MODE note + customInstructions) */
  systemPromptSuffix: string;
}

export class WalkieTalkieSession {
  private profile: VoiceProfile;
  private entityTurn: EntityTurn;
  private conversationId: string;
  private systemPromptSuffix: string;
  private _state: WalkieTalkieState = "idle";
  private audioBuffer: Uint8Array[] = [];
  private eventHandler: ((event: WalkieTalkieEvent) => void) | null = null;
  private currentTurnAbort: AbortController | null = null;
  private _stopped = false;
  /**
   * True while a Pulse-driven turn is in flight (between processPulseTurn
   * start and the response completing). User transcripts that arrive
   * during this window are QUEUED rather than dropped — the Pulse is
   * system-initiated, so the user's intentional turn should still go
   * through once the Pulse finishes. (Verbal blips during a normal
   * entity response are still dropped — see isEntityMidResponse guard.)
   */
  private _isPulseTurn = false;
  private queuedUserTranscript: string | null = null;

  constructor(opts: WalkieTalkieSessionOptions) {
    this.profile = opts.profile;
    this.entityTurn = opts.entityTurn;
    this.conversationId = opts.conversationId;
    this.systemPromptSuffix = opts.systemPromptSuffix;
  }

  get state(): WalkieTalkieState {
    return this._state;
  }

  /** Subscribe to pipeline events. Only one handler at a time. */
  onEvent(handler: (event: WalkieTalkieEvent) => void): void {
    this.eventHandler = handler;
  }

  /** Append audio data to the recording buffer (server-side STT only). */
  pushAudio(audio: Uint8Array): void {
    if (this._stopped) return;
    // Buffer frames even before state transitions (e.g. VAD latency).
    // State is set explicitly by ptt_start or user_speech_start.
    // Don't auto-transition on first frame — that causes "Recording" UI
    // to show immediately on call start instead of staying "Listening".
    this.audioBuffer.push(audio);
  }

  /**
   * Process a user turn from accumulated audio (server-side STT mode).
   * Returns when TTS playback completes or the turn is cancelled.
   */
  async processAudioTurn(): Promise<void> {
    if (this._stopped) return;
    // Browser-side VAD can fire `user_silence` while the entity is
    // responding (audio frames are dropped during speaking/processing,
    // so the buffer stays empty). Don't change state in that case —
    // wait for the entity to finish.
    if (this.isEntityMidResponse()) {
      this.audioBuffer = [];
      return;
    }
    if (this.audioBuffer.length === 0) {
      return;
    }
    const totalBytes = this.audioBuffer.reduce((n, a) => n + a.length, 0);
    const audio = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of this.audioBuffer) {
      audio.set(chunk, offset);
      offset += chunk.length;
    }
    this.audioBuffer = [];

    this.setState("processing");
    this.currentTurnAbort = new AbortController();
    try {
      // Diagnostic: log audio duration so we can tell whether truncation
      // happens before Deepgram (frames missing) or after (Deepgram endpointing).
      // 16kHz mono Int16 = 32000 bytes/sec.
      const audioSeconds = (audio.byteLength / 32000).toFixed(2);
      console.log(
        `[Voice:debug] processAudioTurn — sending ${audio.byteLength} bytes (${audioSeconds}s) to ${this.profile.providerSettings.stt.provider}`,
      );
      const { text: rawText } = await transcribe(audio, this.profile);
      console.log(
        `[Voice:debug] STT returned ${rawText.length} chars: ${
          rawText.slice(0, 200)
        }`,
      );
      const text = applySTTCorrections(rawText.trim(), this.profile);
      if (!text) {
        this.setState("idle");
        return;
      }
      await this.runEntityTurn(text);
    } catch (err) {
      this.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      this.setState("idle");
    } finally {
      this.currentTurnAbort = null;
    }
  }

  /**
   * Process a user turn from pre-transcribed text (browser-native STT).
   * Returns when TTS playback completes or the turn is cancelled.
   *
   * Browser STT keeps listening during the entity's turn, so spurious
   * transcripts (verbal blips, background voices picked up by the mic)
   * would otherwise interrupt mid-response. Drop them.
   */
  async processTextTurn(rawText: string): Promise<void> {
    if (this._stopped) return;
    // If the entity is mid-response to a NORMAL user turn (not a Pulse),
    // drop the transcript — it's a verbal blip or background voice, and
    // we don't want it interrupting. The walkie-talkie model is non-
    // interruptible for normal turns.
    //
    // If the entity is mid-response to a PULSE, queue the transcript
    // instead. The Pulse is system-initiated; the user's intentional
    // turn should still go through once the Pulse finishes.
    if (this.isEntityMidResponse()) {
      if (this._isPulseTurn) {
        this.queuedUserTranscript = rawText;
      }
      return;
    }
    const text = applySTTCorrections(rawText.trim(), this.profile);
    if (!text) return;

    this.setState("processing");
    this.currentTurnAbort = new AbortController();
    try {
      await this.runEntityTurn(text);
    } catch (err) {
      this.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      this.setState("idle");
    } finally {
      this.currentTurnAbort = null;
    }
  }

  /**
   * Drive a queued Pulse through the voice pipeline. Emits a `pulse_start`
   * event first (browser plays the heartbeat cue + shows the toast), waits
   * briefly for the cue, then runs EntityTurn.process with the Pulse prompt
   * + voice options + Pulse metadata (so EntityTurn adds the
   * `[System — Pulse "..."]` prefix to the persisted message).
   *
   * The session manager drains pendingPulses at speaking→idle transitions.
   * User voice turns stay disabled throughout (state is processing/speaking,
   * pushAudio drops frames, user_silence gets ignored — same as a normal
   * entity response).
   */
  async processPulseTurn(
    promptText: string,
    pulseMeta: {
      pulseId: string;
      pulseName: string;
      skipStickyDecrement?: boolean;
    },
  ): Promise<void> {
    if (this._stopped) return;
    // Transition to processing FIRST so the browser UI immediately reflects
    // "the entity is busy" (greyed waveform, "Thinking..." label). Then
    // emit pulse_start (triggers the heartbeat cue + toast) and pause
    // briefly so the cue plays cleanly before TTS starts.
    this.setState("processing");
    this._isPulseTurn = true;
    this.emit({ type: "pulse_start", name: pulseMeta.pulseName });
    // Brief pause so the cue plays cleanly before the entity's response
    // starts streaming through TTS. 250ms is enough for the bah-bump rhythm.
    await new Promise((r) => setTimeout(r, 250));
    if (this._stopped) return;

    this.currentTurnAbort = new AbortController();
    try {
      await this.runEntityTurn(promptText, pulseMeta);
    } catch (err) {
      this.emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      this.setState("idle");
    } finally {
      this.currentTurnAbort = null;
      this._isPulseTurn = false;
      // If the user's transcript arrived during the Pulse response (race
      // case the userSpeaking guard didn't catch), process it now that
      // the pipeline is idle again.
      const queued = this.queuedUserTranscript;
      this.queuedUserTranscript = null;
      if (queued && !this._stopped) {
        // Defer slightly so the idle state event fires first and any
        // pending Pulse drain check runs (otherwise we'd jump straight
        // into another turn before the session manager sees idle).
        setTimeout(() => {
          void this.processTextTurn(queued);
        }, 0);
      }
    }
  }

  /** Cancel any in-flight turn and reset state to idle. */
  async cancel(): Promise<void> {
    if (this.currentTurnAbort) {
      this.currentTurnAbort.abort();
    }
    this.audioBuffer = [];
    this.setState("idle");
  }

  /**
   * Drop any audio accumulated in the recording buffer. Called by the
   * session manager on `ptt_start` so server-side STT + PTT only
   * transcribes audio from the hold period, not from session start.
   */
  clearAudioBuffer(): void {
    this.audioBuffer = [];
  }

  /** Current size of the recording buffer in bytes (diagnostic). */
  audioBufferLength(): number {
    return this.audioBuffer.reduce((n, a) => n + a.length, 0);
  }

  /** Stop the session entirely. Future events are dropped. */
  stop(): void {
    this._stopped = true;
    if (this.currentTurnAbort) {
      this.currentTurnAbort.abort();
    }
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  /**
   * Returns true if a new user turn would interrupt an in-flight entity
   * response. The walkie-talkie model is non-interruptible by default —
   * user verbal blips and background voices during the entity's turn are
   * ignored until the entity finishes speaking.
   */
  private isEntityMidResponse(): boolean {
    return this._state === "processing" || this._state === "speaking";
  }

  /**
   * Drive an EntityTurn.process() iteration, routing content chunks to the
   * TTS pipeline. EntityTurn handles all the context-building, tool
   * execution, persistence (with `[Voice Chat] ` prefix via messagePrefix),
   * context snapshots, and metrics.
  /**
   * Drive an EntityTurn.process() iteration, routing content chunks to the
   * TTS pipeline. EntityTurn handles all the context-building, tool
   * execution, persistence (with `[Voice Chat] ` prefix via messagePrefix),
   * context snapshots, and metrics.
   *
   * `pulseOptions` is set when this turn is being driven by a queued Pulse
   * — EntityTurn adds the `[System — Pulse "..."]` prefix so the entity
   * knows the prompt is system-automated.
   */
  private async runEntityTurn(
    userText: string,
    pulseOptions?: {
      pulseId: string;
      pulseName: string;
      skipStickyDecrement?: boolean;
    },
  ): Promise<void> {
    // Emit the user-side transcript for browser UI display. EntityTurn
    // persists the same text (with prefix) to the DB.
    this.emit({ type: "transcript", role: "user", text: userText });

    const signal = this.currentTurnAbort?.signal;
    let fullResponse = "";
    let sentenceBuffer = "";
    let firstFrameSent = false;

    const flushSentence = async () => {
      const text = sentenceBuffer;
      sentenceBuffer = "";
      if (!text.trim()) return;
      // Order matters: strip <t> tags first (they wrap content we want to
      // preserve), then normalize punctuation (em/en dashes → commas, etc.),
      // then apply user pronunciation substitutions.
      const cleaned = normalizePunctuationForSpeech(stripTTag(text));
      if (!cleaned.trim()) return;
      const spokenText = applyTTSPronunciation(cleaned, this.profile);
      try {
        for await (const chunk of streamTTS(spokenText, this.profile)) {
          if (signal?.aborted) return;
          if (!firstFrameSent) {
            firstFrameSent = true;
            this.setState("speaking");
          }
          this.emit({ type: "audio", data: chunk });
        }
      } catch (ttsErr) {
        console.error(
          "[Voice:pipeline] TTS fetch failed for text:",
          JSON.stringify(spokenText).slice(0, 200),
        );
        console.error(
          "[Voice:pipeline] TTS error:",
          ttsErr instanceof Error ? ttsErr.message : String(ttsErr),
        );
        throw ttsErr;
      }
    };

    try {
      const stream = this.entityTurn.process(this.conversationId, userText, {
        voiceMode: true,
        systemPromptSuffix: this.systemPromptSuffix,
        messagePrefix: "[Voice Chat] ",
        ...(pulseOptions ?? {}),
      });

      for await (const event of stream) {
        // Drain the generator even after disconnect so post-yield
        // persistence (tool results) still runs. Breaking would skip
        // the db.addMessage after a tool_result yield, orphaning the
        // tool call — same bug that affected the chat handlers.
        if (signal?.aborted) continue;
        // Route stream events by type. Content feeds the TTS pipeline;
        // tool_call / tool_result drive the tool toast + chime in the
        // browser; other event types (metrics, context snapshots,
        // message_id, image_generated, dom_update) are ignored —
        // EntityTurn handles persistence internally.
        if (event.type === "tool_call") {
          this.emit({
            type: "tool_start",
            toolName: event.toolCall.function.name,
            toolCallId: event.toolCall.id,
          });
          continue;
        }
        if (event.type === "tool_result") {
          this.emit({
            type: "tool_end",
            toolCallId: event.result.toolCallId,
          });
          continue;
        }
        if (event.type === "status" && event.status.error) {
          this.emit({ type: "error", message: event.status.error });
          continue;
        }
        if (event.type !== "content") continue;
        const piece = event.content;
        fullResponse += piece;
        sentenceBuffer += piece;
        // Re-check signal before any TTS call — don't synthesize audio
        // for a disconnected client. fullResponse still accumulates
        // (cheap) but is discarded post-loop on abort.
        if (signal?.aborted) continue;
        // Flush at sentence boundaries or when buffer gets large
        const lastChar = piece[piece.length - 1];
        if (lastChar && SENTENCE_BOUNDARY.test(lastChar)) {
          await flushSentence();
        } else if (sentenceBuffer.length >= MAX_SENTENCE_CHARS) {
          await flushSentence();
        }
      }
      // Flush any remaining buffered text
      if (!signal?.aborted && sentenceBuffer.trim()) {
        await flushSentence();
      }
    } catch (err) {
      // Try to flush what we have before surfacing the error
      if (sentenceBuffer.trim() && !signal?.aborted) {
        try {
          await flushSentence();
        } catch { /* surface original error instead */ }
      }
      throw err;
    }

    if (signal?.aborted) {
      this.setState("idle");
      return;
    }

    // Emit the assistant-side transcript (raw response, no TTS substitutions).
    // EntityTurn already persisted this with the [Voice Chat] prefix and
    // stripped any parrot-emitted prefix from the LLM output.
    const cleanedResponse = normalizePunctuationForSpeech(
      stripTTag(fullResponse),
    ).trim();
    if (cleanedResponse) {
      this.emit({
        type: "transcript",
        role: "assistant",
        text: cleanedResponse,
      });
    }

    this.setState("idle");
  }

  public setState(state: WalkieTalkieState): void {
    if (this._stopped) return;
    if (this._state === state) return;
    this._state = state;
    this.emit({ type: "state", state });
  }

  private emit(event: WalkieTalkieEvent): void {
    if (this._stopped) return;
    try {
      this.eventHandler?.(event);
    } catch (err) {
      console.error("[Voice:pipeline] event handler threw:", err);
    }
  }
}
