import { assert, assertEquals } from "@std/assert";
import type { ToolContext } from "./types.ts";
import { createSendVoiceMessageTool } from "./send-voice-message.ts";

function oggPage(granule: number, payload: Uint8Array): Uint8Array {
  const page = new Uint8Array(28 + payload.length);
  page.set([0x4f, 0x67, 0x67, 0x53], 0);
  const view = new DataView(page.buffer);
  view.setUint32(6, granule >>> 0, true);
  view.setUint32(10, Math.floor(granule / 0x1_0000_0000), true);
  page[26] = 1;
  page[27] = payload.length;
  page.set(payload, 28);
  return page;
}

function testOgg(): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"));
  head[8] = 1;
  head[9] = 1;
  const first = oggPage(0, head);
  const second = oggPage(48_000, new Uint8Array([1, 2, 3, 4]));
  const audio = new Uint8Array(first.length + second.length);
  audio.set(first);
  audio.set(second, first.length);
  return audio;
}

function context(): ToolContext {
  return {
    toolCallId: "voice-call-123",
    conversationId: "conversation-1",
    db: undefined,
    config: {
      projectRoot: "/tmp",
      dataRoot: "/tmp",
      discordSettings: { botToken: "discord-token" },
      discordContext: {
        channelId: "channel-1",
        channelName: "general",
        serverId: "server-1",
        serverName: "server",
        channelMode: "mention",
        isDM: false,
        senderUsername: "person",
        senderUserId: "user-1",
        deliveryState: {},
      },
      voiceSettings: {
        enabled: true,
        activeProfileId: "geo",
        profiles: [{
          id: "geo",
          name: "GEO",
          enabled: true,
          pronunciation: [],
          providerSettings: {
            tts: {
              provider: "elevenlabs",
              elevenlabs: {
                apiKey: "voice-key",
                voiceId: "voice-id",
                model: "model-id",
              },
            },
            stt: { provider: "browser" },
          },
        }],
      },
    },
  } as unknown as ToolContext;
}

Deno.test("send_voice_message posts one native Discord voice message", async () => {
  const requests: RequestInit[] = [];
  const tool = createSendVoiceMessageTool({
    synthesize: () => Promise.resolve(testOgg()),
    fetcher: ((_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return Promise.resolve(
        new Response(JSON.stringify({ id: "message-1" }), { status: 200 }),
      );
    }) as typeof fetch,
  });
  const result = await tool.execute({ text: "hello" }, context());

  assertEquals(result.isError, false);
  assertEquals(requests.length, 1);
  assert(requests[0].body instanceof FormData);
  const payload = JSON.parse(
    (requests[0].body as FormData).get("payload_json") as string,
  );
  assertEquals(payload.flags, 8192);
  assertEquals(payload.content, undefined);
  assertEquals(payload.attachments.length, 1);
});

Deno.test("send_voice_message falls back to text once when synthesis fails", async () => {
  const requests: RequestInit[] = [];
  const tool = createSendVoiceMessageTool({
    synthesize: () => Promise.reject(new Error("TTS unavailable")),
    fetcher: ((_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return Promise.resolve(
        new Response(JSON.stringify({ id: "fallback-1" }), { status: 200 }),
      );
    }) as typeof fetch,
  });
  const result = await tool.execute(
    { text: "spoken", fallback_text: "text fallback" },
    context(),
  );

  assertEquals(result.isError, false);
  assertEquals(requests.length, 1);
  assertEquals(JSON.parse(requests[0].body as string).content, "text fallback");
});

Deno.test("send_voice_message falls back once when Discord rejects voice upload", async () => {
  const requests: RequestInit[] = [];
  const tool = createSendVoiceMessageTool({
    synthesize: () => Promise.resolve(testOgg()),
    fetcher: ((_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return Promise.resolve(
        requests.length === 1
          ? new Response("voice rejected", { status: 400 })
          : new Response(JSON.stringify({ id: "fallback-1" }), { status: 200 }),
      );
    }) as typeof fetch,
  });
  const result = await tool.execute(
    { text: "spoken", fallback_text: "text fallback" },
    context(),
  );

  assertEquals(result.isError, false);
  assertEquals(requests.length, 2);
  assert(requests[0].body instanceof FormData);
  assertEquals(JSON.parse(requests[1].body as string).content, "text fallback");
});

Deno.test("send_voice_message deduplicates repeated execution", async () => {
  let sends = 0;
  const tool = createSendVoiceMessageTool({
    synthesize: () => Promise.resolve(testOgg()),
    fetcher: (() => {
      sends++;
      return Promise.resolve(
        new Response(JSON.stringify({ id: "message-1" }), { status: 200 }),
      );
    }) as typeof fetch,
  });
  const ctx = context();
  await Promise.all([
    tool.execute({ text: "hello" }, ctx),
    tool.execute({ text: "hello" }, ctx),
  ]);
  assertEquals(sends, 1);
});

Deno.test("send_voice_message does not send after text delivery claimed the turn", async () => {
  let sends = 0;
  const ctx = context();
  ctx.config.discordContext!.deliveryState!.claimedBy = "act_in_discord";
  const tool = createSendVoiceMessageTool({
    synthesize: () => Promise.resolve(testOgg()),
    fetcher: (() => {
      sends++;
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch,
  });
  const result = await tool.execute({ text: "hello" }, ctx);
  assertEquals(result.isError, true);
  assertEquals(sends, 0);
});
