import { assertEquals, assertStringIncludes } from "@std/assert";
import { GoogleClient } from "../src/client/google-client.ts";
import {
  createEvent,
  deleteEvent,
  GoogleApiError,
  listCalendars,
  listEvents,
  patchEvent,
} from "../src/services/calendar.ts";

/**
 * Stub Google API responses by URL pattern. The GoogleClient sends real
 * HTTP-shaped requests — we stub globalThis.fetch to return canned JSON
 * based on the URL/method. Refresh-token endpoint is also stubbed so the
 * client can mint a fake access token before each API call.
 */

interface CannedResponse {
  status: number;
  body: string;
}

function installStubFetch(
  responses: Array<{
    match: (url: string, method: string) => boolean;
    respond: () => CannedResponse | Promise<CannedResponse>;
  }>,
): {
  calls: Array<{ url: string; method: string; body?: string }>;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const method = init?.method ?? "GET";
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, body: bodyText });

    // Always stub the token endpoint.
    if (url === "https://oauth2.googleapis.com/token" && method === "POST") {
      return new Response(
        JSON.stringify({
          access_token: "fake-token",
          expires_in: 3600,
          scope: "",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    for (const entry of responses) {
      if (entry.match(url, method)) {
        const { status, body } = await entry.respond();
        // 204 No Content can't have a body — pass undefined to avoid the
        // TypeError from initializeAResponse.
        if (status === 204) {
          return new Response(null, { status: 204 });
        }
        return new Response(body, {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    // Default: 404 for unmatched.
    return new Response("not found in test stub", { status: 404 });
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function makeClient(): GoogleClient {
  return new GoogleClient({
    clientId: "test-id",
    clientSecret: "test-secret",
    refreshToken: "test-refresh",
  });
}

const SAMPLE_EVENT = {
  id: "evt-123",
  summary: "Standup",
  start: { dateTime: "2026-07-20T14:00:00Z" },
  end: { dateTime: "2026-07-20T14:30:00Z" },
  location: "Zoom",
  attendees: [{ email: "alice@example.com" }, { email: "bob@example.com" }],
  hangoutLink: "https://meet.google.com/abc",
  htmlLink: "https://calendar.google.com/event?eid=123",
  status: "confirmed",
};

Deno.test("listEvents queries primary calendar with default time range + singleEvents=true", async () => {
  const stub = installStubFetch([
    {
      match: (url) => url.includes("/calendars/primary/events"),
      respond: () => ({
        status: 200,
        body: JSON.stringify({ items: [SAMPLE_EVENT] }),
      }),
    },
  ]);
  try {
    const client = makeClient();
    const result = await listEvents(client, {
      timeMin: "2026-07-20T00:00:00Z",
      timeMax: "2026-07-21T00:00:00Z",
    });
    assertEquals(result.items.length, 1);
    assertEquals(result.items[0].summary, "Standup");
    assertEquals(result.items[0].attendees?.length, 2);
    assertEquals(result.items[0].hangoutLink, "https://meet.google.com/abc");

    // URL includes singleEvents=true and orderBy=startTime defaults.
    assertStringIncludes(stub.calls[1].url, "singleEvents=true");
    assertStringIncludes(stub.calls[1].url, "orderBy=startTime");
    assertStringIncludes(stub.calls[1].url, "timeMin=2026-07-20T00%3A00%3A00Z");
    assertStringIncludes(stub.calls[1].url, "timeMax=2026-07-21T00%3A00%3A00Z");
  } finally {
    stub.restore();
  }
});

Deno.test("listEvents uses custom calendarId when provided", async () => {
  const stub = installStubFetch([
    {
      match: (url) => url.includes("/calendars/"),
      respond: () => ({ status: 200, body: JSON.stringify({ items: [] }) }),
    },
  ]);
  try {
    const client = makeClient();
    await listEvents(client, {
      calendarId: "family@group.v.calendar.google.com",
    });
    assertStringIncludes(
      stub.calls[1].url,
      "/calendars/family%40group.v.calendar.google.com/events",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("listEvents handles empty calendar", async () => {
  const stub = installStubFetch([
    {
      match: (url) => url.includes("/calendars/"),
      respond: () => ({ status: 200, body: JSON.stringify({ items: [] }) }),
    },
  ]);
  try {
    const result = await listEvents(makeClient(), {});
    assertEquals(result.items, []);
    assertEquals(result.nextPageToken, undefined);
  } finally {
    stub.restore();
  }
});

Deno.test("createEvent POSTs body with summary/start/end/attendees", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.endsWith("/calendars/primary/events") && method === "POST",
      respond: () => ({ status: 200, body: JSON.stringify(SAMPLE_EVENT) }),
    },
  ]);
  try {
    const created = await createEvent(makeClient(), {
      summary: "Standup",
      start: { dateTime: "2026-07-20T14:00:00Z" },
      end: { dateTime: "2026-07-20T14:30:00Z" },
      attendees: [{ email: "alice@example.com" }],
    });
    assertEquals(created.id, "evt-123");

    const call = stub.calls[stub.calls.length - 1];
    assertEquals(call.method, "POST");
    const body = JSON.parse(call.body ?? "{}");
    assertEquals(body.summary, "Standup");
    assertEquals(body.start.dateTime, "2026-07-20T14:00:00Z");
    assertEquals(body.attendees[0].email, "alice@example.com");
  } finally {
    stub.restore();
  }
});

Deno.test("patchEvent sends PATCH to event URL with only updated fields", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.includes("/calendars/primary/events/evt-123") && method === "PATCH",
      respond: () => ({
        status: 200,
        body: JSON.stringify({ ...SAMPLE_EVENT, summary: "Renamed" }),
      }),
    },
  ]);
  try {
    const updated = await patchEvent(makeClient(), "evt-123", {
      summary: "Renamed",
    });
    assertEquals(updated.summary, "Renamed");

    const call = stub.calls[stub.calls.length - 1];
    assertEquals(call.method, "PATCH");
    assertStringIncludes(call.url, "/calendars/primary/events/evt-123");
    const body = JSON.parse(call.body ?? "{}");
    assertEquals(body.summary, "Renamed");
    // Only the patched field is in the body — no start/end/etc.
    assertEquals(body.start, undefined);
    assertEquals(body.end, undefined);
  } finally {
    stub.restore();
  }
});

Deno.test("deleteEvent sends DELETE; success on 204", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.includes("/calendars/primary/events/evt-123") &&
        method === "DELETE",
      respond: () => ({ status: 204, body: "" }),
    },
  ]);
  try {
    await deleteEvent(makeClient(), "evt-123");
    const call = stub.calls[stub.calls.length - 1];
    assertEquals(call.method, "DELETE");
  } finally {
    stub.restore();
  }
});

Deno.test("deleteEvent throws GoogleApiError on non-2xx", async () => {
  const stub = installStubFetch([
    {
      match: (_url, method) => method === "DELETE",
      respond: () => ({ status: 404, body: '{"error": "not found"}' }),
    },
  ]);
  try {
    let caught: unknown;
    try {
      await deleteEvent(makeClient(), "missing");
    } catch (e) {
      caught = e;
    }
    if (!(caught instanceof GoogleApiError)) {
      throw new Error("expected GoogleApiError");
    }
    assertEquals(caught.status, 404);
  } finally {
    stub.restore();
  }
});

Deno.test("listCalendars parses calendarList response", async () => {
  const stub = installStubFetch([
    {
      match: (url) => url.endsWith("/users/me/calendarList"),
      respond: () => ({
        status: 200,
        body: JSON.stringify({
          items: [
            { id: "alice@gmail.com", summary: "Alice", primary: true },
            { id: "family@group.v.calendar.google.com", summary: "Family" },
          ],
        }),
      }),
    },
  ]);
  try {
    const calendars = await listCalendars(makeClient());
    assertEquals(calendars.length, 2);
    assertEquals(calendars[0].primary, true);
    assertEquals(calendars[0].summary, "Alice");
    assertEquals(calendars[1].primary, undefined);
  } finally {
    stub.restore();
  }
});
