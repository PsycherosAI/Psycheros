/**
 * Memory Chunker
 *
 * Splits memory files into chunks suitable for embedding and retrieval.
 * Respects markdown structure (headers, bullet points) as semantic boundaries.
 */

import type { Chunk, Chunker, ChunkMetadata } from "./types.ts";

/**
 * Estimated characters per token (rough heuristic for English). Used to
 * convert char-based ChunkParams into the token-based targets this chunker's
 * internals grew around.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Char-based defaults. Match the historical hardcoded values (target 512
 * tokens × 4 chars/token = 2048) so existing vault chunks keep their existing
 * boundaries after upgrade.
 */
export interface VaultChunkParams {
  /** Target chunk size in characters. */
  targetChars: number;
  /** Minimum chunk size in characters — smaller tails get merged. */
  minChars: number;
  /** Hard maximum chunk size in characters. */
  maxChars: number;
}

export const DEFAULT_VAULT_CHUNK_PARAMS: VaultChunkParams = {
  targetChars: 2048,
  minChars: 100,
  maxChars: 2048,
};

/**
 * Estimate the token count of a text string.
 * Uses a simple heuristic: ~4 characters per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Memory chunker that respects markdown structure. Accepts chunk-size params
 * at construction; defaults preserve historical behavior.
 */
export class MemoryChunker implements Chunker {
  private readonly targetTokens: number;
  private readonly minChars: number;
  private readonly maxChars: number;

  constructor(params: VaultChunkParams = DEFAULT_VAULT_CHUNK_PARAMS) {
    this.targetTokens = Math.max(
      1,
      Math.floor(params.targetChars / CHARS_PER_TOKEN),
    );
    this.minChars = params.minChars;
    this.maxChars = params.maxChars;
  }

  /**
   * Chunk text into smaller pieces suitable for embedding.
   *
   * Strategy:
   * 1. Split on markdown headers (##) as primary boundaries
   * 2. Split on bullet points as secondary boundaries
   * 3. Split on paragraphs as tertiary boundaries
   * 4. Merge small chunks, split large ones
   *
   * @param text - The markdown text to chunk
   * @param sourceFile - The source file name
   * @returns Array of chunks
   */
  chunk(text: string, sourceFile: string): Chunk[] {
    const chunks: Chunk[] = [];
    const lines = text.split("\n");
    const sections: { header: string; content: string[] }[] = [];

    // Parse into sections by header
    let currentSection = { header: "", content: [] as string[] };

    for (const line of lines) {
      // Check for markdown header (## style)
      const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headerMatch) {
        // Save previous section if it has content
        if (currentSection.content.length > 0) {
          sections.push(currentSection);
        }
        currentSection = { header: headerMatch[2].trim(), content: [] };
      } else if (line.trim()) {
        currentSection.content.push(line);
      }
    }

    // Add final section
    if (currentSection.content.length > 0) {
      sections.push(currentSection);
    }

    // Process each section into chunks
    let lineNumber = 1;
    for (const section of sections) {
      const sectionChunks = this.chunkSection(section, sourceFile, lineNumber);
      chunks.push(...sectionChunks);
      lineNumber += section.content.length + 1; // +1 for header line
    }

    return chunks;
  }

  /**
   * Chunk a single section into appropriately sized pieces.
   */
  private chunkSection(
    section: { header: string; content: string[] },
    sourceFile: string,
    startLine: number,
  ): Chunk[] {
    const chunks: Chunk[] = [];
    let currentChunk: string[] = [];
    let currentTokens = 0;

    // Process content line by line
    for (let i = 0; i < section.content.length; i++) {
      const line = section.content[i];
      const lineTokens = estimateTokens(line);

      // Check if this is a bullet point (potential chunk boundary)
      const isBullet = line.match(/^[-*+]\s+/);

      // If adding this line would exceed target and we have content, finalize chunk
      if (
        currentTokens + lineTokens > this.targetTokens &&
        currentChunk.length > 0 &&
        currentTokens >= this.minChars / CHARS_PER_TOKEN
      ) {
        // Create chunk from accumulated content
        chunks.push(
          this.createChunk(
            currentChunk,
            sourceFile,
            section.header,
            startLine + i,
          ),
        );
        currentChunk = [];
        currentTokens = 0;
      }

      currentChunk.push(line);
      currentTokens += lineTokens;

      // If it's a bullet point and we're at a good size, consider it a chunk boundary
      if (
        isBullet &&
        currentTokens >= this.targetTokens * 0.5 &&
        currentTokens <= this.targetTokens * 1.5
      ) {
        // Check if next line is also a bullet or empty (end of bullet group)
        const nextLine = section.content[i + 1];
        if (
          !nextLine || nextLine.match(/^[-*+]\s+/) || nextLine.trim() === ""
        ) {
          chunks.push(
            this.createChunk(
              currentChunk,
              sourceFile,
              section.header,
              startLine + i,
            ),
          );
          currentChunk = [];
          currentTokens = 0;
        }
      }

      // Hard limit: force chunk if too large
      if (currentTokens > this.targetTokens * 2) {
        chunks.push(
          this.createChunk(
            currentChunk,
            sourceFile,
            section.header,
            startLine + i,
          ),
        );
        currentChunk = [];
        currentTokens = 0;
      }
    }

    // Add remaining content as final chunk
    if (currentChunk.length > 0) {
      // Only add if meaningful content exists
      const content = currentChunk.join("\n").trim();
      if (content.length >= this.minChars) {
        chunks.push(
          this.createChunk(currentChunk, sourceFile, section.header, startLine),
        );
      } else if (chunks.length > 0) {
        // Merge small remaining content into last chunk
        const lastChunk = chunks[chunks.length - 1];
        const mergedContent = lastChunk.content + "\n\n" + content;
        if (mergedContent.length <= this.maxChars) {
          lastChunk.content = mergedContent;
          lastChunk.tokenCount = estimateTokens(mergedContent);
        }
      }
    }

    return chunks;
  }

  /**
   * Create a chunk object from content lines.
   */
  private createChunk(
    lines: string[],
    sourceFile: string,
    header: string,
    lineNumber: number,
  ): Chunk {
    const content = lines.join("\n").trim();
    const metadata: ChunkMetadata = {};

    if (header) {
      metadata.headers = [header];
    }
    metadata.lineNumber = lineNumber;

    return {
      id: crypto.randomUUID(),
      content,
      sourceFile,
      tokenCount: estimateTokens(content),
      metadata,
      createdAt: new Date(),
    };
  }
}

/**
 * Singleton chunker instance cache, keyed by param signature so callers
 * asking for different params (e.g. active model's recommended size) each
 * get their own instance.
 */
const chunkerInstances = new Map<string, MemoryChunker>();

function paramsKey(p: VaultChunkParams): string {
  return `${p.targetChars}:${p.minChars}:${p.maxChars}`;
}

/**
 * Get a chunker instance for the given params. Omit params for defaults.
 * Cached per-param-signature so repeated calls don't re-instantiate.
 */
export function getChunker(params?: VaultChunkParams): MemoryChunker {
  const p = params ?? DEFAULT_VAULT_CHUNK_PARAMS;
  const key = paramsKey(p);
  let inst = chunkerInstances.get(key);
  if (!inst) {
    inst = new MemoryChunker(p);
    chunkerInstances.set(key, inst);
  }
  return inst;
}
