/**
 * Tests for MessageRouter's attachment-marker enrichment wiring — the seam
 * between the Discord flush path and PluginManager.enrichAttachmentMarkers.
 */

import { assertEquals } from "@std/assert";
import { MessageRouter } from "../src/discord/mod.ts";
import type {
  DiscordGatewayClient,
  DiscordMessage,
  RouterDeps,
} from "../src/discord/mod.ts";

type GatewayHandler = (event: string, data: unknown) => void;

function makeRouter(
  depsOverrides: Partial<RouterDeps> = {},
): {
  router: MessageRouter;
  handlers: Map<string, GatewayHandler>;
  capturedTurn: { message: string };
} {
  const handlers = new Map<string, GatewayHandler>();
  const gateway = {
    on: (event: string, handler: GatewayHandler) => {
      handlers.set(event, handler);
    },
    getBotUserId: () => "bot-1",
    getChannels: () => new Map(),
  } as unknown as DiscordGatewayClient;
  const config = {
    servers: [],
    blockedBotIds: [],
    respondToEveryoneHere: false,
    debounceWindowMs: 5000,
    maxBufferSize: 50,
    activeModeTiers: { mentionDebounceMs: 5 },
  } as unknown as RouterDeps["config"];
  const conversationMapper = {
    isDmUserAllowed: () => true,
    getOrCreateConversation: async () => "conv-1",
  } as unknown as RouterDeps["conversationMapper"];
  const capturedTurn = { message: "" };
  const router = new MessageRouter({
    gateway,
    config,
    conversationMapper,
    onTurn: async (_conversationId, userMessage) => {
      capturedTurn.message = userMessage;
    },
    ...depsOverrides,
  });
  return { router, handlers, capturedTurn };
}

function dmMessage(): DiscordMessage {
  return {
    id: "msg-1",
    channel_id: "dm-1",
    guild_id: null,
    author: { id: "user-1", username: "tester" },
    member: null,
    content: "hey, listen to this",
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [{
      id: "att-1",
      filename: "voice-message.ogg",
      content_type: "audio/ogg",
      url: "https://cdn.discordapp.com/attachments/1/2/voice.ogg?sig=x",
      size: 12_000,
    }],
    reference: null,
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    type: 0,
  } as unknown as DiscordMessage;
}

async function flushDm(
  handlers: Map<string, GatewayHandler>,
): Promise<void> {
  handlers.get("MESSAGE_CREATE")!("MESSAGE_CREATE", dmMessage());
  // DM path flushes after the mention debounce (5ms in the stub config).
  await new Promise((resolve) => setTimeout(resolve, 100));
}

Deno.test("router offers declined attachments to the enrichment dep before the turn", async () => {
  const seen: { channelId: string; isDM: boolean; filename: string }[] = [];
  const { router, handlers, capturedTurn } = makeRouter({
    enrichAttachmentMarkers: async (plan, channel) => {
      seen.push({
        channelId: channel.channelId,
        isDM: channel.isDM,
        filename: plan.pluginCandidates[0]?.filename ?? "",
      });
      const candidate = plan.pluginCandidates[0]!;
      const markers = plan.markersByMessageId.get(candidate.messageId)!;
      markers[candidate.markerIndex] = "[voice note: the transcript]";
    },
  });
  router.start();
  try {
    await flushDm(handlers);
    assertEquals(seen, [
      { channelId: "dm-1", isDM: true, filename: "voice-message.ogg" },
    ]);
    assertEquals(
      capturedTurn.message.includes("[voice note: the transcript]"),
      true,
    );
  } finally {
    router.stop();
  }
});

Deno.test("router without the enrichment dep keeps the native marker verbatim", async () => {
  const { router, handlers, capturedTurn } = makeRouter();
  router.start();
  try {
    await flushDm(handlers);
  } finally {
    router.stop();
  }
  assertEquals(
    capturedTurn.message.includes(
      "[file attached: voice-message.ogg (11.7 KB)]",
    ),
    true,
  );
});
