/**
 * Timezone-Aware Date Utilities for Memory System
 *
 * Computes logical dates and UTC time ranges based on the user's configured
 * display timezone and a configurable daily cutoff hour (default 5 AM local).
 *
 * The "logical date" for a message is determined by the most recent cutoff
 * time in the user's timezone. For example, with a 5 AM cutoff in PST:
 * - A message at 7 PM PST on April 1st → logical date April 1st
 * - A message at 3 AM PST on April 2nd → logical date April 1st (before cutoff)
 * - A message at 6 AM PST on April 2nd → logical date April 2nd (after cutoff)
 */

import { getTimezoneOffsetMinutes } from "../pulse/timezone.ts";

/** Default daily cutoff hour in the user's local timezone. */
export const DEFAULT_CUTOFF_HOUR = 5;

/**
 * Compute a SQLite `datetime()` modifier string that shifts a UTC timestamp
 * into the logical-date coordinate system.
 *
 * Combines the timezone offset and the cutoff hour into a single modifier.
 * For PST (UTC-8) with a 5 AM cutoff: `'-13 hours'`.
 *
 * Uses the current DST state. Acceptable for daily summarization since the
 * cron and message queries run at the same point in time.
 */
export function getTimezoneModifier(
  tz: string,
  cutoffHour: number = DEFAULT_CUTOFF_HOUR,
): string {
  const offsetMinutes = getTimezoneOffsetMinutes(tz);
  // offsetMinutes is (UTC - local), positive when local is behind UTC.
  //
  // We want the cutoff hour in local time to map to midnight in the shifted
  // coordinate system, so SQLite's date() naturally splits at the cutoff.
  //
  // shifted = UTC + modifier = (UTC - offset) - cutoff = local - cutoff
  // Therefore: modifier = -offset_hours - cutoff_hours
  //           = -(offsetMinutes / 60 + cutoffHour)
  //
  // Example: PDT (offset=+7h), cutoff=5h → modifier = -(7+5) = -12 hours
  //   4:59 AM PDT (11:59 UTC) → 11:59 + (-12h) = 23:59 prev day → date = prev day ✓
  //   5:00 AM PDT (12:00 UTC) → 12:00 + (-12h) = 00:00       → date = today ✓
  const offsetHours = offsetMinutes / 60;
  const combined = -(offsetHours + cutoffHour);
  return `${combined >= 0 ? "+" : ""}${combined} hours`;
}

/**
 * Given a logical date string (YYYY-MM-DD), return the UTC time range
 * that corresponds to the full "day" in the user's timezone.
 *
 * The range starts at `cutoffHour` local time on the given date and
 * ends at `cutoffHour` local time on the next date (exclusive).
 *
 * Uses `getTimezoneOffsetMinutes` with a refDate on the specific day
 * for DST-correct boundaries.
 */
export function getLogicalDateRange(
  dateStr: string,
  tz: string,
  cutoffHour: number = DEFAULT_CUTOFF_HOUR,
): { startUTC: string; endUTC: string } {
  const [year, month, day] = dateStr.split("-").map(Number);

  // Reference date at noon UTC on the target day (avoids edge cases)
  const refDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const offsetMinutes = getTimezoneOffsetMinutes(tz, refDate);

  // Start of logical day: cutoffHour local time on this date
  // UTC = local + (UTC - local offset)
  const startUTC = Date.UTC(year, month - 1, day, cutoffHour, 0, 0) +
    offsetMinutes * 60_000;

  // End of logical day: cutoffHour local time on the next date
  // Use a refDate on the next day for correct DST at the boundary
  const nextRefDate = new Date(Date.UTC(year, month - 1, day + 1, 12, 0, 0));
  const nextOffsetMinutes = getTimezoneOffsetMinutes(tz, nextRefDate);
  const endUTC = Date.UTC(year, month - 1, day + 1, cutoffHour, 0, 0) +
    nextOffsetMinutes * 60_000;

  return {
    startUTC: new Date(startUTC).toISOString(),
    endUTC: new Date(endUTC).toISOString(),
  };
}

/**
 * Return the current logical date as YYYY-MM-DD, accounting for the cutoff hour.
 *
 * If the current local time is before the cutoff, returns yesterday's date.
 */
export function getLogicalDateNow(
  tz: string,
  cutoffHour: number = DEFAULT_CUTOFF_HOUR,
): string {
  const now = new Date();

  // Get the current local date components using Intl (timezone-aware)
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";

  const localHour = parseInt(get("hour"), 10);
  const year = get("year");
  const month = get("month");
  const day = get("day");

  // If before cutoff, the logical date is yesterday
  if (localHour < cutoffHour) {
    const yesterday = new Date(
      Date.UTC(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10)),
    );
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return yesterday.toISOString().split("T")[0];
  }

  return `${year}-${month}-${day}`;
}
