import type { VoiceProfile } from "../llm/voice-settings.ts";
import { applySTTCorrections } from "../voice/pronunciation.ts";
import { transcribeEncodedAudio } from "../voice/stt.ts";
import type { DiscordMessage } from "./gateway.ts";

export const DISCORD_VOICE_MESSAGE_FLAG = 1 << 13;
export const MAX_DISCORD_VOICE_BYTES = 10 * 1024 * 1024;
export const MAX_DISCORD_VOICE_DURATION_SECS = 5 * 60;
export const DISCORD_VOICE_DOWNLOAD_TIMEOUT_MS = 15_000;
export const DISCORD_VOICE_STT_TIMEOUT_MS = 60_000;

const ALLOWED_AUDIO_TYPES = new Set(["audio/ogg", "audio/opus"]);
const ALLOWED_AUDIO_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

export type DiscordVoiceResult =
  | { kind: "not_voice" }
  | { kind: "success"; transcript: string }
  | { kind: "failure"; marker: string };

export interface DiscordVoiceDeps {
  fetcher?: typeof fetch;
  transcribe?: typeof transcribeEncodedAudio;
  downloadTimeoutMs?: number;
  transcriptionTimeoutMs?: number;
}

function normalizedType(value?: string): string {
  return value?.split(";", 1)[0].trim().toLowerCase() ?? "";
}

function assertDiscordAudioUrl(rawUrl: string): void {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    !ALLOWED_AUDIO_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error("the recording URL is not an allowed Discord media URL");
  }
}

async function readLimitedAudio(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_DISCORD_VOICE_BYTES
  ) {
    throw new Error("the recording is too large");
  }
  if (!response.body) throw new Error("the recording download was empty");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_DISCORD_VOICE_BYTES) {
      await reader.cancel();
      throw new Error("the recording is too large");
    }
    chunks.push(value);
  }
  if (total === 0) throw new Error("the recording download was empty");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function assertOggOpus(bytes: Uint8Array): void {
  const capture = new TextDecoder().decode(bytes.subarray(0, 4));
  const headerWindow = new TextDecoder().decode(bytes.subarray(0, 256));
  if (capture !== "OggS" || !headerWindow.includes("OpusHead")) {
    throw new Error("the recording is not valid Ogg Opus audio");
  }
}

function timeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds);
}

function failureMarker(reason: string): DiscordVoiceResult {
  return {
    kind: "failure",
    marker:
      `[Discord voice message could not be transcribed: ${reason}. Please let the sender know kindly.]`,
  };
}

/** Download and transcribe one native Discord voice note entirely in memory. */
export async function prepareDiscordVoiceTranscript(
  message: Pick<DiscordMessage, "id" | "flags" | "attachments">,
  profile: VoiceProfile | undefined,
  deps: DiscordVoiceDeps = {},
): Promise<DiscordVoiceResult> {
  if (((message.flags ?? 0) & DISCORD_VOICE_MESSAGE_FLAG) === 0) {
    return { kind: "not_voice" };
  }

  try {
    const attachments = message.attachments ?? [];
    if (attachments.length !== 1) {
      throw new Error("Discord did not provide exactly one recording");
    }
    const attachment = attachments[0];
    const mediaType = normalizedType(attachment.content_type);
    if (!ALLOWED_AUDIO_TYPES.has(mediaType)) {
      throw new Error("the recording format is unsupported");
    }
    if (
      !Number.isFinite(attachment.duration_secs) ||
      (attachment.duration_secs ?? 0) <= 0 ||
      attachment.duration_secs! > MAX_DISCORD_VOICE_DURATION_SECS
    ) {
      throw new Error("the recording duration is invalid or too long");
    }
    if (attachment.size > MAX_DISCORD_VOICE_BYTES) {
      throw new Error("the recording is too large");
    }
    if (!profile?.enabled) {
      throw new Error("my active voice profile is unavailable");
    }
    if (profile.providerSettings.stt.provider === "browser") {
      throw new Error("my active speech recognition is browser-only");
    }

    const sourceUrl = attachment.proxy_url ?? attachment.url;
    assertDiscordAudioUrl(sourceUrl);
    const fetcher = deps.fetcher ?? fetch;
    console.log(
      `[DiscordVoiceIn] Download begins: message=${message.id}, declaredBytes=${attachment.size}, duration=${attachment.duration_secs}s`,
    );
    const response = await fetcher(sourceUrl, {
      redirect: "follow",
      signal: timeoutSignal(
        deps.downloadTimeoutMs ?? DISCORD_VOICE_DOWNLOAD_TIMEOUT_MS,
      ),
    });
    if (response.url) assertDiscordAudioUrl(response.url);
    if (!response.ok) {
      throw new Error(
        `the recording download returned HTTP ${response.status}`,
      );
    }
    const responseType = normalizedType(
      response.headers.get("content-type") ?? undefined,
    );
    if (responseType && !ALLOWED_AUDIO_TYPES.has(responseType)) {
      throw new Error("the downloaded recording format is unsupported");
    }
    const bytes = await readLimitedAudio(response);
    assertOggOpus(bytes);

    const transcribe = deps.transcribe ?? transcribeEncodedAudio;
    console.log(
      `[DiscordVoiceIn] Transcription begins: message=${message.id}, bytes=${bytes.length}, provider=${profile.providerSettings.stt.provider}`,
    );
    const result = await transcribe(
      bytes,
      { mediaType: "audio/ogg", filename: "discord-voice-message.ogg" },
      profile,
      {
        signal: timeoutSignal(
          deps.transcriptionTimeoutMs ?? DISCORD_VOICE_STT_TIMEOUT_MS,
        ),
      },
    );
    const transcript = applySTTCorrections(result.text.trim(), profile);
    if (!transcript) {
      throw new Error("the recording contained no recognizable speech");
    }
    console.log(
      `[DiscordVoiceIn] Transcription succeeded: message=${message.id}, characters=${transcript.length}`,
    );
    return { kind: "success", transcript };
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === "TimeoutError"
        ? "processing timed out"
        : error instanceof Error
        ? error.message
        : "an unexpected error occurred";
    console.error(
      `[DiscordVoiceIn] Processing failed: message=${message.id}, reason=${reason}`,
    );
    return failureMarker(reason);
  }
}
