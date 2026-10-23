import type { Database } from "@db/sqlite";
import type { ImageGenSettings } from "../llm/image-gen-settings.ts";

/**
 * Build the image-generation capability block: the enabled generators
 * (with the IDs generate_image expects) plus the anchor-image list.
 *
 * Classic turns ride this in the stable core; the Flux session composes
 * the SAME block into its late dynamic block (classic parity — without
 * it the session Ego knows the generate_image schema but has no
 * generator or anchor IDs to call it with). One builder for
 * both paths so the two contexts can never drift apart.
 *
 * Returns undefined when no generators are enabled — the block is
 * absent, never empty.
 */
export function buildImageGenContent(
  imageGenSettings: ImageGenSettings | undefined,
  rawDb: Database,
): string | undefined {
  if (!imageGenSettings?.generators.some((g) => g.enabled)) return undefined;
  const enabled = imageGenSettings.generators.filter((g) => g.enabled);
  let content = enabled.map((g) => {
    const nsfwTag = g.nsfw ? "NSFW-capable" : "SFW only";
    // Venice's inpaint parameter was deprecated May 2025 — it is the only
    // image-gen provider that cannot accept anchor/reference images.
    const anchorTag = g.provider === "venice"
      ? "text-to-image only (no anchor support)"
      : "accepts anchor images";
    return `- "${g.name}" (ID: ${g.id}): ${g.description} [${g.provider}, ${nsfwTag}, ${anchorTag}]`;
  }).join("\n");

  // Include available anchor images so the entity knows what IDs to use
  const anchors = rawDb.prepare(
    "SELECT id, label, description FROM anchor_images ORDER BY created_at DESC",
  ).all<{ id: string; label: string; description: string }>();
  if (anchors.length > 0) {
    content +=
      "\n\nAvailable anchor images (use IDs in anchor_ids parameter):\n" +
      anchors.map((a) =>
        `- "${a.label}" (ID: ${a.id}): ${a.description || "no description"}`
      ).join("\n");
  }

  content +=
    "\n\nTo generate an image, I use the generate_image tool with the appropriate generator_id. I can include anchor_images by ID as style references, and a user_image_path if the user provided an image with their message.";
  return content;
}
