/**
 * Image-generation kit context tests.
 *
 * The kit block (enabled generators + anchor IDs) is what the entity
 * reads to call generate_image. Classic rides it in the stable core;
 * the Flux session composes the SAME block into its late dynamic block
 * (classic parity — without it the session Ego knows the
 * tool schema but has no IDs, and generates anchorless "cursed" images).
 *
 * Covers: the builder's exact block shape (generators, anchors,
 * instructions), the no-generators early-out, and the block's slot in
 * the dynamic context (working-set region, before plugin hooks).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Database } from "@db/sqlite";
import { initializeSchema } from "../src/db/schema.ts";
import { buildImageGenContent } from "../src/entity/image-gen-context.ts";
import { buildDynamicBlock } from "../src/entity/turn-context.ts";
import type { ImageGenSettings } from "../src/llm/image-gen-settings.ts";

function makeRawDb(): Database {
  const db = new Database(":memory:");
  initializeSchema(db);
  db.exec(
    `INSERT INTO anchor_images (id, label, description, filename, file_size, created_at)
     VALUES ('aaa', 'Sample Daemonform', 'Male-coded Daemonform sample', 'a.jpg', 1, '2026-01-01'),
            ('bbb', 'Companion', '', 'b.jpg', 1, '2026-01-02')`,
  );
  return db;
}

const settings = {
  generators: [
    {
      id: "gen-1",
      name: "Gemini Nano Banana Pro",
      description: "General use pics. Anime-style is preferred.",
      provider: "gemini",
      enabled: true,
      nsfw: false,
      settings: {},
    },
    {
      id: "gen-2",
      name: "Venice",
      description: "text-to-image only",
      provider: "venice",
      enabled: true,
      nsfw: false,
      settings: {},
    },
  ],
} as unknown as ImageGenSettings;

Deno.test("buildImageGenContent: exact block — generators, anchors, instructions", () => {
  const db = makeRawDb();
  const content = buildImageGenContent(settings, db);
  assertEquals(
    content,
    `- "Gemini Nano Banana Pro" (ID: gen-1): General use pics. Anime-style is preferred. [gemini, SFW only, accepts anchor images]
- "Venice" (ID: gen-2): text-to-image only [venice, SFW only, text-to-image only (no anchor support)]

Available anchor images (use IDs in anchor_ids parameter):
- "Companion" (ID: bbb): no description
- "Sample Daemonform" (ID: aaa): Male-coded Daemonform sample

To generate an image, I use the generate_image tool with the appropriate generator_id. I can include anchor_images by ID as style references, and a user_image_path if the user provided an image with their message.`,
  );
  db.close();
});

Deno.test("buildImageGenContent: undefined when no generators enabled", () => {
  const db = makeRawDb();
  const allOff = {
    generators: [{ ...settings.generators[0], enabled: false }],
  } as unknown as ImageGenSettings;
  assertEquals(buildImageGenContent(allOff, db), undefined);
  assertEquals(buildImageGenContent(undefined, db), undefined);
  db.close();
});

Deno.test("buildDynamicBlock: the kit renders in the working set, before plugin hooks", () => {
  const block = buildDynamicBlock({
    heldSkillsContent: "<held_skills>procedures</held_skills>",
    imageGenContent: 'My available image generators:\n\n- "gen" (ID: x)',
    pluginContent: "a plugin hook",
  });
  const kitAt = block.indexOf("<image_generation>");
  const heldAt = block.indexOf("<held_skills>");
  const pluginAt = block.indexOf("<plugin_context>");
  assertStringIncludes(block, "<image_generation>");
  assertStringIncludes(block, "My available image generators:");
  assertEquals(kitAt > heldAt && kitAt < pluginAt, true);
});
