/**
 * Voice Chat Module
 *
 * Walkie-talkie voice pipeline: one user utterance → STT → LLM → TTS →
 * playback. All in-process (no Python sidecar). See
 * `docs/VOICE_CHAT_UX.md` for the architecture and `../pipecat-shelved/`
 * for the previous real-time Pipecat implementation.
 */

export { VoiceSessionManager } from "./session-manager.ts";
export type {
  VoiceSession,
  VoiceSessionState,
  VoiceTranscriptSegment,
} from "./session-manager.ts";
