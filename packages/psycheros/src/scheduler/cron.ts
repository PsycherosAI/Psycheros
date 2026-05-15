/**
 * Cron Expression Evaluation
 *
 * Computes the next fire time for a standard 5-field cron expression
 * (minute, hour, day-of-month, month, day-of-week) in UTC.
 *
 * I support: wildcards (`*`), numbers (`5`), ranges (`1-5`),
 * step values (`* /5`, `0-30/5`), and lists (`1,3,5`).
 *
 * Day-of-month and day-of-week combine with OR semantics when neither is `*`,
 * matching Vixie cron behaviour.
 *
 * @module
 */

interface ParsedField {
  values: Set<number>;
}

interface ParsedCron {
  minute: ParsedField;
  hour: ParsedField;
  dayOfMonth: ParsedField;
  month: ParsedField;
  dayOfWeek: ParsedField;
  /** True when both DoM and DoW are constrained — fire if EITHER matches. */
  domDowOr: boolean;
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day-of-month
  [1, 12], // month
  [0, 6], // day-of-week (0 = Sunday; we also accept 7 as Sunday)
];

function parseField(spec: string, min: number, max: number): ParsedField {
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    let range = part;
    let step = 1;
    const slashIdx = part.indexOf("/");
    if (slashIdx >= 0) {
      range = part.slice(0, slashIdx);
      step = parseInt(part.slice(slashIdx + 1), 10);
      if (!Number.isFinite(step) || step <= 0) {
        throw new Error(`Invalid step in cron field: ${part}`);
      }
    }
    let lo: number;
    let hi: number;
    if (range === "*" || range === "") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map((s) => parseInt(s, 10));
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        throw new Error(`Invalid range in cron field: ${part}`);
      }
      lo = a;
      hi = b;
    } else {
      const n = parseInt(range, 10);
      if (!Number.isFinite(n)) {
        throw new Error(`Invalid value in cron field: ${part}`);
      }
      lo = n;
      hi = n;
    }
    // Day-of-week field accepts 7 as Sunday — normalize to 0.
    if (max === 6) {
      if (lo === 7) lo = 0;
      if (hi === 7) hi = 0;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(
        `Out-of-range value in cron field: ${part} (allowed ${min}-${max})`,
      );
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values };
}

/**
 * Parse a 5-field cron expression. Throws on malformed input.
 */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression must have 5 fields (got ${fields.length}): ${expr}`,
    );
  }
  const parsed = fields.map((f, i) =>
    parseField(f, FIELD_RANGES[i][0], FIELD_RANGES[i][1])
  );
  return {
    minute: parsed[0],
    hour: parsed[1],
    dayOfMonth: parsed[2],
    month: parsed[3],
    dayOfWeek: parsed[4],
    // Vixie-cron rule: if EITHER DoM or DoW is restricted (not `*`), the
    // restricted one is OR-combined with the other. If both are `*`, neither
    // restricts. We detect "restricted" by comparing to the full range.
    domDowOr: parsed[2].values.size < 31 && parsed[4].values.size < 7,
  };
}

/**
 * Compute the next fire time strictly after `after` (UTC).
 * Returns an ISO 8601 timestamp.
 *
 * Searches forward minute-by-minute up to four years; throws if no match
 * (which only happens for nonsensical expressions like `0 0 31 2 *`).
 */
export function nextFireAtFromCron(expr: string, after: Date): string {
  const cron = parseCron(expr);

  // Start at the next whole minute after `after`. Cron only resolves to
  // minute granularity, so we floor and add one minute.
  const start = new Date(
    Date.UTC(
      after.getUTCFullYear(),
      after.getUTCMonth(),
      after.getUTCDate(),
      after.getUTCHours(),
      after.getUTCMinutes() + 1,
      0,
      0,
    ),
  );

  // Bound the search to four years. Cron expressions like `0 0 29 2 *`
  // (Feb 29) need up to ~4 years to find a leap day; nothing legitimate
  // needs more.
  const limit = new Date(start.getTime() + 4 * 366 * 86400_000);

  const candidate = new Date(start.getTime());
  while (candidate.getTime() <= limit.getTime()) {
    const minute = candidate.getUTCMinutes();
    const hour = candidate.getUTCHours();
    const dom = candidate.getUTCDate();
    const month = candidate.getUTCMonth() + 1;
    const dow = candidate.getUTCDay();

    const monthOk = cron.month.values.has(month);
    if (!monthOk) {
      // Skip to the 1st of next month at 00:00.
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    let dateOk: boolean;
    if (cron.domDowOr) {
      dateOk = cron.dayOfMonth.values.has(dom) ||
        cron.dayOfWeek.values.has(dow);
    } else {
      dateOk = cron.dayOfMonth.values.has(dom) &&
        cron.dayOfWeek.values.has(dow);
    }
    if (!dateOk) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    if (!cron.hour.values.has(hour)) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }

    if (!cron.minute.values.has(minute)) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
      continue;
    }

    return candidate.toISOString();
  }

  throw new Error(
    `Cron expression "${expr}" has no fire time in the next four years`,
  );
}

/**
 * Validate that an expression parses. Returns null on success, an error
 * message on failure.
 */
export function validateCron(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
