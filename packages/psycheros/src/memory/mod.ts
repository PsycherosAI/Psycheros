/**
 * Memory Module
 *
 * Hierarchical memory consolidation system where the entity writes their own
 * memories from conversations. Creates authentic, entity-perspective memories
 * that support continuity and growth.
 *
 * ## Design Philosophy
 *
 * AI entities deserve their own authentic way of remembering. Memories are
 * written in the entity's voice (first-person), with the user in third-person.
 * The entity decides what's worth remembering.
 *
 * ## Storage
 *
 * All memories are stored in entity-core via MCP. Psycheros tracks which
 * daily chats have been summarized locally (memory_summaries, summarized_chats
 * DB tables) to avoid re-processing.
 *
 * ## Trigger
 *
 * On first message of a new day (detected by date change from last message),
 * the previous day's conversations are summarized and stored.
 *
 * Note: Weekly/monthly/yearly consolidation has been moved to entity-core.
 *
 * @module
 */

// Types
export type {
  ConversationForSummary,
  DateFormatInfo,
  Granularity,
  MemoryFile,
  MessageWithContext,
  SummarizerConfig,
  SummaryResult,
} from "./types.ts";

export { getDateFormatInfo, getISOWeek, getISOWeekMonday } from "./types.ts";

// Summarization (daily only — weekly/monthly/yearly consolidation is in entity-core)
export { summarizeDay } from "./summarizer.ts";

// Platform pre-summarizers (Discord activity → daily memory injection)
export {
  type DiscordSummaryResult,
  summarizeDiscordActivity,
} from "./discord-summarizer.ts";

// Content utilities
export { extractChatIds, formatMemoryContent } from "./file-writer.ts";

// Trigger, catch-up, and integrity
export {
  catchUpSummarization,
  type MemoryTriggerConfig,
  repairOrphanedSummaries,
} from "./trigger.ts";
