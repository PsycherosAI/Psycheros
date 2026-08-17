/**
 * Discord Turn Images
 *
 * I turn image attachments from Discord messages into content the entity
 * can perceive. Discord's CDN URLs are signed and expire (~24h), so I
 * download at turn time and convert to base64 data URLs — provider-agnostic
 * and never persisted. Failed downloads skip the image, never the turn.
 *
 * Every attachment — image or not — gets a textual marker in the transcript,
 * so the record of "an image was shared here" survives even when the model
 * can't see pixels and captioning is off.
 */

import type { DiscordAttachment } from "./gateway.ts";
import type { CaptioningSettings } from "../llm/image-gen-settings.ts";
import type { ChatImageUrlPart } from "../llm/types.ts";
import { getMediaType, uint8ToBase64 } from "../tools/generate-image.ts";
import { captionImageDual } from "../tools/describe-image.ts";

/** How many images I attach to one entity turn (matches the web chat cap) */
export const MAX_DISCORD_TURN_IMAGES = 4;
/** Pre/post-download size cap per image */
export const MAX_DISCORD_IMAGE_BYTES = 8 * 1024 * 1024;
/** Per-fetch timeout — a hung CDN connection must not stall the turn */
const DOWNLOAD_TIMEOUT_MS = 15_000;

const VISION_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);
const VISION_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
const IMAGE_EXTENSIONS = new Set([
  "gif",
  "avif",
  "heic",
  "heif",
  "bmp",
  "tif",
  "tiff",
  "svg",
  "jfif",
]);

/** Image metadata I carry from the router into the server for one turn. */
export interface DiscordTurnImage {
  attachmentId: string;
  messageId: string;
  url: string;
  filename: string;
  /** Normalized vision-safe media type (always jpeg/png/webp) */
  contentType: string;
  size: number;
}

/** Channel context carried into plugin attachment enrichment. */
export interface AttachmentEnrichmentChannel {
  channelId: string;
  channelName: string;
  serverName: string | null;
  isDM: boolean;
}

/**
 * An attachment the native walk declined — a non-vision image format or a
 * non-image file — eligible for plugin enrichment. The host only consults
 * plugins for these; native vision handling is never intercepted.
 */
export interface DiscordPluginAttachment {
  messageId: string;
  /** Index into that message's markers array in markersByMessageId. */
  markerIndex: number;
  attachmentId: string;
  filename: string;
  /** Signed CDN URL — expires ~24h; plugins download at hook time. */
  url: string;
  size: number;
  /** Effective content type: declared content_type, else extension-derived. */
  contentType: string;
}

/** Marker lines per message + the images selected for this turn. */
export interface TurnAttachmentPlan {
  markersByMessageId: Map<string, string[]>;
  turnImages: DiscordTurnImage[];
  /** Attachments the native path declined, in marker-walk order. */
  pluginCandidates: DiscordPluginAttachment[];
}

/** A downloaded image, ready for vision parts or captioning. */
export interface DownloadedImage {
  base64: string;
  mediaType: string;
  filename: string;
}

/**
 * Classify an attachment for the turn. "vision" = image I can send to the
 * model; "image" = an image in a format I can't send (gif, avif, …); "file" =
 * not an image at all. getMediaType() defaults unknown extensions to
 * image/png, so I check extensions explicitly — a stray .avif must not
 * masquerade as a png.
 */
function resolveAttachmentKind(
  attachment: DiscordAttachment,
): "vision" | "image" | "file" {
  const declared = attachment.content_type?.toLowerCase().split(";")[0]?.trim();
  if (declared?.startsWith("image/")) {
    return VISION_CONTENT_TYPES.has(declared) ? "vision" : "image";
  }
  const ext = attachment.filename.split(".").pop()?.toLowerCase() ?? "";
  if (VISION_EXTENSIONS.has(ext)) return "vision";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "file";
}

/** Normalized vision-safe media type — only valid for "vision" kind. */
function visionMediaType(attachment: DiscordAttachment): string {
  const declared = attachment.content_type?.toLowerCase().split(";")[0]?.trim();
  if (declared && VISION_CONTENT_TYPES.has(declared)) {
    return declared === "image/jpg" ? "image/jpeg" : declared;
  }
  const ext = attachment.filename.split(".").pop()?.toLowerCase() ?? "png";
  return ext === "jpg" ? "image/jpeg" : `image/${ext}`;
}

/**
 * Extension→content-type map for the attachments the native walk declines.
 * Discord voice messages arrive as `voice-message.ogg` with a declared
 * `audio/ogg`, but the declared type is absent often enough that the
 * extension branch is the workhorse for matching plugin claims.
 */
const EXTENSION_CONTENT_TYPES = new Map<string, string>([
  // Non-vision image formats (mirrors IMAGE_EXTENSIONS).
  ["gif", "image/gif"],
  ["avif", "image/avif"],
  ["heic", "image/heic"],
  ["heif", "image/heif"],
  ["bmp", "image/bmp"],
  ["tif", "image/tiff"],
  ["tiff", "image/tiff"],
  ["svg", "image/svg+xml"],
  ["jfif", "image/jpeg"],
  // Audio.
  ["ogg", "audio/ogg"],
  ["oga", "audio/ogg"],
  ["opus", "audio/ogg"],
  ["mp3", "audio/mpeg"],
  ["m4a", "audio/mp4"],
  ["wav", "audio/wav"],
  ["flac", "audio/flac"],
  ["aac", "audio/aac"],
  // Video.
  ["mp4", "video/mp4"],
  ["mov", "video/quicktime"],
  ["webm", "video/webm"],
  // Common documents.
  ["pdf", "application/pdf"],
  ["zip", "application/zip"],
  ["txt", "text/plain"],
  ["json", "application/json"],
]);

/** Effective content type: declared content_type, else extension-derived. */
function effectiveContentType(attachment: DiscordAttachment): string {
  const declared = attachment.content_type?.toLowerCase().split(";")[0]?.trim();
  if (declared) return declared;
  const ext = attachment.filename.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_CONTENT_TYPES.get(ext) ?? "application/octet-stream";
}

export function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Plan attachment markers and turn images for a flushed buffer. Marker
 * number N always corresponds to index N-1 of turnImages, so the entity can
 * correlate the numbered markers in the transcript with the vision parts
 * (or captions) attached to the turn. When more images qualify than the
 * cap allows, I keep the most recent ones.
 */
export function planTurnAttachments(
  messages: ReadonlyArray<
    { messageId: string; attachments?: DiscordAttachment[] }
  >,
): TurnAttachmentPlan {
  const candidates: DiscordTurnImage[] = [];
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (
        resolveAttachmentKind(attachment) !== "vision" || !attachment.url ||
        attachment.size > MAX_DISCORD_IMAGE_BYTES
      ) continue;
      candidates.push({
        attachmentId: attachment.id,
        messageId: message.messageId,
        url: attachment.url,
        filename: attachment.filename,
        contentType: visionMediaType(attachment),
        size: attachment.size,
      });
    }
  }

  const selected = candidates.length > MAX_DISCORD_TURN_IMAGES
    ? candidates.slice(candidates.length - MAX_DISCORD_TURN_IMAGES)
    : candidates;
  const selectedIds = new Set(selected.map((image) => image.attachmentId));

  const markersByMessageId = new Map<string, string[]>();
  const pluginCandidates: DiscordPluginAttachment[] = [];
  let imageNumber = 0;
  for (const message of messages) {
    const markers: string[] = [];
    for (const attachment of message.attachments ?? []) {
      const kind = resolveAttachmentKind(attachment);
      if (kind === "file" || kind === "image") {
        // Offer declined attachments to plugin hooks later in the flush —
        // but only when there's a URL to hand over.
        if (attachment.url) {
          pluginCandidates.push({
            messageId: message.messageId,
            markerIndex: markers.length,
            attachmentId: attachment.id,
            filename: attachment.filename,
            url: attachment.url,
            size: attachment.size,
            contentType: effectiveContentType(attachment),
          });
        }
      }
      if (kind === "file") {
        markers.push(
          `[file attached: ${attachment.filename} (${
            formatByteSize(attachment.size)
          })]`,
        );
      } else if (kind === "image") {
        markers.push(
          `[image attached: ${attachment.filename} (format not supported)]`,
        );
      } else if (!attachment.url) {
        markers.push(`[image attached: ${attachment.filename} (unavailable)]`);
      } else if (attachment.size > MAX_DISCORD_IMAGE_BYTES) {
        markers.push(
          `[image attached: ${attachment.filename} (${
            formatByteSize(attachment.size)
          }, too large)]`,
        );
      } else if (!selectedIds.has(attachment.id)) {
        markers.push(
          `[image attached: ${attachment.filename} (image limit reached)]`,
        );
      } else {
        imageNumber++;
        markers.push(`[image ${imageNumber} attached: ${attachment.filename}]`);
      }
    }
    if (markers.length > 0) markersByMessageId.set(message.messageId, markers);
  }

  return { markersByMessageId, turnImages: selected, pluginCandidates };
}

/**
 * Download one image as base64. Returns null (with a log line) on any
 * failure — the turn proceeds, the marker stays truthful.
 */
export async function downloadTurnImage(
  image: DiscordTurnImage,
): Promise<DownloadedImage | null> {
  try {
    const response = await fetch(image.url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error("empty response body");
    if (bytes.byteLength > MAX_DISCORD_IMAGE_BYTES) {
      throw new Error(
        `downloaded ${formatByteSize(bytes.byteLength)} — over cap`,
      );
    }
    const headerType = response.headers.get("content-type")?.toLowerCase()
      .split(";")[0]?.trim();
    const mediaType = headerType && VISION_CONTENT_TYPES.has(headerType)
      ? headerType === "image/jpg" ? "image/jpeg" : headerType
      : image.contentType || getMediaType(image.filename);
    return {
      base64: uint8ToBase64(bytes),
      mediaType,
      filename: image.filename,
    };
  } catch (error) {
    console.error(
      `[Discord] Failed to download image attachment "${image.filename}" (${image.attachmentId}):`,
      error instanceof Error ? error.message : String(error),
      "— skipping",
    );
    return null;
  }
}

/**
 * Download all turn images as transient vision parts, order-preserving.
 * Images that fail to download are dropped — never the turn.
 */
export async function downloadTurnImages(
  images: readonly DiscordTurnImage[],
): Promise<ChatImageUrlPart[]> {
  const results = await Promise.allSettled(images.map(downloadTurnImage));
  const parts: ChatImageUrlPart[] = [];
  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value) continue;
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${result.value.mediaType};base64,${result.value.base64}`,
      },
    });
  }
  return parts;
}

/**
 * Download and caption the turn's images, producing a text block to append
 * to the turn message — the image-content channel for models that can't see
 * pixels. Numbering matches the numbered markers already in the transcript.
 * Returns "" when nothing could be captioned.
 */
export async function captionTurnImages(
  images: readonly DiscordTurnImage[],
  settings: CaptioningSettings,
): Promise<string> {
  const results = await Promise.allSettled(
    images.map(async (image) => {
      const downloaded = await downloadTurnImage(image);
      if (!downloaded) throw new Error("download failed");
      const caption = await captionImageDual(
        downloaded.base64,
        downloaded.mediaType,
        settings,
      );
      return { image, caption };
    }),
  );

  const lines: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      lines.push(
        `[image ${
          i + 1
        }: ${result.value.image.filename}] ${result.value.caption.long}`,
      );
    } else {
      console.error(
        `[Discord] Image captioning failed for "${
          images[i].filename
        }" — keeping marker only:`,
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
      );
    }
  }

  if (lines.length === 0) return "";
  return (
    `\n\n[Image captions — generated by an image captioning service because the current model cannot see images directly:]\n` +
    lines.join("\n")
  );
}
