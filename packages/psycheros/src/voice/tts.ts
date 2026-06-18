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
 *   Auth is `xi-api-key` (NOT `Authorization: Bearer` — ElevenLabs rejects
 *   Bearer with "Provided authorization header was invalid").
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
import { MPEGDecoder } from "mpg123-decoder";

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
 * Re-emit chunks with guaranteed even byte length so consumers can safely
 * construct Int16Array views. Odd bytes from upstream are carried into the
 * next chunk as `leftover`. Provider chunk boundaries are not sample-aligned
 * — HTTP/2 framing can split a 2-byte Int16 sample across two chunks, and
 * treating each chunk independently turns the second half into static.
 * Final trailing odd byte is zero-padded so the stream ends cleanly.
 */
async function* alignChunks(
  source: AsyncGenerator<PCMAudioChunk> | ReadableStream<Uint8Array>,
): AsyncGenerator<PCMAudioChunk> {
  let leftover = new Uint8Array(0);
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array) || chunk.length === 0) continue;
    const combined = new Uint8Array(leftover.length + chunk.length);
    combined.set(leftover);
    combined.set(chunk, leftover.length);
    const evenLength = combined.length - (combined.length % 2);
    if (evenLength < 2) {
      leftover = combined;
      continue;
    }
    leftover = combined.slice(evenLength);
    yield combined.slice(0, evenLength);
  }
  if (leftover.length === 1) {
    const padded = new Uint8Array(2);
    padded.set(leftover);
    yield padded;
  } else if (leftover.length >= 2) {
    yield leftover;
  }
}

// ===========================================================================
// Format detection + decoding for the custom OpenAI-compatible path.
//
// Third-party "OpenAI-compatible" TTS servers (PocketTTS, Kokoro, etc.)
// routinely IGNORE `response_format: "pcm"` and return MP3 or WAV instead.
// Without detection, those bytes get played as raw PCM and the user hears
// static. The user shouldn't have to write a translation layer.
//
// Detection: magic bytes first (most reliable), then Content-Type, then
// default to raw PCM (preserves the existing fast path for spec-compliant
// servers). MP3 decoding uses mpg123-decoder (WASM, ~77 KB, libmpg123
// reference decoder). WAV is parsed inline — header tells us sample rate
// and channels so we don't assume.
// ===========================================================================

type DetectedAudioFormat = "pcm" | "wav" | "mp3";

/**
 * Identify the audio container from the first non-empty chunk + Content-Type.
 * Magic bytes win over Content-Type (some servers send `application/json`
 * even for binary bodies — yes really).
 */
function detectAudioFormat(
  contentType: string | null,
  head: Uint8Array,
): DetectedAudioFormat {
  // Need at least 12 bytes for RIFF....WAVE; 4 for ID3 + frame sync.
  if (head.length >= 4) {
    // WAV: "RIFF"...."WAVE"
    if (
      head.length >= 12 &&
      head[0] === 0x52 && head[1] === 0x49 &&
      head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x41 &&
      head[10] === 0x56 && head[11] === 0x45
    ) {
      return "wav";
    }
    // MP3: "ID3" tag header (v2) OR MPEG frame sync (0xFF followed by
    // 0xE+ — version+layer bits in upper 3 bits).
    if (
      head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33
    ) {
      return "mp3";
    }
    if (head[0] === 0xFF && (head[1] & 0xE0) === 0xE0) {
      return "mp3";
    }
  }
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("mpeg") || ct.includes("mp3")) return "mp3";
  if (ct.includes("wav") || ct.includes("wave") || ct.includes("x-wav")) {
    return "wav";
  }
  // Default: raw PCM (existing streaming behavior).
  return "pcm";
}

/**
 * Parse a WAV container and return mono Int16 PCM samples + the source sample
 * rate. Walks chunks to find fmt + data (handles LIST/INFO chunks between
 * them). Supports 16-bit signed PCM only — that's what TTS servers return.
 * Stereo input is downmixed to mono.
 */
function parseWav(
  buffer: Uint8Array,
): { samples: Int16Array; sampleRate: number } {
  if (buffer.length < 44) {
    throw new Error(`WAV too short (${buffer.length} bytes)`);
  }
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  let offset = 12; // skip RIFF header
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      if (offset + 24 > buffer.length) break;
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataLength = Math.min(size, buffer.length - dataOffset);
      break;
    }
    // Chunks are word-aligned (padded to even length).
    offset += 8 + size + (size % 2);
  }
  if (!sampleRate || !dataOffset) {
    throw new Error("WAV missing fmt or data chunk");
  }
  if (bitsPerSample !== 16) {
    throw new Error(
      `WAV unsupported bit depth: ${bitsPerSample} (only 16-bit supported)`,
    );
  }
  if (channels < 1 || channels > 2) {
    throw new Error(`WAV unsupported channel count: ${channels}`);
  }
  const sampleCount = Math.floor(dataLength / 2);
  const interleaved = new Int16Array(
    buffer.buffer,
    buffer.byteOffset + dataOffset,
    sampleCount,
  );
  if (channels === 1) {
    // Copy out so callers don't hold the full body buffer alive.
    return { samples: interleaved.slice(), sampleRate };
  }
  // Stereo → mono downmix.
  const mono = new Int16Array(Math.floor(sampleCount / 2));
  for (let i = 0, j = 0; i < mono.length; i++, j += 2) {
    const mixed = (interleaved[j] + interleaved[j + 1]) * 0.5;
    mono[i] = Math.max(-32768, Math.min(32767, Math.round(mixed)));
  }
  return { samples: mono, sampleRate };
}

/**
 * Module-level MPEGDecoder singleton. WASM compile is ~50ms one-time; keep
 * the instance alive across TTS calls. The decoder caches prior frame state
 * for the MP3 bit reservoir, so `reset()` between unrelated streams is
 * mandatory (called in decodeMp3).
 */
let mp3DecoderInstance: MPEGDecoder | null = null;
let mp3DecoderInitPromise: Promise<MPEGDecoder> | null = null;

async function getMp3Decoder(): Promise<MPEGDecoder> {
  if (mp3DecoderInstance) return mp3DecoderInstance;
  if (!mp3DecoderInitPromise) {
    mp3DecoderInitPromise = (async () => {
      const dec = new MPEGDecoder();
      await dec.ready;
      mp3DecoderInstance = dec;
      return dec;
    })();
  }
  return mp3DecoderInitPromise;
}

/**
 * Decode a complete MP3 byte buffer to mono Int16 PCM. mpg123-decoder returns
 * Float32 planar samples at the MP3's native sample rate (usually 24kHz for
 * TTS, but we trust whatever the decoder reports). Caller resamples to 16kHz.
 */
async function decodeMp3(
  bytes: Uint8Array,
): Promise<{ samples: Int16Array; sampleRate: number }> {
  const decoder = await getMp3Decoder();
  await decoder.reset();
  const decoded = decoder.decode(bytes);
  if (!decoded || !decoded.channelData || !decoded.channelData.length) {
    throw new Error("MP3 decoder returned no samples");
  }
  const left = decoded.channelData[0];
  const right = decoded.channelData[1];
  const out = new Int16Array(left.length);
  if (right) {
    for (let i = 0; i < left.length; i++) {
      const m = (left[i] + right[i]) * 0.5;
      out[i] = Math.max(-1, Math.min(1, m)) * 0x7FFF;
    }
  } else {
    for (let i = 0; i < left.length; i++) {
      out[i] = Math.max(-1, Math.min(1, left[i])) * 0x7FFF;
    }
  }
  return { samples: out, sampleRate: decoded.sampleRate };
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

  yield* alignChunks((async function* () {
    for await (const chunk of resp.body!) {
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
  })());
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
        "xi-api-key": settings.apiKey,
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
    // 404 is almost always a voice_id that doesn't exist on the calling
    // account. Surface the suffix + model so users self-diagnose instead of
    // pasting bare "404" into a bug report.
    if (resp.status === 404) {
      const v = settings.voiceId || "(none)";
      const vSuffix = v.length > 4 ? v.slice(-4) : v;
      msg += ` — voiceId ends "${vSuffix}", model="${
        settings.model || "(default)"
      }". 404 usually means the voice ID isn't on this account.`;
    }
    throw new Error(msg);
  }

  if (!resp.body) throw new Error("ElevenLabs response body is null");
  // ElevenLabs streams raw PCM_16000 bytes; chunk boundaries are HTTP-framed
  // and can split Int16 samples. Align before yielding.
  yield* alignChunks(resp.body);
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
    // For custom OpenAI-compatible servers, 404 usually means the baseUrl
    // doesn't expose /audio/speech (some servers put it under /v1/ or use
    // a different route entirely). Surface what we hit so the user can
    // spot the mismatch in logs.
    if (resp.status === 404) {
      msg +=
        ` — POST ${baseUrl}/audio/speech not found. Check baseUrl (some servers want /v1, custom routes, or an adapter).`;
    }
    throw new Error(msg);
  }

  if (!resp.body) throw new Error("TTS response body is null");

  // We request `response_format: "pcm"` for low-latency streaming. Most
  // spec-compliant servers honor it and return raw 24kHz Int16 PCM that we
  // can stream+resample on the fly. But many "OpenAI-compatible" servers
  // (PocketTTS, Kokoro, etc.) ignore the parameter and return MP3 or WAV
  // instead. Detect on the first chunk and switch paths accordingly.
  //
  // MP3/WAV can't be played by streaming chunks — they have headers + (for
  // MP3) a bit reservoir that requires the whole file. So those paths
  // buffer the entire body and decode at the end. The latency hit is real
  // (a sentence-length decode is ~50-100ms on top of the network wait), but
  // it's better than static, and the walkie-talkie model tolerates it.
  const contentType = resp.headers.get("Content-Type");
  let format: DetectedAudioFormat | null = null;
  let leftover = new Uint8Array(0);
  const buffered: Uint8Array[] = [];
  let bufferedTotal = 0;

  for await (const chunk of resp.body) {
    if (!(chunk instanceof Uint8Array) || chunk.length === 0) continue;
    if (format === null) {
      format = detectAudioFormat(contentType, chunk);
      if (format !== "pcm") {
        console.log(
          `[Voice:tts] Custom server returned ${format} ` +
            `(requested pcm) — decoding transparently. Content-Type: ${
              contentType || "(none)"
            }`,
        );
      }
    }
    if (format !== "pcm") {
      buffered.push(chunk);
      bufferedTotal += chunk.length;
      continue;
    }
    // Raw PCM streaming path (existing behavior): byte-align chunks and
    // resample 24kHz → 16kHz on the fly.
    const combined = new Uint8Array(leftover.length + chunk.length);
    combined.set(leftover);
    combined.set(chunk, leftover.length);
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

  // Raw PCM final flush.
  if (format === "pcm") {
    if (leftover.length >= 2) {
      const samples = int16BytesToView(leftover);
      const resampled = resamplePcm16(samples, 24000, TARGET_SAMPLE_RATE);
      yield viewToInt16Bytes(resampled);
    }
    return;
  }

  // No data arrived at all — common when a server accepts /audio/speech
  // but returns 200 with an empty body (Pocket's wrapper did this).
  if (format === null || bufferedTotal === 0) {
    throw new Error(
      "TTS returned 200 OK but empty body — server may not support this request shape. " +
        `Try a different response_format or check that ${baseUrl}/audio/speech is correct.`,
    );
  }

  // Combine buffered chunks for whole-file decode.
  const body = new Uint8Array(bufferedTotal);
  let offset = 0;
  for (const c of buffered) {
    body.set(c, offset);
    offset += c.length;
  }

  if (format === "wav") {
    const { samples, sampleRate } = parseWav(body);
    const resampled = resamplePcm16(samples, sampleRate, TARGET_SAMPLE_RATE);
    yield viewToInt16Bytes(resampled);
    return;
  }

  // format === "mp3"
  const { samples, sampleRate } = await decodeMp3(body);
  const resampled = resamplePcm16(samples, sampleRate, TARGET_SAMPLE_RATE);
  yield viewToInt16Bytes(resampled);
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
