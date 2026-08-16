import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import sharp from "sharp";
import { createGifPickerService } from "../media/gif-picker.ts";
import { getDefaultVoiceSettings } from "../llm/voice-settings.ts";
import type { ImageGenSettings } from "../llm/image-gen-settings.ts";
import { DiscordPluginHost } from "./plugin-host.ts";
import { createDiscordPluginServices } from "./plugin-services.ts";

const discordSettings = {
  botToken: "discord-secret",
  defaultChannelId: "",
  enabled: true,
  gatewayEnabled: true,
  globalInstructions: "",
  showHubInSidebar: true,
};

function generatorSettings(): ImageGenSettings {
  return {
    generators: [{
      id: "generator-1",
      name: "Configured generator",
      description: "",
      enabled: true,
      nsfw: false,
      provider: "openrouter",
      settings: {
        openrouter: {
          apiKey: "image-secret",
          model: "example/image-model",
          baseUrl: "https://example.test/v1",
        },
        params: {
          width: 1024,
          height: 1024,
          steps: 20,
          negative_prompt: "",
        },
      },
    }],
  };
}

function gifBytes(extraBytes = 0): Uint8Array {
  const bytes = new Uint8Array(6 + extraBytes);
  bytes.set(new TextEncoder().encode("GIF89a"));
  return bytes;
}

function createPicker(
  options: { configured?: boolean; gif?: Uint8Array } = {},
) {
  return createGifPickerService({
    apiKey: () => options.configured === false ? "" : "giphy-key",
    createToken: () => "selection-token",
    fetcher: (input) => {
      const url = String(input);
      if (url.includes("/search")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{
                title: "Celebration dance",
                images: {
                  original: {
                    url: "https://media.giphy.com/media/example/giphy.gif",
                    width: "320",
                    height: "240",
                  },
                  fixed_width: {
                    url: "https://media.giphy.com/media/example/preview.gif",
                    width: "200",
                    height: "150",
                  },
                },
              }],
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      }
      const media = options.gif ?? gifBytes(16);
      return Promise.resolve(
        new Response(media.slice().buffer as ArrayBuffer, {
          headers: { "content-type": "image/gif" },
        }),
      );
    },
  });
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function testOgg(): Uint8Array {
  const page = (granule: number, payload: Uint8Array) => {
    const output = new Uint8Array(28 + payload.length);
    output.set([0x4f, 0x67, 0x67, 0x53]);
    new DataView(output.buffer).setUint32(6, granule, true);
    output[26] = 1;
    output[27] = payload.length;
    output.set(payload, 28);
    return output;
  };
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"));
  const first = page(0, head);
  const second = page(48_000, new Uint8Array([1, 2, 3, 4]));
  const output = new Uint8Array(first.length + second.length);
  output.set(first);
  output.set(second, first.length);
  return output;
}

Deno.test("outgoing GIF and image-generation readiness reuses host configuration", () => {
  const ready = createDiscordPluginServices({
    host: new DiscordPluginHost(),
    gifPicker: createPicker(),
    getDiscordSettings: () => discordSettings,
    getImageGenSettings: generatorSettings,
    getVoiceSettings: getDefaultVoiceSettings,
  });
  assertEquals(ready.readiness.gifSearch().ready, true);
  assertEquals(ready.readiness.imageGeneration().ready, true);

  const unavailable = createDiscordPluginServices({
    host: new DiscordPluginHost(),
    gifPicker: createPicker({ configured: false }),
    getDiscordSettings: () => discordSettings,
    getImageGenSettings: () => ({ generators: [] }),
    getVoiceSettings: getDefaultVoiceSettings,
  });
  assertEquals(unavailable.readiness.gifSearch().ready, false);
  assertEquals(unavailable.readiness.imageGeneration().ready, false);
  assertStringIncludes(
    unavailable.readiness.imageGeneration().reason ?? "",
    "Vision",
  );
});

Deno.test("GIF search returns opaque selections and delivers exactly once", async () => {
  const requests: Array<{ form?: FormData; json?: Record<string, unknown> }> =
    [];
  const services = createDiscordPluginServices({
    host: new DiscordPluginHost(),
    gifPicker: createPicker(),
    getDiscordSettings: () => discordSettings,
    getImageGenSettings: generatorSettings,
    getVoiceSettings: getDefaultVoiceSettings,
    fetcher: (_input, init) => {
      requests.push(
        init?.body instanceof FormData
          ? { form: init.body }
          : { json: JSON.parse(String(init?.body)) },
      );
      return Promise.resolve(
        new Response(JSON.stringify({ id: "message-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });

  const results = await services.outgoingMedia.searchGifs("celebrate");
  assertEquals(results, [{
    selectionReference: "selection-token",
    title: "Celebration dance",
    width: 200,
    height: 150,
  }]);
  assertEquals(JSON.stringify(results).includes("giphy.com"), false);
  const { mediaReference } = await services.outgoingMedia.retrieveGif(
    results[0].selectionReference,
  );
  const input = {
    channelId: "channel-1",
    mediaReference,
    toolCallId: "tool-call-1",
    companionText: "This one fits.",
    fallbackText: "I could not send the GIF.",
  };
  const [first, retry] = await Promise.all([
    services.outgoingMedia.deliver(input),
    services.outgoingMedia.deliver(input),
  ]);
  assertEquals(first, { kind: "media", messageId: "message-1" });
  assertEquals(retry, first);
  assertEquals(requests.length, 1);
  const form = requests[0].form!;
  const payload = JSON.parse(String(form.get("payload_json"))) as Record<
    string,
    unknown
  >;
  const file = form.get("files[0]") as File;
  assertEquals(payload.nonce, "m-tool-call-1");
  assertEquals(payload.content, "This one fits.");
  assertEquals(String(payload.content).includes("media.giphy.com"), false);
  assertEquals(file.type, "image/gif");
  assertEquals(file.name, "selected.gif");
});

Deno.test("generated images remain opaque and upload with validated MIME", async () => {
  const png = new Uint8Array(
    await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).png().toBuffer(),
  );
  let uploads = 0;
  const services = createDiscordPluginServices({
    host: new DiscordPluginHost(),
    gifPicker: createPicker(),
    getDiscordSettings: () => discordSettings,
    getImageGenSettings: generatorSettings,
    getVoiceSettings: getDefaultVoiceSettings,
    generateImage: () =>
      Promise.resolve({
        imageData: encodeBase64(png),
        mediaType: "image/png",
      }),
    fetcher: (_input, init) => {
      uploads++;
      const file = (init?.body as FormData).get("files[0]") as File;
      assertEquals(file.name, "generated.png");
      assertEquals(file.type, "image/png");
      return Promise.resolve(
        new Response(JSON.stringify({ id: "image-message" }), {
          status: 200,
        }),
      );
    },
  });
  const generated = await services.outgoingMedia.generateImage({
    prompt: "private prompt that must not escape",
  });
  assertEquals(generated.provider, "openrouter");
  assertEquals(generated.mediaType, "image/png");
  assertEquals(JSON.stringify(generated).includes("private prompt"), false);
  assertEquals(
    await services.outgoingMedia.deliver({
      channelId: "channel-1",
      mediaReference: generated.mediaReference,
      toolCallId: "image-call",
      fallbackText: "Image generation worked but upload failed.",
    }),
    { kind: "media", messageId: "image-message" },
  );
  assertEquals(uploads, 1);
});

Deno.test("failed media upload sends one stable-nonce fallback across retries", async () => {
  const payloads: Record<string, unknown>[] = [];
  let calls = 0;
  const services = createDiscordPluginServices({
    host: new DiscordPluginHost(),
    gifPicker: createPicker(),
    getDiscordSettings: () => discordSettings,
    getImageGenSettings: generatorSettings,
    getVoiceSettings: getDefaultVoiceSettings,
    fetcher: (_input, init) => {
      calls++;
      if (init?.body instanceof FormData) {
        return Promise.resolve(new Response("rejected", { status: 400 }));
      }
      payloads.push(JSON.parse(String(init?.body)));
      return Promise.resolve(
        new Response(JSON.stringify({ id: "fallback-1" }), {
          status: 200,
        }),
      );
    },
  });
  const result = await services.outgoingMedia.searchGifs("celebrate");
  const media = await services.outgoingMedia.retrieveGif(
    result[0].selectionReference,
  );
  const input = {
    channelId: "channel-1",
    mediaReference: media.mediaReference,
    toolCallId: "retry-call",
    fallbackText: "I could not send that GIF.",
    mode: "attachment" as const,
  };
  assertEquals(await services.outgoingMedia.deliver(input), {
    kind: "text_fallback",
    messageId: "fallback-1",
  });
  assertEquals(await services.outgoingMedia.deliver(input), {
    kind: "text_fallback",
    messageId: "fallback-1",
  });
  assertEquals(calls, 2);
  assertEquals(payloads.length, 1);
  assertEquals(payloads[0].nonce, "f-retry-call");
});

Deno.test("host native voice transport also deduplicates by stable tool call", async () => {
  let calls = 0;
  const services = createDiscordPluginServices({
    host: new DiscordPluginHost(),
    gifPicker: createPicker(),
    getDiscordSettings: () => discordSettings,
    getImageGenSettings: generatorSettings,
    getVoiceSettings: getDefaultVoiceSettings,
    fetcher: () => {
      calls++;
      return Promise.resolve(
        new Response(JSON.stringify({ id: "voice" }), {
          status: 200,
        }),
      );
    },
  });
  const input = {
    channelId: "channel-1",
    audio: testOgg(),
    toolCallId: "voice-stable",
    fallbackText: "Voice failed.",
  };
  assertEquals(await services.transport.sendNativeVoiceMessage(input), {
    kind: "voice",
  });
  assertEquals(await services.transport.sendNativeVoiceMessage(input), {
    kind: "voice",
  });
  assertEquals(calls, 1);
});

Deno.test("unavailable and invalid generation fail before Discord delivery", async () => {
  let discordCalls = 0;
  const unavailable = createDiscordPluginServices({
    host: new DiscordPluginHost(),
    gifPicker: createPicker({ configured: false }),
    getDiscordSettings: () => discordSettings,
    getImageGenSettings: () => ({ generators: [] }),
    getVoiceSettings: getDefaultVoiceSettings,
    fetcher: () => {
      discordCalls++;
      return Promise.resolve(
        new Response(JSON.stringify({ id: "safe-fallback" }), { status: 200 }),
      );
    },
  });
  await assertRejects(() => unavailable.outgoingMedia.searchGifs("hello"));
  await assertRejects(() =>
    unavailable.outgoingMedia.generateImage({ prompt: "hello" })
  );

  const invalid = createDiscordPluginServices({
    host: new DiscordPluginHost(),
    gifPicker: createPicker(),
    getDiscordSettings: () => discordSettings,
    getImageGenSettings: generatorSettings,
    getVoiceSettings: getDefaultVoiceSettings,
    generateImage: () =>
      Promise.resolve({
        imageData: encodeBase64(new Uint8Array([1, 2, 3])),
        mediaType: "image/png",
      }),
  });
  await assertRejects(() =>
    invalid.outgoingMedia.generateImage({ prompt: "invalid" })
  );
  const fallbackInput = {
    channelId: "channel-1",
    toolCallId: "generation-failed",
    fallbackText: "I could not generate that image.",
  };
  assertEquals(await unavailable.outgoingMedia.sendFallback(fallbackInput), {
    kind: "text_fallback",
    messageId: "safe-fallback",
  });
  assertEquals(await unavailable.outgoingMedia.sendFallback(fallbackInput), {
    kind: "text_fallback",
    messageId: "safe-fallback",
  });
  assertEquals(discordCalls, 1);
});

Deno.test("oversized GIF is rejected by the host and falls back once", async () => {
  let calls = 0;
  const services = createDiscordPluginServices({
    host: new DiscordPluginHost(),
    gifPicker: createPicker({ gif: gifBytes(10 * 1024 * 1024 + 1) }),
    getDiscordSettings: () => discordSettings,
    getImageGenSettings: generatorSettings,
    getVoiceSettings: getDefaultVoiceSettings,
    fetcher: (_input, init) => {
      calls++;
      assertEquals(init?.body instanceof FormData, false);
      return Promise.resolve(
        new Response(JSON.stringify({ id: "fallback" }), {
          status: 200,
        }),
      );
    },
  });
  const result = await services.outgoingMedia.searchGifs("large");
  const media = await services.outgoingMedia.retrieveGif(
    result[0].selectionReference,
  );
  assertEquals(
    await services.outgoingMedia.deliver({
      channelId: "channel-1",
      mediaReference: media.mediaReference,
      toolCallId: "large-call",
      fallbackText: "The GIF was too large.",
    }),
    { kind: "text_fallback", messageId: "fallback" },
  );
  assertEquals(calls, 1);
});

Deno.test("outgoing media diagnostics exclude prompts, credentials, URLs, and bytes", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => logs.push(values.map(String).join(" "));
  console.error = (...values) => logs.push(values.map(String).join(" "));
  try {
    const services = createDiscordPluginServices({
      host: new DiscordPluginHost(),
      gifPicker: createPicker(),
      getDiscordSettings: () => discordSettings,
      getImageGenSettings: generatorSettings,
      getVoiceSettings: getDefaultVoiceSettings,
      fetcher: () => Promise.resolve(new Response("no", { status: 400 })),
    });
    const result = await services.outgoingMedia.searchGifs("private-query");
    const media = await services.outgoingMedia.retrieveGif(
      result[0].selectionReference,
    );
    await assertRejects(() =>
      services.outgoingMedia.deliver({
        channelId: "channel-1",
        mediaReference: media.mediaReference,
        toolCallId: "privacy-call",
        fallbackText: "private-fallback",
      })
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const output = logs.join("\n");
  for (
    const privateValue of [
      "discord-secret",
      "giphy-key",
      "private-query",
      "private-fallback",
      "giphy.com",
      "GIF89a",
    ]
  ) {
    assertEquals(output.includes(privateValue), false, privateValue);
  }
});
