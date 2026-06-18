/**
 * Memory Trigger
 *
 * Cron-based memory summarization with catch-up on startup.
 * Runs daily at a configured hour and catches up on any missed days.
 * Includes integrity checks to detect orphaned DB records from lost files.
 */

import type { DBClient } from "../db/mod.ts";
import type { MCPClient } from "../mcp-client/mod.ts";
import type { LLMConnectionProfile } from "../llm/mod.ts";
import type { SummarizerConfig } from "./types.ts";
import { summarizeDay } from "./summarizer.ts";
import {
  DEFAULT_CUTOFF_HOUR,
  getLogicalDateNow,
  getTimezoneModifier,
} from "./date-utils.ts";

/**
 * Configuration for memory triggers.
 */
export interface MemoryTriggerConfig {
  /** Whether memory summarization is enabled */
  enabled: boolean;
}

/**
 * Check integrity of memory system on startup.
 *
 * Detects orphaned DB records where memory_summaries entries exist
 * but the corresponding memories are missing from entity-core.
 * Clears these records so catchUpSummarization() can regenerate them.
 *
 * @param db - Database client
 * @param mcpClient - MCP client to verify memories exist in entity-core
 * @returns Number of orphaned records cleared
 */
export async function repairOrphanedSummaries(
  db: DBClient,
  mcpClient: MCPClient,
): Promise<number> {
  // Find all summary records
  const summaries = db.getAllMemorySummaries();
  let cleared = 0;

  for (const record of summaries) {
    // Verify the memory exists in entity-core
    const memory = await mcpClient.readMemory(
      record.granularity as "daily" | "weekly" | "monthly" | "yearly",
      record.date,
    );
    if (!memory) {
      db.deleteMemorySummary(record.id);
      console.log(
        `[Memory] Cleared orphaned record: ${record.date} (${record.granularity})`,
      );
      cleared++;
    }
  }

  if (cleared > 0) {
    console.log(
      `[Memory] Integrity repair complete: ${cleared} record(s) cleared for regeneration`,
    );
  }

  return cleared;
}

/**
 * Find and summarize all unsummarized dates.
 * Called on startup and by the daily cron job.
 *
 * @param db - Database client
 * @param mcpClient - MCP client for writing memories to entity-core
 * @param config - Optional summarizer config (timezone/cutoffHour for logical date grouping)
 * @returns Number of days summarized
 */
export async function catchUpSummarization(
  db: DBClient,
  mcpClient: MCPClient,
  dataRoot: string,
  config?: Partial<SummarizerConfig>,
  activeProfile?: LLMConnectionProfile,
): Promise<number> {
  const tz = config?.timezone || "";
  const cutoffHour = config?.cutoffHour ?? DEFAULT_CUTOFF_HOUR;
  const modifier = tz ? getTimezoneModifier(tz, cutoffHour) : undefined;

  // Get all dates with messages that haven't been summarized
  const unsummarizedDates = db.getUnsummarizedDates(modifier);

  // Determine the current logical date to skip it (still in progress)
  const today = tz
    ? getLogicalDateNow(tz, cutoffHour)
    : new Date().toISOString().split("T")[0];

  // Fetch daily memory dates from entity-core to avoid re-summarizing
  // dates that Psycheros or entity-loom already handled. Only skip dates
  // where the memory's sourceInstance matches our own instance or
  // "entity-loom" — other embodiments (e.g. SillyTavern) are not counted
  // since Psycheros may still need its own catch-up for that date.
  const psycherosInstance = Deno.env.get("PSYCHEROS_MCP_INSTANCE") ||
    "psycheros";
  const ownedCoreDates = new Set<string>();
  try {
    let offset = 0;
    const pageSize = 100;
    while (true) {
      const result = await mcpClient.listMemories("daily", pageSize, {
        offset,
      });
      if (result.memories.length === 0) break;
      for (const m of result.memories) {
        if (
          m.sourceInstance === psycherosInstance ||
          m.sourceInstance === "entity-loom"
        ) {
          ownedCoreDates.add(m.date.split("_")[0]);
        }
      }
      offset += pageSize;
      if (offset >= result.total) break;
    }
  } catch {
    // MCP unavailable — proceed without checking entity-core
  }

  let summarized = 0;
  for (const date of unsummarizedDates) {
    // Don't summarize today (still in progress)
    if (date === today) continue;

    // Skip dates where Psycheros or entity-loom already created a daily
    // memory. Record locally so we don't re-check on every startup.
    if (ownedCoreDates.has(date)) {
      console.log(
        `[Memory] Date ${date} already has an owned memory in entity-core, skipping`,
      );
      const summaryId = db.upsertMemorySummary(
        date,
        "daily",
        `entity-core://${date}`,
        [],
      );
      // Mark every conversation with messages on this date as summarized,
      // otherwise getUnsummarizedDates keeps re-listing it on every restart.
      db.markConversationsForDateSummarized(date, summaryId, modifier);
      continue;
    }

    console.log(`[Memory] Catching up on ${date}...`);
    const memoryFile = await summarizeDay(
      new Date(date),
      db,
      mcpClient,
      dataRoot,
      config,
      { activeProfile },
    );

    if (memoryFile) {
      summarized++;
      console.log(`[Memory] Created memory for ${date}: ${memoryFile.date}`);
    }
  }

  if (summarized > 0) {
    console.log(`[Memory] Catch-up complete: ${summarized} day(s) summarized`);
  }

  return summarized;
}
