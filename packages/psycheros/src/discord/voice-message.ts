const OGG_CAPTURE = [0x4f, 0x67, 0x67, 0x53];

export interface DiscordVoiceMetadata {
  durationSecs: number;
  waveform: string;
}

function isCapture(bytes: Uint8Array, offset: number): boolean {
  return OGG_CAPTURE.every((value, index) => bytes[offset + index] === value);
}

/** Read enough Ogg Opus metadata for Discord's native voice-message payload. */
export function inspectOggOpus(audio: Uint8Array): DiscordVoiceMetadata {
  let offset = 0;
  let lastGranule = 0;
  let preSkip = 0;
  const pageSizes: number[] = [];

  while (offset + 27 <= audio.length) {
    if (!isCapture(audio, offset)) {
      throw new Error("ElevenLabs response is not an Ogg stream");
    }
    const view = new DataView(audio.buffer, audio.byteOffset + offset);
    const low = view.getUint32(6, true);
    const high = view.getUint32(10, true);
    const granule = high * 0x1_0000_0000 + low;
    if (Number.isSafeInteger(granule)) {
      lastGranule = Math.max(lastGranule, granule);
    }

    const segmentCount = audio[offset + 26];
    if (offset + 27 + segmentCount > audio.length) {
      throw new Error("ElevenLabs returned a truncated Ogg page");
    }
    let payloadSize = 0;
    for (let i = 0; i < segmentCount; i++) {
      payloadSize += audio[offset + 27 + i];
    }
    const payloadOffset = offset + 27 + segmentCount;
    const pageEnd = payloadOffset + payloadSize;
    if (pageEnd > audio.length) {
      throw new Error("ElevenLabs returned truncated Ogg audio");
    }

    if (
      payloadSize >= 12 &&
      new TextDecoder().decode(
          audio.subarray(payloadOffset, payloadOffset + 8),
        ) === "OpusHead"
    ) {
      preSkip = audio[payloadOffset + 10] | (audio[payloadOffset + 11] << 8);
    }
    if (payloadSize > 0) pageSizes.push(payloadSize);
    offset = pageEnd;
  }

  if (offset !== audio.length || lastGranule <= preSkip) {
    throw new Error("ElevenLabs response did not contain complete Opus audio");
  }
  const durationSecs = (lastGranule - preSkip) / 48_000;
  const maxPage = Math.max(...pageSizes, 1);
  const samples = pageSizes.slice(-256).map((size) =>
    Math.max(1, Math.min(255, Math.round((size / maxPage) * 255)))
  );
  return {
    durationSecs,
    waveform: encodeBase64(Uint8Array.from(samples.length ? samples : [128])),
  };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function discordNonce(toolCallId: string, suffix = "v"): string {
  const cleaned = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "");
  return `${suffix}-${cleaned}`.slice(0, 25);
}
