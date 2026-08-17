/**
 * Entity-supplied image path resolution for Discord sends.
 *
 * image_path comes from an LLM tool call — treat it as untrusted input. A
 * crafted "../../" traversal must never escape the .psycheros/ data root
 * (it would upload arbitrary files to Discord). Both outbound Discord
 * image paths (DM + channel) resolve through here.
 */

import { isAbsolute, relative, resolve } from "@std/path";

type DiscordImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

const DISCORD_IMAGE_EXTENSIONS = new Map<string, DiscordImageMediaType>([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
]);

export interface ResolvedDiscordImage {
  /** Absolute path, verified to live strictly under <dataRoot>/.psycheros/. */
  absolutePath: string;
  /** Bare filename (last path segment) for the multipart upload. */
  filename: string;
  mediaType: DiscordImageMediaType;
}

/**
 * Validate the extension set directly — never getMediaType(), which defaults
 * unknown extensions to image/png and would let "notes.txt" pass as a png.
 */
export function resolveDiscordImagePath(
  dataRoot: string,
  relativePath: string,
): ResolvedDiscordImage {
  const trimmed = relativePath.trim();
  if (!trimmed) throw new Error("image path is empty");

  if (isAbsolute(trimmed)) {
    throw new Error(
      `image path '${trimmed}' must be relative to .psycheros/, not absolute`,
    );
  }

  // Fast, friendly rejection of ".." in either separator spelling; the
  // resolve/relative gate below is the authoritative containment check.
  if (trimmed.split(/[\\/]/).includes("..")) {
    throw new Error(
      `image path '${trimmed}' must stay inside .psycheros/ (no ".." segments)`,
    );
  }

  const filename = trimmed.split(/[\\/]/).pop() ?? "";
  const ext = filename.includes(".")
    ? filename.split(".").pop()?.toLowerCase() ?? ""
    : "";
  const mediaType = DISCORD_IMAGE_EXTENSIONS.get(ext);
  if (!mediaType) {
    throw new Error(
      `unsupported image type for '${trimmed}' — supported: png, jpg, jpeg, webp, gif`,
    );
  }

  const root = resolve(dataRoot, ".psycheros");
  const absolutePath = resolve(root, trimmed);
  const rel = relative(root, absolutePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `image path '${trimmed}' escapes the .psycheros/ directory`,
    );
  }

  return { absolutePath, filename, mediaType };
}
