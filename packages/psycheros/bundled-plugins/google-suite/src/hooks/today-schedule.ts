/**
 * today_schedule prompt hook — injects the operator's calendar as plugin context.
 *
 * Lookahead is configurable via `calendarLookaheadDays` (default 1 = today only).
 * When > 1, events are grouped by day:
 *
 *   Today's schedule (2026-07-22):
 *     - 14:00: Standup
 *   Tomorrow (2026-07-23):
 *     - 09:00: Morning run
 *   Wed Jul 24:
 *     - 10:00: Doctor appointment
 *
 * Reads from the background-refresh cache (5 min interval). Mutations
 * (google_calendar create/update/delete) invalidate the cache for immediate
 * refresh.
 *
 * Returns `undefined` (silent skip) when: not connected, calendar disabled,
 * cache empty/stale, or no events in the lookahead window.
 */

import type { PluginPromptHook } from "../../../../src/plugins/plugin-manager.ts";
import { getConfig, getGoogleClient, getHookCache } from "../plugin-state.ts";
import { type CalendarEvent, listEvents } from "../services/calendar.ts";

const TODAY_SCHEDULE_KEY = "today_schedule";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_EVENTS = 50;

export interface TodayScheduleCacheEntry {
  date: string;
  events: CalendarEvent[];
  lookaheadDays: number;
}

export const todayScheduleHook: PluginPromptHook = {
  name: "today-schedule",
  priority: 20,
  async run(ctx) {
    const client = getGoogleClient();
    if (!client?.isConfigured()) return undefined;

    const config = getConfig();
    if (!config?.services.calendar) return undefined;

    const cache = getHookCache();
    if (!cache) return undefined;

    const cached = cache.read<TodayScheduleCacheEntry>(TODAY_SCHEDULE_KEY);
    if (!cached) return undefined;

    const today = new Date().toDateString();
    if (cached.date !== today) return undefined;

    const label = (config.calendarLabel ?? "Today's schedule").replace(
      "{userName}",
      ctx.userName ?? "the user",
    );

    const lookahead = cached.lookaheadDays > 0 ? cached.lookaheadDays : 1;

    if (lookahead === 1) {
      // Single-day format: flat list. Date is intentionally omitted — the
      // entity already has today's date from situational awareness.
      const lines = cached.events.map(formatEventLine);
      if (cached.events.length === 0) {
        return `${label}: nothing today.`;
      }
      return `${label}:\n${lines.join("\n")}`;
    }

    // Multi-day format: grouped by day
    const groups = groupByDay(cached.events);
    const sections: string[] = [];
    const now = new Date();
    for (let dayOffset = 0; dayOffset < lookahead; dayOffset++) {
      const day = new Date(now);
      day.setDate(day.getDate() + dayOffset);
      const dayKey = day.toDateString();
      const dayEvents = groups.get(dayKey) ?? [];
      if (dayEvents.length === 0) continue;
      const dayLabel = dayOffset === 0 ? label : dayLabelFor(day, dayOffset);
      const lines = dayEvents.map(formatEventLine);
      sections.push(`${dayLabel}:\n${lines.join("\n")}`);
    }
    if (sections.length === 0) {
      return `${label}: nothing for ${lookahead} days.`;
    }
    return sections.join("\n\n");
  },
};

function formatEventLine(event: CalendarEvent): string {
  const time = event.start?.dateTime
    ? new Date(event.start.dateTime).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })
    : event.start?.date
    ? "all day"
    : "time TBD";
  const attendees = event.attendees && event.attendees.length > 0
    ? ` (${event.attendees.length} attendee${
      event.attendees.length === 1 ? "" : "s"
    })`
    : "";
  const location = event.location ? ` @ ${event.location}` : "";
  const meet = event.hangoutLink ? " [Meet]" : "";
  return `  - ${time}: ${event.summary}${location}${attendees}${meet}`;
}

function groupByDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const groups = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    // For timed events (dateTime), use local date (correct — the event
    // happens at that local time). For all-day events (date-only string),
    // new Date("2026-07-22") parses as UTC midnight which shifts to the
    // previous day in negative-offset timezones. Parse date-only strings
    // directly instead.
    let key: string;
    if (event.start?.dateTime) {
      key = new Date(event.start.dateTime).toDateString();
    } else if (event.start?.date) {
      // Date-only string like "2026-07-22" — extract as-is, don't let
      // Date constructor add a timezone offset.
      const [y, m, d] = event.start.date.split("-").map(Number);
      key = new Date(y, m - 1, d).toDateString();
    } else {
      continue;
    }
    const arr = groups.get(key) ?? [];
    arr.push(event);
    groups.set(key, arr);
  }
  return groups;
}

function dayLabelFor(day: Date, offset: number): string {
  if (offset === 1) return "Tomorrow";
  if (offset <= 6) {
    return day.toLocaleDateString([], { weekday: "long" });
  }
  return day.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export async function refreshTodaySchedule(): Promise<void> {
  const client = getGoogleClient();
  if (!client?.isConfigured()) return;

  const config = getConfig();
  if (!config?.services.calendar) return;

  const cache = getHookCache();
  if (!cache) return;

  const now = new Date();
  const lookahead = config.calendarLookaheadDays > 0
    ? config.calendarLookaheadDays
    : 1;
  const endTime = new Date(now);
  // lookahead=1 → end of today (offset 0). lookahead=7 → end of 6th day
  // from now. The -1 avoids pulling events from one day past the window.
  endTime.setDate(endTime.getDate() + (lookahead - 1));
  endTime.setHours(23, 59, 59, 999);

  const result = await listEvents(client, {
    timeMin: now.toISOString(),
    timeMax: endTime.toISOString(),
    maxResults: MAX_EVENTS,
    singleEvents: true,
    orderBy: "startTime",
  });

  await cache.write<TodayScheduleCacheEntry>(TODAY_SCHEDULE_KEY, {
    date: now.toDateString(),
    events: result.items,
    lookaheadDays: lookahead,
  });
}

export const TODAY_SCHEDULE_REFRESH_INTERVAL_MS = REFRESH_INTERVAL_MS;
