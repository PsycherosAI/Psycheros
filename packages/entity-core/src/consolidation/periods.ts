/**
 * Period Calculation Helpers
 *
 * ISO week calculation, date range filtering, and period boundary logic
 * for memory consolidation.
 */

/**
 * Get the ISO 8601 week number and year for a UTC date.
 * ISO weeks start on Monday. Week 1 contains the year's first Thursday.
 */
export function getISOWeek(date: Date): { year: number; week: number } {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
  return { year: isoYear, week };
}

/**
 * Get the Monday of a given ISO week.
 */
export function getISOWeekMonday(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayNum = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - dayNum + 1);
  const result = new Date(week1Monday);
  result.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return result;
}

/**
 * Get the start of the week (Monday) for a given date.
 */
export function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  d.setUTCDate(diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Get the start of the month for a given date.
 */
export function getMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/**
 * Get the start of the previous period for a given granularity.
 */
export function getPreviousPeriodStart(
  granularity: "weekly" | "monthly" | "yearly",
  now: Date,
): Date {
  const d = new Date(now);

  switch (granularity) {
    case "weekly": {
      const day = d.getUTCDay();
      const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1) - 7;
      d.setUTCDate(diff);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
    case "monthly": {
      d.setUTCMonth(d.getUTCMonth() - 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
    case "yearly": {
      d.setUTCFullYear(d.getUTCFullYear() - 1, 0, 1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
  }
}

/**
 * Get target date string and title for a consolidation period.
 */
export function getConsolidationDateInfo(
  granularity: "weekly" | "monthly" | "yearly",
  date: Date,
): { dateStr: string; title: string } {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");

  switch (granularity) {
    case "weekly": {
      const iso = getISOWeek(date);
      const weekStr = `${iso.year}-W${String(iso.week).padStart(2, "0")}`;
      return { dateStr: weekStr, title: `Weekly Memory - ${weekStr}` };
    }
    case "monthly": {
      const monthStr = `${year}-${month}`;
      return { dateStr: monthStr, title: `Monthly Memory - ${monthStr}` };
    }
    case "yearly":
      return { dateStr: String(year), title: `Yearly Memory - ${year}` };
  }
}

/**
 * Parse a target date string into a Date for a given granularity.
 * Returns null if the string is invalid.
 */
export function parseTargetDate(
  granularity: "weekly" | "monthly" | "yearly",
  dateStr: string,
): Date | null {
  switch (granularity) {
    case "weekly": {
      const match = dateStr.match(/^(\d{4})-W(\d{2})$/);
      if (!match) return null;
      return getISOWeekMonday(parseInt(match[1]), parseInt(match[2]));
    }
    case "monthly": {
      const date = new Date(dateStr + "-01");
      return isNaN(date.getTime()) ? null : date;
    }
    case "yearly": {
      const date = new Date(`${dateStr}-01-01`);
      return isNaN(date.getTime()) ? null : date;
    }
  }
}

/**
 * Parse a date string that may be a YYYY-WNN week format or a standard date.
 * Returns null if unparseable.
 */
export function parseAnyDate(dateStr: string): Date | null {
  const weekMatch = dateStr.match(/^(\d{4})-W(\d{2})$/);
  if (weekMatch) {
    return getISOWeekMonday(parseInt(weekMatch[1]), parseInt(weekMatch[2]));
  }
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Filter source memory files to those belonging to a specific consolidation period.
 * Handles both standard date strings (YYYY-MM-DD) and week strings (YYYY-WNN).
 */
export function filterFilesForPeriod(
  files: Array<{ date: string; content: string }>,
  granularity: "weekly" | "monthly" | "yearly",
  periodDate: Date,
): Array<{ date: string; content: string }> {
  switch (granularity) {
    case "weekly": {
      const weekStart = getWeekStart(periodDate);
      const weekEnd = new Date(weekStart);
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
      weekEnd.setUTCHours(23, 59, 59, 999);
      return files.filter((f) => {
        const d = parseAnyDate(f.date);
        return d !== null && d >= weekStart && d <= weekEnd;
      });
    }
    case "monthly": {
      const monthStart = getMonthStart(periodDate);
      const nextMonthStart = new Date(monthStart);
      nextMonthStart.setUTCMonth(nextMonthStart.getUTCMonth() + 1);
      return files.filter((f) => {
        const d = parseAnyDate(f.date);
        return d !== null && d >= monthStart && d < nextMonthStart;
      });
    }
    case "yearly": {
      const year = periodDate.getUTCFullYear();
      return files.filter((f) => {
        const d = parseAnyDate(f.date);
        return d !== null && d.getUTCFullYear() === year;
      });
    }
  }
}
