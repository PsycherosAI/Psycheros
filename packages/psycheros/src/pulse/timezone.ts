/**
 * Timezone Conversion Helpers
 *
 * Converts between user-facing local times and UTC cron expressions
 * so that Deno.cron (which always interprets in UTC) fires at the
 * correct local wall-clock time for the user's configured display timezone.
 *
 * @module
 */

// =============================================================================
// Display Timezone
// =============================================================================

/**
 * Read the user's configured display timezone.
 * Returns `undefined` when no timezone is configured, making all
 * conversion functions fall through to existing (UTC / passthrough) behaviour.
 */
export function getDisplayTimezone(): string | undefined {
  return Deno.env.get("PSYCHEROS_DISPLAY_TZ") ?? Deno.env.get("TZ") ??
    undefined;
}

// =============================================================================
// Offset Helpers
// =============================================================================

/**
 * Return the `UTC − local` offset in **minutes** for `timezone` at `refDate`.
 *
 * - Positive → local is *behind* UTC (e.g. UTC−7 → 420).
 * - Negative → local is *ahead* of UTC (e.g. UTC+2 → −120).
 *
 * Uses `Intl.DateTimeFormat` with `timeZoneName: "shortOffset"` so the
 * result is always correct for the IANA timezone, including DST transitions.
 */
export function getTimezoneOffsetMinutes(
  timezone: string,
  refDate?: Date,
): number {
  const date = refDate ?? new Date();

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(date);
  const tzPart = parts.find((p) => p.type === "timeZoneName");

  // Parse offset from the formatted string like "GMT-7" or "GMT+2"
  if (!tzPart) return 0;

  const tzValue = tzPart.value; // e.g. "GMT-7", "GMT+5:30", "GMT"
  if (tzValue === "GMT" || tzValue === "UTC") return 0;

  const match = tzValue.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;

  const sign = match[1] === "+" ? -1 : 1; // invert: UTC−local
  const hours = parseInt(match[2], 10);
  const minutes = match[3] ? parseInt(match[3], 10) : 0;

  return sign * (hours * 60 + minutes);
}

// =============================================================================
// Local → UTC Conversion (for building cron expressions on save)
// =============================================================================

/**
 * Convert a daily local time to UTC cron components.
 *
 * @returns `{ utcHour, utcMin }` — always 0–23 / 0–59.
 */
export function localTimeToUtcCron(
  hour: number,
  min: number,
  tz: string,
): { utcHour: number; utcMin: number } {
  const offset = getTimezoneOffsetMinutes(tz);
  let totalMin = hour * 60 + min + offset;
  // Normalize into a single day
  totalMin = ((totalMin % 1440) + 1440) % 1440;
  return {
    utcHour: Math.floor(totalMin / 60) % 24,
    utcMin: totalMin % 60,
  };
}

/**
 * Convert a weekly local schedule to UTC cron components.
 * Handles day-of-week rollover via total-minutes math.
 *
 * @param day - 0 (Sun) … 6 (Sat)
 * @returns `{ utcDayOfWeek, utcHour, utcMin }`
 */
export function localWeeklyToUtcCron(
  day: number,
  hour: number,
  min: number,
  tz: string,
): { utcDayOfWeek: number; utcHour: number; utcMin: number } {
  const offset = getTimezoneOffsetMinutes(tz);
  // Convert to total minutes from Sunday 00:00 local
  let totalMin = day * 1440 + hour * 60 + min + offset;
  // Normalize into a single week (7 * 1440 = 10080)
  totalMin = ((totalMin % 10080) + 10080) % 10080;
  return {
    utcDayOfWeek: Math.floor(totalMin / 1440) % 7,
    utcHour: Math.floor((totalMin % 1440) / 60) % 24,
    utcMin: totalMin % 60,
  };
}

/**
 * Convert a monthly local schedule to UTC cron components.
 * Handles day-of-month rollover via total-minutes math.
 *
 * @param day - 1 … 31
 * @returns `{ utcDayOfMonth, utcHour, utcMin }`
 */
export function localMonthlyToUtcCron(
  day: number,
  hour: number,
  min: number,
  tz: string,
): { utcDayOfMonth: number; utcHour: number; utcMin: number } {
  const offset = getTimezoneOffsetMinutes(tz);
  // Convert to total minutes from the 1st of month 00:00 local
  let totalMin = (day - 1) * 1440 + hour * 60 + min + offset;
  // Normalize into a single month (31 * 1440 = 44640)
  totalMin = ((totalMin % 44640) + 44640) % 44640;
  return {
    utcDayOfMonth: Math.floor(totalMin / 1440) + 1,
    utcHour: Math.floor((totalMin % 1440) / 60) % 24,
    utcMin: totalMin % 60,
  };
}

// =============================================================================
// UTC → Local Conversion (for displaying / pre-filling the editor)
// =============================================================================

/**
 * Inverse of `localTimeToUtcCron` — converts stored UTC cron values
 * back to local hour/minute for display.
 */
export function utcCronToLocalTime(
  hour: number,
  min: number,
  tz: string,
): { localHour: number; localMin: number } {
  const offset = getTimezoneOffsetMinutes(tz);
  let totalMin = hour * 60 + min - offset;
  totalMin = ((totalMin % 1440) + 1440) % 1440;
  return {
    localHour: Math.floor(totalMin / 60) % 24,
    localMin: totalMin % 60,
  };
}

/**
 * Inverse of `localWeeklyToUtcCron`.
 */
export function utcCronToLocalWeekly(
  day: number,
  hour: number,
  min: number,
  tz: string,
): { localDayOfWeek: number; localHour: number; localMin: number } {
  const offset = getTimezoneOffsetMinutes(tz);
  let totalMin = day * 1440 + hour * 60 + min - offset;
  totalMin = ((totalMin % 10080) + 10080) % 10080;
  return {
    localDayOfWeek: Math.floor(totalMin / 1440) % 7,
    localHour: Math.floor((totalMin % 1440) / 60) % 24,
    localMin: totalMin % 60,
  };
}

/**
 * Inverse of `localMonthlyToUtcCron`.
 */
export function utcCronToLocalMonthly(
  day: number,
  hour: number,
  min: number,
  tz: string,
): { localDayOfMonth: number; localHour: number; localMin: number } {
  const offset = getTimezoneOffsetMinutes(tz);
  let totalMin = (day - 1) * 1440 + hour * 60 + min - offset;
  totalMin = ((totalMin % 44640) + 44640) % 44640;
  return {
    localDayOfMonth: Math.floor(totalMin / 1440) + 1,
    localHour: Math.floor((totalMin % 1440) / 60) % 24,
    localMin: totalMin % 60,
  };
}

// =============================================================================
// Datetime-Local Helpers (for one-shot pulses)
// =============================================================================

/**
 * Convert a UTC ISO string to `YYYY-MM-DDTHH:MM` suitable for a
 * `<input type="datetime-local">` pre-fill value in the display timezone.
 */
export function formatUtcIsoToLocalDatetimeLocal(
  utcIso: string,
  tz: string,
): string {
  const date = new Date(utcIso);
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";

  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${
    get("minute")
  }`;
}

/**
 * Parse a `YYYY-MM-DDTHH:MM` value from a `datetime-local` input
 * (interpreted in the display timezone) and convert to a UTC ISO string.
 */
export function localDatetimeLocalToUtcIso(
  datetimeLocal: string,
  tz: string,
): string {
  const [datePart, timePart] = datetimeLocal.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, min] = (timePart ?? "00:00").split(":").map(Number);

  // Build a Date in UTC that represents the wall-clock values in `tz`.
  // First get the offset at that specific date (DST-aware).
  const refDate = new Date(Date.UTC(year, month - 1, day, hour, min));
  const offset = getTimezoneOffsetMinutes(tz, refDate);

  // Subtract the offset: if local is behind UTC (positive offset),
  // the UTC instant is later → add offset minutes.
  const utcMs = refDate.getTime() + offset * 60_000;
  return new Date(utcMs).toISOString();
}
