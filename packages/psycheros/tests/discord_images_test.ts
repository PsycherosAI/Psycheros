/**
 * Tests for discord/images.ts — attachment planning for entity turns.
 */

import { assertEquals } from "@std/assert";
import type { DiscordAttachment } from "../src/discord/gateway.ts";
import {
  MAX_DISCORD_IMAGE_BYTES,
  planTurnAttachments,
} from "../src/discord/images.ts";

const KB = 1024;

function attachment(
  id: string,
  filename: string,
  overrides: Partial<DiscordAttachment> = {},
): DiscordAttachment {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const fallbackType = ext === "png"
    ? "image/png"
    : ext === "jpg" || ext === "jpeg"
    ? "image/jpeg"
    : ext === "webp"
    ? "image/webp"
    : ext === "gif"
    ? "image/gif"
    : null;
  return {
    id,
    filename,
    content_type: fallbackType,
    url: `https://cdn.discordapp.com/attachments/1/2/${filename}?sig=${id}`,
    size: 100 * KB,
    ...overrides,
  };
}

Deno.test("planTurnAttachments: numbers markers in turnImages order", () => {
  const plan = planTurnAttachments([
    {
      messageId: "m1",
      attachments: [attachment("a1", "cat.png"), attachment("a2", "doc.pdf")],
    },
    {
      messageId: "m2",
      attachments: [attachment("a3", "dog.jpg")],
    },
  ]);

  assertEquals(plan.turnImages.length, 2);
  assertEquals(plan.turnImages[0].attachmentId, "a1");
  assertEquals(plan.turnImages[0].contentType, "image/png");
  assertEquals(plan.turnImages[1].attachmentId, "a3");
  assertEquals(plan.turnImages[1].contentType, "image/jpeg");

  assertEquals(plan.markersByMessageId.get("m1"), [
    "[image 1 attached: cat.png]",
    "[file attached: doc.pdf (100.0 KB)]",
  ]);
  assertEquals(plan.markersByMessageId.get("m2"), [
    "[image 2 attached: dog.jpg]",
  ]);
});

Deno.test("planTurnAttachments: keeps the last 4 over the cap", () => {
  const plan = planTurnAttachments([
    {
      messageId: "m1",
      attachments: [1, 2, 3, 4, 5, 6].map((n) =>
        attachment(`a${n}`, `pic${n}.png`)
      ),
    },
  ]);

  assertEquals(
    plan.turnImages.map((image) => image.attachmentId),
    ["a3", "a4", "a5", "a6"],
  );
  assertEquals(plan.markersByMessageId.get("m1"), [
    "[image attached: pic1.png (image limit reached)]",
    "[image attached: pic2.png (image limit reached)]",
    "[image 1 attached: pic3.png]",
    "[image 2 attached: pic4.png]",
    "[image 3 attached: pic5.png]",
    "[image 4 attached: pic6.png]",
  ]);
});

Deno.test("planTurnAttachments: oversize image gets a too-large marker", () => {
  const plan = planTurnAttachments([
    {
      messageId: "m1",
      attachments: [
        attachment("big", "huge.png", { size: MAX_DISCORD_IMAGE_BYTES + 1 }),
      ],
    },
  ]);

  assertEquals(plan.turnImages.length, 0);
  assertEquals(plan.markersByMessageId.get("m1"), [
    `[image attached: huge.png (${
      ((MAX_DISCORD_IMAGE_BYTES + 1) / (1024 * 1024)).toFixed(1)
    } MB, too large)]`,
  ]);
});

Deno.test("planTurnAttachments: gif gets a format marker, not a file marker", () => {
  const plan = planTurnAttachments([
    { messageId: "m1", attachments: [attachment("g1", "anim.gif")] },
  ]);

  assertEquals(plan.turnImages.length, 0);
  assertEquals(plan.markersByMessageId.get("m1"), [
    "[image attached: anim.gif (format not supported)]",
  ]);
});

Deno.test("planTurnAttachments: extension fallback when content_type is null", () => {
  const plan = planTurnAttachments([
    {
      messageId: "m1",
      attachments: [
        attachment("a1", "photo.webp", { content_type: null }),
        attachment("a2", "mystery.avif", { content_type: null }),
        attachment("a3", "noext", { content_type: null }),
      ],
    },
  ]);

  assertEquals(plan.turnImages.length, 1);
  assertEquals(plan.turnImages[0].contentType, "image/webp");
  // .avif must not fall through to a vision candidate via the png-defaulting
  // getMediaType() — it's an image, just not one I can send.
  assertEquals(plan.markersByMessageId.get("m1"), [
    "[image 1 attached: photo.webp]",
    "[image attached: mystery.avif (format not supported)]",
    "[file attached: noext (100.0 KB)]",
  ]);
});

Deno.test("planTurnAttachments: normalizes image/jpg to image/jpeg", () => {
  const plan = planTurnAttachments([
    {
      messageId: "m1",
      attachments: [attachment("a1", "pic.jpg", { content_type: "image/jpg" })],
    },
  ]);

  assertEquals(plan.turnImages[0].contentType, "image/jpeg");
});

Deno.test("planTurnAttachments: empty and absent attachments", () => {
  const plan = planTurnAttachments([
    { messageId: "m1", attachments: [] },
    { messageId: "m2" },
  ]);

  assertEquals(plan.turnImages.length, 0);
  assertEquals(plan.markersByMessageId.size, 0);
});

Deno.test("planTurnAttachments: image without a URL is unavailable, not selected", () => {
  const plan = planTurnAttachments([
    {
      messageId: "m1",
      attachments: [attachment("a1", "ghost.png", { url: "" })],
    },
  ]);

  assertEquals(plan.turnImages.length, 0);
  assertEquals(plan.markersByMessageId.get("m1"), [
    "[image attached: ghost.png (unavailable)]",
  ]);
});

Deno.test("planTurnAttachments: records declined attachments as plugin candidates", () => {
  const plan = planTurnAttachments([
    {
      messageId: "m1",
      attachments: [
        attachment("a1", "cat.png"),
        attachment("g1", "anim.gif"),
        attachment("v1", "voice-message.ogg", { content_type: "audio/ogg" }),
        attachment("v2", "clip.ogg", { content_type: null }),
        attachment("f1", "doc.pdf", { content_type: null }),
        attachment("f2", "ghost.ogg", { content_type: null, url: "" }),
      ],
    },
  ]);

  // Vision attachments are never plugin candidates; no URL means no candidate.
  assertEquals(
    plan.pluginCandidates.map((c) => c.attachmentId),
    ["g1", "v1", "v2", "f1"],
  );
  // Declared content type wins; the extension derives audio/ogg and
  // application/pdf when content_type is null.
  assertEquals(plan.pluginCandidates.map((c) => c.contentType), [
    "image/gif",
    "audio/ogg",
    "audio/ogg",
    "application/pdf",
  ]);
  // markerIndex points at the native fallback marker it would replace.
  const m1 = plan.markersByMessageId.get("m1")!;
  assertEquals(
    m1[plan.pluginCandidates[0]!.markerIndex],
    "[image attached: anim.gif (format not supported)]",
  );
  assertEquals(
    m1[plan.pluginCandidates[1]!.markerIndex],
    "[file attached: voice-message.ogg (100.0 KB)]",
  );
});
