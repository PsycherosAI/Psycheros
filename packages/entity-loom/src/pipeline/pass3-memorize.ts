/**
 * Entity Loom — Pass 3a: Daily Memories
 *
 * Generates daily memory files from stored conversations (day-by-day).
 */

import type {
  CheckpointState,
  PipelineConfig,
  ProgressCallback,
} from "../types.ts";
import { DBWriter } from "../writers/db-writer.ts";
import { MemoryWriter } from "../writers/memory-writer.ts";
import type { LLMClient } from "../llm/mod.ts";

/**
 * Generate daily memories for all dates that have stored conversations.
 */
export async function generateDailyMemories(
  dbPath: string,
  packageDir: string,
  config: PipelineConfig,
  checkpoint: CheckpointState,
  llm: LLMClient,
  onProgress?: ProgressCallback,
): Promise<{ dailyMemoriesCreated: number }> {
  const db = new DBWriter(dbPath);
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

  // Get all unique dates from the database, optionally filtered by date range
  let dates: string[];
  if (config.dateFrom || config.dateTo) {
    let query =
      "SELECT DISTINCT DATE(created_at) as date FROM messages WHERE 1=1";
    const params: string[] = [];
    if (config.dateFrom) {
      query += " AND DATE(created_at) >= ?";
      params.push(config.dateFrom);
    }
    if (config.dateTo) {
      query += " AND DATE(created_at) <= ?";
      params.push(config.dateTo);
    }
    query += " ORDER BY date";
    dates = db.query(query, params).map((row) => row.date as string);
  } else {
    dates = db.query(
      "SELECT DISTINCT DATE(created_at) as date FROM messages ORDER BY date",
    ).map((row) => row.date as string);
  }

  let dailyMemoriesCreated = 0;

  // Retry failed dates first
  const datesToProcess = [
    ...checkpoint.pass3a.failedDates.filter((d) =>
      !checkpoint.pass3a.processedDates.includes(d)
    ),
    ...dates.filter((d) => !checkpoint.pass3a.processedDates.includes(d)),
  ];

  onProgress?.(
    `Processing ${datesToProcess.length} dates for daily memory generation`,
  );

  for (const date of datesToProcess) {
    try {
      // Check if daily memory already exists
      if (await memoryWriter.dailyMemoryExists(date)) {
        checkpoint.pass3a.processedDates.push(date);
        continue;
      }

      // Get messages for this date
      const messages = db.getMessagesByDate(date);
      if (messages.length === 0) continue;

      // Group by conversation
      const conversationMap = new Map<
        string,
        Array<{ role: string; content: string }>
      >();
      const conversationTitles = new Map<string, string>();

      for (const msg of messages) {
        const existing = conversationMap.get(msg.conversationId) || [];
        existing.push({ role: msg.role, content: msg.content });
        conversationMap.set(msg.conversationId, existing);

        if (!conversationTitles.has(msg.conversationId)) {
          const title = db.getConversationTitle(msg.conversationId);
          conversationTitles.set(msg.conversationId, title || undefined!);
        }
      }

      // Format for memory writer
      const groups = Array.from(conversationMap.entries()).map((
        [convId, msgs],
      ) => ({
        conversationId: convId,
        title: conversationTitles.get(convId),
        messages: msgs,
      }));

      // Generate daily memory
      const result = await memoryWriter.generateDailyMemory(date, groups);
      if (result) {
        const filePath = await memoryWriter.writeDailyMemory(
          date,
          result.content,
        );

        // Record in DB for tracking
        db.recordMemorySummary(
          date,
          "daily",
          memoryWriter.getDailyMemoryPath(date),
          result.chatIds,
        );

        dailyMemoriesCreated++;
        onProgress?.(`Created daily memory: ${filePath}`);
      }

      checkpoint.pass3a.processedDates.push(date);
      // Remove from failed if it was there
      checkpoint.pass3a.failedDates = checkpoint.pass3a.failedDates.filter((
        d,
      ) => d !== date);
    } catch (error) {
      onProgress?.(
        `Failed to generate daily memory for ${date}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      checkpoint.pass3a.failedDates.push(date);
    }
  }

  db.close();
  onProgress?.(`Created ${dailyMemoriesCreated} daily memories`);

  return { dailyMemoriesCreated };
}
