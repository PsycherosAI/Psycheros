/**
 * Tests for act_in_discord's image_path support — multipart routing, nonce
 * idempotency, and the path-containment gate.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { actInDiscordTool } from "../src/tools/discord-action.ts";
import type { ToolContext } from "../src/tools/types.ts";

interface CapturedSend {
  url: string;
  headers: Record<string, string>;
  body: FormData | string;
}

function makeContext(dataRoot: string): ToolContext {
  return {
    toolCallId: "call-1",
    conversationId: "conv-1",
    db: {} as never,
    config: {
      dataRoot,
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
}

async function withCapturedFetch(
  run: () => Promise<void>,
): Promise<CapturedSend[]> {
  const sends: CapturedSend[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    sends.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as FormData | string,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ id: `m${sends.length}` }), { status: 200 }),
    );
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  return sends;
}

Deno.test("act_in_discord sends content + image via multipart with nonce", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-action-" });
  await Deno.mkdir(join(root, ".psycheros", "generated-images"), {
    recursive: true,
  });
  await Deno.writeFile(
    join(root, ".psycheros", "generated-images", "x.png"),
    new Uint8Array([1, 2, 3, 4]),
  );
  const ctx = makeContext(root);

  const sends = await withCapturedFetch(async () => {
    const result = await actInDiscordTool.execute({
      actions: [{
        message_id: "msg-9",
        content: "look at this",
        image_path: "generated-images/x.png",
      }],
    }, ctx);
    assertEquals(result.isError, false);
    assertStringIncludes(result.content, "with image 'generated-images/x.png'");
  });

  assertEquals(sends.length, 1);
  assertEquals(
    sends[0].url,
    "https://discord.com/api/v10/channels/ch-1/messages",
  );
  assertEquals(sends[0].headers["Authorization"], "Bot test-token");

  const form = sends[0].body as FormData;
  const payload = JSON.parse(form.get("payload_json") as string);
  assertEquals(payload.content, "look at this");
  assertEquals(payload.message_reference, {
    message_id: "msg-9",
    channel_id: "ch-1",
  });
  assertEquals(typeof payload.nonce, "string");
  assertEquals(payload.nonce.length, 25);
  assertEquals(/^[0-9a-f]{25}$/.test(payload.nonce), true);
  assertEquals(payload.enforce_nonce, true);
  const blob = form.get("files[0]") as Blob;
  assertEquals(blob.size, 4);
  assertEquals(blob.type, "image/png");
});

Deno.test("act_in_discord image-only action and per-action nonce keys", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-action-" });
  await Deno.mkdir(join(root, ".psycheros", "generated-images"), {
    recursive: true,
  });
  await Deno.writeFile(
    join(root, ".psycheros", "generated-images", "y.png"),
    new Uint8Array([9]),
  );
  const ctx = makeContext(root);

  const sends = await withCapturedFetch(async () => {
    const result = await actInDiscordTool.execute({
      actions: [
        { image_path: "generated-images/y.png" },
        { content: "and some words" },
      ],
    }, ctx);
    assertEquals(result.isError, false);
  });

  // First action: multipart without content. Second: plain JSON text.
  assertEquals(sends.length, 2);
  const first = JSON.parse(
    (sends[0].body as FormData).get("payload_json") as string,
  );
  assertEquals(first.content, undefined);
  assertEquals(typeof first.nonce, "string");
  const second = JSON.parse(sends[1].body as string);
  assertEquals(second.content, "and some words");
  assertEquals(second.nonce, undefined);
});

Deno.test("act_in_discord rejects traversal and bad paths without sending", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-action-" });
  await Deno.mkdir(join(root, ".psycheros", "generated-images"), {
    recursive: true,
  });
  const ctx = makeContext(root);

  const sends = await withCapturedFetch(async () => {
    const traversal = await actInDiscordTool.execute({
      actions: [{ content: "hi", image_path: "../../deno.json" }],
    }, ctx);
    assertEquals(traversal.isError, true);
    assertStringIncludes(traversal.content, "unavailable");

    const badExt = await actInDiscordTool.execute({
      actions: [{ content: "hi", image_path: "generated-images/notes.txt" }],
    }, ctx);
    assertEquals(badExt.isError, true);
    assertStringIncludes(badExt.content, "unsupported image type");

    const missing = await actInDiscordTool.execute({
      actions: [{ image_path: "generated-images/ghost.png" }],
    }, ctx);
    assertEquals(missing.isError, true);
    assertStringIncludes(missing.content, "unavailable");
  });

  // No fetch may ever fire for rejected paths.
  assertEquals(sends.length, 0);
});
