/**
 * Voice Chat Settings Persistence
 *
 * Manages loading and saving voice chat configuration settings to disk.
 * Settings are stored in `.psycheros/voice-settings.json`.
 */

import { join } from "@std/path";
import { maskApiKey } from "./settings.ts";

// =============================================================================
// Provider Types
// =============================================================================

export type VoiceTTSProvider = "minimax" | "elevenlabs" | "openai" | "custom";
export type VoiceSTTProvider = "browser" | "deepgram" | "openai" | "custom";

// =============================================================================
// TTS Provider Settings
// =============================================================================

export interface MinimaxTTSSettings {
  apiKey: string;
  groupId: string;
  voiceId: string;
  model?: string;
}

export interface ElevenLabsTTSSettings {
  apiKey: string;
  voiceId: string;
  model: string;
}

export interface OpenAITTSSettings {
  apiKey: string;
  baseUrl: string;
  voice: string;
  model: string;
}

// =============================================================================
// STT Provider Settings
// =============================================================================

/**
 * Browser-native STT via the Web Speech API (`SpeechRecognition` /
 * `webkitSpeechRecognition`). Runs entirely in the browser — the daemon
 * receives transcribed text, never audio. No API key, no server-side
 * call. Quality and language support depend on the browser vendor's
 * implementation (Chrome/Edge use Google/Microsoft cloud STT under the hood).
 */
export interface BrowserSTTSettings {
  /** BCP-47 language code (e.g. "en-US"), empty for browser default */
  language?: string;
}

export interface DeepgramSTTSettings {
  apiKey: string;
  model: string;
  language: string;
}

export interface OpenAISTTSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Optional BCP-47 language code for the OpenAI Whisper API */
  language?: string;
}

// Custom OpenAI-compatible STT (e.g. local Whisper HTTP server, remote
// Whisper endpoint). Point baseUrl at any server that speaks the
// OpenAI `/audio/transcriptions` shape.
export interface CustomSTTSettings {
  baseUrl: string;
  apiKey?: string;
  model: string;
  language?: string;
}

// Custom OpenAI-compatible TTS (Kokoro, Chatterbox, NeuTTS, local TTS
// servers, etc.). Point baseUrl at any server that speaks the OpenAI
// `/audio/speech` shape.
export interface CustomTTSSettings {
  baseUrl: string;
  apiKey?: string;
  model: string;
  voice: string;
}

// =============================================================================
// Voice Provider Settings
// =============================================================================

export interface VoiceProviderSettings {
  tts: {
    provider: VoiceTTSProvider;
    minimax?: MinimaxTTSSettings;
    elevenlabs?: ElevenLabsTTSSettings;
    openai?: OpenAITTSSettings;
    custom?: CustomTTSSettings;
  };
  stt: {
    provider: VoiceSTTProvider;
    browser?: BrowserSTTSettings;
    deepgram?: DeepgramSTTSettings;
    openai?: OpenAISTTSettings;
    custom?: CustomSTTSettings;
  };
}

// =============================================================================
// Pronunciation & Audio Effects
// =============================================================================

export interface PronunciationEntry {
  /** The word or phrase as it appears in text */
  written: string;
  /** Phonetic spelling for TTS (e.g. "sy-KEH-ros" for "Psycheros") */
  spoken: string;
}

/**
 * STT correction entry. Maps a common misrecognition to the correct
 * spelling. Applied as post-processing on STT output before the LLM
 * sees it. Useful for proper nouns that Whisper/Deepgram consistently
 * mishear (e.g. "sih keh ros" → "Psycheros").
 */
export interface STTCorrectionEntry {
  /** The text as the STT model tends to transcribe it */
  misheard: string;
  /** The correct spelling to substitute */
  correct: string;
}

export type AudioEffectType = "gain" | "equalizer" | "reverb" | "compressor";

export interface AudioEffect {
  id: string;
  name: string;
  type: AudioEffectType;
  params: Record<string, number>;
  enabled: boolean;
}

// =============================================================================
// Voice Profile
// =============================================================================

export interface VoiceProfile {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  providerSettings: VoiceProviderSettings;
  pronunciation: PronunciationEntry[];
  /** STT corrections — applied to recognized text before the LLM sees it */
  sttCorrections: STTCorrectionEntry[];
  customInstructions: string;
  audioEffects: AudioEffect[];
  /** Rolling context window size for voice mode in tokens (default 64000) */
  contextWindowSize: number;
  /** VAD silence threshold 0.0–1.0 (default 0.5, higher = longer pause needed) */
  vadThreshold: number;
  /** Idle timeout in seconds before session auto-ends (default 300) */
  idleTimeoutSeconds: number;
  /** TTS keep-alive interval in days (0 = disabled, default 0). Prevents voice deletion on providers like Minimax. */
  ttsKeepAliveDays: number;
  /** Last keep-alive timestamp (ISO string). Updated automatically by the scheduler. */
  lastKeepAlive?: string;
  /**
   * Push-to-talk mode (default false). When true, the user holds a button
   * to record and releases to send — no silence-based turn end. When
   * false (the default), end-of-speech detection is used for a hands-free
   * conversational feel.
   */
  pushToTalk: boolean;
  /**
   * Disable LLM reasoning/thinking tokens for this profile (default true).
   * Saves latency and tokens on providers that support it — important for
   * voice where every second of wait is felt. Passed to the LLM client as
   * `thinkingEnabled: !disableReasoning`.
   */
  disableReasoning: boolean;
  /** Seconds of silence before ending user's turn (default 1.5). Higher = more tolerant of pauses. */
  endOfTurnSilence: number;
  /**
   * Browser STT phrase debounce in milliseconds (default 1200). Chrome
   * Android fires a "final" SpeechRecognition result at every natural
   * phrase pause; this batches consecutive finals into one utterance
   * before sending. Only used by browser STT — server-side STT modes
   * have their own turn endpointing via the VAD silence detector.
   */
  phraseDebounceMs: number;
  /**
   * Show diagnostic toasts for browser STT events during voice calls
   * (default false). When on, surfaces: "STT listening" on first start,
   * "Speech detected" on first onspeechstart, "Heard (interim): …" on
   * first interim result, and "Heard: …" per flushed utterance. STT
   * error toasts always show regardless. Useful when diagnosing why
   * transcripts aren't flowing; noisy for everyday use.
   */
  sttDebug: boolean;
  /**
   * Voice effect preset applied to TTS playback. "none" = clean playback.
   * All presets use cheap Web Audio nodes (filters, delays) — negligible
   * CPU overhead. Designed to "embrace the synthetic" character of budget
   * TTS rather than trying to make it sound human.
   */
  voiceEffect: VoiceEffectType;
}

export type VoiceEffectType =
  | "none"
  | "comms"
  | "robot"
  | "telephone"
  | "deep"
  | "cavern";

// =============================================================================
// Top-Level Settings
// =============================================================================

export interface VoiceSettings {
  /** Master feature flag — when false, voice chat is disabled */
  enabled: boolean;
  /** Currently active voice profile ID */
  activeProfileId: string | null;
  profiles: VoiceProfile[];
  /**
   * Global push-to-talk toggle. When true, the voice overlay shows a
   * hold-to-talk circle and the configured key bindings trigger PTT.
   * When false, normal VAD / end-of-speech detection is used.
   * Persists across calls — set once in settings or toggled mid-call.
   */
  pttEnabled: boolean;
  /**
   * Array of key bindings that trigger PTT hold/release. Each entry is
   * a KeyboardEvent.code (e.g., "Space", "KeyV", "MediaPlayPause") or
   * a mouse button reference ("Mouse3" for back, "Mouse4" for forward).
   * Multiple bindings allow different keys for different devices (e.g.,
   * Space on desktop, media key for headset on mobile).
   */
  pttKeys: string[];
  /**
   * Show diagnostic log for the voice chat pipeline (default false).
   * Captures the Tauri mic-permission pre-request flow, WebSocket
   * connection events, walkie-talkie state transitions, TTS frame
   * arrival, AudioContext setup, and any decode/playback errors.
   * Useful when diagnosing why voice chat can't start, why STT/TTS
   * isn't flowing, or where audio glitches (pops, dropouts, format
   * mismatches) originate. Output goes to the "Debug" section in
   * Audio settings — copy/paste-friendly for support threads.
   * Lives at the VoiceSettings level (not per-profile) because it's
   * a global diagnostic, not something that varies by profile.
   */
  voiceChatDebug: boolean;
}

// =============================================================================
// Defaults
// =============================================================================

export function getDefaultVoiceSettings(): VoiceSettings {
  return {
    enabled: false,
    activeProfileId: null,
    profiles: [],
    pttEnabled: false,
    pttKeys: ["Space"],
    voiceChatDebug: false,
  };
}

/**
 * Apply defaults to a single profile, filling in any fields missing
 * from older persisted settings. Keeps loaded settings forward-compatible
 * when new fields are added.
 */
export function normalizeVoiceProfile(
  profile: Partial<VoiceProfile>,
): VoiceProfile {
  return {
    id: profile.id ?? crypto.randomUUID(),
    name: profile.name ?? "Unnamed profile",
    description: profile.description ?? "",
    enabled: profile.enabled ?? true,
    providerSettings: profile.providerSettings ?? {
      tts: { provider: "openai" },
      stt: { provider: "browser" },
    },
    pronunciation: profile.pronunciation ?? [],
    sttCorrections: profile.sttCorrections ?? [],
    customInstructions: profile.customInstructions ?? "",
    audioEffects: profile.audioEffects ?? [],
    contextWindowSize: profile.contextWindowSize ?? 64000,
    vadThreshold: profile.vadThreshold ?? 0.5,
    idleTimeoutSeconds: profile.idleTimeoutSeconds ?? 300,
    ttsKeepAliveDays: profile.ttsKeepAliveDays ?? 0,
    lastKeepAlive: profile.lastKeepAlive,
    pushToTalk: profile.pushToTalk ?? false,
    disableReasoning: profile.disableReasoning ?? true,
    endOfTurnSilence: profile.endOfTurnSilence ?? 1.5,
    phraseDebounceMs: profile.phraseDebounceMs ?? 1200,
    sttDebug: profile.sttDebug ?? false,
    voiceEffect: (profile.voiceEffect as VoiceEffectType | undefined) ?? "none",
  };
}

// =============================================================================
// Load / Save
// =============================================================================

export async function loadVoiceSettings(
  dataRoot: string,
): Promise<VoiceSettings> {
  const defaults = getDefaultVoiceSettings();
  const settingsPath = join(
    dataRoot,
    ".psycheros",
    "voice-settings.json",
  );

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<VoiceSettings>;
    // Migration: old settings files have per-profile pushToTalk but no
    // top-level pttEnabled. Copy from the active profile on first load.
    let pttEnabled = saved.pttEnabled;
    if (pttEnabled === undefined) {
      const activeProfile = (saved.profiles ?? []).find((p) =>
        p.id === saved.activeProfileId
      );
      pttEnabled = (activeProfile as { pushToTalk?: boolean })?.pushToTalk ??
        false;
    }
    // Migration: voiceChatDebug used to live on VoiceProfile. If the
    // top-level field is unset, inherit from any profile that had it on
    // (or from the legacy micPermissionDebug field name).
    let voiceChatDebug = saved.voiceChatDebug;
    if (voiceChatDebug === undefined) {
      const profiles = (saved.profiles ?? []) as unknown as Array<
        Record<string, unknown>
      >;
      voiceChatDebug = profiles.some((p) =>
        p.voiceChatDebug === true || p.micPermissionDebug === true
      );
    }
    return {
      ...defaults,
      ...saved,
      pttEnabled,
      pttKeys: saved.pttKeys ?? defaults.pttKeys,
      voiceChatDebug,
      // Normalize each profile so newly-added fields get defaults
      profiles: (saved.profiles ?? []).map(normalizeVoiceProfile),
    };
  } catch {
    return defaults;
  }
}

/**
 * Save voice settings to disk.
 *
 * Masked API keys in the incoming settings (containing the mask marker) are
 * replaced with the real keys from the existing on-disk file before saving.
 * Returns the corrected settings so callers can update their in-memory
 * state to match what was actually persisted — otherwise the in-memory
 * state would still hold the masked values, and the next voice session
 * would fail at the fetch site with a ByteString error.
 */
export async function saveVoiceSettings(
  dataRoot: string,
  settings: VoiceSettings,
): Promise<VoiceSettings> {
  const settingsDir = join(dataRoot, ".psycheros");
  const settingsPath = join(settingsDir, "voice-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });

  const existing = await loadVoiceSettings(dataRoot);
  const corrected = preserveRealApiKeys(settings, existing);

  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(corrected, null, 2) + "\n",
  );

  return corrected;
}

/** Mask marker used in masked API key display. U+2022 (BULLET) repeated. */
export const API_KEY_MASK = "••••";

/** True if the value looks like a masked API key (contains the mask marker). */
export function isMaskedApiKey(value: string | undefined | null): boolean {
  return !!value && value.includes(API_KEY_MASK);
}

/** If an incoming apiKey contains the mask marker (••••), keep the existing real key. */
function preserveRealApiKeys(
  incoming: VoiceSettings,
  existing: VoiceSettings,
): VoiceSettings {
  const MASK = API_KEY_MASK;
  // Match existing profiles by ID, not array index. Index-based matching breaks
  // when profiles are deleted or reordered — the wrong key gets preserved.
  const existingById = new Map(existing.profiles.map((p) => [p.id, p]));
  return {
    ...incoming,
    profiles: incoming.profiles.map((profile) => {
      const ex = existingById.get(profile.id);
      if (!ex) return profile;
      const ps = profile.providerSettings;
      const eps = ex.providerSettings;
      return {
        ...profile,
        providerSettings: {
          tts: {
            ...ps.tts,
            minimax: ps.tts.minimax && eps.tts.minimax
              ? {
                ...ps.tts.minimax,
                apiKey: ps.tts.minimax.apiKey.includes(MASK)
                  ? eps.tts.minimax.apiKey
                  : ps.tts.minimax.apiKey,
              }
              : ps.tts.minimax,
            elevenlabs: ps.tts.elevenlabs && eps.tts.elevenlabs
              ? {
                ...ps.tts.elevenlabs,
                apiKey: ps.tts.elevenlabs.apiKey.includes(MASK)
                  ? eps.tts.elevenlabs.apiKey
                  : ps.tts.elevenlabs.apiKey,
              }
              : ps.tts.elevenlabs,
            openai: ps.tts.openai && eps.tts.openai
              ? {
                ...ps.tts.openai,
                apiKey: ps.tts.openai.apiKey?.includes(MASK)
                  ? eps.tts.openai.apiKey
                  : ps.tts.openai.apiKey,
              }
              : ps.tts.openai,
            custom: ps.tts.custom && eps.tts.custom
              ? {
                ...ps.tts.custom,
                apiKey: ps.tts.custom.apiKey?.includes(MASK)
                  ? eps.tts.custom.apiKey
                  : ps.tts.custom.apiKey,
              }
              : ps.tts.custom,
          },
          stt: {
            ...ps.stt,
            deepgram: ps.stt.deepgram && eps.stt.deepgram
              ? {
                ...ps.stt.deepgram,
                apiKey: ps.stt.deepgram.apiKey.includes(MASK)
                  ? eps.stt.deepgram.apiKey
                  : ps.stt.deepgram.apiKey,
              }
              : ps.stt.deepgram,
            openai: ps.stt.openai && eps.stt.openai
              ? {
                ...ps.stt.openai,
                apiKey: ps.stt.openai.apiKey?.includes(MASK)
                  ? eps.stt.openai.apiKey
                  : ps.stt.openai.apiKey,
              }
              : ps.stt.openai,
            custom: ps.stt.custom && eps.stt.custom
              ? {
                ...ps.stt.custom,
                apiKey: ps.stt.custom.apiKey?.includes(MASK)
                  ? eps.stt.custom.apiKey
                  : ps.stt.custom.apiKey,
              }
              : ps.stt.custom,
          },
        },
      };
    }),
  };
}

// =============================================================================
// Masking (for safe UI display)
// =============================================================================

function maskProfile(profile: VoiceProfile): VoiceProfile {
  const ps = profile.providerSettings;
  return {
    ...profile,
    providerSettings: {
      tts: {
        ...ps.tts,
        minimax: ps.tts.minimax
          ? {
            ...ps.tts.minimax,
            apiKey: maskApiKey(ps.tts.minimax.apiKey || ""),
          }
          : undefined,
        elevenlabs: ps.tts.elevenlabs
          ? {
            ...ps.tts.elevenlabs,
            apiKey: maskApiKey(ps.tts.elevenlabs.apiKey || ""),
          }
          : undefined,
        openai: ps.tts.openai
          ? { ...ps.tts.openai, apiKey: maskApiKey(ps.tts.openai.apiKey || "") }
          : undefined,
        custom: ps.tts.custom
          ? { ...ps.tts.custom, apiKey: maskApiKey(ps.tts.custom.apiKey || "") }
          : undefined,
      },
      stt: {
        ...ps.stt,
        deepgram: ps.stt.deepgram
          ? {
            ...ps.stt.deepgram,
            apiKey: maskApiKey(ps.stt.deepgram.apiKey || ""),
          }
          : undefined,
        openai: ps.stt.openai
          ? { ...ps.stt.openai, apiKey: maskApiKey(ps.stt.openai.apiKey || "") }
          : undefined,
        custom: ps.stt.custom
          ? { ...ps.stt.custom, apiKey: maskApiKey(ps.stt.custom.apiKey || "") }
          : undefined,
      },
    },
  };
}

export function maskVoiceSettings(settings: VoiceSettings): VoiceSettings {
  return {
    ...settings,
    profiles: settings.profiles.map(maskProfile),
  };
}
