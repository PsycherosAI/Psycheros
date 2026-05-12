/**
 * Entity Loom — Conversation Title Utilities
 *
 * Shared helpers for generating conversation titles when a platform
 * doesn't provide one.
 */

/**
 * Generate a date-range fallback title like "Jan 15 – Feb 3, 2025".
 * Returns null if dates aren't available.
 */
export function dateRangeTitle(first: Date, last: Date): string | null {
  if (!first || !last || isNaN(first.getTime()) || isNaN(last.getTime())) {
    return null;
  }

  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  // Same date — just show one
  if (first.toDateString() === last.toDateString()) {
    return fmt(first);
  }

  // Same year — omit year from first date
  if (first.getFullYear() === last.getFullYear()) {
    const f = first.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    return `${f} – ${fmt(last)}`;
  }

  return `${fmt(first)} – ${fmt(last)}`;
}

/**
 * Build a platform-prefixed conversation title.
 *
 * Priority:
 * 1. Explicit title from the platform (if non-empty)
 * 2. Date range from first/last messages (if available)
 * 3. "Untitled"
 */
export function buildTitle(
  platform: string,
  title: string | undefined | null,
  firstMsgDate?: Date,
  lastMsgDate?: Date,
): string {
  if (title?.trim()) return `[${platform}] ${title.trim()}`;

  const dateTitle = dateRangeTitle(firstMsgDate!, lastMsgDate!);
  if (dateTitle) return `[${platform}] ${dateTitle}`;

  return `[${platform}] Untitled`;
}
