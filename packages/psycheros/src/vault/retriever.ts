/**
 * Vault Retriever
 *
 * Formats vault search results for injection into the LLM system message.
 */

import type { VaultSearchResult } from "./types.ts";

/**
 * Format vault search results for injection into the system message.
 * Placed after lorebook content, before memories.
 */
export function formatVaultContext(results: VaultSearchResult[]): string {
  if (results.length === 0) return "";

  const parts: string[] = [
    "---\n\nRelevant Documents from Data Vault:",
  ];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const pct = Math.round(r.score * 100);
    parts.push(`[${i + 1}] (from "${r.documentTitle}", ${pct}% relevant)`);
    parts.push(r.chunk.content);
  }

  return parts.join("\n\n");
}
