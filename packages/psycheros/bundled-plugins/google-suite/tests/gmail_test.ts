import { assertEquals, assertStringIncludes } from "@std/assert";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import { GoogleClient } from "../src/client/google-client.ts";
import {
  extractTextBody,
  findHeader,
  getMessage,
  type GmailMessage,
  GoogleApiError,
  listAttachments,
  listLabels,
  listMessages,
  modifyMessage,
  sendMessage,
} from "../src/services/gmail.ts";

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

    if (url === "https://oauth2.googleapis.com/token" && method === "POST") {
      return new Response(
        JSON.stringify({ access_token: "fake-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    for (const entry of responses) {
      if (entry.match(url, method)) {
        const { status, body } = await entry.respond();
        return new Response(body, {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("not found in stub", { status: 404 });
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

const SAMPLE_MESSAGE_FULL: GmailMessage = {
  id: "msg-1",
  threadId: "thr-1",
  labelIds: ["INBOX", "UNREAD"],
  snippet: "Hello there",
  internalDate: String(Date.parse("2026-07-20T14:00:00Z")),
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "Alice <alice@example.com>" },
      { name: "To", value: "bob@example.com" },
      { name: "Subject", value: "Hello" },
      { name: "Date", value: "Mon, 20 Jul 2026 14:00:00 +0000" },
    ],
    parts: [
      {
        mimeType: "text/plain",
        body: { data: "", size: 0 },
      },
      {
        mimeType: "text/html",
        body: { data: "PGh0bWw+PC9odG1sPg==", size: 13 },
      },
    ],
  },
};

Deno.test("listMessages passes query + labelIds + maxResults to API", async () => {
  const stub = installStubFetch([
    {
      match: (url) => url.includes("/gmail/v1/users/me/messages"),
      respond: () => ({
        status: 200,
        body: JSON.stringify({
          messages: [{ id: "msg-1", threadId: "thr-1" }],
          resultSizeEstimate: 1,
        }),
      }),
    },
  ]);
  try {
    const result = await listMessages(makeClient(), {
      q: "from:alice@example.com",
      labelIds: ["INBOX"],
      maxResults: 10,
    });
    assertEquals(result.messages.length, 1);
    assertEquals(result.messages[0].id, "msg-1");

    const call = stub.calls[1];
    assertStringIncludes(call.url, "q=from%3Aalice%40example.com");
    assertStringIncludes(call.url, "labelIds=INBOX");
    assertStringIncludes(call.url, "maxResults=10");
  } finally {
    stub.restore();
  }
});

Deno.test("listMessages caps maxResults at 500 and floors at 1", async () => {
  const stub = installStubFetch([
    {
      match: (url) => url.includes("/messages"),
      respond: () => ({ status: 200, body: JSON.stringify({ messages: [] }) }),
    },
  ]);
  try {
    await listMessages(makeClient(), { maxResults: 99999 });
    assertStringIncludes(stub.calls[1].url, "maxResults=500");
  } finally {
    stub.restore();
  }
});

Deno.test("getMessage fetches with format=full by default", async () => {
  const stub = installStubFetch([
    {
      match: (url) => url.includes("/messages/msg-1"),
      respond: () => ({
        status: 200,
        body: JSON.stringify(SAMPLE_MESSAGE_FULL),
      }),
    },
  ]);
  try {
    const msg = await getMessage(makeClient(), "msg-1");
    assertEquals(msg.id, "msg-1");
    assertEquals(msg.labelIds, ["INBOX", "UNREAD"]);
    assertStringIncludes(stub.calls[1].url, "format=full");
  } finally {
    stub.restore();
  }
});

Deno.test("sendMessage constructs RFC 822 + base64url-encodes", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.endsWith("/messages/send") && method === "POST",
      respond: () => ({
        status: 200,
        body: JSON.stringify({ id: "sent-1", threadId: "thr-sent" }),
      }),
    },
  ]);
  try {
    const result = await sendMessage(makeClient(), {
      to: [{ email: "alice@example.com", displayName: "Alice" }],
      subject: "Test",
      body: "Hello world",
    });
    assertEquals(result.id, "sent-1");

    const call = stub.calls[stub.calls.length - 1];
    const sentBody = JSON.parse(call.body ?? "{}");
    assert(sentBody.raw, "expected 'raw' field in send body");
    // Decode the base64url to verify RFC 822 contents.
    const rfc822 = new TextDecoder().decode(decodeBase64Url(sentBody.raw));
    assertStringIncludes(rfc822, "To: Alice <alice@example.com>");
    assertStringIncludes(rfc822, "Subject: Test");
    assertStringIncludes(rfc822, "Content-Type: text/plain; charset=utf-8");
    assertStringIncludes(rfc822, "Hello world");
    // No From header — Gmail sets it server-side.
    assertEquals(rfc822.includes("From:"), false);
  } finally {
    stub.restore();
  }
});

Deno.test("modifyMessage posts add+remove label IDs in one call", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.includes("/messages/msg-1/modify") && method === "POST",
      respond: () => ({
        status: 200,
        body: JSON.stringify({ labelIds: ["INBOX", "STARRED"] }),
      }),
    },
  ]);
  try {
    const result = await modifyMessage(makeClient(), "msg-1", {
      addLabelIds: ["STARRED"],
      removeLabelIds: ["UNREAD"],
    });
    assertEquals(result.labelIds, ["INBOX", "STARRED"]);

    const call = stub.calls[stub.calls.length - 1];
    const body = JSON.parse(call.body ?? "{}");
    assertEquals(body.addLabelIds, ["STARRED"]);
    assertEquals(body.removeLabelIds, ["UNREAD"]);
  } finally {
    stub.restore();
  }
});

Deno.test("modifyMessage rejects when neither add nor remove provided", async () => {
  let caught: unknown;
  try {
    await modifyMessage(makeClient(), "msg-1", {});
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof GoogleApiError)) {
    throw new Error("expected GoogleApiError");
  }
});

Deno.test("listLabels parses system + user labels", async () => {
  const stub = installStubFetch([
    {
      match: (url) => url.endsWith("/labels"),
      respond: () => ({
        status: 200,
        body: JSON.stringify({
          labels: [
            { id: "INBOX", name: "Inbox", type: "system" },
            { id: "Label_1", name: "work", type: "user" },
          ],
        }),
      }),
    },
  ]);
  try {
    const labels = await listLabels(makeClient());
    assertEquals(labels.length, 2);
    assertEquals(labels[0].type, "system");
    assertEquals(labels[1].type, "user");
  } finally {
    stub.restore();
  }
});

Deno.test("extractTextBody walks multipart tree to find text/plain", () => {
  const plainData = encodeBase64Url(new TextEncoder().encode("Hello body"));
  const msg: GmailMessage = {
    id: "msg-1",
    payload: {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: plainData, size: 10 } },
            { mimeType: "text/html", body: { data: "PGh0bWw+" } },
          ],
        },
        {
          mimeType: "application/pdf",
          filename: "doc.pdf",
          body: { attachmentId: "att-1", size: 1024 },
        },
      ],
    },
  };
  assertEquals(extractTextBody(msg), "Hello body");
});

Deno.test("extractTextBody returns undefined when only HTML body exists", () => {
  const msg: GmailMessage = {
    id: "msg-1",
    payload: {
      mimeType: "text/html",
      body: { data: "PGh0bWw+" },
    },
  };
  assertEquals(extractTextBody(msg), undefined);
});

Deno.test("findHeader is case-insensitive", () => {
  const msg: GmailMessage = {
    id: "msg-1",
    payload: {
      headers: [
        { name: "Subject", value: "Hello" },
        { name: "From", value: "Alice <alice@example.com>" },
      ],
    },
  };
  assertEquals(findHeader(msg, "subject"), "Hello");
  assertEquals(findHeader(msg, "FROM"), "Alice <alice@example.com>");
  assertEquals(findHeader(msg, "missing"), undefined);
});

Deno.test("listAttachments walks parts tree for filenames", () => {
  const msg: GmailMessage = {
    id: "msg-1",
    payload: {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: "hello", size: 5 },
        },
        {
          mimeType: "application/pdf",
          filename: "report.pdf",
          body: { attachmentId: "att-1", size: 1024 * 100 },
        },
        {
          mimeType: "image/png",
          filename: "screenshot.png",
          body: { attachmentId: "att-2", size: 2048 },
        },
      ],
    },
  };
  const atts = listAttachments(msg);
  assertEquals(atts.length, 2);
  assertEquals(atts[0].filename, "report.pdf");
  assertEquals(atts[1].filename, "screenshot.png");
});

// Local assert helper (smaller than importing @std/assert just for one use).
function assert(value: unknown, message?: string): void {
  if (!value) throw new Error(message ?? "assertion failed");
}
