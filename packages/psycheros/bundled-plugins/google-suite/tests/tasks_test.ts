import { assertEquals, assertStringIncludes } from "@std/assert";
import { GoogleClient } from "../src/client/google-client.ts";
import {
  completeTask,
  createTask,
  deleteTask,
  GoogleApiError,
  listTaskLists,
  listTasks,
  type Task,
  uncompleteTask,
  updateTask,
} from "../src/services/tasks.ts";

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

const SAMPLE_TASK: Task = {
  id: "task-1",
  title: "Buy milk",
  status: "needsAction",
  due: "2026-07-22T00:00:00.000Z",
  updated: "2026-07-21T14:00:00.000Z",
};

Deno.test("listTasks queries default task list with showCompleted=false", async () => {
  const stub = installStubFetch([
    {
      match: (url) =>
        url.includes("/tasks/v1/lists/") && url.includes("/tasks?"),
      respond: () => ({
        status: 200,
        body: JSON.stringify({ items: [SAMPLE_TASK] }),
      }),
    },
  ]);
  try {
    const result = await listTasks(makeClient(), { maxResults: 10 });
    assertEquals(result.tasks.length, 1);
    assertEquals(result.tasks[0].title, "Buy milk");
    assertStringIncludes(stub.calls[1].url, "showCompleted=false");
    assertStringIncludes(stub.calls[1].url, "maxResults=10");
  } finally {
    stub.restore();
  }
});

Deno.test("listTasks supports custom tasklistId", async () => {
  const stub = installStubFetch([
    {
      match: (url) => url.includes("/tasks/v1/lists/"),
      respond: () => ({ status: 200, body: JSON.stringify({ items: [] }) }),
    },
  ]);
  try {
    await listTasks(makeClient(), {
      tasklistId: "MTkzMzA3NjI2OTM0MzQ1NTY4MjU6MDow",
    });
    assertStringIncludes(
      stub.calls[1].url,
      "/lists/MTkzMzA3NjI2OTM0MzQ1NTY4MjU6MDow/tasks",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("createTask POSTs to default list with title + due", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.includes("/tasks/v1/lists/") && url.includes("/tasks") &&
        method === "POST",
      respond: () => ({ status: 200, body: JSON.stringify(SAMPLE_TASK) }),
    },
  ]);
  try {
    const created = await createTask(makeClient(), {
      title: "Buy milk",
      due: "2026-07-22T00:00:00.000Z",
    });
    assertEquals(created.title, "Buy milk");
    const call = stub.calls[stub.calls.length - 1];
    assertEquals(call.method, "POST");
    const body = JSON.parse(call.body ?? "{}");
    assertEquals(body.title, "Buy milk");
    assertEquals(body.due, "2026-07-22T00:00:00.000Z");
  } finally {
    stub.restore();
  }
});

Deno.test("updateTask PATCHes with only changed fields", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.includes("/tasks/task-1") && method === "PATCH",
      respond: () => ({ status: 200, body: JSON.stringify(SAMPLE_TASK) }),
    },
  ]);
  try {
    await updateTask(makeClient(), "task-1", { title: "Buy oat milk" });
    const call = stub.calls[stub.calls.length - 1];
    const body = JSON.parse(call.body ?? "{}");
    assertEquals(body.title, "Buy oat milk");
    assertEquals(body.due, undefined);
  } finally {
    stub.restore();
  }
});

Deno.test("completeTask sets status=completed", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.includes("/tasks/task-1") && method === "PATCH",
      respond: () => ({
        status: 200,
        body: JSON.stringify({ ...SAMPLE_TASK, status: "completed" }),
      }),
    },
  ]);
  try {
    const result = await completeTask(makeClient(), "task-1");
    assertEquals(result.status, "completed");
    const body = JSON.parse(stub.calls[stub.calls.length - 1].body ?? "{}");
    assertEquals(body.status, "completed");
  } finally {
    stub.restore();
  }
});

Deno.test("uncompleteTask sets status=needsAction", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) => url.includes("/tasks/") && method === "PATCH",
      respond: () => ({
        status: 200,
        body: JSON.stringify({ ...SAMPLE_TASK, status: "needsAction" }),
      }),
    },
  ]);
  try {
    const result = await uncompleteTask(makeClient(), "task-1");
    assertEquals(result.status, "needsAction");
  } finally {
    stub.restore();
  }
});

Deno.test("deleteTask sends DELETE; success on 204", async () => {
  const stub = installStubFetch([
    {
      match: (url, method) =>
        url.includes("/tasks/task-1") && method === "DELETE",
      respond: () => ({ status: 204, empty: true }),
    },
  ]);
  try {
    await deleteTask(makeClient(), "task-1");
    const deleteCall = stub.calls.find((c) => c.method === "DELETE");
    if (!deleteCall) throw new Error("expected DELETE call");
  } finally {
    stub.restore();
  }
});

Deno.test("deleteTask throws on non-2xx", async () => {
  const stub = installStubFetch([
    {
      match: (_url, method) => method === "DELETE",
      respond: () => ({ status: 404, body: '{"error": "not found"}' }),
    },
  ]);
  try {
    let caught: unknown;
    try {
      await deleteTask(makeClient(), "missing");
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

Deno.test("listTaskLists parses response", async () => {
  const stub = installStubFetch([
    {
      match: (url) => url.includes("/tasks/v1/users/@me/lists"),
      respond: () => ({
        status: 200,
        body: JSON.stringify({
          items: [
            { id: "@default", title: "My Tasks" },
            { id: "list-2", title: "Shopping" },
          ],
        }),
      }),
    },
  ]);
  try {
    const lists = await listTaskLists(makeClient());
    assertEquals(lists.length, 2);
    assertEquals(lists[0].id, "@default");
    assertEquals(lists[1].title, "Shopping");
  } finally {
    stub.restore();
  }
});
