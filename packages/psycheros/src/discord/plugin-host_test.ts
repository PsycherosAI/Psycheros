import { assertEquals, assertStringIncludes } from "@std/assert";
import { DiscordPluginHost } from "./plugin-host.ts";
import type { DiscordMessage } from "./gateway.ts";

function message(): DiscordMessage {
  return {
    id: "message-1",
    channel_id: "channel-1",
    guild_id: "guild-1",
    author: {
      id: "user-1",
      username: "Bebo",
      discriminator: "0",
      global_name: "Bebo",
      bot: false,
    },
    member: null,
    content: "please inspect this",
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    reference: null,
    timestamp: new Date(0).toISOString(),
    edited_timestamp: null,
    type: 0,
    attachments: [{
      id: "attachment-1",
      filename: "photo.png",
      size: 123,
      content_type: "image/png",
      url: "https://cdn.discordapp.com/private/signed?secret=value",
      proxy_url: "https://media.discordapp.net/private/proxy?secret=value",
    }],
    embeds: [],
  };
}

Deno.test("Discord plugin events are sanitized and subscriptions dispose", async () => {
  const host = new DiscordPluginHost();
  const seen: unknown[] = [];
  const dispose = host.subscribe(
    ["MESSAGE_CREATE"],
    (event) => {
      seen.push(event);
    },
  );
  await host.publish("MESSAGE_CREATE", message());
  dispose();
  await host.publish("MESSAGE_CREATE", { ...message(), id: "message-2" });

  assertEquals(seen.length, 1);
  const serialized = JSON.stringify(seen[0]);
  assertEquals(serialized.includes("discordapp.com"), false);
  assertEquals(serialized.includes("secret=value"), false);
  assertStringIncludes(serialized, "message-1:attachment:0");
});

Deno.test("Discord processors are ordered, isolated, bounded, and preserve text", async () => {
  const host = new DiscordPluginHost();
  const order: string[] = [];
  host.registerProcessor("late", {
    name: "late",
    priority: 20,
    async process() {
      order.push("late");
      return { appendedText: "second" };
    },
  });
  host.registerProcessor("broken", {
    name: "broken",
    priority: 15,
    async process() {
      order.push("broken");
      throw new Error("private detail");
    },
  });
  host.registerProcessor("early", {
    name: "early",
    priority: 10,
    async process() {
      order.push("early");
      return {
        appendedText: "first",
        visionImages: Array.from({ length: 6 }, (_, index) => ({
          type: "image_url" as const,
          image_url: { url: `data:image/png;base64,${index}` },
        })),
      };
    },
  });

  const event = host.sanitize("MESSAGE_CREATE", message());
  const result = await host.process(
    "channel-1",
    [event],
    new AbortController().signal,
  );
  assertEquals(order, ["early", "broken", "late"]);
  assertEquals(result.appendedText, "first\n\nsecond");
  assertEquals(result.visionImages?.length, 4);
  assertEquals(event.content, "please inspect this");
});

Deno.test("Discord media pipeline ownership returns safely to legacy core", () => {
  const host = new DiscordPluginHost();
  assertEquals(host.getMediaPipelineOwner(), "legacy-core");
  assertEquals(host.claimMediaPipeline("plugin"), true);
  assertEquals(host.claimMediaPipeline("other-plugin"), false);
  assertEquals(host.getMediaPipelineOwner(), "plugin");
  host.releaseMediaPipeline("other-plugin");
  assertEquals(host.getMediaPipelineOwner(), "plugin");
  host.releaseMediaPipeline("plugin");
  assertEquals(host.getMediaPipelineOwner(), "legacy-core");
});

Deno.test("Discord plugin host source is platform-neutral", async () => {
  const sources = [
    await Deno.readTextFile(new URL("./plugin-host.ts", import.meta.url)),
    await Deno.readTextFile(new URL("./plugin-services.ts", import.meta.url)),
  ].join("\n").toLowerCase();
  for (
    const forbidden of [
      "/users/",
      "\\users\\",
      "ffmpeg",
      "process.platform",
      "deno.build.os",
    ]
  ) {
    assertEquals(sources.includes(forbidden), false, `found ${forbidden}`);
  }
});
