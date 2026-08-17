/**
 * Tests for the Discord media plugin surface — attachment-marker enrichment
 * (inbound) and the scoped sendAttachments service (outbound).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { PluginManager } from "../../src/plugins/mod.ts";
import { planTurnAttachments } from "../../src/discord/mod.ts";
import type { DiscordAttachment } from "../../src/discord/mod.ts";

async function writePlugin(
  root: string,
  id: string,
  manifest: Record<string, unknown>,
  entrypointSource: string,
): Promise<void> {
  const directory = join(root, id);
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    join(directory, "plugin.json"),
    JSON.stringify({ id, apiVersion: 2, ...manifest }),
  );
  await Deno.writeTextFile(join(directory, "psycheros.ts"), entrypointSource);
}

const FAKE_LLM = () => ({}) as never;

const CHANNEL = {
  channelId: "ch-1",
  channelName: "general",
  serverName: null,
  isDM: true,
};

function attachment(
  id: string,
  filename: string,
  overrides: Partial<DiscordAttachment> = {},
): DiscordAttachment {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const fallbackType = ext === "png"
    ? "image/png"
    : ext === "ogg"
    ? "audio/ogg"
    : ext === "gif"
    ? "image/gif"
    : null;
  return {
    id,
    filename,
    content_type: fallbackType,
    url: `https://cdn.discordapp.com/attachments/1/2/${filename}?sig=${id}`,
    size: 100 * 1024,
    ...overrides,
  };
}

Deno.test("enrichAttachmentMarkers replaces declined markers, keeps vision numbering", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-media-" });
  await writePlugin(
    root,
    "media-plugin",
    {
      name: "Media",
      version: "1.0.0",
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: {
        discordMedia: { attachmentTypes: ["audio/*", "image/gif"] },
      },
    },
    `export default {
      attachmentHook: {
        async run(ctx) {
          return "[media plugin heard: hello from " + ctx.attachment.filename + "]";
        },
      },
    };`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const plan = planTurnAttachments([
      {
        messageId: "m1",
        attachments: [
          attachment("a1", "cat.png"),
          attachment("v1", "voice-message.ogg"),
          attachment("g1", "anim.gif"),
        ],
      },
    ]);
    await manager.enrichAttachmentMarkers(plan, CHANNEL);

    const markers = plan.markersByMessageId.get("m1")!;
    // Vision marker keeps its number and correlation with turnImages.
    assertEquals(markers[0], "[image 1 attached: cat.png]");
    assertEquals(plan.turnImages.length, 1);
    // Declined markers replaced by the hook's text.
    assertEquals(
      markers[1],
      "[media plugin heard: hello from voice-message.ogg]",
    );
    assertEquals(markers[2], "[media plugin heard: hello from anim.gif]");
  } finally {
    await manager.stop();
  }
});

Deno.test("enrichAttachmentMarkers consults claimants in priority order, declining falls through", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-media-" });
  await writePlugin(
    root,
    "a-first",
    {
      name: "First",
      version: "1.0.0",
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: { discordMedia: { attachmentTypes: ["audio/*"] } },
    },
    `export default {
      attachmentHook: {
        priority: 0,
        run() { return undefined; },
      },
    };`,
  );
  await writePlugin(
    root,
    "b-second",
    {
      name: "Second",
      version: "1.0.0",
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: { discordMedia: { attachmentTypes: ["audio/*"] } },
    },
    `export default {
      attachmentHook: {
        priority: 10,
        run() { return "[from second plugin]"; },
      },
    };`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const plan = planTurnAttachments([
      { messageId: "m1", attachments: [attachment("v1", "note.ogg")] },
    ]);
    await manager.enrichAttachmentMarkers(plan, CHANNEL);
    assertEquals(
      plan.markersByMessageId.get("m1")![0],
      "[from second plugin]",
    );
  } finally {
    await manager.stop();
  }
});

Deno.test("enrichAttachmentMarkers skips hooks whose globs do not match", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-media-" });
  await writePlugin(
    root,
    "audio-only",
    {
      name: "Audio Only",
      version: "1.0.0",
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: { discordMedia: { attachmentTypes: ["audio/*"] } },
    },
    `let calls = 0;
     export default {
       get calls() { return calls; },
       attachmentHook: {
         async run() { calls++; return "[should never land]"; },
       },
     };`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const plan = planTurnAttachments([
      { messageId: "m1", attachments: [attachment("g1", "anim.gif")] },
    ]);
    await manager.enrichAttachmentMarkers(plan, CHANNEL);
    assertEquals(
      plan.markersByMessageId.get("m1")![0],
      "[image attached: anim.gif (format not supported)]",
    );
  } finally {
    await manager.stop();
  }
});

Deno.test("enrichAttachmentMarkers leaves the native marker on timeout, marks degraded, logs", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-media-" });
  await writePlugin(
    root,
    "slow-stt",
    {
      name: "Slow STT",
      version: "1.0.0",
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: { discordMedia: { attachmentTypes: ["audio/*"] } },
    },
    `export default {
      attachmentHook: {
        timeoutMs: 25,
        // Never resolves and holds no timer — the host's timeout must win.
        run() { return new Promise(() => {}); },
      },
    };`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const plan = planTurnAttachments([
      { messageId: "m1", attachments: [attachment("v1", "note.ogg")] },
    ]);
    await manager.enrichAttachmentMarkers(plan, CHANNEL);
    assertEquals(
      plan.markersByMessageId.get("m1")![0],
      "[file attached: note.ogg (100.0 KB)]",
    );
    const status = manager.getStatuses().find((s) => s.id === "slow-stt")!;
    assertEquals(status.degraded, true);
    assertEquals(
      manager.getRecentEvents("slow-stt").some((event) =>
        event.category === "media" && event.level === "error"
      ),
      true,
    );
  } finally {
    await manager.stop();
  }
});

Deno.test("enrichAttachmentMarkers leaves the native marker when the hook throws", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-media-" });
  await writePlugin(
    root,
    "broken-stt",
    {
      name: "Broken STT",
      version: "1.0.0",
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: { discordMedia: { attachmentTypes: ["audio/*"] } },
    },
    `export default {
      attachmentHook: {
        async run() { throw new Error("provider down"); },
      },
    };`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const plan = planTurnAttachments([
      { messageId: "m1", attachments: [attachment("v1", "note.ogg")] },
    ]);
    await manager.enrichAttachmentMarkers(plan, CHANNEL);
    assertEquals(
      plan.markersByMessageId.get("m1")![0],
      "[file attached: note.ogg (100.0 KB)]",
    );
    assertEquals(
      manager.getStatuses().find((s) => s.id === "broken-stt")!.degraded,
      true,
    );
  } finally {
    await manager.stop();
  }
});

Deno.test("enrichAttachmentMarkers collapses multi-line output to one line", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-media-" });
  await writePlugin(
    root,
    "chatty-stt",
    {
      name: "Chatty STT",
      version: "1.0.0",
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: { discordMedia: { attachmentTypes: ["audio/*"] } },
    },
    `export default {
      attachmentHook: {
        async run() { return "line one\\nline two\\tand a tab"; },
      },
    };`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const plan = planTurnAttachments([
      { messageId: "m1", attachments: [attachment("v1", "note.ogg")] },
    ]);
    await manager.enrichAttachmentMarkers(plan, CHANNEL);
    assertEquals(
      plan.markersByMessageId.get("m1")![0],
      "line one line two and a tab",
    );
  } finally {
    await manager.stop();
  }
});

Deno.test("enrichAttachmentMarkers truncates to the per-hook cap with a marker", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-media-" });
  await writePlugin(
    root,
    "truncating-stt",
    {
      name: "Truncating STT",
      version: "1.0.0",
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: { discordMedia: { attachmentTypes: ["audio/*"] } },
    },
    `export default {
      attachmentHook: {
        maxChars: 10,
        async run() { return "x".repeat(30); },
      },
    };`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const plan = planTurnAttachments([
      { messageId: "m1", attachments: [attachment("v1", "note.ogg")] },
    ]);
    await manager.enrichAttachmentMarkers(plan, CHANNEL);
    assertEquals(
      plan.markersByMessageId.get("m1")![0],
      "xxxxxxxxxx [truncated]",
    );
  } finally {
    await manager.stop();
  }
});

Deno.test("enrichAttachmentMarkers is a no-op with zero claiming plugins", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-media-" });
  await writePlugin(
    root,
    "plain-plugin",
    {
      name: "Plain",
      version: "1.0.0",
      entrypoints: { psycheros: "./psycheros.ts" },
    },
    `export default {};`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const plan = planTurnAttachments([
      {
        messageId: "m1",
        attachments: [attachment("v1", "note.ogg"), attachment("g1", "a.gif")],
      },
    ]);
    const before = JSON.stringify(
      [...plan.markersByMessageId.entries()],
    );
    await manager.enrichAttachmentMarkers(plan, CHANNEL);
    assertEquals(
      JSON.stringify([...plan.markersByMessageId.entries()]),
      before,
    );
  } finally {
    await manager.stop();
  }
});

Deno.test("apiVersion 1 plugin loads unchanged and never enriches; v1 + discordMedia fails discovery", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-media-" });
  await writePlugin(
    root,
    "legacy-plugin",
    {
      apiVersion: 1,
      name: "Legacy",
      version: "1.0.0",
      entrypoints: { psycheros: "./psycheros.ts" },
    },
    `export default {};`,
  );
  await writePlugin(
    root,
    "confused-plugin",
    {
      apiVersion: 1,
      name: "Confused",
      version: "1.0.0",
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: { discordMedia: { send: true } },
    },
    `export default {};`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const legacy = manager.getStatuses().find((s) => s.id === "legacy-plugin")!;
    assertEquals(legacy.active, true);
    assertEquals(legacy.degraded, false);
    assertEquals(manager.hasDiscordMedia("legacy-plugin"), false);

    const confused = manager.getStatuses().find((s) =>
      s.id === "confused-plugin"
    )!;
    assertEquals(confused.active, false);
    assertEquals(confused.degraded, true);
    assertEquals(
      (confused.lastError ?? "").includes("apiVersion"),
      true,
    );

    const plan = planTurnAttachments([
      { messageId: "m1", attachments: [attachment("v1", "note.ogg")] },
    ]);
    await manager.enrichAttachmentMarkers(plan, CHANNEL);
    assertEquals(
      plan.markersByMessageId.get("m1")![0],
      "[file attached: note.ogg (100.0 KB)]",
    );
  } finally {
    await manager.stop();
  }
});

Deno.test("declared attachmentTypes without an exported hook degrades, load survives", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-media-" });
  await writePlugin(
    root,
    "liar-plugin",
    {
      name: "Liar",
      version: "1.0.0",
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: { discordMedia: { attachmentTypes: ["audio/*"] } },
    },
    `export default {};`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const status = manager.getStatuses().find((s) => s.id === "liar-plugin")!;
    assertEquals(status.active, true);
    assertEquals(status.degraded, true);
    assertEquals(
      manager.getRecentEvents("liar-plugin").some((event) =>
        event.category === "load" &&
        event.message.includes("attachmentHook")
      ),
      true,
    );
  } finally {
    await manager.stop();
  }
});

Deno.test("discord service sends multipart with the host token and logs the send", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-media-" });
  await writePlugin(
    root,
    "sender",
    {
      name: "Sender",
      version: "1.0.0",
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: { discordMedia: { send: true } },
    },
    `export default {};`,
  );

  const manager = new PluginManager(
    root,
    FAKE_LLM,
    undefined,
    undefined,
    () => "test-token",
  );
  await manager.load();
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(_url);
    capturedInit = init;
    return Promise.resolve(
      new Response(JSON.stringify({ id: "m1" }), { status: 200 }),
    );
  }) as typeof fetch;
  try {
    const services = manager.getServices("sender")!;
    assertEquals(typeof services.discord?.sendAttachments, "function");

    const result = await services.discord!.sendAttachments({
      channelId: "ch-1",
      content: "here you go",
      messageReferenceId: "msg-9",
      files: [{
        filename: "voice-message.ogg",
        contentType: "audio/ogg",
        data: new Uint8Array([1, 2, 3]),
      }],
    });

    assertEquals(result.messageIds, ["m1"]);
    assertEquals(
      capturedUrl,
      "https://discord.com/api/v10/channels/ch-1/messages",
    );
    assertEquals(
      (capturedInit!.headers as Record<string, string>)["Authorization"],
      "Bot test-token",
    );
    const form = capturedInit!.body as FormData;
    const payload = JSON.parse(form.get("payload_json") as string);
    assertEquals(payload.content, "here you go");
    assertEquals(payload.message_reference, {
      message_id: "msg-9",
      channel_id: "ch-1",
    });
    const blob = form.get("files[0]") as Blob;
    assertEquals(blob.size, 3);
    assertEquals(blob.type, "audio/ogg");

    assertEquals(
      manager.getRecentEvents("sender").some((event) =>
        event.category === "media" && event.level === "info" &&
        event.message.includes("sent 1 attachment") &&
        (event.details?.filenames as string[]).includes("voice-message.ogg")
      ),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await manager.stop();
  }
});

Deno.test("discord service surfaces missing token and rate limits", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-media-" });
  await writePlugin(
    root,
    "sender",
    {
      name: "Sender",
      version: "1.0.0",
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: { discordMedia: { send: true } },
    },
    `export default {};`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  const originalFetch = globalThis.fetch;
  try {
    // No token getter configured → explicit error, not a silent no-op.
    await assertRejects(
      () =>
        manager.getServices("sender")!.discord!.sendAttachments({
          channelId: "ch-1",
          files: [{ filename: "a.ogg", data: new Uint8Array([1]) }],
        }),
      Error,
      "no Discord bot token",
    );

    // 429 surfaces the retry delay.
    const tokenized = new PluginManager(
      root,
      FAKE_LLM,
      undefined,
      undefined,
      () => "test-token",
    );
    await tokenized.load();
    try {
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response("{}", {
            status: 429,
            headers: { "Retry-After": "2" },
          }),
        )) as typeof fetch;
      await assertRejects(
        () =>
          tokenized.getServices("sender")!.discord!.sendAttachments({
            channelId: "ch-1",
            files: [{ filename: "a.ogg", data: new Uint8Array([1]) }],
          }),
        Error,
        "rate limited",
      );
    } finally {
      await tokenized.stop();
    }
  } finally {
    globalThis.fetch = originalFetch;
    await manager.stop();
  }
});

Deno.test("idempotencyKey derives a stable enforce_nonce in payload_json", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-media-" });
  await writePlugin(
    root,
    "sender",
    {
      name: "Sender",
      version: "1.0.0",
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: { discordMedia: { send: true } },
    },
    `export default {};`,
  );

  const manager = new PluginManager(
    root,
    FAKE_LLM,
    undefined,
    undefined,
    () => "test-token",
  );
  await manager.load();
  const originalFetch = globalThis.fetch;
  const payloads: string[] = [];
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    const form = init?.body as FormData;
    payloads.push(form.get("payload_json") as string);
    return Promise.resolve(
      new Response(JSON.stringify({ id: "m1" }), { status: 200 }),
    );
  }) as typeof fetch;
  try {
    const services = manager.getServices("sender")!;
    const send = () =>
      services.discord!.sendAttachments({
        channelId: "ch-1",
        idempotencyKey: "call-1:0",
        files: [{ filename: "a.png", data: new Uint8Array([1]) }],
      });
    await send();
    // Same key retried — the nonce must be identical so Discord dedupes.
    await send();
    // No key — no nonce fields at all.
    await services.discord!.sendAttachments({
      channelId: "ch-1",
      files: [{ filename: "b.png", data: new Uint8Array([1]) }],
    });

    const first = JSON.parse(payloads[0]!) as Record<string, unknown>;
    const second = JSON.parse(payloads[1]!) as Record<string, unknown>;
    const third = JSON.parse(payloads[2]!) as Record<string, unknown>;
    assertEquals(typeof first.nonce, "string");
    assertEquals((first.nonce as string).length, 25);
    assertEquals(/^[0-9a-f]{25}$/.test(first.nonce as string), true);
    assertEquals(first.enforce_nonce, true);
    assertEquals(second.nonce, first.nonce);
    assertEquals(third.nonce, undefined);
    assertEquals(third.enforce_nonce, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    await manager.stop();
  }
});

Deno.test("discord service is absent without capabilities.discordMedia.send", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-media-" });
  await writePlugin(
    root,
    "receiver-only",
    {
      name: "Receiver Only",
      version: "1.0.0",
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: { discordMedia: { attachmentTypes: ["audio/*"] } },
    },
    `export default { attachmentHook: { async run() { return "[x]"; } } };`,
  );

  const manager = new PluginManager(
    root,
    FAKE_LLM,
    undefined,
    undefined,
    () => "test-token",
  );
  await manager.load();
  try {
    assertEquals(manager.getServices("receiver-only")!.discord, undefined);
  } finally {
    await manager.stop();
  }
});
