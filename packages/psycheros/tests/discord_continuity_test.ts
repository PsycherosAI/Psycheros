import { Database } from "@db/sqlite";
import { assertEquals } from "@std/assert";
import { initializeSchema } from "../src/db/schema.ts";
import type { DBClient } from "../src/db/client.ts";
import type { EntityConfig } from "../src/entity/loop.ts";
import {
  classifyDiscordTurnDisposition,
  DiscordPendingStore,
  MessageRouter,
} from "../src/discord/mod.ts";
import type {
  AccumulatedMessage,
  DiscordTurnContext,
} from "../src/discord/router.ts";
import type {
  DiscordGatewayClient,
  DiscordMessage,
  GatewayEventHandler,
  GatewayEventType,
} from "../src/discord/gateway.ts";
import type { ConversationMapper } from "../src/discord/conversation-map.ts";
import {
  actInDiscordTool,
  isDiscordActionTargetEligible,
} from "../src/tools/discord-action.ts";
import { getDefaultDiscordGatewayConfig } from "../src/llm/discord-settings.ts";

function message(id = "message-1"): AccumulatedMessage {
  return {
    authorId: "user-1",
    authorUsername: "Test User",
    authorBot: false,
    content: "<@bot-1> this should survive a restart",
    timestamp: "2026-07-28T16:00:00.000Z",
    messageId: id,
    mentionsBot: true,
    replyToBot: false,
    referenceMessageId: null,
  };
}

function gatewayStub(
  handlers?: Map<GatewayEventType, GatewayEventHandler[]>,
): DiscordGatewayClient {
  return {
    on: (event: GatewayEventType, handler: GatewayEventHandler) => {
      const existing = handlers?.get(event) ?? [];
      existing.push(handler);
      handlers?.set(event, existing);
    },
    getBotUserId: () => "bot-1",
    getChannels: () =>
      new Map([["channel-1", { id: "channel-1", name: "general" }]]),
  } as unknown as DiscordGatewayClient;
}

function mapperStub(): ConversationMapper {
  return {
    getOrCreateConversation: () => Promise.resolve("conversation-1"),
  } as unknown as ConversationMapper;
}

function strictConfig() {
  const config = getDefaultDiscordGatewayConfig();
  config.servers = [{
    serverId: "server-1",
    serverName: "Test",
    channels: [{
      channelId: "channel-1",
      mode: "strict",
      instructions: "",
    }],
  }];
  return config;
}

Deno.test("Discord durable inbox reclaims processing rows and settles deliberate quiet", async () => {
  const db = new Database(":memory:");
  initializeSchema(db);
  const firstStore = new DiscordPendingStore(db);
  firstStore.enqueue({
    channelId: "channel-1",
    serverId: "server-1",
    isDM: false,
    mode: "strict",
    directlyAddressed: true,
    message: message(),
  });
  firstStore.claim(["message-1"]);
  assertEquals(firstStore.recoverReady().length, 0);

  const restartedStore = new DiscordPendingStore(db);
  assertEquals(restartedStore.recoverReady().length, 1);
  let seenContext: DiscordTurnContext | undefined;
  const router = new MessageRouter({
    gateway: gatewayStub(),
    pendingStore: restartedStore,
    conversationMapper: mapperStub(),
    config: strictConfig(),
    onTurn: async (_conversationId, _userMessage, context) => {
      seenContext = context;
      return { disposition: "deliberately_quiet" };
    },
  });
  router.start();

  const deadline = Date.now() + 1_000;
  while (restartedStore.count() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  router.stop();

  assertEquals(restartedStore.count(), 0);
  assertEquals(seenContext?.eligibleMessageIds, ["message-1"]);
  db.close();
});

Deno.test("Discord failed turn remains durable and retryable", async () => {
  const db = new Database(":memory:");
  initializeSchema(db);
  const store = new DiscordPendingStore(db);
  store.enqueue({
    channelId: "channel-1",
    serverId: "server-1",
    isDM: false,
    mode: "strict",
    directlyAddressed: true,
    message: message(),
  });
  let attempted = false;
  const router = new MessageRouter({
    gateway: gatewayStub(),
    pendingStore: store,
    conversationMapper: mapperStub(),
    config: strictConfig(),
    onTurn: () => {
      attempted = true;
      return Promise.resolve({ disposition: "failed" });
    },
  });
  router.start();
  const deadline = Date.now() + 1_000;
  while (!attempted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  router.stop();

  assertEquals(store.count(), 1);
  assertEquals(
    store.recoverReady(new Date(Date.now() + 31_000)).map((record) =>
      record.message.messageId
    ),
    ["message-1"],
  );
  db.close();
});

Deno.test("Discord overlapping eligible flush is deferred and runs after the active turn", async () => {
  const handlers = new Map<GatewayEventType, GatewayEventHandler[]>();
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const turns: string[][] = [];
  const router = new MessageRouter({
    gateway: gatewayStub(handlers),
    conversationMapper: mapperStub(),
    config: strictConfig(),
    onTurn: async (_conversationId, _userMessage, context) => {
      turns.push(context.eligibleMessageIds);
      if (turns.length === 1) await firstBlocked;
      return { disposition: "deliberately_quiet" };
    },
  });
  router.start();
  const receive = handlers.get("MESSAGE_CREATE")?.[0];
  if (!receive) throw new Error("MESSAGE_CREATE handler was not registered");

  receive("MESSAGE_CREATE", discordMessage("message-1"));
  const firstDeadline = Date.now() + 1_000;
  while (turns.length < 1 && Date.now() < firstDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  receive("MESSAGE_CREATE", discordMessage("message-2"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseFirst();

  const secondDeadline = Date.now() + 1_000;
  while (turns.length < 2 && Date.now() < secondDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  router.stop();

  assertEquals(turns, [["message-1"], ["message-2"]]);
});

Deno.test("Discord action rejects historical targets and commits visible work", async () => {
  assertEquals(
    isDiscordActionTargetEligible(
      { eligibleMessageIds: ["current-message"] },
      "old-message",
    ),
    false,
  );
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  let commitCount = 0;
  globalThis.fetch = (() => {
    fetchCount++;
    return Promise.resolve(
      new Response(JSON.stringify({ id: "sent-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    const config = {
      projectRoot: ".",
      dataRoot: ".",
      discordSettings: { botToken: "fake-token" },
      discordContext: {
        channelId: "channel-1",
        channelName: "general",
        serverId: "server-1",
        serverName: "Test",
        channelMode: "active",
        isDM: false,
        senderUsername: "Test User",
        senderUserId: "user-1",
        eligibleMessageIds: ["current-message"],
        commitVisibleAction: () => commitCount++,
      },
    } as unknown as EntityConfig;
    const db = {} as DBClient;
    const rejected = await actInDiscordTool.execute({
      actions: [{ message_id: "old-message", content: "Too late." }],
    }, { toolCallId: "tool-1", conversationId: "conv-1", db, config });
    assertEquals(rejected.isError, true);
    assertEquals(fetchCount, 0);
    assertEquals(commitCount, 0);

    const sent = await actInDiscordTool.execute({
      actions: [{
        message_id: "current-message",
        content: "This belongs to the current batch.",
      }],
    }, { toolCallId: "tool-2", conversationId: "conv-1", db, config });
    assertEquals(sent.isError, false);
    assertEquals(fetchCount, 1);
    assertEquals(commitCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Discord disposition separates quiet from failed visible action", () => {
  assertEquals(
    classifyDiscordTurnDisposition({
      discordActionAttempted: false,
      discordActionSucceeded: false,
    }),
    "deliberately_quiet",
  );
  assertEquals(
    classifyDiscordTurnDisposition({
      discordActionAttempted: true,
      discordActionSucceeded: false,
    }),
    "failed",
  );
});

function discordMessage(id: string): DiscordMessage {
  return {
    id,
    channel_id: "channel-1",
    guild_id: "server-1",
    author: {
      id: "user-1",
      username: "tester",
      global_name: "Test User",
      bot: false,
    },
    content: `<@bot-1> ${id}`,
    timestamp: new Date().toISOString(),
    mentions: [{
      id: "bot-1",
      username: "test-bot",
      global_name: "Test Bot",
      bot: true,
    }],
    mention_everyone: false,
  } as DiscordMessage;
}
