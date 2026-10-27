/**
 * Tests for the router's author-name resolution — the entity sees the server
 * nickname (when one is set) before the account-wide display name.
 */

import { assertEquals } from "@std/assert";
import { MessageRouter } from "../src/discord/mod.ts";
import type {
  DiscordGatewayClient,
  DiscordMessage,
  RouterDeps,
} from "../src/discord/mod.ts";

type GatewayHandler = (event: string, data: unknown) => void;

function makeGuildRouter(capturedTurn: { message: string }): {
  router: MessageRouter;
  handlers: Map<string, GatewayHandler>;
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
    servers: [{
      serverId: "guild-1",
      serverName: "Test Guild",
      channels: [{ channelId: "chan-1", mode: "strict" }],
    }],
    blockedBotIds: [],
    respondToEveryoneHere: false,
    debounceWindowMs: 5,
    maxBufferSize: 50,
    activeModeTiers: { mentionDebounceMs: 5 },
  } as unknown as RouterDeps["config"];
  const conversationMapper = {
    isDmUserAllowed: () => true,
    getOrCreateConversation: async () => "conv-1",
  } as unknown as RouterDeps["conversationMapper"];
  const router = new MessageRouter({
    gateway,
    config,
    conversationMapper,
    onTurn: async (_conversationId, userMessage) => {
      capturedTurn.message = userMessage;
    },
  });
  return { router, handlers };
}

function guildMessage(member: unknown): DiscordMessage {
  return {
    id: "msg-1",
    channel_id: "chan-1",
    guild_id: "guild-1",
    author: { id: "user-1", username: "tester", global_name: "Global Name" },
    member,
    content: "hello there",
    mention_everyone: false,
    mentions: [{ id: "bot-1", username: "the-bot", global_name: null }],
    mention_roles: [],
    attachments: [],
    reference: null,
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    type: 0,
  } as unknown as DiscordMessage;
}

async function flushGuild(
  handlers: Map<string, GatewayHandler>,
  member: unknown,
): Promise<void> {
  handlers.get("MESSAGE_CREATE")!("MESSAGE_CREATE", guildMessage(member));
  // Strict mode with a mention flushes immediately; give the async turn a beat.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

Deno.test("router shows the server nickname when one is set", async () => {
  const capturedTurn = { message: "" };
  const { router, handlers } = makeGuildRouter(capturedTurn);
  router.start();
  try {
    await flushGuild(handlers, { nick: "Server Nick", roles: [] });
  } finally {
    router.stop();
  }
  assertEquals(capturedTurn.message.includes("**Server Nick**"), true);
  assertEquals(capturedTurn.message.includes("**Global Name**"), false);
});

Deno.test("router falls back to the account display name when no nickname is set", async () => {
  const capturedTurn = { message: "" };
  const { router, handlers } = makeGuildRouter(capturedTurn);
  router.start();
  try {
    await flushGuild(handlers, { nick: null, roles: [] });
  } finally {
    router.stop();
  }
  assertEquals(capturedTurn.message.includes("**Global Name**"), true);
});
