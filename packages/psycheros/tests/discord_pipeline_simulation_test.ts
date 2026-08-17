/**
 * End-to-end Discord pipeline simulation — no real Discord, no real LLM.
 *
 * Drives the REAL MessageRouter with a stub gateway, runs the REAL
 * attachment planning and captioning code (stubbed CDN + captioning
 * provider), and exercises the REAL outbound tools (stubbed Discord REST).
 * The point: assert exactly what the entity would see and exactly what
 * would be posted, without configuring a Discord connection.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import sharp from "sharp";
import {
  captionTurnImages,
  downloadTurnImages,
  MessageRouter,
} from "../src/discord/mod.ts";
import type {
  DiscordGatewayClient,
  DiscordMessage,
  RouterDeps,
} from "../src/discord/mod.ts";
import type { CaptioningSettings } from "../src/llm/image-gen-settings.ts";
import { actInDiscordTool } from "../src/tools/discord-action.ts";
import { sendDiscordDmTool } from "../src/tools/send-discord-dm.ts";
import type { ToolContext } from "../src/tools/types.ts";

const KB = 1024;

/** 4×4 white PNG as an ArrayBuffer — Response bodies want BodyInit. */
async function pngBody(): Promise<ArrayBuffer> {
  const buffer = await sharp({
    create: { width: 4, height: 4, channels: 3, background: "#ffffff" },
  }).png().toBuffer();
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}

function attachment(
  id: string,
  filename: string,
  contentType: string | null,
): {
  id: string;
  filename: string;
  content_type: string | null;
  url: string;
  size: number;
} {
  return {
    id,
    filename,
    content_type: contentType,
    url: `https://cdn.discordapp.com/attachments/1/2/${filename}?sig=${id}`,
    size: 100 * KB,
  };
}

function dmMessage(
  messageId: string,
  attachments: ReturnType<typeof attachment>[],
): DiscordMessage {
  return {
    id: messageId,
    channel_id: "dm-1",
    guild_id: null,
    author: { id: "user-1", username: "tester" },
    member: null,
    content: "hey, check these out",
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments,
    reference: null,
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    type: 0,
  } as unknown as DiscordMessage;
}

/** Stub CDN + captioning provider; the ONLY network the pipeline sees. */
function stubMediaFetch(caption: string): typeof fetch {
  return (async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const target = String(url);
    if (target.startsWith("https://cdn.discordapp.com/")) {
      return new Response(await pngBody(), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    if (target.startsWith("https://caption.test/")) {
      return Response.json({
        choices: [{ message: { content: `SHORT: A cat.\nLONG: ${caption}` } }],
      });
    }
    throw new Error(
      `unexpected fetch in simulation: ${target} ${init?.method}`,
    );
  }) as typeof fetch;
}

const CAPTIONING: CaptioningSettings = {
  enabled: true,
  provider: "openrouter",
  openrouter: {
    apiKey: "test-key",
    model: "test-model",
    baseUrl: "https://caption.test/v1",
  },
};

function makeRouter(): {
  router: MessageRouter;
  handlers: Map<string, (event: string, data: unknown) => void>;
  captured: { message: string; imageCount: number }[];
} {
  const handlers = new Map<string, (event: string, data: unknown) => void>();
  const gateway = {
    on: (event: string, handler: (event: string, data: unknown) => void) => {
      handlers.set(event, handler);
    },
    getBotUserId: () => "bot-1",
    getChannels: () => new Map(),
  } as unknown as DiscordGatewayClient;
  const captured: { message: string; imageCount: number }[] = [];
  const router = new MessageRouter({
    gateway,
    config: {
      servers: [],
      blockedBotIds: [],
      respondToEveryoneHere: false,
      debounceWindowMs: 5000,
      maxBufferSize: 50,
      activeModeTiers: { mentionDebounceMs: 5 },
    } as unknown as RouterDeps["config"],
    conversationMapper: {
      isDmUserAllowed: () => true,
      getOrCreateConversation: async () => "conv-1",
    } as unknown as RouterDeps["conversationMapper"],
    onTurn: async (_conversationId, userMessage, context) => {
      captured.push({
        message: userMessage,
        imageCount: context.images?.length ?? 0,
      });
    },
  });
  return { router, handlers, captured };
}

Deno.test("simulation: inbound DM with mixed attachments → entity-visible turn", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubMediaFetch("A ginger cat asleep on a windowsill.");
  const { router, handlers, captured } = makeRouter();
  router.start();
  try {
    handlers.get("MESSAGE_CREATE")!(
      "MESSAGE_CREATE",
      dmMessage("msg-1", [
        attachment("a1", "cat.png", "image/png"),
        attachment("g1", "anim.gif", "image/gif"),
        attachment("v1", "note.ogg", "audio/ogg"),
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    assertEquals(captured.length, 1);
    const turn = captured[0]!;
    // The router's half: markers land in the persisted user message, in
    // attachment order, with the vision image numbered.
    assertStringIncludes(turn.message, "[image 1 attached: cat.png]");
    assertStringIncludes(
      turn.message,
      "[image attached: anim.gif (format not supported)]",
    );
    assertStringIncludes(turn.message, "[file attached: note.ogg (100.0 KB)]");
    assertEquals(turn.imageCount, 1);
    // Uninvolved content is untouched.
    assertStringIncludes(turn.message, "hey, check these out");

    // The server's half for a text-only model: captioning resolves the
    // numbered image into the appended caption block.
    const images = [{
      attachmentId: "a1",
      messageId: "msg-1",
      url: "https://cdn.discordapp.com/attachments/1/2/cat.png?sig=a1",
      filename: "cat.png",
      contentType: "image/png",
      size: 100 * KB,
    }];
    const captionBlock = await captionTurnImages(images, CAPTIONING);
    assertStringIncludes(
      captionBlock,
      "[Image captions — generated by an image captioning service",
    );
    assertStringIncludes(
      captionBlock,
      "[image 1: cat.png] A ginger cat asleep on a windowsill.",
    );

    // And for a vision-capable model: the same numbered image becomes
    // transient pixel parts instead.
    const parts = await downloadTurnImages(images);
    assertEquals(parts.length, 1);
    assertEquals(parts[0]!.type, "image_url");
    assertStringIncludes(parts[0]!.image_url.url, "data:image/png;base64,");
  } finally {
    router.stop();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("simulation: entity replies in-channel with text + image + reaction", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-sim-" });
  await Deno.mkdir(join(root, ".psycheros", "generated-images"), {
    recursive: true,
  });
  await Deno.writeFile(
    join(root, ".psycheros", "generated-images", "art.png"),
    new Uint8Array(await pngBody()),
  );

  const sends: Array<{ url: string; body: FormData | string; method: string }> =
    [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    sends.push({
      url: String(url),
      body: init?.body as FormData | string,
      method: init?.method ?? "GET",
    });
    return new Response(JSON.stringify({ id: "m-out" }), { status: 200 });
  }) as typeof fetch;

  const ctx = {
    toolCallId: "call-1",
    conversationId: "conv-1",
    db: {} as never,
    config: {
      dataRoot: root,
      discordSettings: { botToken: "test-token" },
      discordContext: {
        channelId: "ch-1",
        channelName: "general",
        serverId: null,
        serverName: null,
        channelMode: "active",
        isDM: false,
        senderUsername: "tester",
        senderUserId: "u-1",
      },
    },
  } as unknown as ToolContext;

  try {
    const result = await actInDiscordTool.execute({
      actions: [
        {
          message_id: "msg-1",
          content: "made you this",
          image_path: "generated-images/art.png",
        },
        { message_id: "msg-1", emoji: "💜" },
      ],
    }, ctx);
    assertEquals(result.isError, false);

    // Image action: multipart with threading + idempotency nonce.
    assertEquals(sends[0]!.method, "POST");
    assertEquals(
      sends[0]!.url,
      "https://discord.com/api/v10/channels/ch-1/messages",
    );
    const payload = JSON.parse(
      (sends[0]!.body as FormData).get("payload_json") as string,
    );
    assertEquals(payload.content, "made you this");
    assertEquals(payload.message_reference.message_id, "msg-1");
    assertEquals(payload.enforce_nonce, true);
    assertEquals(
      ((sends[0]!.body as FormData).get("files[0]") as Blob).size > 0,
      true,
    );

    // Reaction action: separate react PUT with URL-encoded emoji.
    assertEquals(sends[1]!.method, "PUT");
    assertStringIncludes(sends[1]!.url, "/reactions/");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("simulation: entity sends a DM with an image, routed into a conversation", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-sim-" });
  await Deno.mkdir(join(root, ".psycheros", "generated-images"), {
    recursive: true,
  });
  await Deno.writeFile(
    join(root, ".psycheros", "generated-images", "poke.png"),
    new Uint8Array(await pngBody()),
  );

  const posts: Array<{ url: string; body: FormData | string }> = [];
  const messages: Array<
    { conversationId: string; role: string; content: string }
  > = [];
  const db = {
    getConversationByChannel: () => null,
    createConversation: (title: string) => ({ id: "dm-conv", title }),
    getConversation: () => null,
    addMessage: (
      conversationId: string,
      message: { role: string; content: string },
    ) => {
      messages.push({ conversationId, ...message });
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const target = String(url);
    posts.push({ url: target, body: init?.body as FormData | string });
    if (target.endsWith("/users/@me/channels")) {
      return Response.json({
        id: "dm-channel",
        recipients: [{ global_name: "Tester", username: "tester" }],
      });
    }
    return Response.json({ id: "dm-out" });
  }) as typeof fetch;

  const ctx = {
    toolCallId: "call-2",
    conversationId: "origin-conv",
    db,
    config: {
      dataRoot: root,
      discordSettings: {
        enabled: true,
        botToken: "test-token",
        defaultChannelId: "user-1",
      },
    },
  } as unknown as ToolContext;

  try {
    const result = await sendDiscordDmTool.execute({
      message: "thought of you",
      image_path: "generated-images/poke.png",
    }, ctx);
    assertEquals(result.isError, false);

    // DM channel opened for the configured user, then the multipart send.
    assertEquals(
      posts[0]!.url,
      "https://discord.com/api/v10/users/@me/channels",
    );
    assertEquals(
      posts[1]!.url,
      "https://discord.com/api/v10/channels/dm-channel/messages",
    );
    const form = posts[1]!.body as FormData;
    const payload = JSON.parse(form.get("payload_json") as string);
    assertEquals(payload.content, "thought of you");
    assertEquals(payload.attachments[0]!.filename, "poke.png");
    assertEquals((form.get("files[0]") as Blob).size > 0, true);

    // Routed into the DM conversation with role alternation and the
    // attached-image note — under the per-conversation lock.
    assertEquals(messages.length, 2);
    assertEquals(messages[0]!.conversationId, "dm-conv");
    assertEquals(messages[0]!.role, "user");
    assertEquals(messages[1]!.role, "assistant");
    assertStringIncludes(messages[1]!.content, "thought of you");
    assertStringIncludes(
      messages[1]!.content,
      "[attached image: generated-images/poke.png]",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
