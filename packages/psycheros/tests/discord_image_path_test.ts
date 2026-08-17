/**
 * Tests for resolveDiscordImagePath — the containment gate for
 * entity-supplied image paths on outbound Discord sends.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { resolveDiscordImagePath } from "../src/tools/discord-image-path.ts";

Deno.test("resolveDiscordImagePath resolves valid relative paths under .psycheros", () => {
  const resolved = resolveDiscordImagePath(
    "/data",
    "generated-images/abc.png",
  );
  assertEquals(
    resolved.absolutePath,
    join("/data/.psycheros/generated-images/abc.png"),
  );
  assertEquals(resolved.filename, "abc.png");
  assertEquals(resolved.mediaType, "image/png");

  assertEquals(
    resolveDiscordImagePath("/data", "generated-images/photo.JPG").mediaType,
    "image/jpeg",
  );
  assertEquals(
    resolveDiscordImagePath("/data", "x/anim.gif").mediaType,
    "image/gif",
  );
  assertEquals(
    resolveDiscordImagePath("/data", "y/pic.webp").mediaType,
    "image/webp",
  );
});

Deno.test("resolveDiscordImagePath rejects traversal in every spelling", () => {
  const root = "/data";
  // Relative parent escape.
  assertThrows(
    () => resolveDiscordImagePath(root, "../secrets.txt"),
    Error,
    'no ".." segments',
  );
  // Mixed-segment escape.
  assertThrows(
    () => resolveDiscordImagePath(root, "generated-images/../../deno.json"),
    Error,
    'no ".." segments',
  );
  // Backslash spelling (Windows-style).
  assertThrows(
    () => resolveDiscordImagePath(root, "..\\..\\deno.json"),
    Error,
    'no ".." segments',
  );
  // Absolute paths.
  assertThrows(
    () => resolveDiscordImagePath(root, "/etc/passwd"),
    Error,
    "must be relative",
  );
  // The root itself.
  assertThrows(
    () => resolveDiscordImagePath(root, "."),
    Error,
  );
});

Deno.test("resolveDiscordImagePath validates the extension set directly", () => {
  // Unknown extensions are rejected — never png-defaulted (the getMediaType
  // trap this helper exists to close).
  const error = assertThrows(
    () => resolveDiscordImagePath("/data", "notes.txt"),
    Error,
    "unsupported image type",
  );
  assertStringIncludes(error.message, "notes.txt");

  assertThrows(
    () => resolveDiscordImagePath("/data", "generated-images/noext"),
    Error,
    "unsupported image type",
  );
  assertThrows(
    () => resolveDiscordImagePath("/data", ""),
    Error,
    "empty",
  );
});
