/**
 * Identity Metadata
 *
 * Manages prompt label metadata for identity files.
 * Prompt labels are the XML tag names used to wrap identity content
 * when building the LLM context (e.g., "human_identity" for <human_identity>,
 * or any name a user prefers).
 *
 * Files on disk store inner content only. The prompt label determines
 * what XML tags wrap the content at context-build time.
 */

import { join } from "@std/path";

/**
 * Metadata mapping category/filename to prompt label.
 * Key format: "category/filename" (e.g., "user/user_identity.md")
 * Value: prompt label (e.g., "human_identity")
 */
export type IdentityMeta = Record<string, string>;

const META_FILENAME = "identity-meta.json";

/**
 * Load identity metadata from disk.
 * Returns an empty record if the file doesn't exist yet.
 */
export async function loadIdentityMeta(dataDir: string): Promise<IdentityMeta> {
  const filePath = join(dataDir, META_FILENAME);

  try {
    const content = await Deno.readTextFile(filePath);
    return JSON.parse(content) as IdentityMeta;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {};
    }
    throw error;
  }
}

/**
 * Save identity metadata to disk.
 */
export async function saveIdentityMeta(
  dataDir: string,
  meta: IdentityMeta,
): Promise<void> {
  const filePath = join(dataDir, META_FILENAME);
  await Deno.writeTextFile(filePath, JSON.stringify(meta, null, 2) + "\n");
}

/**
 * Get the prompt label for a specific identity file.
 * Defaults to the filename without .md extension if no custom label is set.
 */
export function getPromptLabel(
  meta: IdentityMeta,
  category: string,
  filename: string,
): string {
  const key = `${category}/${filename}`;
  return meta[key] ?? filename.replace(/\.md$/, "");
}

/**
 * Get prompt labels for a list of identity files.
 * Returns a map of category/filename → prompt label.
 */
export function getPromptLabels(
  meta: IdentityMeta,
  files: Array<{ category: string; filename: string }>,
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const file of files) {
    const key = `${file.category}/${file.filename}`;
    labels[key] = getPromptLabel(meta, file.category, file.filename);
  }
  return labels;
}
