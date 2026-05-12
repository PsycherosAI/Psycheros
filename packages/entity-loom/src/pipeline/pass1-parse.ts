/**
 * Entity Loom — Pass 1: Parse
 *
 * Parses the export file and normalizes into ImportedConversation[].
 * Serializes raw conversations to disk for use by later passes.
 */

import { join } from "@std/path";
import type {
  CheckpointState,
  ImportedConversation,
  PlatformType,
  ProgressCallback,
} from "../types.ts";
import { createParser } from "../parsers/mod.ts";
import { hashConversation } from "../dedup/content-hash.ts";

/**
 * Parse the export file and return conversations, skipping already-parsed ones.
 * Conversation IDs are preserved as-is from the parser; message IDs are preserved too.
 * Serialized conversations are written to {packageDir}/raw/conversations.json.
 */
export async function parseExport(
  inputPath: string,
  platform: PlatformType,
  checkpoint: CheckpointState,
  packageDir: string,
  onProgress?: ProgressCallback,
  _idPrefix?: string,
): Promise<{ conversations: ImportedConversation[]; skipped: number }> {
  const parser = createParser(platform);
  const allConversations = await parser.parse(inputPath);

  onProgress?.(
    `Parsed ${allConversations.length} conversations from ${inputPath}`,
  );

  const conversations: ImportedConversation[] = [];
  let skipped = 0;

  for (const conv of allConversations) {
    // Check dedup hash (computed on raw content, keyed by conversation ID)
    const hash = await hashConversation(conv);

    if (checkpoint.pass1.conversationHashes[conv.id] === hash) {
      skipped++;
      continue;
    }

    conversations.push(conv);
    checkpoint.pass1.conversationHashes[conv.id] = hash;
  }

  if (skipped > 0) {
    onProgress?.(`Skipped ${skipped} already-parsed conversations (dedup)`);
  }

  // Serialize raw conversations for pass 3b (significant memory extraction)
  const rawDir = join(packageDir, "raw");
  await Deno.mkdir(rawDir, { recursive: true });
  const rawPath = join(rawDir, "_loom_conversations.json");
  await Deno.writeTextFile(rawPath, JSON.stringify(conversations));
  onProgress?.(
    `Serialized ${conversations.length} conversations to ${rawPath}`,
  );

  return { conversations, skipped };
}
