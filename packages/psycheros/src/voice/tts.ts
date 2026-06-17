/**
 * Streaming TTS provider implementations for the walkie-talkie pipeline.
 *
 * Each provider function is an async generator that yields Int16 PCM 16kHz
 * mono bytes as they arrive from the upstream API. The session manager
 * forwards these binary frames directly to the browser, which already has
 * a 16kHz PCM playback queue wired up (see `web/js/voice.js`).
 *
 * All providers are coerced to Int16 PCM 16kHz:
 * - MiniMax: request `format: "pcm"`, `sample_rate: 16000`, parse SSE hex
 *   chunks. Ported from `FixedMiniMaxTTSService` in the shelved
 *   `pipecat-shelved/bot.py` (the buffer_remaining bug fix lives here too —
 *   we process whatever's left in the buffer after the stream ends).
 * - ElevenLabs: request `output_format: "pcm_16000"`, stream raw bytes.
 * - OpenAI / custom: request `response_format: "pcm"`, stream raw bytes,
 *   resample from 24kHz to 16kHz.
 *
 * The non-streaming test endpoint (`callTTS` in `routes.ts`) is separate
 * and unchanged — it keeps using MP3 because it returns a single blob for
 * a one-shot play, where MP3's smaller payload is worth the decode cost.
 */

import type {
  CustomTTSSettings,
  ElevenLabsTTSSettings,
  MinimaxTTSSettings,
  OpenAITTSSettings,
  VoiceProfile,
} from "../llm/voice-settings.ts";
import { isMaskedApiKey } from "../llm/voice-settings.ts";

const TARGET_SAMPLE_RATE = 16000;

export type PCMAudioChunk = Uint8Array;

/**
 * Throw a clear error if the API key looks masked. Masked keys (containing
 * U+2022 bullet characters) aren't valid HTTP ByteString values, so without
 * this check the fetch fails with a cryptic "Failed to construct 'Request'"
 * error. This usually means an older version of the daemon persisted the
 * masked display value instead of the real key.
 */
function ensureRealKey(provider: string, key: string | undefined): void {
  if (isMaskedApiKey(key)) {
    throw new Error(
      `${provider} API key looks masked ("${key}"). Re-enter the real key ` +
        "in Settings → Voice to fix this.",
    );
  }
}

/**
 * Linear-interpolation resample from `srcRate` Int16 PCM to 16kHz Int16 PCM.
 * Good enough for voice — not audiophile quality, but cheap and correct.
 */
export function resamplePcm16(
  pcm: Int16Array,
  srcRate: number,
  dstRate: number,
): Int16Array {
  if (srcRate === dstRate) return pcm;
  const ratio = srcRate / dstRate;
  const outLength = Math.floor(pcm.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const frac = srcPos - i0;
    const s0 = pcm[i0];
    const s1 = pcm[i1];
    const value = s0 + (s1 - s0) * frac;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(value)));
  }
  return out;
}

function int16BytesToView(bytes: Uint8Array): Int16Array {
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

function viewToInt16Bytes(view: Int16Array): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/**
 * Parse MiniMax SSE chunks. Each `data:` block contains JSON with hex-encoded
 * PCM in `data.audio`. Skip `extra_info` blocks. Flush whatever remains in
 * the buffer after the stream ends — this is the buffer_remaining bug from
 * the shelved Pipecat code.
 */
async function* streamMinimax(
  text: string,
  settings: MinimaxTTSSettings,
): AsyncGenerator<PCMAudioChunk> {
  ensureRealKey("Minimax TTS", settings.apiKey);
  const resp = await fetch("https://api.minimax.io/v1/t2a_v2", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: settings.model || "speech-2.8-hd",
      text,
      stream: true,
      output_format: "hex",
      voice_setting: {
        voice_id: settings.voiceId,
        speed: 1,
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: TARGET_SAMPLE_RATE,
        bitrate: 128000,
        format: "pcm",
        channel: 1,
      },
    }),
  });

  if (!resp.ok) {
    let msg = `MiniMax HTTP ${resp.status}`;
    try {
      const body = await resp.json() as Record<string, unknown>;
      const baseResp = body.base_resp as Record<string, unknown> | undefined;
      if (baseResp?.status_msg) msg = String(baseResp.status_msg);
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  if (!resp.body) throw new Error("MiniMax response body is null");

  const decoder = new TextDecoder();
  let buffer = new Uint8Array(0);
  let dataBlocksFound = 0;

  const parseDataBlock = (data: Uint8Array): Uint8Array | null => {
    const text = decoder.decode(data).trim();
    const jsonStr = text.startsWith("data:") ? text.slice(5).trim() : text;
    if (!jsonStr) return null;
    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      if ("extra_info" in parsed) return null;
      const chunkData = parsed.data as Record<string, unknown> | undefined;
      const hex = chunkData?.audio as string | undefined;
      if (!hex) return null;
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
      }
      return bytes;
    } catch {
      return null;
    }
  };

  for await (const chunk of resp.body) {
    const newBuffer = new Uint8Array(buffer.length + chunk.length);
    newBuffer.set(buffer);
    newBuffer.set(chunk, buffer.length);
    buffer = newBuffer;

    while (true) {
      const start = buffer.findIndex((b, i) =>
        i + 4 < buffer.length &&
        b === 0x64 && buffer[i + 1] === 0x61 &&
        buffer[i + 2] === 0x74 && buffer[i + 3] === 0x61 &&
        buffer[i + 4] === 0x3a
      );
      if (start === -1) break;
      const nextStart = buffer.findIndex((b, i) =>
        i > start + 5 && i + 4 < buffer.length &&
        b === 0x64 && buffer[i + 1] === 0x61 &&
        buffer[i + 2] === 0x74 && buffer[i + 3] === 0x61 &&
        buffer[i + 4] === 0x3a
      );
      if (nextStart === -1) {
        if (start > 0) buffer = buffer.slice(start);
        break;
      }
      const dataBlock = buffer.slice(start, nextStart);
      buffer = buffer.slice(nextStart);
      dataBlocksFound++;
      const audio = parseDataBlock(dataBlock);
      if (audio && audio.length) yield audio;
    }
  }

  // Flush remaining buffer (the buffer_remaining fix from FixedMiniMaxTTSService)
  if (buffer.length > 5) {
    dataBlocksFound++;
    const audio = parseDataBlock(buffer);
    if (audio && audio.length) yield audio;
  }

  console.log(
    `[Voice:tts] MiniMax stream done: ${dataBlocksFound} data blocks`,
  );
}

async function* streamElevenLabs(
  text: string,
  settings: ElevenLabsTTSSettings,
): AsyncGenerator<PCMAudioChunk> {
  ensureRealKey("ElevenLabs TTS", settings.apiKey);
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${settings.voiceId}?output_format=pcm_16000`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: settings.model,
        voice_settings: { stability: 0.5, similarity_boost: 0.5 },
      }),
    },
  );

  if (!resp.ok) {
    let msg = `ElevenLabs HTTP ${resp.status}`;
    try {
      const err = await resp.json() as Record<string, unknown>;
      const detail = err.detail as Record<string, unknown> | undefined;
      if (detail?.message) msg = String(detail.message);
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  if (!resp.body) throw new Error("ElevenLabs response body is null");
  for await (const chunk of resp.body) {
    if (chunk instanceof Uint8Array && chunk.length) yield chunk;
  }
}

async function* streamOpenAICompatible(
  text: string,
  settings: OpenAITTSSettings | CustomTTSSettings,
): AsyncGenerator<PCMAudioChunk> {
  ensureRealKey("TTS", settings.apiKey);
  const baseUrl = settings.baseUrl.replace(/\/+$/, "");
  const resp = await fetch(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${settings.apiKey || "not-needed"}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: settings.model,
      input: text,
      voice: settings.voice,
      response_format: "pcm",
    }),
  });

  if (!resp.ok) {
    let msg = `TTS HTTP ${resp.status}`;
    try {
      const err = await resp.json() as { error?: { message?: string } };
      if (err.error?.message) msg = err.error.message;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  if (!resp.body) throw new Error("TTS response body is null");
  // OpenAI returns 24kHz PCM; resample to 16kHz to match the browser's
  // playback queue. We buffer chunks and resample on the fly to keep
  // streaming latency low.
  let leftover = new Uint8Array(0);
  for await (const chunk of resp.body) {
    const combined = new Uint8Array(leftover.length + chunk.length);
    combined.set(leftover);
    combined.set(chunk, leftover.length);
    // Ensure even byte length (Int16 alignment)
    const evenLength = combined.length - (combined.length % 2);
    if (evenLength < 2) {
      leftover = combined;
      continue;
    }
    const usable = combined.slice(0, evenLength);
    leftover = combined.slice(evenLength);
    const samples = int16BytesToView(usable);
    const resampled = resamplePcm16(samples, 24000, TARGET_SAMPLE_RATE);
    yield viewToInt16Bytes(resampled);
  }
  if (leftover.length >= 2) {
    const samples = int16BytesToView(leftover);
    const resampled = resamplePcm16(samples, 24000, TARGET_SAMPLE_RATE);
    yield viewToInt16Bytes(resampled);
  }
}

/**
 * Stream synthesized speech for `text` from the profile's TTS provider.
 * Yields Int16 PCM 16kHz mono bytes suitable for direct playback in the
 * browser (the existing audio queue expects this format).
 */
export async function* streamTTS(
  text: string,
  profile: VoiceProfile,
): AsyncGenerator<PCMAudioChunk> {
  if (!text.trim()) return;
  const tts = profile.providerSettings.tts;

  if (tts.provider === "minimax") {
    if (!tts.minimax) throw new Error("Minimax TTS settings missing");
    yield* streamMinimax(text, tts.minimax);
    return;
  }
  if (tts.provider === "elevenlabs") {
    if (!tts.elevenlabs) throw new Error("ElevenLabs TTS settings missing");
    yield* streamElevenLabs(text, tts.elevenlabs);
    return;
  }
  if (tts.provider === "openai") {
    if (!tts.openai) throw new Error("OpenAI TTS settings missing");
    yield* streamOpenAICompatible(text, tts.openai);
    return;
  }
  if (tts.provider === "custom") {
    if (!tts.custom) throw new Error("Custom TTS settings missing");
    yield* streamOpenAICompatible(text, tts.custom);
    return;
  }
  throw new Error(`Unknown TTS provider: ${tts.provider}`);
}
