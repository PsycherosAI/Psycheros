/**
 * Memory Chunker
 *
 * Splits memory files into chunks suitable for embedding and retrieval.
 * Respects markdown structure (headers, bullet points) as semantic boundaries.
 */

import type { Chunk, Chunker, ChunkMetadata } from "./types.ts";

/**
 * Target chunk size in tokens.
 */
const TARGET_CHUNK_TOKENS = 512;

/**
 * Estimated characters per token (rough heuristic for English).
 */
const CHARS_PER_TOKEN = 4;

/**
 * Minimum chunk size in characters.
 */
const MIN_CHUNK_CHARS = 100;

/**
 * Maximum chunk size in characters (hard limit).
 */
const MAX_CHUNK_CHARS = TARGET_CHUNK_TOKENS * CHARS_PER_TOKEN;

/**
 * Estimate the token count of a text string.
 * Uses a simple heuristic: ~4 characters per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Memory chunker that respects markdown structure.
 */
export class MemoryChunker implements Chunker {
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
        currentTokens + lineTokens > TARGET_CHUNK_TOKENS &&
        currentChunk.length > 0 &&
        currentTokens >= MIN_CHUNK_CHARS / CHARS_PER_TOKEN
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
        currentTokens >= TARGET_CHUNK_TOKENS * 0.5 &&
        currentTokens <= TARGET_CHUNK_TOKENS * 1.5
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
      if (currentTokens > TARGET_CHUNK_TOKENS * 2) {
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
      if (content.length >= MIN_CHUNK_CHARS) {
        chunks.push(
          this.createChunk(currentChunk, sourceFile, section.header, startLine),
        );
      } else if (chunks.length > 0) {
        // Merge small remaining content into last chunk
        const lastChunk = chunks[chunks.length - 1];
        const mergedContent = lastChunk.content + "\n\n" + content;
        if (mergedContent.length <= MAX_CHUNK_CHARS) {
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
 * Singleton instance of the memory chunker.
 */
let chunkerInstance: MemoryChunker | null = null;

/**
 * Get the singleton chunker instance.
 */
export function getChunker(): MemoryChunker {
  if (!chunkerInstance) {
    chunkerInstance = new MemoryChunker();
  }
  return chunkerInstance;
}
