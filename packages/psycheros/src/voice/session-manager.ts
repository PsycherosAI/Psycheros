/**
 * Voice Session Manager
 *
 * Singleton that owns active walkie-talkie voice sessions. Each session
 * hosts a `WalkieTalkieSession` (the pipeline) and a WebSocket to the
 * browser. Audio frames, transcripts, and state events flow between them.
 *
 * Message persistence is handled by `EntityTurn.process()` — each voice
 * turn (user utterance + entity response) is persisted to the conversation
 * DB as it happens, with a `[Voice Chat] ` prefix. The session manager
 * no longer batches transcripts at session end.
 */

import type { EntityTurn } from "../entity/loop.ts";
import type { VoiceProfile } from "../llm/voice-settings.ts";
import { WalkieTalkieSession } from "./pipeline.ts";
import type { WalkieTalkieEvent } from "./pipeline.ts";

// =============================================================================
// Types
// =============================================================================

export type VoiceSessionState =
  | "connecting"
  | "active"
  | "paused"
  | "ending";

export interface VoiceTranscriptSegment {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface VoiceSession {
  id: string;
  conversationId: string;
  profileId: string;
  state: VoiceSessionState;
  browserSocket: WebSocket;
  pipeline: WalkieTalkieSession;
  transcript: VoiceTranscriptSegment[];
  startedAt: number;
  lastActivityAt: number;
  muted: boolean;
  /** Server-side PTT hold state. Set by ptt_start/ptt_end messages.
   *  When true + pttEnabled, audio frames are pushed to the pipeline. */
  pttHolding: boolean;
  /** Global PTT toggle from VoiceSettings (set at session creation). */
  pttEnabled: boolean;
  /** Track PTT vs vanilla mode ('ptt' or 'vanilla'). */
  pttMode: "ptt" | "vanilla";
  /**
   * True when the browser has detected the start of user speech but the
   * corresponding finalized transcript hasn't arrived yet. Used to defer
   * Pulse draining so a Pulse that fires right after the entity finishes
   * speaking doesn't cut off the user mid-utterance.
   *
   * Browser STT only — server-side STT modes have their own audio buffer
   * state for this.
   */
  userSpeaking: boolean;
  /**
   * Pulses queued during this voice session. Each entry holds the full
   * prompt + name + a Promise resolver. The pipeline drains the queue at
   * speaking→idle transitions (after a brief grace period so the user
   * can take their turn first). When drained, the pipeline emits a
   * `pulse_start` event (browser plays a heartbeat cue + shows a toast),
   * runs the Pulse prompt through entityTurn.process with voice options,
   * and resolves the Promise when the response completes.
   */
  pendingPulses: PendingPulse[];
  /** Idle timeout handle — fires `endSession` after `idleTimeoutSeconds`. */
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * A Pulse queued for execution during a voice call. The Pulse engine hands
 * these off via `executePulseInVoice` instead of running them through the
 * text chat path. The resolver is called when the voice pipeline finishes
 * the Pulse's response (or with an error if the call ends first).
 */
export interface PendingPulse {
  id: string;
  name: string;
  promptText: string;
  resolve: (result: { status: "success" | "skipped"; result?: string }) => void;
}

// =============================================================================
// Manager
// =============================================================================

export class VoiceSessionManager {
  private static instance: VoiceSessionManager | null = null;
  private sessions: Map<string, VoiceSession> = new Map();
  /** conversationId → sessionId — enforces one voice session per conversation */
  private conversationLocks: Map<string, string> = new Map();

  static getInstance(): VoiceSessionManager {
    if (!VoiceSessionManager.instance) {
      VoiceSessionManager.instance = new VoiceSessionManager();
    }
    return VoiceSessionManager.instance;
  }

  /** Number of currently active sessions */
  get activeSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Create a new voice session for a conversation.
   * Rejects if another session is already active for the same conversation.
   *
   * The `entityTurn` is constructed by the caller with the same EntityConfig
   * as text chat — voice mode gets the full context (SA, lorebook, RAG,
   * vault, graph, image-gen, etc.) for free. The pipeline drives
   * `entityTurn.process()` and routes content chunks to TTS.
   */
  createSession(
    conversationId: string,
    profileId: string,
    browserSocket: WebSocket,
    profile: VoiceProfile,
    entityTurn: EntityTurn,
    voiceSuffix: string,
    pttEnabled: boolean,
  ): { session: VoiceSession } | { error: string } {
    // Multi-device lock: reject if conversation already in voice
    const existingId = this.conversationLocks.get(conversationId);
    if (existingId) {
      return { error: "Conversation already in a voice session" };
    }

    const sessionId = `voice_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    const pipeline = new WalkieTalkieSession({
      profile,
      entityTurn,
      conversationId,
      systemPromptSuffix: voiceSuffix,
    });

    const session: VoiceSession = {
      id: sessionId,
      conversationId,
      profileId,
      state: "active",
      browserSocket,
      pipeline,
      transcript: [],
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      muted: false,
      pttHolding: false,
      pttEnabled: pttEnabled,
      pttMode: pttEnabled ? "ptt" : "vanilla",
      userSpeaking: false,
      pendingPulses: [],
      idleTimer: null,
    };

    // Wire pipeline events → browser messages + transcript accumulation
    pipeline.onEvent((event) => this.handlePipelineEvent(session, event));

    this.sessions.set(sessionId, session);
    this.conversationLocks.set(conversationId, sessionId);

    // Wire up browser WebSocket events
    this.setupBrowserListeners(session, profile);

    // Kick off idle timeout
    this.resetIdleTimer(session, profile);

    console.log(
      `[Voice] Session created: ${sessionId} (conversation: ${conversationId})`,
    );

    return { session };
  }

  /** Get a session by ID */
  getSession(id: string): VoiceSession | null {
    return this.sessions.get(id) ?? null;
  }

  /** Get the active session for a conversation (if any) */
  getSessionByConversation(conversationId: string): VoiceSession | null {
    const sessionId = this.conversationLocks.get(conversationId);
    if (!sessionId) return null;
    return this.sessions.get(sessionId) ?? null;
  }

  /** Check if a conversation has an active voice session */
  isConversationInVoice(conversationId: string): boolean {
    return this.conversationLocks.has(conversationId);
  }

  /**
   * Hand off a Pulse from the Pulse engine to the voice pipeline. The Pulse
   * is queued and drained at the next speaking→idle transition. Returns a
   * Promise that resolves when the voice pipeline finishes the Pulse's
   * response (or with `skipped` if the voice session ends first).
   *
   * Called by the Pulse engine when it detects the conversation is in voice
   * mode — replaces the text chat execution path for that Pulse.
   */
  executePulseInVoice(
    conversationId: string,
    pulse: { id: string; name: string; promptText: string },
  ): Promise<{ status: "success" | "skipped"; result?: string }> {
    const session = this.getSessionByConversation(conversationId);
    if (!session) {
      // Voice session ended between the engine's check and this call.
      // Return "skipped" so the Pulse engine treats it as not-run and
      // fires again on the next schedule.
      return Promise.resolve({
        status: "skipped",
        result: "Voice session ended before Pulse could be queued",
      });
    }
    return new Promise((resolve) => {
      session.pendingPulses.push({
        id: pulse.id,
        name: pulse.name,
        promptText: pulse.promptText,
        resolve,
      });
      // If the pipeline is currently idle (between turns), trigger the
      // drain immediately. Otherwise it'll happen at the next idle state.
      this.maybeDrainPulse(session);
    });
  }

  /**
   * End a voice session. Cleans up connections and locks.
   *
   * Transcript persistence is handled by EntityTurn during the call — each
   * voice turn (user utterance + entity response) is persisted as it
   * happens with the `[Voice Chat] ` prefix. Nothing to batch here.
   */
  async endSession(
    sessionId: string,
  ): Promise<VoiceTranscriptSegment[]> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    session.state = "ending";

    // Stop the pipeline (cancels any in-flight turn)
    session.pipeline.stop();

    // Clear idle timer
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    // Notify browser before closing so it can clean up gracefully
    try {
      this.sendToBrowser(session, { type: "session_ended" });
    } catch {
      // Already closed
    }

    // Close browser connection
    try {
      session.browserSocket.close();
    } catch {
      // Already closed
    }

    // Resolve any queued Pulses so the Pulse engine doesn't hang waiting
    // on Promises that will never complete. The Pulse will be marked
    // "skipped" in job_runs and fire again on its next schedule.
    for (const pulse of session.pendingPulses) {
      pulse.resolve({
        status: "skipped",
        result: "Voice session ended before Pulse could be processed",
      });
    }
    session.pendingPulses = [];

    // Clean up locks
    this.conversationLocks.delete(session.conversationId);
    this.sessions.delete(sessionId);

    console.log(
      `[Voice] Session ended: ${sessionId} (${session.transcript.length} transcript segments)`,
    );

    return session.transcript;
  }

  /** Clean up all sessions on daemon shutdown */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.pipeline.stop();
      if (session.idleTimer) clearTimeout(session.idleTimer);
      try {
        this.sendToBrowser(session, { type: "session_ended" });
        session.browserSocket.close();
      } catch {
        // Best-effort cleanup
      }
    }
    this.sessions.clear();
    this.conversationLocks.clear();
  }

  // ===========================================================================
  // Internal: browser message handling
  // ===========================================================================

  private setupBrowserListeners(
    session: VoiceSession,
    profile: VoiceProfile,
  ): void {
    session.browserSocket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          this.handleBrowserMessage(session, msg, profile);
        } catch {
          console.error("[Voice] Failed to parse browser message");
        }
      } else if (event.data instanceof ArrayBuffer) {
        // Binary audio frame from the browser — push to pipeline.
        // (Only relevant for server-side STT modes; browser-native STT
        // sends transcripts as JSON, not audio.)
        if (!session.muted) {
          // PTT mode: only accept audio while the user is holding the button.
          // Without this gate, frames arriving before ptt_start (e.g. during
          // the async config load race) push the pipeline into RECORDING state
          // immediately on call start.
          if (session.pttMode && !session.pttHolding) {
            // Still reset idle timer so the session doesn't time out.
            session.lastActivityAt = Date.now();
            this.resetIdleTimer(session, profile);
            return;
          }
          // Diagnostic: log frame arrival (throttled — first 3 + every 100th)
          const fc = (session as { _frameCount?: number })._frameCount ?? 0;
          (session as { _frameCount?: number })._frameCount = fc + 1;
          if (fc < 3 || fc % 100 === 0) {
            console.log(
              `[Voice:debug] binary frame #${
                fc + 1
              } received: ${event.data.byteLength} bytes`,
            );
          }
          session.pipeline.pushAudio(new Uint8Array(event.data));
          session.lastActivityAt = Date.now();
          this.resetIdleTimer(session, profile);
        }
      }
    };

    session.browserSocket.onclose = () => {
      if (session.state !== "ending") {
        console.log(
          `[Voice] Browser disconnected for session ${session.id}`,
        );
        void this.endSession(session.id);
      }
    };

    session.browserSocket.onerror = () => {
      console.error(
        `[Voice] Browser WebSocket error for session ${session.id}`,
      );
    };
  }

  private handleBrowserMessage(
    session: VoiceSession,
    msg: Record<string, unknown>,
    profile: VoiceProfile,
  ): void {
    session.lastActivityAt = Date.now();
    this.resetIdleTimer(session, profile);

    switch (msg.type) {
      case "ping":
        this.sendToBrowser(session, { type: "pong" });
        break;

      case "mute":
        session.muted = true;
        session.state = "paused";
        break;

      case "unmute":
        session.muted = false;
        session.state = "active";
        break;

      case "end_call":
        void this.endSession(session.id);
        break;

      case "ptt_start":
        session.pttHolding = true;
        // PTT pressed. For server-side STT mode, clear any audio that
        // accumulated between session start and this PTT press — only
        // audio during the hold should be transcribed. For browser STT
        // mode this is a no-op (the browser starts/stops recognition
        // itself on PTT events).
        console.log(
          `[Voice:debug] ptt_start — buffer cleared (was ${session.pipeline.audioBufferLength()} bytes)`,
        );
        session.pipeline.clearAudioBuffer();
        session.pipeline.setState("recording");
        break;

      case "ptt_end":
        session.pttHolding = false;
        // PTT released — process accumulated audio.
        console.log(
          `[Voice:debug] ptt_end — processing ${session.pipeline.audioBufferLength()} bytes of audio`,
        );
        void session.pipeline.processAudioTurn();
        break;

      case "user_silence":
        // Browser-side VAD detected end of speech — process accumulated audio.
        console.log(
          `[Voice:debug] user_silence — UNEXPECTED IN PTT MODE, processing ${session.pipeline.audioBufferLength()} bytes`,
        );
        void session.pipeline.processAudioTurn();
        break;

      case "transcript":
        // Browser-native STT mode: text already transcribed in the browser.
        // The finalized transcript means speech ended — clear the
        // userSpeaking flag so queued Pulses can now drain.
        session.userSpeaking = false;
        void session.pipeline.processTextTurn(String(msg.text ?? ""));
        break;

      case "user_speech_start":
        // Browser detected the start of user speech. Transition to recording
        // state and set the flag so Pulse drainer defer — see maybeDrainPulse.
        session.pipeline.setState("recording");
        session.userSpeaking = true;
        break;

      default:
        console.log(`[Voice] Unknown browser message type: ${msg.type}`);
    }
  }

  // ===========================================================================
  // Internal: pipeline event handling
  // ===========================================================================

  private handlePipelineEvent(
    session: VoiceSession,
    event: WalkieTalkieEvent,
  ): void {
    switch (event.type) {
      case "state":
        this.sendToBrowser(session, { type: "state", state: event.state });
        session.lastActivityAt = Date.now();
        // When pipeline returns to idle (entity done speaking), check for
        // queued Pulses. The drain method handles its own state check — if
        // the user has already started speaking (state moved to recording
        // between the pipeline emitting idle and us processing it), the
        // Pulse defers until the next idle.
        if (event.state === "idle") {
          this.maybeDrainPulse(session);
        }
        break;

      case "pulse_start":
        // Browser plays the heartbeat cue + shows the Pulse toast.
        this.sendToBrowser(session, {
          type: "pulse_start",
          name: event.name,
        });
        session.lastActivityAt = Date.now();
        break;

      case "tool_start":
        // Browser plays the ascending chime + adds a tool chip to the toast.
        this.sendToBrowser(session, {
          type: "tool_start",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        });
        session.lastActivityAt = Date.now();
        break;

      case "tool_end":
        // Browser removes the matching tool chip.
        this.sendToBrowser(session, {
          type: "tool_end",
          toolCallId: event.toolCallId,
        });
        session.lastActivityAt = Date.now();
        break;

      case "transcript":
        session.transcript.push({
          role: event.role,
          text: event.text,
          timestamp: Date.now(),
        });
        this.sendToBrowser(session, {
          type: "transcript",
          role: event.role,
          text: event.text,
        });
        session.lastActivityAt = Date.now();
        break;

      case "audio":
        // Binary frame — send raw bytes.
        this.sendToBrowser(session, event.data);
        session.lastActivityAt = Date.now();
        break;

      case "error":
        console.error(`[Voice] Pipeline error (${session.id}):`, event.message);
        this.sendToBrowser(session, { type: "error", message: event.message });
        break;
    }
  }

  // ===========================================================================
  // Internal: idle timeout
  // ===========================================================================

  private resetIdleTimer(
    session: VoiceSession,
    profile: VoiceProfile,
  ): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }
    const timeoutSec = profile.idleTimeoutSeconds ?? 300;
    if (timeoutSec <= 0) return; // 0 = disabled
    session.idleTimer = setTimeout(() => {
      console.log(
        `[Voice] Idle timeout (${timeoutSec}s) — ending session ${session.id}`,
      );
      void this.endSession(session.id);
    }, timeoutSec * 1000);
  }

  // ===========================================================================
  // Internal: Pulse queue draining
  // ===========================================================================

  /**
   * Check for queued Pulses and drain one if the pipeline is idle. Called
   * at speaking→idle transitions and when a Pulse is first queued during
   * idle. If the pipeline isn't idle (user started speaking, or another
   * Pulse is already draining), the Pulse stays queued for the next idle.
   *
   * One Pulse per call — recursive draining happens via the idle state
   * event that fires when the Pulse's own response completes.
   */
  private maybeDrainPulse(session: VoiceSession): void {
    if (session.pendingPulses.length === 0) return;
    if (session.pipeline.state !== "idle") return;
    // Defer if the browser reports the user is mid-speech. The Pulse would
    // cut off their turn — the finalized transcript would arrive during
    // the Pulse response and get dropped by the interruption guard.
    // Once the transcript arrives (clearing userSpeaking) the next idle
    // transition re-triggers this check and drains.
    if (session.userSpeaking) return;
    const pulse = session.pendingPulses.shift()!;
    // Drive the Pulse through the pipeline. The pipeline emits pulse_start
    // (which we forward to the browser as the cue/toast trigger), then runs
    // entityTurn.process with the Pulse prompt + voice options + Pulse
    // metadata. Resolves when the entity's response completes.
    void session.pipeline.processPulseTurn(pulse.promptText, {
      pulseId: pulse.id,
      pulseName: pulse.name,
      skipStickyDecrement: true,
    }).then(() => {
      pulse.resolve({ status: "success", result: "Processed in voice" });
    }).catch((err) => {
      console.error(`[Voice] Pulse "${pulse.name}" failed:`, err);
      // Mark as skipped (not success) so the Pulse engine's job_runs
      // records the failure. The Pulse will fire again on its next
      // schedule.
      pulse.resolve({
        status: "skipped",
        result: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ===========================================================================
  // Internal: Helpers
  // ===========================================================================

  private sendToBrowser(session: VoiceSession, data: unknown): void {
    if (session.browserSocket.readyState !== WebSocket.OPEN) return;
    try {
      if (typeof data === "string") {
        session.browserSocket.send(data);
      } else if (data instanceof ArrayBuffer) {
        session.browserSocket.send(data);
      } else if (data instanceof Uint8Array) {
        // Copy into a fresh ArrayBuffer — Deno's WebSocket requires it
        // because Uint8Array's underlying buffer may be larger than the
        // view (e.g., for a slice of a bigger allocation).
        session.browserSocket.send(data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        ));
      } else {
        session.browserSocket.send(JSON.stringify(data));
      }
    } catch {
      // Socket may have closed
    }
  }
}
