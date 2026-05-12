/**
 * Memory Module Type Definitions
 *
 * Types for the hierarchical memory consolidation system where the entity
 * writes their own memories from conversations.
 */

/**
 * Granularity levels for memory summaries.
 * "significant" is for emotionally important events that should be permanently remembered.
 */
export type Granularity =
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "significant";

/**
 * A memory file with its metadata and content.
 */
export interface MemoryFile {
  /** Path to the memory file (relative to project root) */
  path: string;
  /** Content of the memory file */
  content: string;
  /** Chat IDs referenced in this memory */
  chatIds: string[];
  /** Granularity level */
  granularity: Granularity;
  /** Date string (YYYY-MM-DD for daily, YYYY-WXX for weekly, YYYY-MM for monthly, YYYY for yearly) */
  date: string;
  /** Which embodiment created this memory (e.g., "psycheros", "sillytavern") */
  sourceInstance?: string;
  /** Other embodiments that participated in the conversation */
  participatingInstances?: string[];
}

/**
 * A message with its conversation context for summarization.
 */
export interface MessageWithContext {
  /** Message ID */
  id: string;
  /** Conversation ID */
  conversationId: string;
  /** Message role */
  role: "system" | "user" | "assistant" | "tool";
  /** Message content */
  content: string;
  /** Creation timestamp */
  createdAt: Date;
}

/**
 * Conversation data grouped for summarization.
 */
export interface ConversationForSummary {
  /** Conversation ID */
  id: string;
  /** Conversation title (if any) */
  title?: string;
  /** Messages in this conversation */
  messages: MessageWithContext[];
}

/**
 * Result of a summarization operation.
 */
export interface SummaryResult {
  /** Whether the summarization was successful */
  success: boolean;
  /** The generated memory file (if successful) */
  memoryFile?: MemoryFile;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Configuration for the memory summarizer.
 */
export interface SummarizerConfig {
  /** Root directory for memory files */
  memoriesDir: string;
  /** Maximum tokens for summary generation */
  maxSummaryTokens?: number;
  /** Whether memory consolidation is enabled */
  enabled?: boolean;
  /** IANA timezone string for timezone-aware message grouping (e.g. "America/Los_Angeles") */
  timezone?: string;
  /** Hour at which the logical day boundary occurs in the user's timezone (default: 5) */
  cutoffHour?: number;
}

/**
 * Date format info for each granularity.
 */
export interface DateFormatInfo {
  /** The date string format */
  dateStr: string;
  /** The file path (relative to memories dir) */
  filePath: string;
  /** The title for the memory file */
  title: string;
}

/**
 * Get the ISO 8601 week number and year for a UTC date.
 * ISO weeks start on Monday. Week 1 contains the year's first Thursday.
 * The ISO year may differ from the calendar year near year boundaries.
 */
export function getISOWeek(date: Date): { year: number; week: number } {
  // Copy to avoid mutation, set to nearest Thursday (ISO week definition)
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // Set to nearest Thursday: current date + 4 - current day number (Mon=1, Sun=7)
  const dayNum = d.getUTCDay() || 7; // Convert Sunday from 0 to 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  // ISO year is the year of the Thursday
  const isoYear = d.getUTCFullYear();
  // Week 1 = the week with the year's first Thursday
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
  return { year: isoYear, week };
}

/**
 * Get the Monday of a given ISO week.
 */
export function getISOWeekMonday(year: number, week: number): Date {
  // Jan 4 is always in ISO week 1
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayNum = jan4.getUTCDay() || 7;
  // Monday of week 1
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - dayNum + 1);
  // Add (week - 1) * 7 days
  const result = new Date(week1Monday);
  result.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return result;
}

/**
 * Get date format info for a given date and granularity.
 * Daily memories use instance-scoped filenames when instanceId is provided.
 */
export function getDateFormatInfo(
  date: Date,
  granularity: Granularity,
  instanceId?: string,
): DateFormatInfo {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  switch (granularity) {
    case "daily": {
      const dateStr = `${year}-${month}-${day}`;
      const fileName = instanceId
        ? `${dateStr}_${instanceId}.md`
        : `${dateStr}.md`;
      return {
        dateStr,
        filePath: `daily/${fileName}`,
        title: `Daily Memory - ${dateStr}`,
      };
    }
    case "weekly": {
      const iso = getISOWeek(date);
      const weekStr = `${iso.year}-W${String(iso.week).padStart(2, "0")}`;
      return {
        dateStr: weekStr,
        filePath: `weekly/${weekStr}.md`,
        title: `Weekly Memory - ${weekStr}`,
      };
    }
    case "monthly": {
      const monthStr = `${year}-${month}`;
      return {
        dateStr: monthStr,
        filePath: `monthly/${monthStr}.md`,
        title: `Monthly Memory - ${monthStr}`,
      };
    }
    case "yearly":
      return {
        dateStr: String(year),
        filePath: `yearly/${year}.md`,
        title: `Yearly Memory - ${year}`,
      };
    case "significant": {
      const dateStr = `${year}-${month}-${day}`;
      return {
        dateStr,
        filePath: `significant/${dateStr}.md`,
        title: `Significant Memory - ${dateStr}`,
      };
    }
  }
}
