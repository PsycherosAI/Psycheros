/**
 * Memory Chunker
 *
 * Splits long memory files into overlapping chunks for independent embedding.
 * Short memories pass through unchanged.
 *
 * Chunking respects markdown structure: ## headers are primary boundaries,
 * then - bullet lines, then paragraphs. Each chunk includes the title line
 * (if present) as context so embeddings retain topical grounding.
 */

import type { ChunkParams } from "./settings.ts";

/**
 * Default chunk parameters. Match the historical hardcoded values so
 * existing installs keep their existing chunk boundaries after upgrade.
 */
export const DEFAULT_CHUNK_PARAMS: ChunkParams = {
  thresholdChars: 3000,
  targetChars: 2048,
  minChars: 400,
  maxChars: 2800,
  overlapChars: 200,
};

export interface MemoryChunk {
  content: string;
  index: number;
  total: number;
}

/**
 * Whether a memory's content is long enough to require chunking.
 * Pass `params` to use a non-default threshold; omit for defaults.
 */
export function shouldChunk(content: string, params?: ChunkParams): boolean {
  const p = params ?? DEFAULT_CHUNK_PARAMS;
  return content.length > p.thresholdChars;
}

/**
 * Split memory content into chunks suitable for embedding.
 *
 * For content at or below the threshold, returns a single chunk (no splitting).
 * For longer content, splits at semantic boundaries with overlap.
 *
 * Pass `params` to use non-default chunk sizes; omit for defaults.
 */
export function chunkContent(
  content: string,
  params?: ChunkParams,
): MemoryChunk[] {
  const p = params ?? DEFAULT_CHUNK_PARAMS;
  if (!shouldChunk(content, p)) {
    return [{ content, index: 0, total: 1 }];
  }

  // Extract and strip the title line so it can be prepended to each chunk
  const titleMatch = content.match(/^# .+\n?/);
  const title = titleMatch ? titleMatch[0].trimEnd() + "\n" : "";
  const body = titleMatch ? content.slice(titleMatch[0].length) : content;

  // Split body into segments at ## headers (primary) then bullets (secondary)
  const segments = splitIntoSegments(body);

  // Pack segments into chunks with overlap
  const rawChunks = packSegments(segments, p);

  // Merge final chunk if too small
  const merged = mergeTailChunk(rawChunks, p);

  // Build output with title prepended
  return merged.map((text, index) => ({
    content: title + text.trim(),
    index,
    total: merged.length,
  }));
}

// ---- Internal helpers ----

type Segment = {
  text: string;
  isHeader: boolean;
  isBullet: boolean;
};

function splitIntoSegments(body: string): Segment[] {
  const lines = body.split("\n");
  const segments: Segment[] = [];
  let current: string[] = [];
  let currentIsBullet = false;

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,6})\s+.+$/);
    const isBullet = /^[-*+]\s+/.test(line);

    // Flush current segment at header boundaries
    if (headerMatch && current.length > 0) {
      segments.push({
        text: current.join("\n"),
        isHeader: false,
        isBullet: currentIsBullet,
      });
      current = [];
      currentIsBullet = false;
    }

    current.push(line);
    if (isBullet) currentIsBullet = true;
  }

  if (current.length > 0) {
    segments.push({
      text: current.join("\n"),
      isHeader: false,
      isBullet: currentIsBullet,
    });
  }

  return segments;
}

function packSegments(segments: Segment[], p: ChunkParams): string[] {
  if (segments.length === 0) return [];

  const chunks: string[] = [];
  let currentLines: string[] = [];
  let currentLen = 0;

  const flush = () => {
    if (currentLines.length > 0) {
      chunks.push(currentLines.join("\n"));
    }
    currentLines = [];
    currentLen = 0;
  };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    // Hard-split oversized segments at paragraph or bullet boundaries
    if (seg.text.length > p.maxChars) {
      flush();
      const subChunks = hardSplit(seg.text, p);
      chunks.push(...subChunks);
      continue;
    }

    const segLen = seg.text.length;

    // If adding this segment exceeds target and we have enough content, flush
    if (
      currentLen + segLen > p.targetChars &&
      currentLen >= p.minChars
    ) {
      // Record overlap from the tail of the current chunk
      const overlap = extractOverlap(currentLines.join("\n"), p.overlapChars);

      flush();

      if (overlap) {
        currentLines.push(overlap);
        currentLen = overlap.length;
      }
    }

    currentLines.push(seg.text);
    currentLen += segLen;
  }

  // Flush remaining
  flush();

  return chunks;
}

function extractOverlap(text: string, overlapChars: number): string {
  if (text.length <= overlapChars) return "";

  // Find a clean boundary near overlapChars from the end
  const start = text.length - overlapChars;
  const snippet = text.slice(start);

  // Try to break at a bullet boundary
  const bulletIdx = snippet.indexOf("\n- ");
  if (bulletIdx > 0) {
    return snippet.slice(bulletIdx + 1);
  }

  // Fall back to newline boundary
  const nlIdx = snippet.indexOf("\n");
  if (nlIdx > 0) {
    return snippet.slice(nlIdx + 1);
  }

  return snippet;
}

function hardSplit(text: string, p: ChunkParams): string[] {
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= p.maxChars) {
      parts.push(remaining);
      break;
    }

    // Try splitting at a bullet boundary within the limit
    let splitAt = remaining.lastIndexOf("\n- ", p.maxChars);
    if (splitAt <= 0) {
      // Try paragraph boundary
      splitAt = remaining.lastIndexOf("\n\n", p.maxChars);
    }
    if (splitAt <= 0) {
      // Try any newline
      splitAt = remaining.lastIndexOf("\n", p.maxChars);
    }
    if (splitAt <= 0) {
      splitAt = p.maxChars;
    }

    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return parts;
}

function mergeTailChunk(chunks: string[], p: ChunkParams): string[] {
  if (chunks.length <= 1) return chunks;

  const last = chunks[chunks.length - 1];
  if (last.length >= p.minChars) return chunks;

  // Merge final chunk into the previous one if the combined size is reasonable
  const combined = chunks[chunks.length - 2] + "\n\n" + last;
  if (combined.length <= p.maxChars + p.overlapChars) {
    return [...chunks.slice(0, -2), combined];
  }

  return chunks;
}
