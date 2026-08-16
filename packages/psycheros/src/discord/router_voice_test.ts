import { assertEquals, assertStringIncludes } from "@std/assert";
import type { VoiceProfile } from "../llm/voice-settings.ts";
import { getDefaultDiscordGatewayConfig } from "../llm/discord-settings.ts";
import type {
  DiscordGatewayClient,
  DiscordMessage,
  GatewayEventHandler,
  GatewayEventType,
} from "./gateway.ts";
import type { ConversationMapper } from "./conversation-map.ts";
import { MessageRouter } from "./router.ts";
import { DISCORD_VOICE_MESSAGE_FLAG } from "./voice-attachments.ts";

function ogg(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set(new TextEncoder().encode("OggS"), 0);
  bytes.set(new TextEncoder().encode("OpusHead"), 28);
  return bytes;
}

function voiceProfile(): VoiceProfile {
  return {
    id: "geo",
    enabled: true,
    sttCorrections: [],
    providerSettings: {
      stt: {
        provider: "openai",
        openai: {
          apiKey: "x",
          baseUrl: "https://api.openai.com/v1",
          model: "whisper-1",
        },
      },
    },
  } as unknown as VoiceProfile;
}

function discordMessage(
  overrides: Partial<DiscordMessage> = {},
): DiscordMessage {
  return {
    id: "message-voice-1",
    channel_id: "channel-1",
    guild_id: "server-1",
    author: {
      id: "user-1",
      username: "tester",
      discriminator: "0",
      global_name: "Tester",
      bot: false,
    },
    member: null,
    content: "",
    mention_everyone: false,
    mentions: [{
      id: "geo-bot",
      username: "GEO",
      discriminator: "0",
      global_name: "GEO",
      bot: true,
    }],
    mention_roles: [],
    reference: null,
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    type: 0,
    flags: DISCORD_VOICE_MESSAGE_FLAG,
    attachments: [{
      id: "audio-1",
      filename: "voice.ogg",
      size: ogg().length,
      url: "https://cdn.discordapp.com/attachments/voice.ogg",
      content_type: "audio/ogg",
      duration_secs: 2,
    }],
    embeds: [],
    ...overrides,
  };
}

function setup(
  onTurn: (text: string) => void,
  transcript = "hello from voice",
) {
  const handlers = new Map<GatewayEventType, GatewayEventHandler[]>();
  const gateway = {
    on(event: GatewayEventType, handler: GatewayEventHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    off() {},
    getBotUserId: () => "geo-bot",
    getChannels: () => new Map(),
  } as unknown as DiscordGatewayClient;
  const mapper = {
    getOrCreateConversation: () => Promise.resolve("conversation-1"),
  } as unknown as ConversationMapper;
  const config = getDefaultDiscordGatewayConfig();
  config.servers = [{
    serverId: "server-1",
    serverName: "Server",
    channels: [{ channelId: "channel-1", mode: "active", instructions: "" }],
  }];
  config.activeModeTiers.mentionDebounceMs = 5;
  let turns = 0;
  let transcriptions = 0;
  const router = new MessageRouter({
    gateway,
    config,
    conversationMapper: mapper,
    getActiveVoiceProfile: voiceProfile,
    voiceDeps: {
      fetcher: (() =>
        Promise.resolve(
          new Response(ogg().slice().buffer, {
            headers: { "content-type": "audio/ogg" },
          }),
        )) as typeof fetch,
      transcribe: (() => {
        transcriptions++;
        return Promise.resolve({ text: transcript });
      }) as typeof import("../voice/stt.ts").transcribeEncodedAudio,
    },
    onTurn(_conversationId, text) {
      turns++;
      onTurn(text);
      return Promise.resolve();
    },
  });
  router.start();
  return {
    router,
    emit(message: DiscordMessage) {
      for (const handler of handlers.get("MESSAGE_CREATE") ?? []) {
        handler("MESSAGE_CREATE", message);
      }
    },
    emitUpdate(
      update: Partial<DiscordMessage> & { id: string; channel_id: string },
    ) {
      for (const handler of handlers.get("MESSAGE_UPDATE") ?? []) {
        handler("MESSAGE_UPDATE", update);
      }
    },
    counts: () => ({ turns, transcriptions }),
  };
}

Deno.test("Discord router transcribes one native voice note and deduplicates retries", async () => {
  let received = "";
  const test = setup((text) => received = text);
  try {
    const message = discordMessage();
    test.emit(message);
    test.emit(message);
    await new Promise((resolve) => setTimeout(resolve, 40));
    test.emitUpdate({
      id: message.id,
      channel_id: message.channel_id,
      attachments: message.attachments,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertStringIncludes(
      received,
      "[Discord voice message transcript]\nhello from voice",
    );
    assertEquals(test.counts(), { turns: 1, transcriptions: 1 });
  } finally {
    test.router.stop();
  }
});

Deno.test("Discord router preserves typed text on ordinary audio", async () => {
  let received = "";
  const test = setup((text) => received = text);
  try {
    test.emit(discordMessage({
      id: "ordinary-audio",
      flags: 0,
      content: "Keep my typed question",
      attachments: [{
        ...discordMessage().attachments![0],
        content_type: "audio/mpeg",
        filename: "song.mp3",
      }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assertStringIncludes(received, "Keep my typed question");
    assertEquals(test.counts(), { turns: 1, transcriptions: 0 });
  } finally {
    test.router.stop();
  }
});

Deno.test("Discord router passes a safe marker for empty transcription", async () => {
  let received = "";
  const test = setup((text) => received = text, "");
  try {
    test.emit(discordMessage({ id: "empty-voice" }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assertStringIncludes(received, "could not be transcribed");
    assertStringIncludes(received, "Please let the sender know kindly");
  } finally {
    test.router.stop();
  }
});
