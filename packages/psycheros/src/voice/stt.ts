/**
 * Speech-to-text provider implementations for the walkie-talkie pipeline.
 *
 * Browser-native STT (the `browser` provider) is handled entirely in the
 * browser via the Web Speech API — text arrives over the WebSocket as
 * `{ type: "transcript", text }` messages and never touches this module.
 *
 * Server-side providers (deepgram, openai, custom) take a PCM audio buffer
 * and return transcribed text. The PCM is wrapped in a minimal WAV header
 * so providers that expect a file upload can parse it.
 */

import type {
  CustomSTTSettings,
  DeepgramSTTSettings,
  OpenAISTTSettings,
  VoiceProfile,
} from "../llm/voice-settings.ts";
import { isMaskedApiKey } from "../llm/voice-settings.ts";

function ensureRealKey(provider: string, key: string | undefined): void {
  if (isMaskedApiKey(key)) {
    throw new Error(
      `${provider} API key looks masked ("${key}"). Re-enter the real key ` +
        "in Settings → Voice to fix this.",
    );
  }
}

/** Raw 16kHz mono Int16 PCM samples as bytes (little-endian). */
export type PCM16Audio = Uint8Array;

export interface TranscriptionResult {
  text: string;
  /** Confidence if the provider returns one, otherwise undefined. */
  confidence?: number;
}

/**
 * Wrap raw Int16 16kHz mono PCM in a 44-byte WAV header so it can be sent
 * as a file upload to providers that expect one (OpenAI, Whisper servers).
 */
export function pcm16ToWav(pcm: PCM16Audio): Uint8Array {
  const numChannels = 1;
  const sampleRate = 16000;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.byteLength;
  const bufferSize = 44 + dataSize;
  const out = new Uint8Array(bufferSize);
  const view = new DataView(out.buffer);

  // RIFF header
  view.setUint32(0, 0x52494646, false); // "RIFF" (big-endian tag)
  view.setUint32(4, 36 + dataSize, true); // file size minus 8
  view.setUint32(8, 0x57415645, false); // "WAVE"

  // fmt chunk
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataSize, true);
  out.set(pcm, 44);

  return out;
}

/**
 * Ensure a Uint8Array is backed by a regular ArrayBuffer (not a
 * SharedArrayBuffer). Required because Deno's BodyInit / BlobPart types
 * reject `Uint8Array<ArrayBufferLike>` even though at runtime any
 * Uint8Array works fine.
 */
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function transcribeDeepgram(
  audio: Uint8Array,
  settings: DeepgramSTTSettings,
  boostWords: string[],
): Promise<TranscriptionResult> {
  ensureRealKey("Deepgram STT", settings.apiKey);
  const params = new URLSearchParams({
    model: settings.model || "nova-3",
    smart_format: "true",
  });
  if (settings.language) params.set("language", settings.language);
  if (boostWords.length) params.set("keywords", boostWords.join(","));

  const resp = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: {
      "Authorization": `Token ${settings.apiKey}`,
      "Content-Type": "audio/wav",
    },
    body: asArrayBuffer(audio),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Deepgram HTTP ${resp.status}: ${detail.slice(0, 200)}`);
  }

  const body = await resp.json() as {
    results?: {
      channels?: Array<{
        alternatives?: Array<{ transcript?: string; confidence?: number }>;
      }>;
    };
  };
  const alt = body.results?.channels?.[0]?.alternatives?.[0];
  if (!alt?.transcript) return { text: "" };
  return { text: alt.transcript.trim(), confidence: alt.confidence };
}

async function transcribeOpenAICompatible(
  audio: Uint8Array,
  settings: OpenAISTTSettings | CustomSTTSettings,
): Promise<TranscriptionResult> {
  ensureRealKey("STT", settings.apiKey);
  const baseUrl = settings.baseUrl.replace(/\/+$/, "");
  const form = new FormData();
  const file = new Blob([asArrayBuffer(audio)], { type: "audio/wav" });
  form.append("file", file, "voice.wav");
  form.append("model", settings.model);
  if (settings.language) form.append("language", settings.language);

  const headers: Record<string, string> = {};
  if (settings.apiKey) headers["Authorization"] = `Bearer ${settings.apiKey}`;

  const resp = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers,
    body: form,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`STT HTTP ${resp.status}: ${detail.slice(0, 200)}`);
  }

  const body = await resp.json() as { text?: string };
  return { text: (body.text ?? "").trim() };
}

/**
 * Transcribe an audio buffer using the profile's STT provider.
 * Returns empty text on empty/failed transcription — callers should
 * skip the LLM turn in that case.
 *
 * Provider selection comes from `profile.providerSettings.stt.provider`.
 * The `browser` provider never reaches this function — text arrives
 * pre-transcribed from the browser via a separate code path.
 */
export async function transcribe(
  audio: Uint8Array,
  profile: VoiceProfile,
): Promise<TranscriptionResult> {
  const wav = pcm16ToWav(audio);
  const stt = profile.providerSettings.stt;
  const boostWords = profile.sttCorrections
    ?.map((c) => c.correct)
    .filter((s) => s && !s.includes(" ")) ?? [];

  if (stt.provider === "deepgram") {
    if (!stt.deepgram) throw new Error("Deepgram STT settings missing");
    return transcribeDeepgram(wav, stt.deepgram, boostWords);
  }

  if (stt.provider === "openai") {
    if (!stt.openai) throw new Error("OpenAI STT settings missing");
    return transcribeOpenAICompatible(wav, stt.openai);
  }

  if (stt.provider === "custom") {
    if (!stt.custom) throw new Error("Custom STT settings missing");
    return transcribeOpenAICompatible(wav, stt.custom);
  }

  throw new Error(`Unsupported server-side STT provider: ${stt.provider}`);
}
