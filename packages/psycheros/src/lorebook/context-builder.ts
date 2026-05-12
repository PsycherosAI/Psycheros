/**
 * Lorebook Context Builder
 *
 * Builds the context string from evaluated lorebook entries.
 * Handles:
 * - Entry formatting with [entry.name]\nentry.content format
 * - Token budget management (approximate 4 chars/token)
 * - Priority sorting (higher priority = injected earlier = more weight)
 */

import type { EvaluatedEntry } from "./types.ts";

/**
 * Chars per token approximation for token counting.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Options for building lorebook context.
 */
export interface BuildContextOptions {
  /** Maximum total tokens for lorebook content (0 = unlimited) */
  maxTokens?: number;
  /** Whether to include entry names as headers */
  includeNames?: boolean;
  /** Separator between entries */
  separator?: string;
}

/**
 * Build a formatted context string from evaluated entries.
 * Entries are sorted by priority (higher first) for LLM attention weight.
 *
 * @param entries - Evaluated entries to include
 * @param options - Build options
 * @returns Formatted context string
 */
export function buildLorebookContext(
  entries: EvaluatedEntry[],
  options: BuildContextOptions = {},
): string {
  const {
    maxTokens = 0,
    includeNames = true,
    separator = "\n\n",
  } = options;

  if (entries.length === 0) {
    return "";
  }

  // Sort by priority (higher first) - earlier in context = more LLM attention
  const sortedEntries = [...entries].sort(
    (a, b) => b.entry.priority - a.entry.priority,
  );

  // Build content string
  const parts: string[] = [];
  let totalTokens = 0;

  for (const evaluated of sortedEntries) {
    const entry = evaluated.entry;
    let content = entry.content;

    if (includeNames && entry.name) {
      content = `[${entry.name}]\n${content}`;
    }

    const contentTokens = estimateTokens(content);
    const totalEntryTokens = parts.length > 0
      ? contentTokens + estimateTokens(separator)
      : contentTokens;

    // Check token budget
    if (maxTokens > 0 && totalTokens + totalEntryTokens > maxTokens) {
      // Check if entry has maxTokens limit and can be truncated
      if (entry.maxTokens > 0 && entry.maxTokens <= maxTokens - totalTokens) {
        const truncatedContent = truncateToTokens(content, entry.maxTokens);
        parts.push(truncatedContent);
        break;
      }
      // Can't fit this entry, stop
      break;
    }

    parts.push(content);
    totalTokens += totalEntryTokens;
  }

  if (parts.length === 0) {
    return "";
  }

  return `---
Context Notes:

${parts.join(separator)}`;
}

/**
 * Estimate token count for a string.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncate text to approximately fit within a token limit.
 */
function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) {
    return text;
  }
  // Try to truncate at a word boundary
  const truncated = text.substring(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.8) {
    return truncated.substring(0, lastSpace) + "...";
  }
  return truncated + "...";
}

/**
 * Calculate total tokens for a set of entries.
 *
 * @param entries - Evaluated entries
 * @returns Estimated token count
 */
export function calculateTotalTokens(entries: EvaluatedEntry[]): number {
  return entries.reduce(
    (sum, e) => sum + estimateTokens(e.entry.content),
    0,
  );
}
