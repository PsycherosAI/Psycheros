import sharp from "sharp";
import type { ChatImageUrlPart } from "../llm/types.ts";
import type { DiscordAttachment, DiscordEmbed } from "./gateway.ts";

export const MAX_DISCORD_VISION_IMAGES = 4;
// Leaves room for the data-URL header inside EntityTurn's 8,000,000-character
// limit while retaining the existing roughly-six-megabyte decoded boundary.
export const MAX_DISCORD_IMAGE_BYTES = 5_999_900;

export interface DiscordMediaCandidate {
  url: string;
  /** Ordered download choices; Discord proxies precede origin media URLs. */
  urls?: string[];
  declaredType?: string;
  filename?: string;
  kind: "image" | "gif";
}

export interface DiscordMessageMedia {
  attachments?: DiscordAttachment[];
  embeds?: DiscordEmbed[];
}

type Fetcher = typeof fetch;

const STATIC_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);
const SAFE_MEDIA_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
  "images-ext-1.discordapp.net",
  "images-ext-2.discordapp.net",
  "media.tenor.com",
  "c.tenor.com",
]);

function normalizedMediaType(value?: string): string | undefined {
  return value?.split(";", 1)[0].trim().toLowerCase();
}

function typeFromUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".gif")) return "image/gif";
    if (pathname.endsWith(".mp4")) return "video/mp4";
    if (pathname.endsWith(".png")) return "image/png";
    if (pathname.endsWith(".webp")) return "image/webp";
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) {
      return "image/jpeg";
    }
  } catch {
    // Invalid URLs are rejected before download.
  }
  return undefined;
}

function candidateFor(
  url: string | undefined,
  declaredType?: string,
  filename?: string,
): DiscordMediaCandidate | undefined {
  if (!url) return undefined;
  const type = normalizedMediaType(declaredType) ??
    typeFromUrl(filename ?? "") ??
    typeFromUrl(url);
  if (type === "image/gif") {
    return { url, declaredType: type, filename, kind: "gif" };
  }
  if (type && STATIC_TYPES.has(type)) {
    return { url, declaredType: type, filename, kind: "image" };
  }
  return undefined;
}

/** Collect image-bearing Discord attachments and Discord/Tenor embed previews. */
export function collectDiscordMediaCandidates(
  messages: DiscordMessageMedia[],
): DiscordMediaCandidate[] {
  const candidates: DiscordMediaCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate?: DiscordMediaCandidate) => {
    if (candidate && !seen.has(candidate.url)) {
      seen.add(candidate.url);
      candidates.push(candidate);
    }
  };

  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      add(candidateFor(
        attachment.proxy_url ?? attachment.url,
        attachment.content_type,
        attachment.filename,
      ));
    }
    for (const embed of message.embeds ?? []) {
      if (embed.type !== "image" && embed.type !== "gifv") continue;
      const orderedUrls = [
        embed.video?.proxy_url,
        embed.image?.proxy_url,
        embed.thumbnail?.proxy_url,
        embed.video?.url,
        embed.image?.url,
        embed.thumbnail?.url,
      ].filter((url): url is string => Boolean(url));
      if (orderedUrls.length === 0) continue;
      const candidate: DiscordMediaCandidate = {
        url: orderedUrls[0],
        urls: [...new Set(orderedUrls)],
        kind: embed.type === "gifv" ? "gif" : "image",
      };
      add(candidate);
    }
  }
  return candidates;
}

function assertSafeMediaUrl(rawUrl: string): void {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    !SAFE_MEDIA_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error(`media URL host is not allowed: ${url.hostname}`);
  }
}

async function readLimitedBody(response: Response): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) && contentLength > MAX_DISCORD_IMAGE_BYTES
  ) {
    throw new Error(`image exceeds ${MAX_DISCORD_IMAGE_BYTES} bytes`);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_DISCORD_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error(`image exceeds ${MAX_DISCORD_IMAGE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function toDataUrl(bytes: Uint8Array, mediaType: string): ChatImageUrlPart {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return {
    type: "image_url",
    image_url: { url: `data:${mediaType};base64,${btoa(binary)}` },
  };
}

export function representativeGifFrameIndexes(
  pageCount: number,
  limit: number,
): number[] {
  const count = Math.min(Math.max(0, pageCount), Math.max(0, limit));
  if (count === 0) return [];
  if (count === 1) return [0];
  return Array.from(
    { length: count },
    (_, index) => Math.round(index * (pageCount - 1) / (count - 1)),
  );
}

async function convertGifFrames(
  bytes: Uint8Array,
  limit: number,
): Promise<ChatImageUrlPart[]> {
  const metadata = await sharp(bytes, { animated: true }).metadata();
  const pages = metadata.pages ?? 1;
  const frames: ChatImageUrlPart[] = [];
  for (const page of representativeGifFrameIndexes(pages, limit)) {
    const frame = await sharp(bytes, { animated: true, page, pages: 1 })
      .webp()
      .toBuffer();
    if (frame.length > MAX_DISCORD_IMAGE_BYTES) {
      console.warn(
        `[DiscordVision] GIF frame ${page} skipped: converted frame is oversized`,
      );
      continue;
    }
    frames.push(toDataUrl(frame, "image/webp"));
  }
  return frames;
}

/** Download and normalize Discord media without allowing one failure to abort the turn. */
export async function prepareDiscordVisionImages(
  candidates: DiscordMediaCandidate[],
  fetcher: Fetcher = fetch,
): Promise<ChatImageUrlPart[]> {
  const images: ChatImageUrlPart[] = [];
  for (const candidate of candidates) {
    if (images.length >= MAX_DISCORD_VISION_IMAGES) break;
    const sourceUrls = candidate.urls?.length
      ? candidate.urls
      : [candidate.url];
    let accepted = false;
    for (const sourceUrl of sourceUrls) {
      try {
        assertSafeMediaUrl(sourceUrl);
        const response = await fetcher(sourceUrl, { redirect: "follow" });
        if (!response.ok) {
          throw new Error(`download returned HTTP ${response.status}`);
        }
        const bytes = await readLimitedBody(response);
        const responseType = normalizedMediaType(
          response.headers.get("content-type") ?? undefined,
        );
        const mediaType = responseType ?? candidate.declaredType ??
          typeFromUrl(sourceUrl);

        if (mediaType === "image/gif") {
          images.push(
            ...await convertGifFrames(
              bytes,
              MAX_DISCORD_VISION_IMAGES - images.length,
            ),
          );
          accepted = true;
          break;
        }
        if (!mediaType || !STATIC_TYPES.has(mediaType)) {
          throw new Error(
            `unsupported response type ${mediaType ?? "unknown"}`,
          );
        }
        const metadata = await sharp(bytes).metadata();
        const detectedType = metadata.format === "jpeg"
          ? "image/jpeg"
          : metadata.format === "png"
          ? "image/png"
          : metadata.format === "webp"
          ? "image/webp"
          : undefined;
        if (!detectedType) {
          throw new Error(
            `unsupported image format ${metadata.format ?? "unknown"}`,
          );
        }
        images.push(toDataUrl(bytes, detectedType));
        accepted = true;
        break;
      } catch (error) {
        console.warn(
          `[DiscordVision] Media source rejected (${candidate.kind}, host=${
            safeHost(sourceUrl)
          }):`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (!accepted) {
      console.warn(
        `[DiscordVision] Media skipped (${candidate.kind}): all sources failed`,
      );
    }
  }
  return images.slice(0, MAX_DISCORD_VISION_IMAGES);
}

function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "invalid";
  }
}
