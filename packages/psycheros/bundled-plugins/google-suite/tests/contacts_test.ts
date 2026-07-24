import { assertEquals, assertStringIncludes } from "@std/assert";
import { GoogleClient } from "../src/client/google-client.ts";
import {
  type Contact,
  createContact,
  deleteContact,
  displayName,
  getContact,
  GoogleApiError,
  listContacts,
  primaryEmail,
  primaryPhone,
  updateContact,
} from "../src/services/contacts.ts";

interface CannedResponse {
  status: number;
  body?: string;
  empty?: boolean;
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
        const { status, body, empty } = await entry.respond();
        if (status === 204 || empty) {
          return new Response(null, { status: 204 });
        }
        return new Response(body ?? "", {
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

const SAMPLE_CONTACT: Contact = {
  resourceName: "people/c123",
  names: [{
    displayName: "Alice Smith",
    givenName: "Alice",
    familyName: "Smith",
    metadata: { primary: true },
  }],
  emailAddresses: [
    { value: "alice@work.com", type: "work", metadata: { primary: true } },
    { value: "alice@home.com", type: "home" },
  ],
  phoneNumbers: [
    { value: "+15551234567", type: "mobile", metadata: { primary: true } },
  ],
};

Deno.test("listContacts requests /people/me/connections with personFields mask", async () => {
  const stub = installStubFetch([
    {
      match: (url) => url.includes("/people/me/connections"),
      respond: () => ({
        status: 200,
        body: JSON.stringify({
          connections: [SAMPLE_CONTACT],
          totalItems: 1,
        }),
      }),
    },
  ]);
  try {
    const result = await listContacts(makeClient(), { maxResults: 10 });
    assertEquals(result.contacts.length, 1);
    assertEquals(result.contacts[0].resourceName, "people/c123");

    const call = stub.calls[1];
    assertStringIncludes(call.url, "personFields=names%2CemailAddresses");
    assertStringIncludes(call.url, "pageSize=10");
  } finally {
    stub.restore();
  }
});

Deno.test("listContacts caps pageSize at 1000", async () => {
  const stub = installStubFetch([
    {
      match: (url) => url.includes("/people/me/connections"),
      respond: () => ({
        status: 200,
        body: JSON.stringify({ connections: [] }),
      }),
    },
  ]);
  try {
    await listContacts(makeClient(), { maxResults: 99999 });
    assertStringIncludes(stub.calls[1].url, "pageSize=1000");
  } finally {
    stub.restore();
  }
});

Deno.test("getContact builds URL with resourceName + personFields", async () => {
  const stub = installStubFetch([
    {
      match: (url) => url.includes("/v1/people%2Fc123"),
      respond: () => ({ status: 200, body: JSON.stringify(SAMPLE_CONTACT) }),
    },
  ]);
  try {
    const result = await getContact(makeClient(), "people/c123");
    assertEquals(result.resourceName, "people/c123");
    assertStringIncludes(stub.calls[1].url, "personFields=names");
  } finally {
    stub.restore();
  }
});

Deno.test("createContact body marks first email + phone as primary", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.includes("/people:createContact") && method === "POST",
      respond: () => ({ status: 200, body: JSON.stringify(SAMPLE_CONTACT) }),
    },
  ]);
  try {
    await createContact(makeClient(), {
      givenName: "Alice",
      familyName: "Smith",
      emailAddresses: [
        { value: "alice@work.com", type: "work" },
        { value: "alice@home.com", type: "home" },
      ],
      phoneNumbers: [
        { value: "+15551234567", type: "mobile" },
      ],
    });
    const call = stub.calls[stub.calls.length - 1];
    const body = JSON.parse(call.body ?? "{}");
    assertEquals(body.names[0].givenName, "Alice");
    assertEquals(body.emailAddresses[0].value, "alice@work.com");
    assertEquals(body.emailAddresses[0].metadata.primary, true);
    assertEquals(body.emailAddresses[1].metadata.primary, false);
    assertEquals(body.phoneNumbers[0].metadata.primary, true);
  } finally {
    stub.restore();
  }
});

Deno.test("updateContact body + mask cover only the fields passed", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.includes(":updateContact") && method === "PATCH",
      respond: () => ({ status: 200, body: JSON.stringify(SAMPLE_CONTACT) }),
    },
  ]);
  try {
    await updateContact(makeClient(), "people/c123", {
      biography: "Updated notes",
      emailAddresses: [{ value: "new@x.com" }],
    });
    const call = stub.calls[stub.calls.length - 1];
    // Mask should include both fields being updated.
    assertStringIncludes(call.url, "updatePersonFields=");
    assertStringIncludes(call.url, "biographies");
    assertStringIncludes(call.url, "emailAddresses");
    assertStringIncludes(call.url, "personFields=names");
    const body = JSON.parse(call.body ?? "{}");
    assertEquals(body.biographies[0].value, "Updated notes");
    assertEquals(body.emailAddresses[0].value, "new@x.com");
    assertEquals(body.emailAddresses[0].metadata.primary, true);
    assertEquals(body.names, undefined);
  } finally {
    stub.restore();
  }
});

Deno.test("updateContact rejects when no fields provided", async () => {
  let caught: unknown;
  try {
    await updateContact(makeClient(), "people/c123", {});
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof GoogleApiError)) {
    throw new Error("expected GoogleApiError");
  }
});

Deno.test("deleteContact sends DELETE to :deleteContact endpoint", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.includes(":deleteContact") && method === "DELETE",
      respond: () => ({ status: 204, empty: true }),
    },
  ]);
  try {
    await deleteContact(makeClient(), "people/c123");
    const deleteCall = stub.calls.find((c) => c.method === "DELETE");
    if (!deleteCall) throw new Error("expected DELETE call");
    assertStringIncludes(deleteCall.url, "people%2Fc123");
  } finally {
    stub.restore();
  }
});

Deno.test("primaryEmail extracts the field with metadata.primary=true", () => {
  const email = primaryEmail(SAMPLE_CONTACT);
  assertEquals(email, "alice@work.com");
});

Deno.test("primaryEmail falls back to first if no primary flag", () => {
  const contact: Contact = {
    resourceName: "people/x",
    emailAddresses: [{ value: "first@x.com" }, { value: "second@x.com" }],
  };
  assertEquals(primaryEmail(contact), "first@x.com");
});

Deno.test("primaryPhone returns undefined when no phones", () => {
  const contact: Contact = { resourceName: "people/x" };
  assertEquals(primaryPhone(contact), undefined);
});

Deno.test("displayName extracts primary name", () => {
  assertEquals(displayName(SAMPLE_CONTACT), "Alice Smith");
});
