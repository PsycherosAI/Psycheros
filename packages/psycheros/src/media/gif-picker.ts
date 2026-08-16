import { join } from "@std/path";

const GIPHY_SEARCH_URL = "https://api.giphy.com/v1/gifs/search";
const MAX_QUERY_LENGTH = 100;
const MAX_RESULTS = 12;
const MAX_GIF_BYTES = 15 * 1024 * 1024;
const TOKEN_TTL_MS = 5 * 60 * 1000;

export interface GifPickerCandidate {
  token: string;
  previewUrl: string;
  title: string;
  width?: number;
  height?: number;
}

interface StoredCandidate {
  mediaUrl: string;
  expiresAt: number;
}

export interface GifPickerDependencies {
  apiKey?: () => string;
  fetcher?: typeof fetch;
  now?: () => number;
  createToken?: () => string;
}

export class GifPickerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GifPickerError";
  }
}

function isGiphyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "giphy.com" || url.hostname.endsWith(".giphy.com"));
  } catch {
    return false;
  }
}

function gifSignatureIsValid(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false;
  const signature = new TextDecoder().decode(bytes.subarray(0, 6));
  return signature === "GIF87a" || signature === "GIF89a";
}

async function readBounded(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_GIF_BYTES) {
    throw new GifPickerError("GIF is too large", 413);
  }
  if (!response.body) throw new GifPickerError("GIF download was empty", 502);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_GIF_BYTES) {
        await reader.cancel();
        throw new GifPickerError("GIF is too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function createGifPickerService(
  dependencies: GifPickerDependencies = {},
) {
  const apiKey = dependencies.apiKey ??
    (() => Deno.env.get("GIPHY_API_KEY")?.trim() ?? "");
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;
  const createToken = dependencies.createToken ?? (() => crypto.randomUUID());
  const candidates = new Map<string, StoredCandidate>();

  function prune(): void {
    const timestamp = now();
    for (const [token, candidate] of candidates) {
      if (candidate.expiresAt <= timestamp) candidates.delete(token);
    }
    while (candidates.size > 200) {
      const first = candidates.keys().next().value;
      if (typeof first !== "string") break;
      candidates.delete(first);
    }
  }

  async function retrieve(token: string): Promise<{
    bytes: Uint8Array;
    mediaType: "image/gif";
    filename: string;
    publicUrl: string;
  }> {
    prune();
    if (!token || token.length > 200 || /\s/.test(token)) {
      throw new GifPickerError("Invalid GIF selection", 400);
    }
    const candidate = candidates.get(token);
    if (!candidate) throw new GifPickerError("GIF selection expired", 404);
    if (!isGiphyUrl(candidate.mediaUrl)) {
      candidates.delete(token);
      throw new GifPickerError("Invalid GIF source", 400);
    }

    let response: Response;
    try {
      response = await fetcher(candidate.mediaUrl, {
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new GifPickerError("GIF download failed", 502);
    }
    if (!response.ok || (response.url && !isGiphyUrl(response.url))) {
      throw new GifPickerError("GIF download failed", 502);
    }
    const contentType = response.headers.get("content-type")?.split(";")[0];
    if (contentType !== "image/gif") {
      throw new GifPickerError("GIF provider returned invalid media", 502);
    }

    const bytes = await readBounded(response);
    if (!gifSignatureIsValid(bytes)) {
      throw new GifPickerError("GIF provider returned invalid media", 502);
    }
    candidates.delete(token);
    return {
      bytes,
      mediaType: "image/gif",
      filename: "selected.gif",
      publicUrl: candidate.mediaUrl,
    };
  }

  return {
    status(): { enabled: boolean; configured: boolean } {
      return { enabled: true, configured: Boolean(apiKey()) };
    },

    async search(rawQuery: string): Promise<GifPickerCandidate[]> {
      const query = rawQuery.replace(/\s+/g, " ").trim();
      if (!query || query.length > MAX_QUERY_LENGTH) {
        throw new GifPickerError("Enter a GIF search of 1–100 characters", 400);
      }
      const key = apiKey();
      if (!key) {
        throw new GifPickerError("GIF provider credentials are missing", 503);
      }

      const url = new URL(GIPHY_SEARCH_URL);
      url.searchParams.set("api_key", key);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", String(MAX_RESULTS));
      url.searchParams.set("rating", "pg");

      let response: Response;
      try {
        response = await fetcher(url, {
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        throw new GifPickerError("GIF search is temporarily unavailable", 502);
      }
      if (!response.ok) {
        throw new GifPickerError("GIF search is temporarily unavailable", 502);
      }

      const payload = await response.json() as { data?: unknown[] };
      prune();
      const result: GifPickerCandidate[] = [];
      for (const raw of payload.data ?? []) {
        if (!raw || typeof raw !== "object") continue;
        const item = raw as Record<string, unknown>;
        const images = item.images as
          | Record<string, Record<string, unknown>>
          | undefined;
        const original = images?.original;
        const preview = images?.fixed_width ?? images?.downsized ?? original;
        const mediaUrl = typeof original?.url === "string" ? original.url : "";
        const previewUrl = typeof preview?.url === "string" ? preview.url : "";
        if (!isGiphyUrl(mediaUrl) || !isGiphyUrl(previewUrl)) continue;

        const token = createToken();
        candidates.set(token, { mediaUrl, expiresAt: now() + TOKEN_TTL_MS });
        result.push({
          token,
          previewUrl,
          title: typeof item.title === "string"
            ? item.title.slice(0, 200)
            : "GIF",
          width: Number(preview?.width) || undefined,
          height: Number(preview?.height) || undefined,
        });
      }
      prune();
      return result;
    },

    async attach(token: string, dataRoot: string): Promise<{
      attachmentId: string;
      filename: string;
      url: string;
    }> {
      const { bytes } = await retrieve(token);

      const attachmentId = crypto.randomUUID();
      const filename = `${attachmentId}.gif`;
      const directory = join(dataRoot, ".psycheros", "chat-attachments");
      await Deno.mkdir(directory, { recursive: true });
      await Deno.writeFile(join(directory, filename), bytes);
      return {
        attachmentId,
        filename,
        url: `/chat-attachments/${filename}`,
      };
    },
    retrieve,
  };
}

export type GifPickerService = ReturnType<typeof createGifPickerService>;
