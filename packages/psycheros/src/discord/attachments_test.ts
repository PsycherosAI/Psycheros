import { assertEquals, assertMatch } from "@std/assert";
import sharp from "sharp";
import {
  collectDiscordMediaCandidates,
  MAX_DISCORD_IMAGE_BYTES,
  prepareDiscordVisionImages,
  representativeGifFrameIndexes,
} from "./attachments.ts";

Deno.test("collectDiscordMediaCandidates supports attachments and Discord/Tenor embeds", () => {
  const candidates = collectDiscordMediaCandidates([{
    attachments: [
      {
        id: "1",
        filename: "photo.png",
        size: 123,
        url: "https://cdn.discordapp.com/attachments/photo.png",
        content_type: "image/png",
      },
      {
        id: "2",
        filename: "animation.gif",
        size: 456,
        url: "https://cdn.discordapp.com/attachments/animation.gif",
        content_type: "image/gif",
      },
    ],
    embeds: [{
      type: "gifv",
      url: "https://tenor.com/view/example",
      thumbnail: {
        proxy_url: "https://media.discordapp.net/external/tenor-preview",
      },
    }],
  }]);

  assertEquals(candidates.map(({ kind }) => kind), ["image", "gif", "gif"]);
  assertEquals(candidates.length, 3);
});

Deno.test("Klipy gifv prefers Discord proxies and falls back from MP4 to WebP", async () => {
  const videoProxy =
    "https://images-ext-1.discordapp.net/external/video/https/static.klipy.com/RgQqRYTHmiKdzekwP.mp4";
  const thumbnailProxy =
    "https://images-ext-1.discordapp.net/external/thumb/https/static.klipy.com/4CLbtqkN.webp";
  const candidates = collectDiscordMediaCandidates([{
    embeds: [{
      type: "gifv",
      url: "https://klipy.com/gifs/fry-futurama-9",
      video: {
        url: "https://static.klipy.com/RgQqRYTHmiKdzekwP.mp4",
        proxy_url: videoProxy,
      },
      thumbnail: {
        url: "https://static.klipy.com/4CLbtqkN.webp",
        proxy_url: thumbnailProxy,
      },
    }],
  }]);

  assertEquals(candidates.length, 1);
  assertEquals(candidates[0].url, videoProxy);
  assertEquals(candidates[0].urls?.slice(0, 2), [videoProxy, thumbnailProxy]);

  const webp = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 20, g: 40, b: 60 },
    },
  }).webp().toBuffer();
  const requested: string[] = [];
  const fetcher = ((url: string | URL | Request) => {
    requested.push(String(url));
    if (String(url) === videoProxy) {
      return Promise.resolve(
        new Response(new Uint8Array([0, 1, 2]).buffer, {
          headers: { "content-type": "video/mp4" },
        }),
      );
    }
    return Promise.resolve(
      new Response(new Uint8Array(webp).buffer, {
        headers: { "content-type": "image/webp" },
      }),
    );
  }) as typeof fetch;

  const images = await prepareDiscordVisionImages(candidates, fetcher);

  assertEquals(requested, [videoProxy, thumbnailProxy]);
  assertEquals(images.length, 1);
  assertMatch(images[0].image_url.url, /^data:image\/webp;base64,/);
});

Deno.test("representativeGifFrameIndexes spans the animation and honors the limit", () => {
  assertEquals(representativeGifFrameIndexes(10, 4), [0, 3, 6, 9]);
  assertEquals(representativeGifFrameIndexes(2, 4), [0, 1]);
});

Deno.test("prepareDiscordVisionImages accepts static images and converts GIF frames", async () => {
  const png = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  }).png().toBuffer();
  // A valid single-frame GIF is enough to exercise the Sharp GIF conversion path;
  // frame selection across longer animations is covered independently above.
  const gif = Uint8Array.from(
    atob("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="),
    (character) => character.charCodeAt(0),
  );
  const fetcher = ((url: string | URL | Request) => {
    const isGif = String(url).endsWith(".gif");
    const body = new Uint8Array(isGif ? gif : png).buffer;
    return Promise.resolve(
      new Response(body, {
        headers: { "content-type": isGif ? "image/gif" : "image/png" },
      }),
    );
  }) as typeof fetch;

  const images = await prepareDiscordVisionImages([
    {
      url: "https://cdn.discordapp.com/attachments/photo.png",
      declaredType: "image/png",
      kind: "image",
    },
    {
      url: "https://cdn.discordapp.com/attachments/animation.gif",
      declaredType: "image/gif",
      kind: "gif",
    },
  ], fetcher);

  assertEquals(images.length, 2);
  assertMatch(images[0].image_url.url, /^data:image\/png;base64,/);
  assertMatch(images[1].image_url.url, /^data:image\/webp;base64,/);
});

Deno.test("prepareDiscordVisionImages skips unsupported, oversized, and failed downloads", async () => {
  const fetcher = ((url: string | URL | Request) => {
    const value = String(url);
    if (value.includes("failed")) {
      return Promise.resolve(new Response("no", { status: 503 }));
    }
    if (value.includes("oversized")) {
      return Promise.resolve(
        new Response(null, {
          headers: { "content-length": String(MAX_DISCORD_IMAGE_BYTES + 1) },
        }),
      );
    }
    return Promise.resolve(
      new Response("not an image", {
        headers: { "content-type": "text/plain" },
      }),
    );
  }) as typeof fetch;

  const images = await prepareDiscordVisionImages([
    { url: "https://cdn.discordapp.com/failed.png", kind: "image" },
    { url: "https://cdn.discordapp.com/oversized.png", kind: "image" },
    { url: "https://cdn.discordapp.com/unsupported.png", kind: "image" },
  ], fetcher);

  assertEquals(images, []);
});

Deno.test("prepareDiscordVisionImages caps all attachments and GIF frames at four", async () => {
  const png = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: { r: 0, g: 0, b: 255 },
    },
  }).png().toBuffer();
  const body = new Uint8Array(png).buffer;
  let downloads = 0;
  const fetcher = (() => {
    downloads++;
    return Promise.resolve(
      new Response(body.slice(0), {
        headers: { "content-type": "image/png" },
      }),
    );
  }) as typeof fetch;
  const candidates = Array.from({ length: 6 }, (_, index) => ({
    url: `https://cdn.discordapp.com/attachments/${index}.png`,
    declaredType: "image/png",
    kind: "image" as const,
  }));

  const images = await prepareDiscordVisionImages(candidates, fetcher);

  assertEquals(images.length, 4);
  assertEquals(downloads, 4);
});
