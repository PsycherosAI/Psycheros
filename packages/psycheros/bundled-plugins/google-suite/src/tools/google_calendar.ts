/**
 * google_calendar omni-tool — all Calendar operations in one tool.
 *
 * Action parameter selects the operation; per-action args vary. Replaces the
 * four-tool split (list_calendar_events / create_calendar_event /
 * update_calendar_event / delete_calendar_event) for consistency with the
 * rest of the google-suite plugin (one tool per service).
 *
 * Mutation actions (create / update / delete) invalidate the today_schedule
 * cache after API success so the next turn's hook sees fresh data.
 *
 * First-person per CLAUDE.md: I'm the entity, this is my user's calendar
 * that I'm aware of (the entity doesn't own it, just has access via this
 * plugin).
 */

import type { Tool } from "../../../../src/tools/types.ts";
import { getGoogleClient, getHookCache } from "../plugin-state.ts";
import {
  type CalendarEvent,
  type CalendarEventTime,
  createEvent,
  deleteEvent,
  GoogleApiError,
  listEvents,
  patchEvent,
} from "../services/calendar.ts";

const TODAY_SCHEDULE_KEY = "today_schedule";
const MAX_RESULTS_CAP = 250;
const DEFAULT_RANGE_DAYS = 30;

interface CalendarArgs {
  action?: "list" | "create" | "update" | "delete";
  // list args
  time_min?: string;
  time_max?: string;
  max_results?: number;
  query?: string;
  // create args
  summary?: string;
  start?: CalendarEventTime;
  end?: CalendarEventTime;
  location?: string;
  description?: string;
  attendees?: Array<{ email: string; displayName?: string }>;
  // update + delete args
  event_id?: string;
  // shared
  calendar_id?: string;
}

export const googleCalendarTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "google_calendar",
      description:
        "Manage events on my user's connected Google Calendar. Pass `action` " +
        "to pick the operation: 'list' (events in a time range), 'create' " +
        "(new event), 'update' (patch fields on an existing event by ID), " +
        "'delete' (remove by ID — permanent, confirm with user first). I " +
        "use this for awareness of upcoming commitments and for adding, " +
        "rescheduling, or removing events on my user's schedule.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "create", "update", "delete"],
            description: "Operation to perform.",
          },
          time_min: {
            type: "string",
            description:
              "list: ISO 8601 lower bound (inclusive). Default now. Example: '2026-07-21T00:00:00Z'.",
          },
          time_max: {
            type: "string",
            description:
              `list: ISO 8601 upper bound (exclusive). Default ${DEFAULT_RANGE_DAYS} days from time_min.`,
          },
          max_results: {
            type: "integer",
            description:
              `list: cap on number of events. Default 50, max ${MAX_RESULTS_CAP}.`,
          },
          query: {
            type: "string",
            description:
              "list: optional text search over titles, descriptions, locations, attendees.",
          },
          summary: {
            type: "string",
            description: "create/update: event title.",
          },
          start: {
            type: "object",
            description:
              "create/update: start time. Use { dateTime: '2026-07-21T14:00:00-04:00' } for timed events or { date: '2026-07-21' } for all-day. timeZone is optional (IANA like 'America/New_York').",
            properties: {
              dateTime: { type: "string" },
              date: { type: "string" },
              timeZone: { type: "string" },
            },
          },
          end: {
            type: "object",
            description:
              "create/update: end time. Same shape as `start`. For all-day events, end.date should be the day AFTER the last day.",
            properties: {
              dateTime: { type: "string" },
              date: { type: "string" },
              timeZone: { type: "string" },
            },
          },
          location: {
            type: "string",
            description:
              "create/update: free-text location (address, room name).",
          },
          description: {
            type: "string",
            description: "create/update: plain-text description / agenda.",
          },
          attendees: {
            type: "array",
            description: "create/update: attendee email addresses.",
            items: {
              type: "object",
              properties: {
                email: { type: "string" },
                displayName: { type: "string" },
              },
              required: ["email"],
            },
          },
          event_id: {
            type: "string",
            description:
              "update/delete: event ID — from a prior list or create result.",
          },
          calendar_id: {
            type: "string",
            description: "Calendar to operate on. Default 'primary'.",
          },
        },
        required: ["action"],
      },
    },
  },

  async execute(args, ctx) {
    const client = getGoogleClient();
    if (!client?.isConfigured()) {
      return notConnectedResult(ctx.toolCallId);
    }
    const parsed = args as CalendarArgs;
    switch (parsed.action) {
      case "list":
        return doList(parsed, ctx.toolCallId);
      case "create":
        return doCreate(parsed, ctx.toolCallId);
      case "update":
        return doUpdate(parsed, ctx.toolCallId);
      case "delete":
        return doDelete(parsed, ctx.toolCallId);
      default:
        return {
          toolCallId: ctx.toolCallId,
          content: `Missing or invalid action "${
            parsed.action ?? "(missing)"
          }". Use one of: list, create, update, delete.`,
          isError: true,
        };
    }
  },
};

async function doList(args: CalendarArgs, toolCallId: string) {
  const client = getGoogleClient()!;
  const now = new Date();
  const timeMin = args.time_min ?? now.toISOString();
  const defaultMax = new Date(
    now.getTime() + DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000,
  );
  const timeMax = args.time_max ?? defaultMax.toISOString();
  const maxResults = args.max_results !== undefined
    ? Math.min(Math.max(1, args.max_results), MAX_RESULTS_CAP)
    : 50;
  try {
    const result = await listEvents(client, {
      timeMin,
      timeMax,
      maxResults,
      q: args.query,
      calendarId: args.calendar_id,
    });
    return {
      toolCallId,
      content: formatEventsList(result.items, { timeMin, timeMax }),
    };
  } catch (error) {
    return errorResult(toolCallId, "list events", error);
  }
}

async function doCreate(args: CalendarArgs, toolCallId: string) {
  if (!args.summary?.trim()) {
    return missingField(toolCallId, "summary");
  }
  if (!args.start) return missingField(toolCallId, "start");
  if (!args.end) return missingField(toolCallId, "end");
  const client = getGoogleClient()!;
  try {
    const created = await createEvent(
      client,
      {
        summary: args.summary,
        start: args.start,
        end: args.end,
        location: args.location,
        description: args.description,
        attendees: args.attendees,
      },
      args.calendar_id,
    );
    invalidateTodaySchedule();
    return {
      toolCallId,
      content:
        `Created event "${created.summary}" (id: ${created.id}) starting at ${
          formatEventTime(created.start)
        }.${
          created.htmlLink
            ? `\nView in Google Calendar: ${created.htmlLink}`
            : ""
        }`,
    };
  } catch (error) {
    return errorResult(toolCallId, "create event", error);
  }
}

async function doUpdate(args: CalendarArgs, toolCallId: string) {
  if (!args.event_id?.trim()) {
    return missingField(toolCallId, "event_id");
  }
  const hasFields = args.summary !== undefined ||
    args.start !== undefined ||
    args.end !== undefined ||
    args.location !== undefined ||
    args.description !== undefined ||
    args.attendees !== undefined;
  if (!hasFields) {
    return {
      toolCallId,
      content:
        "No fields to update. Provide at least one of: summary, start, end, location, description, attendees.",
      isError: true,
    };
  }
  const client = getGoogleClient()!;
  try {
    const updated = await patchEvent(
      client,
      args.event_id,
      {
        summary: args.summary,
        start: args.start,
        end: args.end,
        location: args.location,
        description: args.description,
        attendees: args.attendees,
      },
      args.calendar_id,
    );
    invalidateTodaySchedule();
    return {
      toolCallId,
      content:
        `Updated event "${updated.summary}" (id: ${updated.id}). New start: ${
          formatEventTime(updated.start)
        }.${updated.htmlLink ? `\nView: ${updated.htmlLink}` : ""}`,
    };
  } catch (error) {
    return errorResult(toolCallId, "update event", error);
  }
}

async function doDelete(args: CalendarArgs, toolCallId: string) {
  if (!args.event_id?.trim()) {
    return missingField(toolCallId, "event_id");
  }
  const client = getGoogleClient()!;
  try {
    await deleteEvent(client, args.event_id, args.calendar_id);
    invalidateTodaySchedule();
    return {
      toolCallId,
      content: `Deleted event ${args.event_id}.`,
    };
  } catch (error) {
    return errorResult(toolCallId, "delete event", error);
  }
}

function invalidateTodaySchedule(): void {
  // After a mutation, the today_schedule hook cache is stale. Clearing +
  // triggering async refresh ensures the next turn sees the new event.
  const cache = getHookCache();
  if (cache) cache.invalidate(TODAY_SCHEDULE_KEY);
}

function formatEventsList(
  items: CalendarEvent[],
  query: { timeMin: string; timeMax: string },
): string {
  if (items.length === 0) {
    return `No events found between ${query.timeMin} and ${query.timeMax}.`;
  }
  const lines = items.map((event) => {
    const start = formatEventTime(event.start);
    const end = formatEventTime(event.end, true);
    const location = event.location ? ` @ ${event.location}` : "";
    const attendees = event.attendees && event.attendees.length > 0
      ? ` (${event.attendees.length} attendee${
        event.attendees.length === 1 ? "" : "s"
      })`
      : "";
    const meet = event.hangoutLink ? " [Meet]" : "";
    return `  - ${start}${
      end ? ` → ${end}` : ""
    }: ${event.summary}${location}${attendees}${meet}`;
  });
  return `Found ${items.length} event(s):\n${lines.join("\n")}`;
}

function formatEventTime(
  time?: CalendarEventTime,
  isEnd?: boolean,
): string {
  if (time?.dateTime) {
    return new Date(time.dateTime).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  if (time?.date) {
    return `all day ${isEnd ? "until" : "on"} ${time.date}`;
  }
  return "time TBD";
}

function missingField(toolCallId: string, field: string) {
  return {
    toolCallId,
    content: `Missing required field for this action: ${field}.`,
    isError: true,
  };
}

function notConnectedResult(toolCallId: string) {
  return {
    toolCallId,
    content:
      "Google Suite is not connected. Ask the operator to configure it in Settings → Plugins → Google Suite.",
    isError: true,
  };
}

function errorResult(toolCallId: string, op: string, error: unknown) {
  const message = error instanceof GoogleApiError
    ? `Google Calendar API error (${error.status}): ${error.message}`
    : error instanceof Error
    ? error.message
    : String(error);
  return {
    toolCallId,
    content: `Failed to ${op}: ${message}`,
    isError: true,
  };
}
