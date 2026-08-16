import { assertEquals, assertStringIncludes } from "@std/assert";
import sharp from "sharp";
import { getDefaultDiscordGatewayConfig } from "../llm/discord-settings.ts";
import type {
  DiscordGatewayClient,
  DiscordMessage,
  GatewayEventHandler,
  GatewayEventType,
} from "./gateway.ts";
import type { ConversationMapper } from "./conversation-map.ts";
import { MessageRouter } from "./router.ts";

Deno.test("Discord router merges delayed Klipy embed proxies without dropping text", async () => {
  const handlers = new Map<GatewayEventType, GatewayEventHandler[]>();
  const gateway = {
    on(event: GatewayEventType, handler: GatewayEventHandler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    getBotUserId: () => "geo-bot",
    getChannels: () =>
      new Map([
        ["channel-1", {
          id: "channel-1",
          name: "images",
          guild_id: "server-1",
          type: 0,
          topic: null,
          parent_id: null,
        }],
      ]),
  } as unknown as DiscordGatewayClient;
  const mapper = {
    getOrCreateConversation: () => Promise.resolve("conversation-1"),
  } as unknown as ConversationMapper;
  const config = getDefaultDiscordGatewayConfig();
  config.servers = [{
    serverId: "server-1",
    serverName: "Test Server",
    channels: [{ channelId: "channel-1", mode: "active", instructions: "" }],
  }];
  config.activeModeTiers.mentionDebounceMs = 25;

  const png = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: { r: 0, g: 255, b: 0 },
    },
  }).webp().toBuffer();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => {
    const isVideo = String(url).endsWith(".mp4");
    return Promise.resolve(
      new Response(
        isVideo ? new Uint8Array([0, 1, 2]).buffer : new Uint8Array(png).buffer,
        {
          headers: {
            "content-type": isVideo ? "video/mp4" : "image/webp",
          },
        },
      ),
    );
  }) as typeof fetch;

  let resolveTurn!: () => void;
  const turnCompleted = new Promise<void>((resolve) => resolveTurn = resolve);
  let receivedText = "";
  let receivedImageCount = 0;
  const router = new MessageRouter({
    gateway,
    config,
    conversationMapper: mapper,
    onTurn(_conversationId, userMessage, context) {
      receivedText = userMessage;
      receivedImageCount = context.visionImages?.length ?? 0;
      resolveTurn();
      return Promise.resolve();
    },
  });

  try {
    router.start();
    const message: DiscordMessage = {
      id: "message-1",
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
      content: "What is in this image?",
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
      attachments: [],
      embeds: [],
    };
    for (const handler of handlers.get("MESSAGE_CREATE") ?? []) {
      handler("MESSAGE_CREATE", message);
    }
    const update = {
      id: message.id,
      channel_id: message.channel_id,
      embeds: [{
        type: "gifv",
        url: "https://klipy.com/gifs/fry-futurama-9",
        video: {
          proxy_url:
            "https://images-ext-1.discordapp.net/external/video/clip.mp4",
        },
        thumbnail: {
          proxy_url:
            "https://images-ext-1.discordapp.net/external/thumb/frame.webp",
        },
      }],
    };
    for (const handler of handlers.get("MESSAGE_UPDATE") ?? []) {
      handler("MESSAGE_UPDATE", update);
    }
    await turnCompleted;

    assertStringIncludes(receivedText, "What is in this image?");
    assertEquals(receivedImageCount, 1);
  } finally {
    router.stop();
    globalThis.fetch = originalFetch;
  }
});
