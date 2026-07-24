import { assertEquals, assertStringIncludes } from "@std/assert";
import { GoogleClient } from "../src/client/google-client.ts";
import {
  createFolder,
  createTextFile,
  deleteDriveFile,
  GoogleApiError,
  listDriveFiles,
  readDriveFile,
  updateDriveFile,
} from "../src/services/drive.ts";

interface CannedResponse {
  status: number;
  body?: string;
  /** If set, returns empty body (for 204 No Content). */
  empty?: boolean;
}

function installStubFetch(
  responses: Array<{
    match: (url: string, method: string) => boolean;
    respond: () => CannedResponse | Promise<CannedResponse>;
  }>,
): {
  calls: Array<
    { url: string; method: string; body?: string; contentType?: string }
  >;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Array<
    { url: string; method: string; body?: string; contentType?: string }
  > = [];
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
    const contentType = init?.headers instanceof Headers
      ? init.headers.get("Content-Type") ?? undefined
      : undefined;
    calls.push({ url, method, body: bodyText, contentType });

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

const SAMPLE_FILE = {
  id: "file-1",
  name: "notes.txt",
  mimeType: "text/plain",
  size: "11",
  modifiedTime: "2026-07-20T14:00:00.000Z",
  webViewLink: "https://drive.google.com/file/d/file-1/view",
};

Deno.test("listDriveFiles builds query from parentId + trashed=false default", async () => {
  const stub = installStubFetch([
    {
      match: (url) => url.includes("/drive/v3/files"),
      respond: () => ({
        status: 200,
        body: JSON.stringify({
          files: [SAMPLE_FILE],
          incompleteSearch: false,
        }),
      }),
    },
  ]);
  try {
    const result = await listDriveFiles(makeClient(), {
      parentId: "folder-1",
      q: "name = 'notes*'",
      maxResults: 10,
    });
    assertEquals(result.files.length, 1);
    assertEquals(result.files[0].name, "notes.txt");

    const call = stub.calls[1];
    assertStringIncludes(call.url, "pageSize=10");
    const q = new URL(call.url).searchParams.get("q") ?? "";
    assertStringIncludes(q, "'folder-1' in parents");
    assertStringIncludes(q, "trashed = false");
    assertStringIncludes(q, "name = 'notes*'");
  } finally {
    stub.restore();
  }
});

Deno.test("listDriveFiles caps pageSize at 1000", async () => {
  const stub = installStubFetch([
    {
      match: (url) => url.includes("/drive/v3/files"),
      respond: () => ({ status: 200, body: JSON.stringify({ files: [] }) }),
    },
  ]);
  try {
    await listDriveFiles(makeClient(), { maxResults: 99999 });
    assertStringIncludes(stub.calls[1].url, "pageSize=1000");
  } finally {
    stub.restore();
  }
});

Deno.test("readDriveFile fetches content via alt=media for plain text", async () => {
  const stub = installStubFetch([
    {
      match: (url) =>
        url.includes("/drive/v3/files/file-1") &&
        url.includes("alt=media"),
      respond: () => ({ status: 200, body: "Hello world" }),
    },
    {
      match: (url, method) =>
        url.includes("/drive/v3/files/file-1") &&
        !url.includes("/export") &&
        !url.includes("alt=media") &&
        method === "GET",
      respond: () => ({ status: 200, body: JSON.stringify(SAMPLE_FILE) }),
    },
  ]);
  try {
    const result = await readDriveFile(makeClient(), "file-1");
    assertEquals(result.metadata.name, "notes.txt");
    assertEquals(result.content, "Hello world");
    assertEquals(result.contentOmitted, undefined);
  } finally {
    stub.restore();
  }
});

Deno.test("readDriveFile exports Google Doc as text/plain", async () => {
  const stub = installStubFetch([
    {
      match: (url) =>
        url.includes("/drive/v3/files/doc-1") && !url.includes("/export"),
      respond: () => ({
        status: 200,
        body: JSON.stringify({
          id: "doc-1",
          name: "Meeting notes",
          mimeType: "application/vnd.google-apps.document",
          size: "0",
        }),
      }),
    },
    {
      match: (url) => url.includes("/drive/v3/files/doc-1/export"),
      respond: () => ({
        status: 200,
        body: "Meeting notes content",
      }),
    },
  ]);
  try {
    const result = await readDriveFile(makeClient(), "doc-1");
    assertEquals(
      result.metadata.mimeType,
      "application/vnd.google-apps.document",
    );
    assertEquals(result.content, "Meeting notes content");
  } finally {
    stub.restore();
  }
});

Deno.test("readDriveFile returns contentOmitted for large files", async () => {
  const stub = installStubFetch([
    {
      match: (url) =>
        url.includes("/drive/v3/files/big-1") && !url.includes("/export"),
      respond: () => ({
        status: 200,
        body: JSON.stringify({
          id: "big-1",
          name: "huge.log",
          mimeType: "text/plain",
          size: String(10 * 1024 * 1024), // 10 MB > 5 MB cap
        }),
      }),
    },
  ]);
  try {
    const result = await readDriveFile(makeClient(), "big-1");
    assertEquals(result.content, undefined);
    assertEquals(result.contentOmitted, true);
    assertStringIncludes(result.note ?? "", "exceeds");
  } finally {
    stub.restore();
  }
});

Deno.test("createTextFile uses multipart/related with metadata + content", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.includes("/drive/v3/files") &&
        url.includes("uploadType=multipart") &&
        method === "POST",
      respond: () => ({ status: 200, body: JSON.stringify(SAMPLE_FILE) }),
    },
  ]);
  try {
    const result = await createTextFile(makeClient(), {
      name: "notes.txt",
      content: "Hello world",
      parentId: "folder-1",
    });
    assertEquals(result.id, "file-1");

    const call = stub.calls[stub.calls.length - 1];
    assertStringIncludes(call.contentType ?? "", "multipart/related");
    assertStringIncludes(call.contentType ?? "", "boundary=psycheros-");
    assertStringIncludes(call.body ?? "", "Hello world");
    assertStringIncludes(call.body ?? "", "notes.txt");
    assertStringIncludes(call.body ?? "", "folder-1");
  } finally {
    stub.restore();
  }
});

Deno.test("createFolder uses application/vnd.google-apps.folder mimeType", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.includes("/drive/v3/files") && !url.includes("uploadType") &&
        method === "POST",
      respond: () => ({
        status: 200,
        body: JSON.stringify({
          id: "folder-new",
          name: "Project X",
          mimeType: "application/vnd.google-apps.folder",
        }),
      }),
    },
  ]);
  try {
    const result = await createFolder(makeClient(), { name: "Project X" });
    assertEquals(result.mimeType, "application/vnd.google-apps.folder");
    const body = JSON.parse(stub.calls[stub.calls.length - 1].body ?? "{}");
    assertEquals(body.mimeType, "application/vnd.google-apps.folder");
    assertEquals(body.name, "Project X");
  } finally {
    stub.restore();
  }
});

Deno.test("updateDriveFile makes two PATCH calls when both metadata + content provided", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.includes("/drive/v3/files/file-1") && method === "PATCH",
      respond: () => ({ status: 200, body: JSON.stringify(SAMPLE_FILE) }),
    },
    {
      match: (url) =>
        url.includes("/drive/v3/files/file-1") && !url.includes("uploadType"),
      respond: () => ({ status: 200, body: JSON.stringify(SAMPLE_FILE) }),
    },
  ]);
  try {
    await updateDriveFile(makeClient(), "file-1", {
      name: "renamed.txt",
      content: "new content",
    });
    const patchCalls = stub.calls.filter((c) => c.method === "PATCH");
    assertEquals(patchCalls.length, 2);
    // One PATCH is metadata (JSON body, no uploadType), other is content
    // (uploadType=media, plain text body).
    const metadataCall = patchCalls.find((c) =>
      c.contentType === "application/json"
    );
    const contentCall = patchCalls.find((c) =>
      c.url.includes("uploadType=media") && c.contentType === "text/plain"
    );
    assert(metadataCall !== undefined, "expected metadata PATCH call");
    assert(contentCall !== undefined, "expected content PATCH call");
  } finally {
    stub.restore();
  }
});

Deno.test("updateDriveFile rejects when no fields provided", async () => {
  let caught: unknown;
  try {
    await updateDriveFile(makeClient(), "file-1", {});
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof GoogleApiError)) {
    throw new Error("expected GoogleApiError");
  }
});

Deno.test("deleteDriveFile trashes by default (PATCH trashed=true)", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.includes("/drive/v3/files/file-1") && method === "PATCH",
      respond: () => ({
        status: 200,
        body: JSON.stringify({ id: "file-1", trashed: true }),
      }),
    },
  ]);
  try {
    await deleteDriveFile(makeClient(), "file-1");
    const call = stub.calls[stub.calls.length - 1];
    assertEquals(call.method, "PATCH");
    assertStringIncludes(call.body ?? "", '"trashed":true');
  } finally {
    stub.restore();
  }
});

Deno.test("deleteDriveFile permanent=true sends DELETE", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.includes("/drive/v3/files/file-1") && method === "DELETE",
      respond: () => ({ status: 204, empty: true }),
    },
  ]);
  try {
    await deleteDriveFile(makeClient(), "file-1", { permanent: true });
    const deleteCall = stub.calls.find((c) => c.method === "DELETE");
    assert(deleteCall !== undefined, "expected a DELETE call");
  } finally {
    stub.restore();
  }
});

function assert(value: unknown, message?: string): void {
  if (!value) throw new Error(message ?? "assertion failed");
}
