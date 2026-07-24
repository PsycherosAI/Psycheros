/**
 * Google Calendar API wrapper.
 *
 * Wraps the REST endpoints at https://www.googleapis.com/calendar/v3/. Methods
 * take a GoogleClient (built in Phase B) and return typed results. Errors
 * throw GoogleApiError with status, message, and Google's response body for
 * diagnostics.
 *
 * Time handling: Google Calendar's API uses ISO 8601 strings. Timed events
 * use `dateTime` ("2026-07-20T14:00:00-04:00"); all-day events use `date`
 * ("2026-07-20"). All times we pass to the API should include an explicit
 * UTC offset (Z suffix or +HH:MM) — bare local times are an undefined
 * timezone and lead to surprises.
 */

import type { GoogleClient } from "../client/google-client.ts";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

export interface CalendarEventTime {
  /** Timed events: "2026-07-20T14:00:00-04:00". Mutually exclusive with `date`. */
  dateTime?: string;
  /** All-day events: "2026-07-20". Mutually exclusive with `dateTime`. */
  date?: string;
  /** IANA tz, e.g. "America/New_York". Only valid with `dateTime`. If omitted,
   *  the calendar's default timezone is used. */
  timeZone?: string;
}

export interface CalendarEventAttendee {
  email: string;
  displayName?: string;
  responseStatus?: "accepted" | "declined" | "needsAction" | "tentative";
  organizer?: boolean;
  optional?: boolean;
}

export interface CalendarEvent {
  /** Opaque event ID — used for update/delete API calls. Stable across reads. */
  id: string;
  /** Underlying iCal UID. Different from `id` — don't confuse the two. */
  iCalUID?: string;
  summary: string;
  start?: CalendarEventTime;
  end?: CalendarEventTime;
  location?: string;
  description?: string;
  attendees?: CalendarEventAttendee[];
  /** Google Meet link if the event has one. */
  hangoutLink?: string;
  status?: "confirmed" | "tentative" | "cancelled";
  /** Link to the event in the Google Calendar web UI. */
  htmlLink?: string;
  /** For recurring events: which occurrence this is, or the master template. */
  recurrence?: string[];
  /** Creator of the event (may be empty for events created by other apps). */
  creator?: { email?: string; displayName?: string };
}

export interface ListEventsOptions {
  calendarId?: string;
  /** ISO lower bound (inclusive). Default: now. */
  timeMin?: string;
  /** ISO upper bound (exclusive). Default: 30 days from now. */
  timeMax?: string;
  maxResults?: number;
  orderBy?: "startTime" | "updated";
  /** Expand recurring events into individual occurrences. Required when
   *  `orderBy: "startTime"`. Default true. */
  singleEvents?: boolean;
  /** Free-text search over titles, descriptions, locations, attendees. */
  q?: string;
  /** Page token for pagination — pass `nextPageToken` from a prior response. */
  pageToken?: string;
}

export interface ListEventsResult {
  items: CalendarEvent[];
  nextPageToken?: string;
}

export interface NewCalendarEvent {
  summary: string;
  start: CalendarEventTime;
  end: CalendarEventTime;
  location?: string;
  description?: string;
  attendees?: Array<Pick<CalendarEventAttendee, "email" | "displayName">>;
}

export interface CalendarListItem {
  id: string;
  summary: string;
  primary?: boolean;
  /** Background color hex string. */
  backgroundColor?: string;
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

const PRIMARY_CALENDAR = "primary";

/**
 * List events in a time range. Default calendarId "primary" — most operators
 * only have one calendar; for those with multiple, the entity should call
 * listCalendars first.
 */
export async function listEvents(
  client: GoogleClient,
  opts: ListEventsOptions = {},
): Promise<ListEventsResult> {
  const calendarId = opts.calendarId ?? PRIMARY_CALENDAR;
  const url = new URL(
    `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
  );
  if (opts.timeMin) url.searchParams.set("timeMin", opts.timeMin);
  if (opts.timeMax) url.searchParams.set("timeMax", opts.timeMax);
  if (opts.maxResults !== undefined) {
    url.searchParams.set("maxResults", String(opts.maxResults));
  }
  // singleEvents defaults to true — most callers want recurring events
  // expanded so they show up in the time range. orderBy defaults to startTime
  // (requires singleEvents=true per Google's docs).
  const singleEvents = opts.singleEvents ?? true;
  url.searchParams.set("singleEvents", String(singleEvents));
  const orderBy = opts.orderBy ?? "startTime";
  if (singleEvents && orderBy === "startTime") {
    url.searchParams.set("orderBy", orderBy);
  }
  if (opts.q) url.searchParams.set("q", opts.q);
  if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);

  const data = await client.fetchJson<EventsListResponseRaw>(url.toString());
  return {
    items: (data.items ?? []).map(normalizeEvent),
    nextPageToken: data.nextPageToken,
  };
}

/**
 * Create an event. Returns the created event with its server-assigned ID and
 * HTML link. Google doesn't auto-create Meet links by default — pass
 * `conferenceData` if you need one (out of scope for v1 tools).
 */
export async function createEvent(
  client: GoogleClient,
  event: NewCalendarEvent,
  calendarId: string = PRIMARY_CALENDAR,
): Promise<CalendarEvent> {
  const url = `${CALENDAR_API_BASE}/calendars/${
    encodeURIComponent(calendarId)
  }/events`;
  const body = serializeNewEvent(event);
  const data = await client.fetchJson<CalendarEvent>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return normalizeEvent(data);
}

/**
 * Patch an existing event by ID. Only fields in `updates` are changed; others
 * stay as they were. Returns the updated event.
 */
export async function patchEvent(
  client: GoogleClient,
  eventId: string,
  updates: Partial<NewCalendarEvent>,
  calendarId: string = PRIMARY_CALENDAR,
): Promise<CalendarEvent> {
  const url = `${CALENDAR_API_BASE}/calendars/${
    encodeURIComponent(calendarId)
  }/events/${encodeURIComponent(eventId)}`;
  const body = serializePatch(updates);
  const data = await client.fetchJson<CalendarEvent>(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return normalizeEvent(data);
}

/**
 * Delete an event by ID. Returns void on success (HTTP 204).
 */
export async function deleteEvent(
  client: GoogleClient,
  eventId: string,
  calendarId: string = PRIMARY_CALENDAR,
): Promise<void> {
  const url = `${CALENDAR_API_BASE}/calendars/${
    encodeURIComponent(calendarId)
  }/events/${encodeURIComponent(eventId)}`;
  const response = await client.fetch(url, { method: "DELETE" });
  if (!response.ok && response.status !== 204) {
    const body = await response.text();
    throw new GoogleApiError(
      `delete ${response.status}: ${body}`,
      response.status,
      body,
    );
  }
}

/**
 * List the operator's calendars. Most operators have one ("primary"), but
 * users with shared / secondary calendars will see them here.
 */
export async function listCalendars(
  client: GoogleClient,
): Promise<CalendarListItem[]> {
  const url = `${CALENDAR_API_BASE}/users/me/calendarList`;
  const data = await client.fetchJson<CalendarListResponseRaw>(url);
  return (data.items ?? []).map((item) => ({
    id: item.id,
    summary: item.summary,
    primary: item.primary,
    backgroundColor: item.backgroundColor,
  }));
}

// Internal types matching Google's response shapes.

interface CalendarListItemRaw {
  id: string;
  summary: string;
  primary?: boolean;
  backgroundColor?: string;
}

interface CalendarListResponseRaw {
  items?: CalendarListItemRaw[];
  nextPageToken?: string;
}

interface EventsListResponseRaw {
  items?: Record<string, unknown>[];
  nextPageToken?: string;
}

function normalizeEvent(raw: unknown): CalendarEvent {
  const e = raw as Record<string, unknown>;
  return {
    id: String(e.id ?? ""),
    iCalUID: typeof e.iCalUID === "string" ? e.iCalUID : undefined,
    summary: String(e.summary ?? "(untitled)"),
    start: e.start as CalendarEventTime | undefined,
    end: e.end as CalendarEventTime | undefined,
    location: typeof e.location === "string" ? e.location : undefined,
    description: typeof e.description === "string" ? e.description : undefined,
    attendees: Array.isArray(e.attendees)
      ? e.attendees as CalendarEventAttendee[]
      : undefined,
    hangoutLink: typeof e.hangoutLink === "string" ? e.hangoutLink : undefined,
    status: e.status as CalendarEvent["status"],
    htmlLink: typeof e.htmlLink === "string" ? e.htmlLink : undefined,
    recurrence: Array.isArray(e.recurrence)
      ? e.recurrence as string[]
      : undefined,
    creator: e.creator as CalendarEvent["creator"],
  };
}

function serializeNewEvent(event: NewCalendarEvent): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: event.summary,
    start: event.start,
    end: event.end,
  };
  if (event.location) body.location = event.location;
  if (event.description) body.description = event.description;
  if (event.attendees && event.attendees.length > 0) {
    body.attendees = event.attendees.map((a) => ({
      email: a.email,
      displayName: a.displayName,
    }));
  }
  return body;
}

function serializePatch(
  updates: Partial<NewCalendarEvent>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (updates.summary !== undefined) body.summary = updates.summary;
  if (updates.start !== undefined) body.start = updates.start;
  if (updates.end !== undefined) body.end = updates.end;
  if (updates.location !== undefined) body.location = updates.location;
  if (updates.description !== undefined) body.description = updates.description;
  if (updates.attendees !== undefined) {
    body.attendees = updates.attendees.map((a) => ({
      email: a.email,
      displayName: a.displayName,
    }));
  }
  return body;
}
