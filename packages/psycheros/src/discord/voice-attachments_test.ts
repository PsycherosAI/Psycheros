import { assertEquals, assertStringIncludes } from "@std/assert";
import type { VoiceProfile } from "../llm/voice-settings.ts";
import type { DiscordMessage } from "./gateway.ts";
import {
  DISCORD_VOICE_MESSAGE_FLAG,
  MAX_DISCORD_VOICE_BYTES,
  prepareDiscordVoiceTranscript,
} from "./voice-attachments.ts";

function profile(): VoiceProfile {
  return {
    id: "geo",
    enabled: true,
    sttCorrections: [],
    providerSettings: {
      tts: { provider: "elevenlabs" },
      stt: {
        provider: "openai",
        openai: {
          apiKey: "secret",
          baseUrl: "https://api.openai.com/v1",
          model: "whisper-1",
        },
      },
    },
  } as unknown as VoiceProfile;
}

function ogg(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set(new TextEncoder().encode("OggS"), 0);
  bytes.set(new TextEncoder().encode("OpusHead"), 28);
  return bytes;
}

function message(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: "message-1",
    flags: DISCORD_VOICE_MESSAGE_FLAG,
    attachments: [{
      id: "attachment-1",
      filename: "voice-message.ogg",
      size: ogg().length,
      url: "https://cdn.discordapp.com/attachments/voice-message.ogg",
      proxy_url: "https://media.discordapp.net/attachments/voice-message.ogg",
      content_type: "audio/ogg",
      duration_secs: 2.5,
      waveform: "AQID",
    }],
    ...overrides,
  } as DiscordMessage;
}

function audioResponse(bytes = ogg()): Response {
  return new Response(bytes.slice().buffer, {
    headers: { "content-type": "audio/ogg" },
  });
}

Deno.test("Discord native voice note downloads and transcribes encoded Ogg", async () => {
  let received: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const result = await prepareDiscordVoiceTranscript(message(), profile(), {
    fetcher: (() => Promise.resolve(audioResponse())) as typeof fetch,
    transcribe: ((audio) => {
      received = audio;
      return Promise.resolve({ text: "hello GEO" });
    }) as typeof import("../voice/stt.ts").transcribeEncodedAudio,
  });
  assertEquals(result, { kind: "success", transcript: "hello GEO" });
  assertEquals(received, ogg());
});

Deno.test("Discord voice note rejects unsupported audio", async () => {
  const bad = message({
    attachments: [{
      ...message().attachments![0],
      content_type: "audio/mpeg",
    }],
  });
  const result = await prepareDiscordVoiceTranscript(bad, profile());
  assertEquals(result.kind, "failure");
  if (result.kind === "failure") {
    assertStringIncludes(result.marker, "unsupported");
  }
});

Deno.test("Discord voice note rejects declared oversized audio before download", async () => {
  let downloads = 0;
  const oversized = message({
    attachments: [{
      ...message().attachments![0],
      size: MAX_DISCORD_VOICE_BYTES + 1,
    }],
  });
  const result = await prepareDiscordVoiceTranscript(oversized, profile(), {
    fetcher: (() => {
      downloads++;
      return Promise.resolve(audioResponse());
    }) as typeof fetch,
  });
  assertEquals(result.kind, "failure");
  assertEquals(downloads, 0);
});

Deno.test("Discord voice note stops a streamed download at the byte limit", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_DISCORD_VOICE_BYTES));
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  const result = await prepareDiscordVoiceTranscript(message(), profile(), {
    fetcher: (() =>
      Promise.resolve(
        new Response(body, { headers: { "content-type": "audio/ogg" } }),
      )) as typeof fetch,
  });
  assertEquals(result.kind, "failure");
  if (result.kind === "failure") {
    assertStringIncludes(result.marker, "too large");
  }
});

Deno.test("Discord voice note rejects excessive duration before download", async () => {
  let downloads = 0;
  const tooLong = message({
    attachments: [{
      ...message().attachments![0],
      duration_secs: 301,
    }],
  });
  const result = await prepareDiscordVoiceTranscript(tooLong, profile(), {
    fetcher: (() => {
      downloads++;
      return Promise.resolve(audioResponse());
    }) as typeof fetch,
  });
  assertEquals(result.kind, "failure");
  assertEquals(downloads, 0);
});

Deno.test("Discord voice note reports failed download safely", async () => {
  const result = await prepareDiscordVoiceTranscript(message(), profile(), {
    fetcher: (() =>
      Promise.resolve(new Response("no", { status: 403 }))) as typeof fetch,
  });
  assertEquals(result.kind, "failure");
  if (result.kind === "failure") {
    assertStringIncludes(result.marker, "HTTP 403");
  }
});

Deno.test("Discord voice note reports transcription failure safely", async () => {
  const result = await prepareDiscordVoiceTranscript(message(), profile(), {
    fetcher: (() => Promise.resolve(audioResponse())) as typeof fetch,
    transcribe: (() =>
      Promise.reject(
        new Error("provider unavailable"),
      )) as typeof import("../voice/stt.ts").transcribeEncodedAudio,
  });
  assertEquals(result.kind, "failure");
  if (result.kind === "failure") {
    assertStringIncludes(result.marker, "provider unavailable");
  }
});

Deno.test("Discord voice note rejects an empty transcript", async () => {
  const result = await prepareDiscordVoiceTranscript(message(), profile(), {
    fetcher: (() => Promise.resolve(audioResponse())) as typeof fetch,
    transcribe: (() =>
      Promise.resolve({
        text: "   ",
      })) as typeof import("../voice/stt.ts").transcribeEncodedAudio,
  });
  assertEquals(result.kind, "failure");
  if (result.kind === "failure") {
    assertStringIncludes(result.marker, "no recognizable speech");
  }
});

Deno.test("ordinary audio is not treated as a native Discord voice note", async () => {
  const result = await prepareDiscordVoiceTranscript(
    message({ flags: 0, content: "Keep this typed text" }),
    profile(),
  );
  assertEquals(result, { kind: "not_voice" });
});
