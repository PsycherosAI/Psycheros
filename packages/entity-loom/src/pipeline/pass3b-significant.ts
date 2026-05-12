/**
 * Entity Loom — Pass 3b: Significant Memories
 *
 * Extracts significant memories from raw parsed conversations (not from the DB).
 * Processes by conversation rather than by day, with chunking for long conversations,
 * to capture multi-day event arcs that would be missed by day-bucketed processing.
 */

import { join } from "@std/path";
import type {
  CheckpointState,
  ImportedConversation,
  PipelineConfig,
  ProgressCallback,
} from "../types.ts";
import { MemoryWriter } from "../writers/memory-writer.ts";
import { chunkConversationForSignificance } from "./chunker.ts";
import type { LLMClient } from "../llm/mod.ts";

/**
 * Generate significant memories from raw conversations.
 * Each conversation is evaluated as a whole (or chunked if too long).
 */
export async function generateSignificantMemories(
  packageDir: string,
  config: PipelineConfig,
  checkpoint: CheckpointState,
  llm: LLMClient,
  onProgress?: ProgressCallback,
): Promise<
  { significantMemoriesCreated: number; conversationsProcessed: number }
> {
  const memoryWriter = new MemoryWriter(
    packageDir,
    config.entityName,
    config.userName,
    config.instanceId,
    config.contextNotes,
    llm,
    config.rateLimitMs,
    config.maxContextTokens,
    config.entityPronouns,
    config.userPronouns,
    config.relationshipContext,
  );

  // Load raw conversations serialized by pass 1
  const rawPath = join(packageDir, "raw", "_loom_conversations.json");
  let conversations: ImportedConversation[];
  try {
    const raw = await Deno.readTextFile(rawPath);
    conversations = JSON.parse(raw) as ImportedConversation[];
    // Restore Date objects from ISO strings
    for (const conv of conversations) {
      conv.createdAt = new Date(conv.createdAt as unknown as string);
      conv.updatedAt = new Date(conv.updatedAt as unknown as string);
      for (const msg of conv.messages) {
        msg.createdAt = new Date(msg.createdAt as unknown as string);
      }
    }
  } catch {
    onProgress?.(
      "No raw conversations found — skipping significant memory extraction",
    );
    return { significantMemoriesCreated: 0, conversationsProcessed: 0 };
  }

  // Filter already-processed conversations, prioritizing failed ones
  const convsToProcess = [
    ...conversations.filter((c) =>
      checkpoint.pass3b.failedConversationIds.includes(c.id) &&
      !checkpoint.pass3b.processedConversationIds.includes(c.id)
    ),
    ...conversations.filter((c) =>
      !checkpoint.pass3b.processedConversationIds.includes(c.id) &&
      !checkpoint.pass3b.failedConversationIds.includes(c.id)
    ),
  ];

  onProgress?.(
    `Processing ${convsToProcess.length} conversations for significant memories`,
  );

  let significantMemoriesCreated = 0;
  let conversationsProcessed = 0;

  for (const conv of convsToProcess) {
    try {
      // Filter to user/assistant messages
      const userAssistantMessages = conv.messages.filter((m) =>
        m.role === "user" || m.role === "assistant"
      );
      if (userAssistantMessages.length === 0) continue;

      // Chunk if conversation is too long for context window
      const chunks = chunkConversationForSignificance(
        conv,
        config.maxContextTokens,
      );

      for (const chunk of chunks) {
        // Format date range for the prompt
        const dateFrom = formatDate(chunk.dateFrom);
        const dateTo = formatDate(chunk.dateTo);
        const dateLabel = dateFrom === dateTo
          ? dateFrom
          : `${dateFrom} to ${dateTo}`;

        // Format as MessageGroup for the memory writer
        const groups = [{
          conversationId: chunk.conversationId,
          title: chunk.title || "Untitled conversation",
          messages: chunk.messages,
        }];

        // Evaluate for significance using the existing method
        const result = await memoryWriter.extractSignificantMemories(
          dateLabel,
          groups,
        );

        if (result) {
          const sigPath = await memoryWriter.writeSignificantMemory(
            dateFrom,
            result.prose,
            result.slug,
          );
          if (sigPath) {
            significantMemoriesCreated++;
            const chunkNote = chunks.length > 1
              ? ` (chunk ${chunk.chunkIndex + 1}/${chunks.length})`
              : "";
            onProgress?.(`Created significant memory: ${sigPath}${chunkNote}`);
          }
        }
      }

      checkpoint.pass3b.processedConversationIds.push(conv.id);
      // Remove from failed if it was there
      checkpoint.pass3b.failedConversationIds = checkpoint.pass3b
        .failedConversationIds.filter((id) => id !== conv.id);
      conversationsProcessed++;
    } catch (error) {
      onProgress?.(
        `Failed to extract significant memories from conversation ${conv.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      checkpoint.pass3b.failedConversationIds.push(conv.id);
    }
  }

  onProgress?.(
    `Created ${significantMemoriesCreated} significant memories across ${conversationsProcessed} conversations`,
  );

  return { significantMemoriesCreated, conversationsProcessed };
}

/** Format a Date as YYYY-MM-DD */
function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
