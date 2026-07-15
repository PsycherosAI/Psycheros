/**
 * Entity Loom — Content Hash
 *
 * SHA-256 hashing for conversation-level deduplication.
 */

import type { ImportedConversation } from "../types.ts";

/**
 * Compute a SHA-256 hash of a conversation's message content sequence.
 * Used for dedup — if the same conversation is imported twice, the hash matches.
 */
export async function hashConversation(
  conversation: ImportedConversation,
): Promise<string> {
  // Hash the ordered sequence of non-system message contents
  const content = conversation.messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role}:${m.content}`)
    .join("\n");

  return sha256Hex(content);
}

/**
 * Compute a SHA-256 hex digest. Accepts either a string (UTF-8 encoded) or
 * raw bytes (Uint8Array / ArrayBuffer) — the bytes form is used for hashing
 * uploaded file content without forcing a string round-trip.
 */
export async function sha256Hex(
  input: string | BufferSource,
): Promise<string> {
  const data = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute a short hash suitable for display/logging.
 */
export async function shortHash(text: string): Promise<string> {
  const full = await sha256Hex(text);
  return full.slice(0, 12);
}
