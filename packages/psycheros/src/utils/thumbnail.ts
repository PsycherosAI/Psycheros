import sharp from "sharp";
import { dirname } from "@std/path";

const THUMB_SIZE = 400;
const THUMB_QUALITY = 78;

const inFlight = new Map<string, Promise<void>>();

/**
 * Generate a 400px WebP thumbnail at destPath from the source image.
 *
 * Idempotent: returns immediately if destPath already exists. Concurrent calls
 * for the same destPath share a single underlying sharp invocation via the
 * in-flight map.
 *
 * Throws on failure (caller decides whether to swallow).
 */
export async function generateThumbnail(
  sourcePath: string,
  destPath: string,
): Promise<void> {
  try {
    await Deno.stat(destPath);
    return;
  } catch {
    // destPath doesn't exist — fall through and generate
  }

  const existing = inFlight.get(destPath);
  if (existing) return existing;

  const promise = (async () => {
    try {
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await sharp(sourcePath)
        .resize(THUMB_SIZE, THUMB_SIZE, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: THUMB_QUALITY })
        .toFile(destPath);
    } finally {
      inFlight.delete(destPath);
    }
  })();

  inFlight.set(destPath, promise);
  return promise;
}
